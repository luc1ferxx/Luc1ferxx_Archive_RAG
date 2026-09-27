import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import chat, { clearDocuments, deleteDocument, ingestDocumentPages } from "../chat.js";
import { configureOpenAIProvider, resetOpenAIProvider } from "../rag/openai.js";
import { configureRagDataDirectory, getRagDataDirectory } from "../rag/storage.js";
import {
  configureDocumentRegistryStore,
  refreshDocumentRegistry,
  resetDocumentRegistry,
  resetDocumentRegistryStore,
} from "../rag/doc-registry.js";
import { applyQueryAdapter } from "../rag/query-adapter.js";
import { createFileDocumentRegistryStore } from "../rag/doc-registry-file.js";
import { resetVectorStore } from "../rag/vector-store.js";
import { resetEmbeddingCache } from "../rag/embedding-cache.js";
import { buildTermSet } from "../rag/text-utils.js";
import {
  DEFAULT_SEMANTIC_CACHE_THRESHOLD,
  getSemanticCacheThreshold,
  getSemanticCacheTtlMs,
  isSemanticCacheEnabled,
} from "../rag/config.js";
import {
  clearSemanticCache,
  describeRetrievalPlanShape,
  getSemanticCacheStats,
  invalidateSemanticCacheDocuments,
  lookupSemanticCache,
  resetSemanticCache,
  storeSemanticCacheAnswer,
} from "../rag/semantic-cache.js";
import {
  SEMANTIC_CACHE_GUARD_MODES,
  analyzeCacheQuestion,
  compareCacheQuestions,
} from "../rag/semantic-cache-guard.js";
import {
  SEMANTIC_CACHE_CASES,
  SEMANTIC_CACHE_CONTRAST_CATEGORIES,
  SEMANTIC_CACHE_FOLLOW_UP_KINDS,
  SEMANTIC_CACHE_HELD_OUT_CATEGORIES,
  SEMANTIC_CACHE_HELD_OUT_PAIRS,
  SEMANTIC_CACHE_HELD_OUT_SPLITS,
  SEMANTIC_CACHE_TENANTS,
  expandSemanticCacheFollowUps,
} from "../evaluation/semantic-cache-cases.js";
import {
  binomialUpperBound,
  summarizeHeldOutDecisions,
  summarizeSemanticCacheRuns,
  sweepSemanticCacheDecisions,
} from "../evaluation/semantic-cache-eval.js";
import { buildEvaluationEvidence, getPublicEvaluationConfig } from "../evaluation/eval-evidence.js";
import {
  EVALUATION_EVIDENCE_REASON_CODES,
  getEvaluationEvidenceFailureReason,
} from "../evaluation/eval-evidence-validation.js";

const CACHE_ENV_NAMES = [
  "RAG_SEMANTIC_CACHE",
  "RAG_SEMANTIC_CACHE_THRESHOLD",
  "RAG_SEMANTIC_CACHE_MAX_ENTRIES",
  "RAG_SEMANTIC_CACHE_TTL_MS",
  "RAG_SEMANTIC_CACHE_MAX_BYTES",
  "VECTOR_STORE_PROVIDER",
  "RAG_HYBRID_ENABLED",
  "RAG_OBSERVABILITY_ENABLED",
  "RAG_OBSERVABILITY_EVENTS_PATH",
  "RAG_LONG_MEMORY_ENABLED",
];

let savedEnvironment = {};
let tempRoot = null;
const originalDataDirectory = getRagDataDirectory();

beforeEach(async () => {
  savedEnvironment = Object.fromEntries(CACHE_ENV_NAMES.map((name) => [name, process.env[name]]));

  for (const name of CACHE_ENV_NAMES) {
    delete process.env[name];
  }

  process.env.VECTOR_STORE_PROVIDER = "local";
  process.env.RAG_HYBRID_ENABLED = "false";
  process.env.RAG_LONG_MEMORY_ENABLED = "false";
  resetSemanticCache();
});

afterEach(async () => {
  for (const [name, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  resetSemanticCache();
});

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

test("guard passes the allowlisted rewrites and nothing broader", () => {
  const base = "How many paid annual leave days do employees receive per year?";

  for (const variant of [
    "how many paid annual leave days do employees receive per year",
    "HOW MANY PAID ANNUAL LEAVE DAYS DO EMPLOYEES RECEIVE PER YEAR?",
    "How many paid annual leave days do employees get per year?",
    "How many days of paid annual leave do employees receive each year?",
  ]) {
    assert.deepEqual(compareCacheQuestions(variant, base).ok, true, variant);
  }

  const allowed = [
    ["Which policy permits staff to work remotely three days per week?", "Which policy allows staff to work remotely 3 days per week?"],
    ["What is the daily meal limit?", "What is the meal limit per day?"],
    ["What's the meal limit per day?", "What is the meal limit per day?"],
    ["Can contractors work remotely?", "May contractors work remotely?"],
    ["Who has to approve remote work?", "Who must approve remote work?"],
    ["Does the program lead have to approve remote work?", "Must the program lead approve remote work?"],
    ["Is pre-approval needed before booking a hotel?", "Is pre-approval required before booking a hotel?"],
    ["What does the handbook state about parking?", "What does the handbook say about parking?"],
    ["What was the limit during 2024?", "What was the limit in 2024?"],
    ["Сколько дней отпуска получают сотрудники", "Сколько дней отпуска получают сотрудники?"],
  ];

  for (const [incoming, cached] of allowed) {
    assert.equal(compareCacheQuestions(incoming, cached).ok, true, incoming);
  }

  // Rewordings outside the allowlist miss; a miss is one ordinary RAG run.
  for (const [incoming, cached] of [
    ["Per year, how many paid annual leave days do employees receive?", base],
    ["Which policy lets staff work remotely 3 days per week?", "Which policy allows staff to work remotely 3 days per week?"],
    ["What is the remote work policy?", "What is the policy on remote work?"],
  ]) {
    assert.equal(compareCacheQuestions(incoming, cached).ok, false, incoming);
  }
});

test("guard rejects the look-alikes the first guard let through", () => {
  const cases = [
    // modal classes
    ["Must employees work remotely on Fridays?", "Can employees work remotely on Fridays?", "modal"],
    ["Can managers approve overtime requests?", "Should managers approve overtime requests?", "modal"],
    ["Will interns attend the offsite?", "Can interns attend the offsite?", "modal"],
    // direction
    ["Can employees transfer unused leave from another employee?", "Can employees transfer unused leave to another employee?", "content"],
    ["Can an employee move to the sales team from the marketing team?", "Can an employee move from the sales team to the marketing team?", "content"],
    // negation scope
    ["Is pre-approval not required when the trip is international?", "Is pre-approval required when the trip is not international?", "negation"],
    // comparators and currency
    ["Are expenses < $500 reimbursed without approval?", "Are expenses > $500 reimbursed without approval?", "number"],
    ["Are purchases ≤ $1,000 reviewed?", "Are purchases ≥ $1,000 reviewed?", "number"],
    ["Are purchases over €500 reviewed?", "Are purchases over $500 reviewed?", "number"],
    // pronouns and possessives
    ["Can his manager see my performance review?", "Can my manager see his performance review?", "content"],
    // relative time, tense, question word
    ["What expenses were reimbursed this quarter?", "What expenses were reimbursed last quarter?", "date"],
    ["Is remote work allowed after probation?", "Is remote work allowed during probation?", "content"],
    ["Which benefits start 30 days after hire?", "Which benefits start 30 days before hire?", "negation"],
    ["Is remote work allowed on Fridays?", "Was remote work allowed on Fridays?", "content"],
    ["Who approves the travel budget?", "Who approved the travel budget?", "content"],
    ["When must remote work be approved?", "Who must approve remote work?", "content"],
    // order of dates and units
    ["Is remote work allowed from friday to monday?", "Is remote work allowed from monday to friday?", "date"],
    ["Is leave accrued per year for each month of service?", "Is leave accrued per month for each year of service?", "date"],
    ["What is the news media policy?", "What is the new media policy?", "content"],
    // any non-Latin letter: exact match only
    ["Не требуется ли предварительное одобрение для командировки?", "Требуется ли предварительное одобрение для командировки?", "script"],
    ["Πόσες ημέρες άδειας δικαιούνται οι εξωτερικοί συνεργάτες;", "Πόσες ημέρες άδειας δικαιούνται οι υπάλληλοι;", "script"],
    ["พนักงานได้รับวันลาป่วยกี่วัน", "พนักงานได้รับวันลาพักร้อนกี่วัน", "script"],
  ];

  for (const [incoming, cached, reason] of cases) {
    const verdict = compareCacheQuestions(incoming, cached);

    assert.equal(verdict.ok, false, incoming);
    assert.equal(verdict.reason, reason, incoming);
  }

  // Accented Latin text is not treated as another script.
  assert.equal(analyzeCacheQuestion("Les employés peuvent-ils télétravailler ?").script, null);
  assert.ok(analyzeCacheQuestion("Не требуется ли одобрение?").script);
});

test("guard rejects negation, numbers, dates, entities, roles, CJK and content swaps", () => {
  const cases = [
    ["Is pre-approval not required before booking a hotel?", "Is pre-approval required before booking a hotel?", "negation"],
    ["Can a hotel be booked without pre-approval?", "Can a hotel be booked with pre-approval?", "negation"],
    ["Which regions can't use it?", "Which regions can use it?", "negation"],
    ["How many unpaid leave days are there?", "How many paid leave days are there?", "negation"],
    ["What is the minimum notice period?", "What is the maximum notice period?", "negation"],
    ["Do employees receive 10 leave days?", "Do employees receive 8 leave days?", "number"],
    ["Do employees receive ten leave days?", "Do employees receive 8 leave days?", "number"],
    ["Is 3 greater than 5?", "Is 5 greater than 3?", "number"],
    ["What was the limit in 2025?", "What was the limit in 2024?", "number"],
    ["What was the limit in March 2024?", "What was the limit in 2024?", "date"],
    ["How many leave hours per year?", "How many leave days per year?", "date"],
    ["What changed last year?", "What changed this year?", "date"],
    ["What does the Benefits Handbook say?", "What does the Contractor Handbook say?", "entity"],
    ["What does vendor-b.pdf say about liability?", "What does vendor-a.pdf say about liability?", "entity"],
    ["What does GPT-4 score?", "What does GPT-5 score?", "number"],
    ["公司每年给员工多少天带薪病假？", "公司每年给员工多少天带薪年假？", "script"],
    ["Can contractors approve expenses submitted by employees?", "Can employees approve expenses submitted by contractors?", "content"],
    ["What is the hotel reimbursement limit per day?", "What is the meal reimbursement limit per day?", "content"],
    [
      "Under the policy for all regions, how many paid leave days do employees receive once they have completed probation?",
      "Under the policy for all offices, how many paid leave days do employees receive once they have completed probation?",
      "content",
    ],
  ];

  for (const [incoming, cached, reason] of cases) {
    const verdict = compareCacheQuestions(incoming, cached);

    assert.equal(verdict.ok, false, incoming);
    assert.equal(verdict.reason, reason, incoming);
  }
});

test("guard modes: required checks only the listed kinds, none checks nothing", () => {
  assert.deepEqual([...SEMANTIC_CACHE_GUARD_MODES], ["full", "required", "none"]);

  const swap = ["What is the hotel limit?", "What is the meal limit?"];

  assert.equal(compareCacheQuestions(...swap).ok, false);
  assert.equal(compareCacheQuestions(...swap, { mode: "required" }).ok, true);
  assert.equal(compareCacheQuestions("Is it not allowed?", "Is it allowed?", { mode: "none" }).ok, true);
  assert.equal(compareCacheQuestions("Is it not allowed?", "Is it allowed?", { mode: "required" }).reason, "negation");
});

test("guard reads number words, ordinals, and the modal 'may' apart from the month", () => {
  assert.deepEqual(analyzeCacheQuestion("twenty five and two hundred and five, third").numbers, ["25", "205", "ord:3"]);
  assert.deepEqual(analyzeCacheQuestion("May 5 leave days be carried over?").dates, ["unit:day"]);
  assert.deepEqual(analyzeCacheQuestion("What changed in May 2024?").dates, ["month:may"]);
  assert.equal(analyzeCacheQuestion("WHAT DOES THE CONTRACTOR HANDBOOK SAY?").entities, null);
});

// ---------------------------------------------------------------------------
// Cache (unit)
// ---------------------------------------------------------------------------

const document = (docId, overrides = {}) => ({
  docId,
  version: 1,
  contentSha256: `sha-${docId}`,
  updatedAt: "2026-01-01T00:00:00.000Z",
  uploadedAt: "2026-01-01T00:00:00.000Z",
  chunkCount: 3,
  ...overrides,
});

const unitVector = (angle) => [Math.cos(angle), Math.sin(angle), 0];

const lookup = (overrides = {}) =>
  lookupSemanticCache({
    accessScope: { userId: "alice", workspaceId: "ws" },
    docIds: ["doc-a"],
    query: "What is the meal limit per day?",
    queryVector: unitVector(0),
    resolvedQuery: "What is the meal limit per day?",
    routeMode: "qa",
    selectedDocuments: [document("doc-a")],
    ...overrides,
  });

const answer = (text = "The meal limit is 50 dollars per day. [Source 1]") => ({
  text,
  citations: [{ docId: "doc-a", pageNumber: 1 }],
  retrieval: { provider: "local" },
});

const prime = async (overrides = {}, response = answer()) => {
  const first = await lookup(overrides);

  assert.equal(first.hit, false);
  assert.equal(storeSemanticCacheAnswer(first, response).stored, true);
  return first;
};

test("cache is off by default and the defaults are conservative", async () => {
  assert.equal(isSemanticCacheEnabled(), false);
  assert.equal(getSemanticCacheThreshold(), DEFAULT_SEMANTIC_CACHE_THRESHOLD);
  assert.equal(DEFAULT_SEMANTIC_CACHE_THRESHOLD, 0.97);
  assert.equal(getSemanticCacheTtlMs(), 3_600_000);
  assert.equal(await lookup(), null);

  process.env.RAG_SEMANTIC_CACHE = "maybe";
  assert.equal(isSemanticCacheEnabled(), false);
  process.env.RAG_SEMANTIC_CACHE_THRESHOLD = "1.5";
  assert.equal(getSemanticCacheThreshold(), 0.97);
});

test("a repeated question hits within its key and returns a marked copy", async () => {
  process.env.RAG_SEMANTIC_CACHE = "on";
  await prime();

  const second = await lookup({ queryVector: unitVector(0.1), resolvedQuery: "what is the meal limit per day" });

  assert.equal(second.hit, true);
  assert.equal(second.response.text, answer().text);
  assert.equal(second.response.semanticCache.hit, true);
  assert.ok(second.response.semanticCache.similarity >= 0.99);
  assert.equal(second.trace.hit, true);

  // The served copy is independent of the stored one.
  second.response.citations.push({ docId: "doc-a", pageNumber: 9 });
  const third = await lookup();

  assert.equal(third.response.citations.length, 1);
});

test("nothing crosses tenant, doc set, document version, answer mode, prompt config or model", async () => {
  process.env.RAG_SEMANTIC_CACHE = "on";
  await prime();

  const misses = {
    tenant: { accessScope: { userId: "bob", workspaceId: "ws" } },
    anonymous: { accessScope: {} },
    docSet: { docIds: ["doc-a", "doc-b"], selectedDocuments: [document("doc-a"), document("doc-b")] },
    routeMode: { routeMode: "compare" },
    plan: {
      agentRetrievalPlan: {
        phase: "primary",
        intent: "fact",
        retrievalQueries: [{ id: "primary", query: "What is the meal limit per day?", primary: true }],
      },
    },
    preference: { preferenceBlock: "Answer in French." },
  };

  for (const [name, overrides] of Object.entries(misses)) {
    const result = await lookup(overrides);

    assert.equal(result.hit, false, name);
  }

  process.env.OPENAI_CHAT_MODEL_SAVED = process.env.OPENAI_CHAT_MODEL ?? "";
  process.env.OPENAI_CHAT_MODEL = "another-model";
  try {
    assert.equal((await lookup()).hit, false, "chat model");
  } finally {
    if (process.env.OPENAI_CHAT_MODEL_SAVED) {
      process.env.OPENAI_CHAT_MODEL = process.env.OPENAI_CHAT_MODEL_SAVED;
    } else {
      delete process.env.OPENAI_CHAT_MODEL;
    }

    delete process.env.OPENAI_CHAT_MODEL_SAVED;
  }

  process.env.RAG_QA_ANSWER_VERDICT_SAVED = process.env.RAG_QA_ANSWER_VERDICT ?? "";
  process.env.RAG_QA_ANSWER_VERDICT = "true";
  try {
    assert.equal((await lookup()).hit, false, "answer prompt / config");
  } finally {
    if (process.env.RAG_QA_ANSWER_VERDICT_SAVED) {
      process.env.RAG_QA_ANSWER_VERDICT = process.env.RAG_QA_ANSWER_VERDICT_SAVED;
    } else {
      delete process.env.RAG_QA_ANSWER_VERDICT;
    }

    delete process.env.RAG_QA_ANSWER_VERDICT_SAVED;
  }

  assert.equal((await lookup()).hit, true, "the original key still hits");
});

test("a lookup without an access scope, for a follow-up plan or an unknown document bypasses", async () => {
  process.env.RAG_SEMANTIC_CACHE = "on";

  assert.equal((await lookup({ accessScope: null })).bypass, "no_access_scope");
  assert.equal((await lookup({ agentRetrievalPlan: { phase: "follow_up", retrievalQueries: [] } })).bypass, "follow_up_plan");
  assert.equal((await lookup({ selectedDocuments: [] })).bypass, "unknown_document_version");
  assert.deepEqual(storeSemanticCacheAnswer(await lookup({ accessScope: null }), answer()), {});
  assert.equal(getSemanticCacheStats().entries, 0);
});

test("the plan shape keeps the planner's templates and drops the question", () => {
  const plan = (question) => ({
    phase: "primary",
    intent: "fact",
    source: "agent-query-planner",
    retrievalOptions: { profile: "narrow", topK: 4 },
    retrievalQueries: [
      { id: "primary", query: question, primary: true },
      { id: "fact-citation", query: `Find exact cited evidence for: ${question}`, primary: false },
    ],
  });

  assert.equal(
    describeRetrievalPlanShape(plan("What is the meal limit?"), "What is the meal limit?"),
    describeRetrievalPlanShape(plan("what is the meal limit"), "what is the meal limit")
  );
  assert.equal(describeRetrievalPlanShape(null, "q"), "none");
  assert.equal(describeRetrievalPlanShape({ phase: "retry" }, "q"), null);
});

test("below the threshold, or rejected by the guard, is a miss", async () => {
  process.env.RAG_SEMANTIC_CACHE = "on";
  await prime();

  const far = await lookup({ queryVector: unitVector(0.5) });

  assert.equal(far.hit, false);
  assert.equal(far.trace.candidateCount, 0);

  const negated = await lookup({ resolvedQuery: "What is not the meal limit per day?" });

  assert.equal(negated.hit, false);
  assert.deepEqual(negated.trace.guardRejections, ["negation"]);
  assert.equal(getSemanticCacheStats().guardRejections.negation, 1);
});

test("abstentions are not stored", async () => {
  process.env.RAG_SEMANTIC_CACHE = "on";

  const first = await lookup();

  assert.deepEqual(storeSemanticCacheAnswer(first, { text: "No evidence.", abstained: true }), {
    stored: false,
    storeSkipReason: "abstained",
  });
  assert.equal((await lookup()).hit, false);
});

test("a new document version, an invalidation or an index switch drops entries", async () => {
  process.env.RAG_SEMANTIC_CACHE = "on";
  await prime();

  const replaced = await lookup({ selectedDocuments: [document("doc-a", { version: 2, contentSha256: "sha-new" })] });

  assert.equal(replaced.hit, false);
  assert.equal(getSemanticCacheStats().entries, 0, "the old version's entry is purged, not just unreachable");

  await prime();
  assert.equal(invalidateSemanticCacheDocuments(["doc-a"]), 1);
  assert.equal((await lookup()).hit, false);

  await prime();
  process.env.VECTOR_STORE_PROVIDER = "qdrant";
  assert.equal((await lookup()).hit, false);
  assert.equal(getSemanticCacheStats().entries, 0);

  process.env.VECTOR_STORE_PROVIDER = "local";
  await prime();
  assert.equal(clearSemanticCache(), 1);
});

test("an answer whose document changed while it was being written is not stored", async () => {
  process.env.RAG_SEMANTIC_CACHE = "on";

  const pending = await lookup();

  invalidateSemanticCacheDocuments(["doc-a"]);
  assert.deepEqual(storeSemanticCacheAnswer(pending, answer()), {
    stored: false,
    storeSkipReason: "document_version_changed",
  });
  assert.equal(getSemanticCacheStats().entries, 0);
});

test("the LRU bound evicts the least recently used entry and the TTL expires entries", async () => {
  process.env.RAG_SEMANTIC_CACHE = "on";
  process.env.RAG_SEMANTIC_CACHE_MAX_ENTRIES = "2";

  await prime({ resolvedQuery: "What is the meal limit?", queryVector: unitVector(0) });
  await prime({ resolvedQuery: "What is the hotel limit?", queryVector: unitVector(1) });
  // Touch the first so the second is the least recently used.
  assert.equal((await lookup({ resolvedQuery: "What is the meal limit?", queryVector: unitVector(0) })).hit, true);
  await prime({ resolvedQuery: "What is the taxi limit?", queryVector: unitVector(2) });

  assert.equal(getSemanticCacheStats().entries, 2);
  assert.equal(getSemanticCacheStats().evictions, 1);
  assert.equal((await lookup({ resolvedQuery: "What is the hotel limit?", queryVector: unitVector(1) })).hit, false);
  assert.equal((await lookup({ resolvedQuery: "What is the meal limit?", queryVector: unitVector(0) })).hit, true);

  resetSemanticCache();
  process.env.RAG_SEMANTIC_CACHE_TTL_MS = "1";
  await prime();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await lookup()).hit, false);
  assert.equal(getSemanticCacheStats().expirations, 1);
});

test("a rewritten question also needs the raw question to match", async () => {
  process.env.RAG_SEMANTIC_CACHE = "on";

  const standalone = "How many annual leave days do contractors receive?";

  await prime({ query: standalone, resolvedQuery: standalone });

  // A session rewrite resolved a follow-up to the stored question, but the
  // answer prompt answers what the user typed.
  const rewritten = await lookup({
    query: "Answer in Chinese, just the number: and for contractors?",
    resolvedQuery: standalone,
  });

  assert.equal(rewritten.hit, false);
  assert.equal(rewritten.trace.candidateCount, 1);
  assert.match(rewritten.trace.guardRejections[0], /^raw_/);
  assert.equal(storeSemanticCacheAnswer(rewritten, answer("12 天。[Source 1]")).stored, true);

  // The stored rewrite serves neither the plain question nor another rewrite.
  assert.equal((await lookup({ query: standalone, resolvedQuery: standalone })).response.text, answer().text);
  assert.equal(
    (await lookup({ query: "and for contractors?", resolvedQuery: standalone })).response?.text ?? null,
    null
  );
  assert.equal(
    (await lookup({ query: "Answer in Chinese, just the number: and for contractors?", resolvedQuery: standalone })).response
      .text,
    "12 天。[Source 1]"
  );
});

const fakeAdapter = (fingerprint) => ({
  dimensions: 3,
  fingerprint,
  matrix: Float32Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]),
});

test("a query adapter retrained in place moves lookups to a new key and purges the old entries", async () => {
  process.env.RAG_SEMANTIC_CACHE = "on";
  await prime({ queryVector: applyQueryAdapter(fakeAdapter("adapter-a"), unitVector(0)) });

  assert.equal((await lookup({ queryVector: applyQueryAdapter(fakeAdapter("adapter-a"), unitVector(0)) })).hit, true);

  // Same file path, new weights: same direction here, but another space.
  const retrained = await lookup({ queryVector: applyQueryAdapter(fakeAdapter("adapter-b"), unitVector(0)) });

  assert.equal(retrained.hit, false);
  assert.equal(getSemanticCacheStats().entries, 0);
  assert.equal((await lookup()).hit, false, "an unadapted vector is another key too");
});

test("expired entries are swept on every store and lookup, not only in their own bucket", async () => {
  process.env.RAG_SEMANTIC_CACHE = "on";

  const pending = await lookup();

  process.env.RAG_SEMANTIC_CACHE_TTL_MS = "1";
  await prime({ docIds: ["doc-b"], selectedDocuments: [document("doc-b")] });
  await new Promise((resolve) => setTimeout(resolve, 5));
  process.env.RAG_SEMANTIC_CACHE_TTL_MS = "0";

  assert.equal(storeSemanticCacheAnswer(pending, answer()).stored, true);
  assert.equal(getSemanticCacheStats().expirations, 1, "the doc-b entry left on a store for doc-a");
  assert.equal(getSemanticCacheStats().entries, 1);

  process.env.RAG_SEMANTIC_CACHE_TTL_MS = "1";
  await prime({ docIds: ["doc-b"], selectedDocuments: [document("doc-b")], queryVector: unitVector(2) });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await lookup({ queryVector: unitVector(1) });
  assert.equal(getSemanticCacheStats().expirations, 2, "and on a lookup for doc-a");
});

test("chunk text is kept only for callers that ask for it", async () => {
  process.env.RAG_SEMANTIC_CACHE = "on";

  const withContexts = { ...answer(), retrievedContexts: [{ docId: "doc-a", text: "chunk text" }] };

  await prime({}, withContexts);

  const plain = await lookup();

  assert.equal(plain.hit, true);
  assert.equal(plain.response.retrievedContexts, undefined);

  const wantsContexts = await lookup({ includeRetrievedContexts: true });

  assert.equal(wantsContexts.hit, false, "an entry without chunk text cannot serve a caller that reads it");
  assert.equal(wantsContexts.trace.entriesWithoutContexts, 1);
  assert.equal(storeSemanticCacheAnswer(wantsContexts, withContexts).stored, true);

  const again = await lookup({ includeRetrievedContexts: true });

  assert.equal(again.hit, true);
  assert.deepEqual(again.response.retrievedContexts, withContexts.retrievedContexts);
  assert.equal((await lookup()).hit, true, "a caller that does not read chunk text may use it");
});

test("the byte budget evicts the least recently used entries and refuses an answer larger than itself", async () => {
  process.env.RAG_SEMANTIC_CACHE = "on";

  const big = answer("x".repeat(600));
  const size = Buffer.byteLength(JSON.stringify(big));

  process.env.RAG_SEMANTIC_CACHE_MAX_BYTES = String(size * 2 + 10);
  await prime({ resolvedQuery: "What is the meal limit?", queryVector: unitVector(0) }, big);
  await prime({ resolvedQuery: "What is the hotel limit?", queryVector: unitVector(1) }, big);
  await prime({ resolvedQuery: "What is the taxi limit?", queryVector: unitVector(2) }, big);

  const stats = getSemanticCacheStats();

  assert.equal(stats.entries, 2);
  assert.equal(stats.bytes, size * 2);
  assert.equal(stats.evictions, 1);
  assert.equal((await lookup({ resolvedQuery: "What is the meal limit?", queryVector: unitVector(0) })).hit, false);

  process.env.RAG_SEMANTIC_CACHE_MAX_BYTES = "10";

  const pending = await lookup({ resolvedQuery: "What is the parking limit?", queryVector: unitVector(3) });

  assert.deepEqual(storeSemanticCacheAnswer(pending, big), { stored: false, storeSkipReason: "too_large" });
});

// ---------------------------------------------------------------------------
// Wiring: chat() -> executeDocumentRag
// ---------------------------------------------------------------------------

const EMBEDDING_DIMENSIONS = 64;

const toEmbedding = (text) => {
  const vector = new Array(EMBEDDING_DIMENSIONS).fill(0);

  for (const term of buildTermSet(text)) {
    let hash = 0;

    for (const character of term) {
      hash = (hash * 31 + character.codePointAt(0)) % EMBEDDING_DIMENSIONS;
    }

    vector[hash] += 1;
  }

  return vector;
};

const setUpArchive = async () => {
  const calls = { completeText: 0 };

  tempRoot = await mkdtemp(path.join(os.tmpdir(), "semantic-cache-test-"));
  configureRagDataDirectory(path.join(tempRoot, "rag-data"));
  process.env.RAG_OBSERVABILITY_ENABLED = "true";
  process.env.RAG_OBSERVABILITY_EVENTS_PATH = path.join(tempRoot, "events.jsonl");
  await resetDocumentRegistryStore();
  await resetDocumentRegistry();
  resetVectorStore();
  resetEmbeddingCache();

  const store = createFileDocumentRegistryStore();

  configureDocumentRegistryStore(store);
  configureOpenAIProvider({
    embedTexts: async (texts) => texts.map((text) => toEmbedding(text)),
    embedQuery: async (query) => toEmbedding(query),
    completeText: async () => {
      calls.completeText += 1;
      return "Employees receive 10 paid annual leave days each year. [Source 1]";
    },
  });

  const filePath = path.join(tempRoot, "benefits-2024.pdf");

  await writeFile(filePath, "fixture", "utf8");

  const ingest = (docId) =>
    ingestDocumentPages({
      docId,
      fileName: `${docId}.pdf`,
      filePath,
      workspaceId: "ws",
      pages: [
        { pageNumber: 1, text: "Annual leave policy: employees receive 10 paid annual leave days each year." },
        { pageNumber: 2, text: "Remote work policy: employees may work remotely 2 days per week with manager approval." },
      ],
    });

  await ingest("benefits-2024");
  return { calls, ingest, store };
};

const tearDownArchive = async () => {
  await clearDocuments({ deleteFiles: false });
  resetOpenAIProvider();
  resetEmbeddingCache();
  resetVectorStore();
  await resetDocumentRegistryStore();
  configureRagDataDirectory(originalDataDirectory);

  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
};

const readTraceEvents = async () =>
  (await readFile(process.env.RAG_OBSERVABILITY_EVENTS_PATH, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((event) => event.routeMode);

test("chat() serves a repeat from the cache and marks it; contrasts, other tenants and replaced documents miss", async () => {
  const { calls, ingest } = await setUpArchive();
  const alice = { accessScope: { userId: "alice", workspaceId: "ws" } };

  try {
    process.env.RAG_SEMANTIC_CACHE = "on";

    const first = await chat(["benefits-2024"], "What is the annual leave policy?", alice);

    assert.equal(first.abstained, false);
    assert.equal(first.semanticCache, undefined);
    assert.equal(calls.completeText, 1);

    const repeat = await chat(["benefits-2024"], "what is the annual leave policy", alice);

    assert.equal(calls.completeText, 1, "the hit skipped the answer model");
    assert.equal(first.retrieval.servedFromCache, undefined);
    assert.equal(first.retrieval.routes.dense.executed, true);
    assert.equal(repeat.retrieval.servedFromCache, true, "the hit says it ran no retrieval");
    assert.equal(repeat.retrieval.routes.dense.executed, false);
    assert.equal(repeat.retrieval.routes.dense.candidateCount, 0);
    assert.equal(repeat.text, first.text);
    assert.deepEqual(repeat.citations, first.citations);
    assert.equal(repeat.semanticCache.hit, true);
    assert.equal(repeat.resolvedQuery, "what is the annual leave policy");

    // Same bag of words for the stub embedder (similarity 1), different meaning.
    await chat(["benefits-2024"], "What is not the annual leave policy?", alice);
    assert.equal(calls.completeText, 2, "the negation guard refused the hit");

    await chat(["benefits-2024"], "What is the annual leave policy?", {
      accessScope: { userId: "bob", workspaceId: "ws" },
    });
    assert.equal(calls.completeText, 3, "another tenant never shares an entry");

    const events = await readTraceEvents();
    const hitEvent = events.find((event) => event.semanticCache?.hit === true);
    const storeEvent = events.find((event) => event.semanticCache?.stored === true);

    assert.ok(hitEvent, "the hit is marked in the RAG trace");
    assert.equal(hitEvent.semanticCache.similarity, 1);
    assert.ok(storeEvent);

    assert.equal(await deleteDocument("benefits-2024", { deleteFile: false }) !== null, true);
    assert.equal(getSemanticCacheStats().entries, 0, "deleting the document purged its entries");

    await ingest("benefits-2024");
    await chat(["benefits-2024"], "What is the annual leave policy?", alice);
    assert.equal(calls.completeText, 4, "the re-ingested document is answered afresh");

    process.env.RAG_SEMANTIC_CACHE = "off";
    const uncached = await chat(["benefits-2024"], "What is the annual leave policy?", alice);

    assert.equal(calls.completeText, 5);
    assert.equal(uncached.semanticCache, undefined);
  } finally {
    await tearDownArchive();
  }
});

test("a document another instance deleted leaves the cache on the next registry read", async () => {
  const { store } = await setUpArchive();
  const alice = { accessScope: { userId: "alice", workspaceId: "ws" } };

  try {
    process.env.RAG_SEMANTIC_CACHE = "on";
    await chat(["benefits-2024"], "What is the annual leave policy?", alice);
    assert.equal(getSemanticCacheStats().entries, 1);

    // Another process's delete: the shared store changes, this process's
    // registry map and cache do not, until the registry reads the store.
    await store.delete("benefits-2024");
    assert.equal(getSemanticCacheStats().entries, 1);
    await refreshDocumentRegistry({});
    assert.equal(getSemanticCacheStats().entries, 0);
  } finally {
    await tearDownArchive();
  }
});

// ---------------------------------------------------------------------------
// Evaluation evidence
// ---------------------------------------------------------------------------

test("evaluation evidence records the semantic cache and the gates refuse a run with it on", async () => {
  const commitSha = "a".repeat(40);
  const report = { summary: { config: {}, status: "pass" } };
  const spec = {
    id: "cache-probe",
    reportType: "synthetic",
    providerId: "deterministic",
    providerMode: "mock",
    modelRouteId: null,
  };
  const build = () =>
    buildEvaluationEvidence({
      command: "npm run eval:synthetic",
      corpus: { id: "probe", version: "1" },
      gitState: { commitSha, dirty: false },
      provider: { id: "deterministic", mode: "mock" },
      publicConfig: getPublicEvaluationConfig({ report, reportType: "synthetic" }),
      reportId: "cache-probe",
      reportType: "synthetic",
      runId: "run-1",
    });
  const reasonFor = (evidence) =>
    getEvaluationEvidenceFailureReason({
      maxAgeHours: 1,
      nowMs: Date.now() + 1000,
      report: { ...report, evidence },
      spec,
      targetCommit: commitSha,
    });

  const off = await build();

  assert.deepEqual(off.semanticCache, { enabled: false, threshold: DEFAULT_SEMANTIC_CACHE_THRESHOLD });
  assert.equal(reasonFor(off), EVALUATION_EVIDENCE_REASON_CODES.ok);

  process.env.RAG_SEMANTIC_CACHE = "on";

  const on = await build();

  assert.equal(on.semanticCache.enabled, true);
  assert.equal(on.configHash, off.configHash, "the cache is not part of the public config");
  assert.equal(reasonFor(on), "semantic_cache_enabled");
});

// ---------------------------------------------------------------------------
// Evaluation case set and summaries
// ---------------------------------------------------------------------------

test("the held-out pairs are well formed and the guard refuses every held-out contrast", () => {
  const ids = new Set();

  for (const heldOut of SEMANTIC_CACHE_HELD_OUT_PAIRS) {
    assert.ok(SEMANTIC_CACHE_HELD_OUT_SPLITS.includes(heldOut.split), heldOut.id);
    assert.ok(!ids.has(heldOut.id), heldOut.id);
    ids.add(heldOut.id);

    if (heldOut.kind === "contrast") {
      assert.ok(SEMANTIC_CACHE_HELD_OUT_CATEGORIES.includes(heldOut.category), heldOut.id);
      assert.equal(compareCacheQuestions(heldOut.question, heldOut.base).ok, false, heldOut.question);
    } else {
      assert.equal(heldOut.kind, "paraphrase", heldOut.id);
    }
  }

  const confirmContrasts = SEMANTIC_CACHE_HELD_OUT_PAIRS.filter(
    (heldOut) => heldOut.split === "confirm" && heldOut.kind === "contrast"
  );

  for (const category of SEMANTIC_CACHE_HELD_OUT_CATEGORIES) {
    assert.ok(confirmContrasts.some((heldOut) => heldOut.category === category), category);
  }
});

test("the held-out summary bounds the false-hit rate per split", () => {
  assert.ok(Math.abs(binomialUpperBound(0, 31) - (1 - 0.05 ** (1 / 31))) < 1e-9);
  assert.ok(binomialUpperBound(1, 20) > binomialUpperBound(0, 20));
  assert.equal(binomialUpperBound(0, 0), null);

  const guard = (full) => ({ full, required: true, none: true });
  const summary = summarizeHeldOutDecisions(
    [
      { id: "t1", split: "tune", kind: "contrast", category: "modal", similarity: 0.98, guard: guard(false) },
      { id: "c1", split: "confirm", kind: "contrast", category: "modal", similarity: 0.99, guard: guard(true) },
      { id: "c2", split: "confirm", kind: "contrast", category: "tense", similarity: 0.9, guard: guard(true) },
      { id: "c3", split: "confirm", kind: "paraphrase", category: null, similarity: 0.99, guard: guard(true) },
    ],
    { threshold: 0.97 }
  );

  assert.equal(summary.splits.tune.contrastFalseHits, 0);
  assert.equal(summary.splits.tune.contrastAboveThreshold, 1);
  assert.equal(summary.splits.confirm.contrastFalseHits, 1);
  assert.deepEqual(summary.splits.confirm.falseHitIds, ["c1"]);
  assert.equal(summary.splits.confirm.byCategory.tense.falseHits, 0);
  assert.equal(summary.splits.confirm.paraphraseHits, 1);
  assert.ok(summary.splits.confirm.falseHitUpperBound95 > 0.5);
});


test("the evaluation case set is well formed and the guard refuses every lexical contrast", () => {
  const followUps = expandSemanticCacheFollowUps();

  assert.ok(SEMANTIC_CACHE_CASES.length >= 10);

  for (const entry of SEMANTIC_CACHE_CASES) {
    assert.ok(SEMANTIC_CACHE_TENANTS[entry.tenant], entry.id);
  }

  for (const followUp of followUps) {
    assert.ok(SEMANTIC_CACHE_FOLLOW_UP_KINDS.includes(followUp.kind), followUp.id);
    assert.ok(SEMANTIC_CACHE_TENANTS[followUp.tenant], followUp.id);

    if (followUp.kind === "contrast") {
      assert.ok(SEMANTIC_CACHE_CONTRAST_CATEGORIES.includes(followUp.category), followUp.id);

      // Document and tenant contrasts are the same words: the key separates them.
      if (!["document", "tenant"].includes(followUp.category)) {
        assert.equal(compareCacheQuestions(followUp.question, followUp.baseQuestion).ok, false, followUp.id);
      }
    }

    if (followUp.kind === "repeat") {
      assert.equal(compareCacheQuestions(followUp.question, followUp.baseQuestion).ok, true, followUp.id);
    }
  }
});

test("the evaluation summary counts hits by kind and flags any contrast hit", () => {
  const runs = [
    { kind: "repeat", category: null, hit: true, baseCached: true, latencyMs: 5, uncachedLatencyMs: 900 },
    { kind: "paraphrase", category: null, hit: false, baseCached: true, latencyMs: 800 },
    { kind: "contrast", category: "negation", hit: false, baseCached: true, latencyMs: 700 },
    { kind: "contrast", category: "number", hit: false, baseCached: false, latencyMs: 700 },
    { kind: "paraphrase", category: null, hit: true, baseCached: true, latencyMs: 4, uncachedLatencyMs: 12, uncachedAbstained: true },
  ];
  const summary = summarizeSemanticCacheRuns(runs, { seed: 1, resamples: 200 });

  assert.equal(summary.repeat.hits, 1);
  assert.equal(summary.paraphrase.hitRate, 0.5);
  assert.equal(summary.hitsWhereUncachedAbstained, 1);
  assert.equal(summary.contrast.falseHits, 0);
  assert.equal(summary.contrast.meaningful, 1);
  assert.ok(Math.abs(summary.contrast.falseHitUpperBound95 - 0.95) < 1e-9);
  assert.equal(summary.latency.pairs, 1);
  assert.equal(summary.latency.meanSavedMs, 895);

  const sweep = sweepSemanticCacheDecisions(
    [
      { kind: "paraphrase", category: null, similarity: 0.98, guard: { full: true, required: true, none: true } },
      { kind: "contrast", category: "negation", similarity: 0.99, guard: { full: false, required: false, none: true } },
    ],
    { thresholds: [0.97] }
  );
  const none = sweep.find((row) => row.mode === "none");
  const full = sweep.find((row) => row.mode === "full");

  assert.equal(none.contrastFalseHits, 1);
  assert.equal(full.contrastFalseHits, 0);
  assert.equal(full.paraphraseHitRate, 1);
});

test("the evaluation runner imports without running and renders its report", async () => {
  const exitCodeBefore = process.exitCode;
  const { renderMarkdown } = await import("../evaluation/run-semantic-cache-eval.mjs");

  assert.equal(process.exitCode, exitCodeBefore);

  const guard = (full) => ({ full, required: true, none: true });
  const decisions = [
    { id: "p1", kind: "paraphrase", category: null, question: "Q | a", baseQuestion: "B", similarity: 0.98, guard: guard(true), guardReason: null },
    { id: "n1", kind: "contrast", category: "negation", question: "Q not", baseQuestion: "B", similarity: 0.99, guard: guard(false), guardReason: "negation" },
  ];
  const heldOutDecisions = decisions.map((decision) => ({ ...decision, split: "confirm" }));
  const sweep = sweepSemanticCacheDecisions(decisions, { thresholds: [0.97] });
  const runs = [
    { id: "p1", kind: "paraphrase", category: null, question: "Q | a", hit: true, similarity: 0.98, baseCached: true, latencyMs: 4, uncachedLatencyMs: 900 },
    { id: "n1", kind: "contrast", category: "negation", question: "Q not", hit: false, similarity: null, baseCached: true, latencyMs: 700 },
  ];
  const report = {
    generatedAt: "2026-09-27T00:00:00.000Z",
    caseSetVersion: "test",
    guardVersion: "test",
    endpoint: { baseUrl: null, chatModel: "chat", embeddingModel: "embed" },
    threshold: 0.97,
    lookupMicroseconds: 1.5,
    offline: { chosen: sweep.find((row) => row.mode === "full"), sweep, decisions },
    heldOut: {
      summary: summarizeHeldOutDecisions(heldOutDecisions, { threshold: 0.97 }),
      sweep: { confirm: sweep },
      lookupCrossCheck: { pairs: 2, hits: 1, disagreements: [] },
      decisions: heldOutDecisions,
    },
    live: {
      summary: summarizeSemanticCacheRuns(runs, { seed: 1, resamples: 50 }),
      bases: [{ caseId: "c1", cached: true, latencyMs: 1200 }],
      runs,
    },
  };
  const markdown = renderMarkdown(report);

  assert.match(markdown, /^# Semantic answer cache evaluation/);
  assert.match(markdown, /## Held-out pairs/);
  assert.match(markdown, /## Live, through chat\(\)/);
  assert.match(markdown, /Q \\\| a/);
  assert.match(markdown, /reject \(negation\)/);
  assert.doesNotMatch(renderMarkdown({ ...report, live: null }), /## Live/);
});
