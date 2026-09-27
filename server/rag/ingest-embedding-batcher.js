import {
  getLlmMaxConcurrency,
  getRagIngestEmbedBatchLingerMs,
  getRagIngestEmbedBatchMaxItems,
  getRagIngestEmbedBatchMaxTokens,
} from "./config.js";
import { CIRCUIT_OPEN_CODE } from "./model-call-guard.js";
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
// (per-model concurrency cap and circuit breaker). The batcher keeps at most
// RAG_LLM_MAX_CONCURRENCY of its own requests in flight, and merges only what
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

export const createEmbeddingBatcher = ({
  embed,
  lingerMs = getRagIngestEmbedBatchLingerMs,
  logger = console,
  maxConcurrency = getLlmMaxConcurrency,
  maxItems = getRagIngestEmbedBatchMaxItems,
  maxTokens = getRagIngestEmbedBatchMaxTokens,
  estimateTokens = estimateEmbeddingTokens,
} = {}) => {
  if (typeof embed !== "function") {
    throw new Error("createEmbeddingBatcher requires an embed(texts, space) function.");
  }

  // Per embedding space: the texts waiting to be sent, oldest first.
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

  const getQueue = (space) => {
    let queue = queues.get(space.key);

    if (!queue) {
      queue = { entries: [], lingerEnded: false, space, timer: null, tokens: 0 };
      queues.set(space.key, queue);
    }

    return queue;
  };

  const settleFailure = (request, error) => {
    if (request.settled) {
      return;
    }

    request.settled = true;
    stats.failedJobs += 1;

    // Its texts still waiting are dropped: nobody wants those vectors now.
    for (const queue of queues.values()) {
      const kept = queue.entries.filter((entry) => entry.request !== request);

      if (kept.length !== queue.entries.length) {
        queue.entries = kept;
        queue.tokens = kept.reduce((total, entry) => total + entry.tokens, 0);
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

  const callEmbed = async (entries, space) => {
    const vectors = await embed(
      entries.map((entry) => entry.text),
      space
    );

    if (!Array.isArray(vectors) || vectors.length !== entries.length) {
      throw createCountMismatchError(Array.isArray(vectors) ? vectors.length : 0, entries.length);
    }

    return vectors;
  };

  // Re-sends a failed batch's texts once per job, so one job's bad input
  // fails that job only.
  const isolate = async (entries, space) => {
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
        const vectors = await callEmbed(requestEntries, space);

        requestEntries.forEach((entry, index) => deliver(entry, vectors[index]));
      } catch (error) {
        settleFailure(request, error);
      }
    }
  };

  const send = async (entries, space) => {
    inFlight += 1;
    stats.requests += 1;
    stats.texts += entries.length;

    const requestCount = new Set(entries.map((entry) => entry.request)).size;

    if (requestCount > 1) {
      stats.batchedRequests += 1;
    }

    try {
      const vectors = await callEmbed(entries, space);

      entries.forEach((entry, index) => deliver(entry, vectors[index]));
    } catch (error) {
      if (requestCount > 1 && !isBatchWideEmbeddingError(error)) {
        logger.warn?.(
          `[ingest-embed] a batch of ${entries.length} text(s) from ${requestCount} jobs failed; re-sending each job's texts on their own.`
        );
        await isolate(entries, space);
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

  // Takes one batch off the head of the queue: at least one text, then as
  // many as fit the item and token limits.
  const takeBatch = (queue) => {
    const limitItems = toLimit(maxItems, 512);
    const limitTokens = toLimit(maxTokens, 240000);
    const batch = [];
    let tokens = 0;

    while (queue.entries.length > 0 && batch.length < limitItems) {
      const entry = queue.entries[0];

      if (batch.length > 0 && tokens + entry.tokens > limitTokens) {
        break;
      }

      batch.push(queue.entries.shift());
      tokens += entry.tokens;
    }

    queue.tokens -= tokens;
    return batch;
  };

  const getCap = () => {
    const cap = Math.floor(Number(resolveSetting(maxConcurrency)));

    return Number.isFinite(cap) && cap > 0 ? cap : 0;
  };

  const hasSlot = () => getCap() === 0 || inFlight < getCap();

  const isFull = (queue) =>
    queue.entries.length >= toLimit(maxItems, 512) || queue.tokens >= toLimit(maxTokens, 240000);

  // An emptied queue ends its window; texts queued later start a new one.
  const forget = (queue) => {
    if (queue.entries.length > 0) {
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
    while (
      queue.entries.length > 0 &&
      hasSlot() &&
      (getCap() > 0 || queue.lingerEnded || isFull(queue))
    ) {
      void send(takeBatch(queue), queue.space);
    }

    forget(queue);
  };

  function dispatchWaiting() {
    for (const queue of [...queues.values()]) {
      flush(queue);
    }
  }

  const startLinger = (queue) => {
    if (queue.timer || queue.lingerEnded || queue.entries.length === 0) {
      return;
    }

    const linger = Math.max(0, Math.floor(Number(resolveSetting(lingerMs)) || 0));

    queue.timer = setTimeout(() => {
      queue.timer = null;
      queue.lingerEnded = true;
      flush(queue);
    }, linger);
  };

  return {
    /**
     * The vectors of `texts` in `space` (an embedding space with a `key`), in
     * order, embedded together with whatever other jobs queued meanwhile.
     */
    embed(texts, space) {
      const safeTexts = Array.isArray(texts) ? texts : [];

      if (!space || typeof space.key !== "string") {
        return Promise.reject(new Error("The embedding batcher needs an embedding space with a key."));
      }

      if (safeTexts.length === 0) {
        return Promise.resolve([]);
      }

      return new Promise((resolve, reject) => {
        const request = {
          id: nextRequestId++,
          reject,
          remaining: safeTexts.length,
          resolve,
          settled: false,
          vectors: new Array(safeTexts.length),
        };
        const queue = getQueue(space);

        safeTexts.forEach((text, index) => {
          const tokens = Math.max(1, Math.floor(Number(estimateTokens(text)) || 1));

          queue.entries.push({ index, request, text: String(text ?? ""), tokens });
          queue.tokens += tokens;

          // A full batch leaves at once; the texts after it fill the next.
          if (isFull(queue)) {
            flush(queue);
            queues.set(space.key, queue);
          }
        });

        if (queue.entries.length > 0 && getCap() > 0) {
          // Under a cap nothing lingers: a free slot takes the texts now.
          queues.set(space.key, queue);
          flush(queue);
        } else if (queue.entries.length > 0) {
          queues.set(space.key, queue);
          startLinger(queue);
        } else {
          forget(queue);
        }
      });
    },

    /** Requests sent, how many carried more than one job, and so on. */
    stats() {
      return { ...stats, inFlight, queuedTexts: [...queues.values()].reduce((sum, queue) => sum + queue.entries.length, 0) };
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
