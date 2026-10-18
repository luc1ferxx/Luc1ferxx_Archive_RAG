import {
  getLlmIngestMaxConcurrency,
  getRagIngestEmbedBatchLingerMs,
  getRagIngestEmbedBatchMaxItems,
  getRagIngestEmbedBatchMaxTokens,
} from "./config.js";
import { CIRCUIT_OPEN_CODE, runWithModelCallAttribution } from "./model-call-guard.js";
import { admitModelCallQuota, chargeModelCallQuota } from "./model-call-quota.js";
import { isModelCallRoutedToGateway } from "./openai.js";
import {
  getActiveDatabaseTenant,
  runAsDatabaseSystem,
  runWithDatabaseTenant,
} from "./postgres-tenant.js";
import {
  createRunUsageCapture,
  getCapturedRunUsageEvents,
  runWithRunUsage,
} from "./run-usage.js";
import {
  describeTenantModelUsage,
  recordTenantModelUsageShares,
  runWithCallerAttributedModelUsage,
} from "./tenant-usage.js";
import { embedDocumentTextsForIndex } from "./vector-store.js";

// The cross-document embedding batcher of the staged ingest pipeline.
//
// Every async job's embed stage hands its chunk texts to one batcher per
// process. Each embeddings request carries at most
// RAG_INGEST_EMBED_BATCH_MAX_ITEMS inputs and RAG_INGEST_EMBED_BATCH_MAX_TOKENS
// estimated tokens, and each job gets exactly its own vectors back, in order.
//
// Requests go through `embed`, by default vector-store.js
// embedDocumentTextsForIndex, i.e. rag/openai.js and its model-call guard
// (per-model concurrency cap and circuit breaker, in the guard's ingest lane,
// which is a guard of its own only with RAG_LLM_INGEST_MAX_CONCURRENCY set).
// The batcher keeps at most RAG_LLM_INGEST_MAX_CONCURRENCY (by default
// RAG_LLM_MAX_CONCURRENCY) of its own requests in flight, and merges only what
// that cap holds back: texts that find a free slot leave at once, alone; texts
// that find every slot busy wait, and when a request finishes everything
// waiting in a space goes out together (up to the limits). Merging while
// slots are idle would only make every job wait for one larger request: it
// saves requests but costs throughput unless the cap binds (the ingest load
// test's batching pairs). With no cap of its own (0) nothing signals that the
// provider is busy, so texts linger RAG_INGEST_EMBED_BATCH_LINGER_MS to collect
// a batch instead, and a full batch leaves at once.
//
// Failures fan out per job. Only a batch refused before the provider looked
// at its inputs -- the circuit open, a rate limit -- fails every job in it:
// each retries on its own (jittered) stage backoff. Any other failure may be
// one job's input: a text the provider rejects with a 400, but also one that
// some OpenAI-compatible servers (Ollama, self-hosted TEI or llama.cpp builds)
// answer with a 500 or let hang until the timeout. So the batch is re-sent
// once per job, and only the job whose own request fails again gets the error.
// A provider that is really down fails those requests too, and the model-call
// guard's circuit breaker then opens and makes them cheap.
//
// Tenants. Each job's texts wait in a sub-queue of its tenant (the active
// database tenant of the job's embed call; every call without one -- an index
// build, an unscoped job -- shares one "system" sub-queue), and a batch takes
// the sub-queues in turn, the one served longest ago first, so a tenant's large
// ingest does not hold back another tenant's small one. With one tenant that is
// the FIFO it always was. Two ways to send, picked by `mergeAcrossTenants`:
//
//   merged (the default when model calls do not go to the model gateway): a
//     batch may carry several tenants' texts. It is sent as no tenant's call
//     (the system database context, its guard failures recorded against every
//     tenant it carried), so nothing charges one job's tenant for the others'
//     texts. Instead each job's tenant is admitted by the in-process quota
//     (model-call-quota.js, MODEL_QUOTA_ENABLED) before its texts join a
//     batch -- so a tenant over quota fails only its own job, never a batch --
//     and every answered request's tokens are charged to the tenants it
//     carried, split by their texts' estimated tokens. The tenant usage
//     ledger (rag/tenant-usage.js) gets the same split of the request's
//     metered tokens and estimated cost, instead of booking them all under
//     the system context's ('', '').
//   per tenant (the default when model calls go to the model gateway): a batch
//     carries one tenant's texts and is sent as that tenant, so the gateway
//     signs, admits, meters and charges it as that tenant's own call, and a
//     quota refusal or any batch-wide failure fails that tenant's jobs only.
//
// Every request runs under its own usage capture rather than the context of
// whichever job's call happened to send it, so no job's run meter is charged
// for another's batch.

/** ~4 characters per token for ASCII text, one per other character (CJK). */
export const estimateEmbeddingTokens = (text) => {
  const value = String(text ?? "");
  let ascii = 0;

  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) < 128) {
      ascii += 1;
    }
  }

  return Math.ceil(ascii / 4) + (value.length - ascii) + 1;
};

const resolveSetting = (value) => (typeof value === "function" ? value() : value);

const toLimit = (value, fallbackValue) => {
  const parsed = Math.floor(Number(resolveSetting(value)));

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackValue;
};

/** Whether a failed batch was refused before its inputs were looked at. */
export const isBatchWideEmbeddingError = (error) =>
  error?.code === CIRCUIT_OPEN_CODE || Number(error?.status) === 429;

const createCountMismatchError = (received, expected) =>
  Object.assign(
    new Error(`Embedding provider returned ${received} vector(s) for ${expected} input(s).`),
    { code: "EMBEDDING_COUNT_MISMATCH" }
  );

const SYSTEM_GROUP_KEY = "system";
const MAX_TRACKED_TENANTS = 1024;

// The job's tenant, from the context of its embed call.
const resolveJobTenant = () => {
  const tenant = getActiveDatabaseTenant();

  return tenant
    ? { key: `tenant:${JSON.stringify([tenant.userId, tenant.workspaceId])}`, tenant }
    : { key: SYSTEM_GROUP_KEY, tenant: null };
};

// Splits `total` tokens over the tenants of `entries` in proportion to their
// estimated tokens (largest remainder, so the parts add up to the total).
export const splitEmbeddingTokensByTenant = (entries, total) => {
  const byTenant = new Map();
  let estimated = 0;

  for (const entry of entries) {
    const part = byTenant.get(entry.tenantKey) ?? { estimated: 0, tenant: entry.tenant, tokens: 0 };

    part.estimated += entry.tokens;
    estimated += entry.tokens;
    byTenant.set(entry.tenantKey, part);
  }

  const amount = Math.max(0, Math.floor(Number(total) || 0));
  const parts = [...byTenant.values()];

  if (estimated <= 0 || amount === 0) {
    return parts;
  }

  let assigned = 0;

  for (const part of parts) {
    part.tokens = Math.floor((amount * part.estimated) / estimated);
    part.remainder = (amount * part.estimated) / estimated - part.tokens;
    assigned += part.tokens;
  }

  [...parts]
    .sort((left, right) => right.remainder - left.remainder)
    .slice(0, amount - assigned)
    .forEach((part) => {
      part.tokens += 1;
    });

  return parts.map(({ estimated: estimatedTokens, tenant, tokens }) => ({ estimated: estimatedTokens, tenant, tokens }));
};

export const createEmbeddingBatcher = ({
  embed,
  lingerMs = getRagIngestEmbedBatchLingerMs,
  logger = console,
  maxConcurrency = getLlmIngestMaxConcurrency,
  maxItems = getRagIngestEmbedBatchMaxItems,
  maxTokens = getRagIngestEmbedBatchMaxTokens,
  mergeAcrossTenants = () => !isModelCallRoutedToGateway(),
  estimateTokens = estimateEmbeddingTokens,
} = {}) => {
  if (typeof embed !== "function") {
    throw new Error("createEmbeddingBatcher requires an embed(texts, space) function.");
  }

  // Per embedding space: per tenant, the texts waiting to be sent, oldest
  // first (queue.groups, in arrival order of the tenants).
  const queues = new Map();
  const stats = {
    batchedRequests: 0,
    failedJobs: 0,
    isolatedRequests: 0,
    requests: 0,
    texts: 0,
  };
  let inFlight = 0;
  let nextRequestId = 1;
  // When each tenant's texts last left (a rising turn number), kept across
  // queues that empty and refill so a tenant whose request is in flight does
  // not count as a newcomer. Bounded: the stamps served longest ago go first,
  // and a tenant without a stamp sorts as served longest ago anyway.
  const servedTurns = new Map();
  let turn = 0;

  const lastServedOf = (key) => servedTurns.get(key) ?? 0;

  const markServed = (key) => {
    turn += 1;
    servedTurns.delete(key);
    servedTurns.set(key, turn);

    if (servedTurns.size > MAX_TRACKED_TENANTS) {
      servedTurns.delete(servedTurns.keys().next().value);
    }
  };

  const isMerging = () => resolveSetting(mergeAcrossTenants) !== false;

  const getQueue = (space) => {
    let queue = queues.get(space.key);

    if (!queue) {
      queue = { groups: new Map(), lingerEnded: false, size: 0, space, timer: null, tokens: 0 };
      queues.set(space.key, queue);
    }

    return queue;
  };

  const getGroup = (queue, job) => {
    let group = queue.groups.get(job.key);

    if (!group) {
      group = { entries: [], key: job.key, tenant: job.tenant, tokens: 0 };
      queue.groups.set(job.key, group);
    }

    return group;
  };

  const settleFailure = (request, error) => {
    if (request.settled) {
      return;
    }

    request.settled = true;
    stats.failedJobs += 1;

    // Its texts still waiting are dropped: nobody wants those vectors now.
    for (const queue of queues.values()) {
      for (const [key, group] of queue.groups) {
        const kept = group.entries.filter((entry) => entry.request !== request);

        if (kept.length !== group.entries.length) {
          const keptTokens = kept.reduce((total, entry) => total + entry.tokens, 0);

          queue.size -= group.entries.length - kept.length;
          queue.tokens -= group.tokens - keptTokens;
          group.entries = kept;
          group.tokens = keptTokens;

          if (kept.length === 0) {
            queue.groups.delete(key);
          }
        }
      }
    }

    request.reject(error);
  };

  const deliver = (entry, vector) => {
    const { request } = entry;

    if (request.settled) {
      return;
    }

    request.vectors[entry.index] = vector;
    request.remaining -= 1;

    if (request.remaining === 0) {
      request.settled = true;
      request.resolve(request.vectors);
    }
  };

  // Charges a merged request's answered tokens to the tenants it carried: the
  // tokens its model calls metered (the LLMOps events the capture kept), or,
  // for an embed function that records none, the batch's own estimate.
  const chargeTenants = (entries, capture) => {
    const events = getCapturedRunUsageEvents(capture);
    const total =
      events.length > 0
        ? events.reduce((sum, event) => sum + (Number.isFinite(event.totalTokens) ? event.totalTokens : 0), 0)
        : entries.reduce((sum, entry) => sum + entry.tokens, 0);

    for (const part of splitEmbeddingTokensByTenant(entries, total)) {
      if (part.tenant && part.tokens > 0) {
        chargeModelCallQuota(part.tenant, part.tokens).catch(() => {});
      }
    }
  };

  // Books a merged request's model usage in the tenant usage ledger
  // (rag/tenant-usage.js): the tokens and estimated cost its answered model
  // calls metered, split over the tenants it carried like chargeTenants splits
  // the quota (a job without a tenant's share goes to ('', ''), as its own
  // call would). The request ran as no tenant's call, so the ledger skipped
  // those events (runWithCallerAttributedModelUsage). Booked whether or not
  // the request succeeded: a call answered before a later one failed was paid.
  const recordLedgerShares = (entries, capture) => {
    let tokens = 0;
    let costMicroUsd = 0;

    for (const event of getCapturedRunUsageEvents(capture)) {
      const usage = describeTenantModelUsage(event);

      tokens += usage?.tokens ?? 0;
      costMicroUsd += usage?.costMicroUsd ?? 0;
    }

    if (tokens <= 0 && costMicroUsd <= 0) {
      return;
    }

    const tokenParts = splitEmbeddingTokensByTenant(entries, tokens);
    const costParts = splitEmbeddingTokensByTenant(entries, Math.round(costMicroUsd));

    recordTenantModelUsageShares(
      tokenParts.map((part, index) => ({
        costMicroUsd: costParts[index]?.tokens ?? 0,
        tenant: part.tenant,
        tokens: part.tokens,
      }))
    );
  };

  const callEmbed = async (entries, space, mode) => {
    const capture = createRunUsageCapture();
    const work = () =>
      runWithRunUsage(capture, () =>
        embed(
          entries.map((entry) => entry.text),
          space
        )
      );
    let vectors;

    if (mode.merged) {
      const tenants = [...new Map(entries.map((entry) => [entry.tenantKey, entry.tenant])).values()];

      try {
        vectors = await runAsDatabaseSystem(() =>
          runWithModelCallAttribution(tenants, () => runWithCallerAttributedModelUsage(work))
        );
      } finally {
        recordLedgerShares(entries, capture);
      }

      chargeTenants(entries, capture);
    } else {
      vectors = await (mode.tenant ? runWithDatabaseTenant(mode.tenant, work) : runAsDatabaseSystem(work));
    }

    if (!Array.isArray(vectors) || vectors.length !== entries.length) {
      throw createCountMismatchError(Array.isArray(vectors) ? vectors.length : 0, entries.length);
    }

    return vectors;
  };

  // Re-sends a failed batch's texts once per job, so one job's bad input
  // fails that job only.
  const isolate = async (entries, space, mode) => {
    const byRequest = new Map();

    for (const entry of entries) {
      if (!entry.request.settled) {
        byRequest.set(entry.request, [...(byRequest.get(entry.request) ?? []), entry]);
      }
    }

    for (const [request, requestEntries] of byRequest) {
      if (request.settled) {
        continue;
      }

      stats.requests += 1;
      stats.isolatedRequests += 1;

      try {
        const vectors = await callEmbed(requestEntries, space, mode);

        requestEntries.forEach((entry, index) => deliver(entry, vectors[index]));
      } catch (error) {
        settleFailure(request, error);
      }
    }
  };

  const send = async ({ entries, mode }, space) => {
    inFlight += 1;
    stats.requests += 1;
    stats.texts += entries.length;

    const requestCount = new Set(entries.map((entry) => entry.request)).size;

    if (requestCount > 1) {
      stats.batchedRequests += 1;
    }

    try {
      const vectors = await callEmbed(entries, space, mode);

      entries.forEach((entry, index) => deliver(entry, vectors[index]));
    } catch (error) {
      if (requestCount > 1 && !isBatchWideEmbeddingError(error)) {
        logger.warn?.(
          `[ingest-embed] a batch of ${entries.length} text(s) from ${requestCount} jobs failed; re-sending each job's texts on their own.`
        );
        await isolate(entries, space, mode);
      } else {
        for (const entry of entries) {
          settleFailure(entry.request, error);
        }
      }
    } finally {
      inFlight -= 1;
      dispatchWaiting();
    }
  };

  const limitItems = () => toLimit(maxItems, 512);
  const limitTokens = () => toLimit(maxTokens, 240000);

  const isGroupFull = (group) =>
    group.entries.length >= limitItems() || group.tokens >= limitTokens();

  // Merged: the whole space's queue is one batch's worth. Per tenant: one
  // tenant's sub-queue is.
  const isFull = (queue, merged = isMerging()) =>
    merged
      ? queue.size >= limitItems() || queue.tokens >= limitTokens()
      : [...queue.groups.values()].some(isGroupFull);

  // The sub-queue served longest ago among `groups` (arrival order breaks ties).
  const pickGroup = (groups) => {
    let chosen = null;
    let chosenTurn = 0;

    for (const group of groups) {
      const groupTurn = lastServedOf(group.key);

      if (group.entries.length > 0 && (chosen === null || groupTurn < chosenTurn)) {
        chosen = group;
        chosenTurn = groupTurn;
      }
    }

    return chosen;
  };

  const shiftEntry = (queue, group) => {
    const entry = group.entries.shift();

    group.tokens -= entry.tokens;
    queue.size -= 1;
    queue.tokens -= entry.tokens;
    markServed(group.key);

    if (group.entries.length === 0) {
      queue.groups.delete(group.key);
    }

    return entry;
  };

  // Takes one batch off the queue: at least one text, then as many as fit the
  // item and token limits, in queue order -- merged, one text per tenant in
  // turn; per tenant, from the one tenant served longest ago. `fullOnly`
  // (no cap, linger still running) takes only a full batch.
  const takeBatch = (queue, { fullOnly }) => {
    const merged = isMerging();
    const items = limitItems();
    const tokensLimit = limitTokens();
    const entries = [];
    let tokens = 0;

    if (merged) {
      if (fullOnly && !isFull(queue, true)) {
        return null;
      }

      while (queue.size > 0 && entries.length < items) {
        const group = pickGroup(queue.groups.values());
        const entry = group.entries[0];

        if (entries.length > 0 && tokens + entry.tokens > tokensLimit) {
          break;
        }

        entries.push(shiftEntry(queue, group));
        tokens += entry.tokens;
      }

      return entries.length > 0 ? { entries, mode: { merged: true } } : null;
    }

    const group = pickGroup([...queue.groups.values()].filter((candidate) => !fullOnly || isGroupFull(candidate)));

    if (!group) {
      return null;
    }

    const { tenant } = group;

    while (group.entries.length > 0 && entries.length < items) {
      const entry = group.entries[0];

      if (entries.length > 0 && tokens + entry.tokens > tokensLimit) {
        break;
      }

      entries.push(shiftEntry(queue, group));
      tokens += entry.tokens;
    }

    return { entries, mode: { merged: false, tenant } };
  };

  const getCap = () => {
    const cap = Math.floor(Number(resolveSetting(maxConcurrency)));

    return Number.isFinite(cap) && cap > 0 ? cap : 0;
  };

  const hasSlot = () => getCap() === 0 || inFlight < getCap();

  // An emptied queue ends its window; texts queued later start a new one.
  const forget = (queue) => {
    if (queue.size > 0) {
      return;
    }

    if (queue.timer) {
      clearTimeout(queue.timer);
      queue.timer = null;
    }

    queue.lingerEnded = false;

    if (queues.get(queue.space.key) === queue) {
      queues.delete(queue.space.key);
    }
  };

  // Sends what is due while a slot is free: with a cap, everything queued;
  // without one, every full batch and, once the linger window ended, the rest
  // too. What does not get a slot waits for the next request to finish
  // (dispatchWaiting), which is where batches form under a cap.
  const flush = (queue) => {
    while (queue.size > 0 && hasSlot()) {
      const batch = takeBatch(queue, { fullOnly: !(getCap() > 0 || queue.lingerEnded) });

      if (!batch) {
        break;
      }

      void send(batch, queue.space);
    }

    forget(queue);
  };

  function dispatchWaiting() {
    for (const queue of [...queues.values()]) {
      flush(queue);
    }
  }

  const startLinger = (queue) => {
    if (queue.timer || queue.lingerEnded || queue.size === 0) {
      return;
    }

    const linger = Math.max(0, Math.floor(Number(resolveSetting(lingerMs)) || 0));

    queue.timer = setTimeout(() => {
      queue.timer = null;
      queue.lingerEnded = true;
      flush(queue);
    }, linger);
  };

  const enqueue = (safeTexts, space, job) =>
    new Promise((resolve, reject) => {
      const request = {
        id: nextRequestId++,
        reject,
        remaining: safeTexts.length,
        resolve,
        settled: false,
        vectors: new Array(safeTexts.length),
      };
      const queue = getQueue(space);
      const merged = isMerging();

      safeTexts.forEach((text, index) => {
        const tokens = Math.max(1, Math.floor(Number(estimateTokens(text)) || 1));
        const group = getGroup(queue, job);

        group.entries.push({
          index,
          request,
          tenant: job.tenant,
          tenantKey: job.key,
          text: String(text ?? ""),
          tokens,
        });
        group.tokens += tokens;
        queue.size += 1;
        queue.tokens += tokens;

        // A full batch leaves at once; the texts after it fill the next.
        if (merged ? isFull(queue, true) : isGroupFull(group)) {
          flush(queue);
          queues.set(space.key, queue);
        }
      });

      if (queue.size > 0 && getCap() > 0) {
        // Under a cap nothing lingers: a free slot takes the texts now.
        queues.set(space.key, queue);
        flush(queue);
      } else if (queue.size > 0) {
        queues.set(space.key, queue);
        startLinger(queue);
      } else {
        forget(queue);
      }
    });

  return {
    /**
     * The vectors of `texts` in `space` (an embedding space with a `key`), in
     * order, embedded together with whatever other jobs queued meanwhile.
     * Merging tenants, a job whose tenant is over its in-process model quota
     * is refused here (429, model-call-quota.js) before its texts join a batch.
     */
    embed(texts, space) {
      const safeTexts = Array.isArray(texts) ? texts : [];

      if (!space || typeof space.key !== "string") {
        return Promise.reject(new Error("The embedding batcher needs an embedding space with a key."));
      }

      if (safeTexts.length === 0) {
        return Promise.resolve([]);
      }

      const job = resolveJobTenant();
      // Per tenant, each request is the tenant's own model call and is
      // admitted where it is sent (openai.js, or the gateway).
      const admission = isMerging() ? admitModelCallQuota(job.tenant) : null;

      return admission
        ? admission.then(() => enqueue(safeTexts, space, job))
        : enqueue(safeTexts, space, job);
    },

    /** Requests sent, how many carried more than one job, and so on. */
    stats() {
      return { ...stats, inFlight, queuedTexts: [...queues.values()].reduce((sum, queue) => sum + queue.size, 0) };
    },
  };
};

let defaultBatcher = null;

/**
 * This process's batcher, shared by every ingest worker loop in it, sending
 * through vector-store.js embedDocumentTextsForIndex.
 */
export const getDefaultEmbeddingBatcher = () => {
  defaultBatcher ??= createEmbeddingBatcher({
    embed: (texts, space) => embedDocumentTextsForIndex(texts, space),
  });

  return defaultBatcher;
};

export const resetDefaultEmbeddingBatcher = () => {
  defaultBatcher = null;
};
