// run-semantic-cache-eval.mjs
//
// Measures the semantic answer cache (rag/semantic-cache.js) with a real
// embedding model and a real chat model, on the constructed question set in
// semantic-cache-cases.js over the five documents of
// synthetic-corpus-5docs.json, ingested into a throwaway standalone archive
// (local index, file registry, no database).
//
// Three measurements:
//
// - offline: every follow-up question against its own base question, the
//   cosine similarity of their query embeddings (the vectors the cache
//   compares) and the guard verdict in each mode (none, required = negation /
//   number / date / entity only, full = the runtime guard). A sweep over
//   thresholds shows the paraphrase hit rate and the contrast false hits each
//   combination would give. Document and tenant contrasts are key-separated
//   and left out of the sweep.
// - held-out: the same for SEMANTIC_CACHE_HELD_OUT_PAIRS, per split (tune =
//   the review's probes, confirm = pairs written after the guard rebuild),
//   with the one-sided 95% upper bound on the false-hit rate, and a cross-check
//   that the real lookup/store path gives the same hits at the configured
//   threshold.
// - live: each case's base question and then its follow-ups through chat()
//   with RAG_SEMANTIC_CACHE=on at the configured threshold, as the MCP
//   archive_ask path runs it. Every hit is asked again with the cache off to
//   give a paired uncached latency. A hit on a contrast is a false hit.
//
// Usage (OpenAI-compatible endpoint, e.g. local Ollama):
//   OPENAI_BASE_URL=http://127.0.0.1:11434/v1 OPENAI_API_KEY=ollama \
//   OPENAI_CHAT_MODEL=qwen2.5:7b OPENAI_EMBEDDING_MODEL=nomic-embed-text \
//   node evaluation/run-semantic-cache-eval.mjs [--threshold 0.97] [--offline-only]

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  SEMANTIC_CACHE_CASES,
  SEMANTIC_CACHE_CASE_SET_VERSION,
  SEMANTIC_CACHE_HELD_OUT_PAIRS,
  SEMANTIC_CACHE_TENANTS,
  expandSemanticCacheFollowUps,
} from "./semantic-cache-cases.js";
import {
  binomialUpperBound,
  summarizeHeldOutDecisions,
  summarizeSemanticCacheRuns,
  sweepSemanticCacheDecisions,
} from "./semantic-cache-eval.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resultsDirectory = path.join(__dirname, "results");
const CORPUS_PATH = path.join(__dirname, "synthetic-corpus-5docs.json");
const SWEEP_THRESHOLDS = [0.9, 0.93, 0.95, 0.96, 0.97, 0.98, 0.99, 0.995];

const readArgument = (name) => {
  const index = process.argv.indexOf(name);

  return index === -1 ? null : process.argv[index + 1] ?? null;
};

const round = (value, digits = 4) => (value === null || value === undefined ? null : Number(Number(value).toFixed(digits)));

const cosine = (left, right) => {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }

  return dot / Math.sqrt(leftNorm * rightNorm);
};

const main = async () => {
  if (!String(process.env.OPENAI_API_KEY ?? "").trim()) {
    console.error("OPENAI_API_KEY is empty (any value works against local Ollama).");
    process.exitCode = 1;
    return;
  }

  const threshold = readArgument("--threshold");
  const offlineOnly = process.argv.includes("--offline-only");
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "semantic-cache-eval-"));

  // Before the first RAG import (rag/storage.js captures it).
  process.env.RAG_DATA_DIRECTORY = path.join(tempRoot, "rag-data");
  process.env.DOCCOMPARE_STANDALONE = "1";
  process.env.RAG_OBSERVABILITY_ENABLED = "true";
  process.env.RAG_OBSERVABILITY_EVENTS_PATH = path.join(tempRoot, "events.jsonl");
  // Every call embeds its question, as a first-time question does: with the
  // query embedding cache on, the offline phase would have embedded every
  // question already and the timings would leave the embedding call out.
  process.env.RAG_EMBEDDING_CACHE_ENABLED = "false";

  if (threshold) {
    process.env.RAG_SEMANTIC_CACHE_THRESHOLD = threshold;
  }

  const { applyStandaloneProfile } = await import("../standalone-profile.js");
  applyStandaloneProfile();

  const { default: chat, ingestDocumentPages, initializeDocumentRegistry } = await import("../chat.js");
  const { embedQueryCached } = await import("../rag/embedding-cache.js");
  const { SEMANTIC_CACHE_GUARD_VERSION, compareCacheQuestions } = await import("../rag/semantic-cache-guard.js");
  const { getSemanticCacheStats, lookupSemanticCache, resetSemanticCache, storeSemanticCacheAnswer } = await import(
    "../rag/semantic-cache.js"
  );
  const { getSemanticCacheThreshold } = await import("../rag/config.js");
  const { getDocuments } = await import("../rag/doc-registry.js");
  const { describeActivePromptTemplates } = await import("../rag/prompt-catalog.js");

  try {
    const corpus = JSON.parse(await readFile(CORPUS_PATH, "utf8"));
    const docIdByKey = new Map(corpus.documents.map((document) => [document.key, `sc-${document.key}`]));

    await initializeDocumentRegistry();
    console.log("Ingesting synthetic-corpus-5docs with the real embedding model...");

    for (const document of corpus.documents) {
      const filePath = path.join(tempRoot, document.fileName);

      await writeFile(filePath, document.pages.join("\n\n"), "utf8");
      await ingestDocumentPages({
        docId: docIdByKey.get(document.key),
        fileName: document.fileName,
        filePath,
        pages: document.pages.map((text, index) => ({ pageNumber: index + 1, text })),
        workspaceId: "ws-cache-eval",
      });
    }

    // ---- offline: similarity and guard verdict per follow-up ---------------
    const followUps = expandSemanticCacheFollowUps();
    const decisions = [];

    for (const followUp of followUps) {
      const [incoming, base] = await Promise.all([
        embedQueryCached(followUp.question),
        embedQueryCached(followUp.baseQuestion),
      ]);

      decisions.push({
        id: followUp.id,
        kind: followUp.kind,
        category: followUp.category,
        question: followUp.question,
        baseQuestion: followUp.baseQuestion,
        similarity: round(cosine(incoming, base)),
        guard: Object.fromEntries(
          ["full", "required", "none"].map((mode) => [
            mode,
            compareCacheQuestions(followUp.question, followUp.baseQuestion, { mode }).ok,
          ])
        ),
        guardReason: compareCacheQuestions(followUp.question, followUp.baseQuestion).reason,
      });
    }

    const sweep = sweepSemanticCacheDecisions(decisions, { thresholds: SWEEP_THRESHOLDS });

    // ---- held-out pairs ------------------------------------------------------
    const guardVerdicts = (question, base) =>
      Object.fromEntries(
        ["full", "required", "none"].map((mode) => [mode, compareCacheQuestions(question, base, { mode }).ok])
      );
    const heldOutDecisions = [];
    const heldOutVectors = new Map();

    for (const heldOut of SEMANTIC_CACHE_HELD_OUT_PAIRS) {
      const [incoming, base] = await Promise.all([embedQueryCached(heldOut.question), embedQueryCached(heldOut.base)]);

      heldOutVectors.set(heldOut.id, { incoming, base });
      heldOutDecisions.push({
        id: heldOut.id,
        split: heldOut.split,
        kind: heldOut.kind,
        category: heldOut.category,
        question: heldOut.question,
        baseQuestion: heldOut.base,
        similarity: round(cosine(incoming, base)),
        guard: guardVerdicts(heldOut.question, heldOut.base),
        guardReason: compareCacheQuestions(heldOut.question, heldOut.base).reason,
      });
    }

    const heldOutSweep = Object.fromEntries(
      ["tune", "confirm"].map((split) => [
        split,
        sweepSemanticCacheDecisions(
          heldOutDecisions.filter((decision) => decision.split === split),
          { thresholds: SWEEP_THRESHOLDS }
        ),
      ])
    );
    const heldOutSummary = summarizeHeldOutDecisions(heldOutDecisions, { threshold: getSemanticCacheThreshold() });

    console.log("\nOffline sweep (lexical contrasts only; document/tenant contrasts are key-separated)");
    console.log("mode      thr    repeat  paraphrase  contrast false hits");

    for (const row of sweep) {
      console.log(
        `${row.mode.padEnd(9)} ${row.threshold.toFixed(3)}  ${String(round(row.repeatHitRate, 2)).padEnd(6)}  ` +
          `${row.paraphraseHits}/${row.paraphraseTotal}`.padEnd(12) +
          `${row.contrastFalseHits}/${row.contrastTotal} ${row.falseHitCategories.join(",")}`
      );
    }

    // ---- in-process lookup cost (paid by every miss) ------------------------
    process.env.RAG_SEMANTIC_CACHE = "on";

    const probeVector = await embedQueryCached(SEMANTIC_CACHE_CASES[0].base);
    const probeDocIds = [docIdByKey.get("benefits_2023")];
    const probeDocuments = getDocuments(probeDocIds, SEMANTIC_CACHE_TENANTS.alice);
    const lookupRounds = 2000;
    const lookupStartedAt = process.hrtime.bigint();

    for (let round = 0; round < lookupRounds; round += 1) {
      await lookupSemanticCache({
        accessScope: SEMANTIC_CACHE_TENANTS.alice,
        docIds: probeDocIds,
        query: SEMANTIC_CACHE_CASES[0].base,
        queryVector: probeVector,
        resolvedQuery: SEMANTIC_CACHE_CASES[0].base,
        routeMode: "qa",
        selectedDocuments: probeDocuments,
      });
    }

    const lookupMicroseconds = Number(process.hrtime.bigint() - lookupStartedAt) / 1000 / lookupRounds;

    // The held-out pairs through the real lookup and store at the configured
    // threshold, one fresh cache per pair: the hits must be the offline ones.
    const lookupCrossCheck = { pairs: 0, hits: 0, disagreements: [] };

    for (const heldOut of SEMANTIC_CACHE_HELD_OUT_PAIRS) {
      const vectors = heldOutVectors.get(heldOut.id);
      const request = (question, queryVector) => ({
        accessScope: SEMANTIC_CACHE_TENANTS.alice,
        docIds: probeDocIds,
        query: question,
        queryVector,
        resolvedQuery: question,
        routeMode: "qa",
        selectedDocuments: probeDocuments,
      });

      resetSemanticCache();
      storeSemanticCacheAnswer(await lookupSemanticCache(request(heldOut.base, vectors.base)), {
        text: "stored answer",
        citations: [],
        retrieval: {},
      });

      const hit = (await lookupSemanticCache(request(heldOut.question, vectors.incoming)))?.hit === true;
      const expected = heldOutDecisions.find((decision) => decision.id === heldOut.id);
      const offlineHit = expected.similarity >= getSemanticCacheThreshold() && expected.guard.full;

      lookupCrossCheck.pairs += 1;
      lookupCrossCheck.hits += hit ? 1 : 0;

      if (hit !== offlineHit) {
        lookupCrossCheck.disagreements.push(heldOut.id);
      }
    }

    // The probe's counters are not part of the live run.
    resetSemanticCache();

    // ---- live: through chat() ----------------------------------------------
    const runs = [];
    const bases = [];

    if (!offlineOnly) {
      const ask = async ({ docKeys, question, tenant, cache }) => {
        process.env.RAG_SEMANTIC_CACHE = cache ? "on" : "off";

        const startedAt = performance.now();
        const response = await chat(
          docKeys.map((key) => docIdByKey.get(key)),
          question,
          { accessScope: SEMANTIC_CACHE_TENANTS[tenant] }
        );

        return { latencyMs: performance.now() - startedAt, response };
      };

      // The first chat call loads the model; keep it out of the numbers.
      await ask({ docKeys: ["benefits_2023"], question: "What is the remote work policy?", tenant: "alice", cache: false });

      for (const entry of SEMANTIC_CACHE_CASES) {
        const storesBefore = getSemanticCacheStats().stores;
        const base = await ask({ docKeys: entry.docKeys, question: entry.base, tenant: entry.tenant, cache: true });
        const baseCached = getSemanticCacheStats().stores > storesBefore;

        bases.push({
          caseId: entry.id,
          question: entry.base,
          abstained: Boolean(base.response.abstained),
          cached: baseCached,
          latencyMs: round(base.latencyMs, 1),
        });
        console.log(`\n[${entry.id}] base ${baseCached ? "stored" : "not stored (abstained)"} ${Math.round(base.latencyMs)} ms`);

        for (const followUp of followUps.filter((candidate) => candidate.caseId === entry.id)) {
          const result = await ask({ ...followUp, cache: true });
          const hit = result.response.semanticCache?.hit === true;
          const run = {
            id: followUp.id,
            kind: followUp.kind,
            category: followUp.category,
            question: followUp.question,
            baseCached,
            hit,
            similarity: result.response.semanticCache?.similarity ?? null,
            abstained: Boolean(result.response.abstained),
            latencyMs: round(result.latencyMs, 1),
          };

          if (hit) {
            const uncached = await ask({ ...followUp, cache: false });

            run.uncachedLatencyMs = round(uncached.latencyMs, 1);
            run.uncachedAbstained = Boolean(uncached.response.abstained);
          }

          runs.push(run);
          console.log(
            `  ${followUp.kind.padEnd(10)} ${(followUp.category ?? "").padEnd(8)} ${hit ? "HIT " : "miss"} ` +
              `${Math.round(result.latencyMs)} ms${hit ? ` (uncached ${Math.round(run.uncachedLatencyMs)} ms${run.uncachedAbstained ? ", abstained" : ""})` : ""}  ${followUp.question}`
          );
        }
      }
    }

    const summary = summarizeSemanticCacheRuns(runs);
    const chosen = sweep.find((row) => row.mode === "full" && row.threshold === getSemanticCacheThreshold());

    if (chosen) {
      chosen.contrastFalseHitUpperBound95 = binomialUpperBound(chosen.contrastFalseHits, chosen.contrastTotal);
    }

    const report = {
      generatedAt: new Date().toISOString(),
      caseSetVersion: SEMANTIC_CACHE_CASE_SET_VERSION,
      guardVersion: SEMANTIC_CACHE_GUARD_VERSION,
      endpoint: {
        baseUrl: process.env.OPENAI_BASE_URL ?? null,
        chatModel: process.env.OPENAI_CHAT_MODEL ?? null,
        embeddingModel: process.env.OPENAI_EMBEDDING_MODEL ?? null,
      },
      threshold: getSemanticCacheThreshold(),
      promptTemplates: describeActivePromptTemplates(),
      lookupMicroseconds: round(lookupMicroseconds, 1),
      offline: { chosen, sweep, decisions },
      heldOut: { summary: heldOutSummary, sweep: heldOutSweep, lookupCrossCheck, decisions: heldOutDecisions },
      live: offlineOnly ? null : { summary, bases, runs },
      cacheStats: getSemanticCacheStats(),
    };

    await mkdir(resultsDirectory, { recursive: true });
    await writeFile(path.join(resultsDirectory, "latest-semantic-cache.json"), `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(path.join(resultsDirectory, "latest-semantic-cache.md"), renderMarkdown(report));

    console.log("\nSummary");
    console.log(
      JSON.stringify(
        {
          threshold: report.threshold,
          lookupMicroseconds: report.lookupMicroseconds,
          chosen,
          heldOut: heldOutSummary,
          lookupCrossCheck,
          live: offlineOnly ? null : summary,
        },
        null,
        2
      )
    );

    const heldOutFalseHits = Object.values(heldOutSummary.splits).reduce(
      (sum, split) => sum + split.contrastFalseHits,
      0
    );

    if ((!offlineOnly && summary.contrast.falseHits > 0) || heldOutFalseHits > 0 || lookupCrossCheck.disagreements.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
};

const percent = (value) => (value === null || value === undefined ? "-" : `${(value * 100).toFixed(1)}%`);
const ms = (value) => (value === null || value === undefined ? "-" : `${Math.round(value)} ms`);

export const renderMarkdown = (report) => {
  const lines = [
    "# Semantic answer cache evaluation",
    "",
    `- generated: ${report.generatedAt}`,
    `- case set: \`${report.caseSetVersion}\`; guard: \`${report.guardVersion}\``,
    `- chat model: \`${report.endpoint.chatModel}\`, embedding model: \`${report.endpoint.embeddingModel}\``,
    `- threshold: ${report.threshold}; in-process lookup cost: ${report.lookupMicroseconds} µs per lookup`,
    "",
    "## In-category offline sweep (lexical contrasts; document/tenant contrasts are separated by the key)",
    "",
    `At the configured threshold with the full guard: ${report.offline.chosen ? `${report.offline.chosen.contrastFalseHits}/${report.offline.chosen.contrastTotal} in-category contrasts hit (one-sided 95% upper bound ${percent(report.offline.chosen.contrastFalseHitUpperBound95)}), ${report.offline.chosen.paraphraseHits}/${report.offline.chosen.paraphraseTotal} paraphrases hit` : "-"}.`,
    "",
    "| guard | threshold | repeat hit rate | paraphrase hits | contrast false hits | false-hit categories |",
    "| --- | --- | --- | --- | --- | --- |",
    ...report.offline.sweep.map(
      (row) =>
        `| ${row.mode} | ${row.threshold} | ${percent(row.repeatHitRate)} | ${row.paraphraseHits}/${row.paraphraseTotal} | ` +
        `${row.contrastFalseHits}/${row.contrastTotal} | ${row.falseHitCategories.join(", ") || "-"} |`
    ),
    "",
    "## Held-out pairs",
    "",
    `Configured threshold ${report.heldOut.summary.threshold}, full guard. Upper bounds are one-sided exact 95% and assume independent pairs.`,
    "",
    "| split | contrasts above threshold | contrast false hits | 95% upper bound | paraphrase hits |",
    "| --- | --- | --- | --- | --- |",
    ...Object.entries(report.heldOut.summary.splits).map(
      ([split, row]) =>
        `| ${split} | ${row.contrastAboveThreshold}/${row.contrastTotal} | ${row.contrastFalseHits}/${row.contrastTotal} | ` +
        `${percent(row.falseHitUpperBound95)} | ${row.paraphraseHits}/${row.paraphraseTotal} |`
    ),
    "",
    `Real lookup/store cross-check: ${report.heldOut.lookupCrossCheck.hits} hits over ${report.heldOut.lookupCrossCheck.pairs} pairs, ` +
      `${report.heldOut.lookupCrossCheck.disagreements.length} disagreements with the offline decision.`,
    "",
    "| split | guard | threshold | contrast false hits | false-hit categories | paraphrase hits |",
    "| --- | --- | --- | --- | --- | --- |",
    ...Object.entries(report.heldOut.sweep).flatMap(([split, rows]) =>
      rows.map(
        (row) =>
          `| ${split} | ${row.mode} | ${row.threshold} | ${row.contrastFalseHits}/${row.contrastTotal} | ` +
          `${row.falseHitCategories.join(", ") || "-"} | ${row.paraphraseHits}/${row.paraphraseTotal} |`
      )
    ),
    "",
    "| split | kind | category | similarity | full guard | base | question |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...report.heldOut.decisions.map(
      (decision) =>
        `| ${decision.split} | ${decision.kind} | ${decision.category ?? ""} | ${decision.similarity} | ` +
        `${decision.guard.full ? "pass" : `reject (${decision.guardReason})`} | ${decision.baseQuestion.replace(/\|/g, "\\|")} | ${decision.question.replace(/\|/g, "\\|")} |`
    ),
    "",
    "## Similarity and guard per in-category follow-up",
    "",
    "| kind | category | similarity | full guard | question |",
    "| --- | --- | --- | --- | --- |",
    ...report.offline.decisions.map(
      (decision) =>
        `| ${decision.kind} | ${decision.category ?? ""} | ${decision.similarity} | ` +
        `${decision.guard.full ? "pass" : `reject (${decision.guardReason})`} | ${decision.question.replace(/\|/g, "\\|")} |`
    ),
  ];

  if (report.live) {
    const { summary } = report.live;

    lines.push(
      "",
      "## Live, through chat()",
      "",
      `- repeats: ${summary.repeat.hits}/${summary.repeat.eligible} hit (${percent(summary.repeat.hitRate)})`,
      `- paraphrases: ${summary.paraphrase.hits}/${summary.paraphrase.eligible} hit (${percent(summary.paraphrase.hitRate)})`,
      `- in-category contrasts: ${summary.contrast.falseHits} false hits of ${summary.contrast.total} (${summary.contrast.meaningful} with a stored base; one-sided 95% upper bound ${percent(summary.contrast.falseHitUpperBound95)})`,
      `- hits whose uncached re-run abstained (served an answer the pipeline would have refused; not timed): ${summary.hitsWhereUncachedAbstained}`,
      `- latency on hits: ${ms(summary.latency.meanHitMs)} mean, ${ms(summary.latency.medianHitMs)} median; ` +
        `same questions uncached ${ms(summary.latency.meanUncachedMs)} mean, ${ms(summary.latency.medianUncachedMs)} median; ` +
        `saved ${ms(summary.latency.meanSavedMs)} per hit (95% CI ${summary.latency.savedCi95 ? summary.latency.savedCi95.map((value) => Math.round(value)).join(" to ") : "-"} ms, n=${summary.latency.pairs})`,
      "",
      "| case | base stored | base latency |",
      "| --- | --- | --- |",
      ...report.live.bases.map((base) => `| ${base.caseId} | ${base.cached ? "yes" : "no (abstained)"} | ${ms(base.latencyMs)} |`),
      "",
      "| kind | category | result | latency | uncached | question |",
      "| --- | --- | --- | --- | --- | --- |",
      ...report.live.runs.map(
        (run) =>
          `| ${run.kind} | ${run.category ?? ""} | ${run.hit ? `hit (${run.similarity})` : "miss"} | ${ms(run.latencyMs)} | ` +
          `${ms(run.uncachedLatencyMs)}${run.uncachedAbstained ? " (abstained)" : ""} | ${run.question.replace(/\|/g, "\\|")} |`
      )
    );
  }

  return `${lines.join("\n")}\n`;
};

// Imported by test/semantic-cache.test.mjs for renderMarkdown; run main()
// only when invoked as a script.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
