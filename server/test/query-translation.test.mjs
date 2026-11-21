import test, { after, afterEach, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import chat, { clearDocuments, ingestDocumentPages } from "../chat.js";
import { buildAgentRetrievalQueries } from "../rag/agent-retrieval-queries.js";
import {
  configureDocumentRegistryStore,
  resetDocumentRegistry,
  resetDocumentRegistryStore,
} from "../rag/doc-registry.js";
import { createFileDocumentRegistryStore } from "../rag/doc-registry-file.js";
import { resetEmbeddingCache } from "../rag/embedding-cache.js";
import { configureOpenAIProvider, resetOpenAIProvider } from "../rag/openai.js";
import { detectScript } from "../rag/query-translation.js";
import { configureRagDataDirectory, getRagDataDirectory } from "../rag/storage.js";
import { buildTermSet } from "../rag/text-utils.js";
import { resetVectorStore } from "../rag/vector-store.js";

// Cross-language retrieval (rag/query-translation.js, chat() in rag/index.js):
// a question over documents written in another script is also searched in
// their language. The chat model is a stub that rewrites by the script of the
// example text it is given and answers in Chinese.

const PINNED_ENVIRONMENT = {
  RAG_HYBRID_ENABLED: "false",
  RAG_OBSERVABILITY_ENABLED: "true",
  VECTOR_STORE_PROVIDER: "local",
};
const savedEnvironment = {};
const originalDataDirectory = getRagDataDirectory();
let tempRoot = null;

const DOCUMENTS = {
  en: "Annual leave policy: employees receive ten paid annual leave days each year. Leave requests need manager approval two weeks ahead.",
  ko: "휴가 정책: 직원은 매년 열흘의 유급 휴가를 받습니다. 휴가 신청은 2주 전에 관리자의 승인을 받아야 합니다.",
  ru: "Политика отпусков: сотрудники получают десять оплачиваемых дней отпуска в год. Заявления на отпуск согласует руководитель.",
  zh: "年假政策：员工每年享有十天带薪年假。请假需提前两周获得经理批准。",
};
const ZH_QUESTION = "员工每年有多少天带薪年假？";
const REWRITES = {
  hangul: "직원은 매년 며칠의 유급 휴가를 받나요?",
  latin: "How many paid annual leave days do employees get each year?",
};
const ANSWER = "员工每年有十天带薪年假。[Source 1]";

// A hashed bag of words: the dense route finds nothing across scripts here,
// as with the local nomic-embed-text.
const embed = (text) => {
  const vector = new Array(64).fill(0);

  for (const term of buildTermSet(text)) {
    let hash = 0;

    for (const character of term) {
      hash = (hash * 31 + character.codePointAt(0)) % 64;
    }

    vector[hash] += 1;
  }

  return vector;
};

const translationPrompts = [];
const answerPrompts = [];
const readExample = (prompt) => prompt.split("Example text:\n")[1].split("\n\nQuestion:")[0];

const useModel = ({ rewrite = (script) => REWRITES[script] } = {}) =>
  configureOpenAIProvider({
    completeText: async (prompt) => {
      if (prompt.includes("Rewritten question:")) {
        translationPrompts.push(prompt);
        return rewrite(detectScript(readExample(prompt)));
      }

      answerPrompts.push(prompt);
      return ANSWER;
    },
    embedQuery: async (text) => embed(text),
    embedTexts: async (texts) => texts.map(embed),
  });

const ingest = async (...languages) => {
  const filePath = path.join(tempRoot, "fixture.pdf");

  await writeFile(filePath, "fixture", "utf8");

  for (const language of languages) {
    await ingestDocumentPages({
      docId: `leave-policy-${language}`,
      fileName: `leave-policy-${language}.pdf`,
      filePath,
      pages: [{ pageNumber: 1, text: DOCUMENTS[language] }],
    });
  }

  return languages.map((language) => `leave-policy-${language}`);
};

const readRagTraces = async () =>
  (await readFile(process.env.RAG_OBSERVABILITY_EVENTS_PATH, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((event) => event.routeMode);

before(() => {
  for (const key of [...Object.keys(PINNED_ENVIRONMENT), "RAG_OBSERVABILITY_EVENTS_PATH"]) {
    savedEnvironment[key] = process.env[key];
  }

  Object.assign(process.env, PINNED_ENVIRONMENT);
});

beforeEach(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "query-translation-test-"));
  process.env.RAG_OBSERVABILITY_EVENTS_PATH = path.join(tempRoot, "events.jsonl");
  configureRagDataDirectory(path.join(tempRoot, "rag-data"));
  await resetDocumentRegistryStore();
  configureDocumentRegistryStore(createFileDocumentRegistryStore());
  await resetDocumentRegistry();
  resetVectorStore();
  resetEmbeddingCache();
  translationPrompts.length = 0;
  answerPrompts.length = 0;
  useModel();
});

afterEach(async () => {
  await clearDocuments({ deleteFiles: false });
  resetVectorStore();
  await resetDocumentRegistryStore();
  resetOpenAIProvider();
  resetEmbeddingCache();
  configureRagDataDirectory(originalDataDirectory);
  await rm(tempRoot, { force: true, recursive: true });
});

after(() => {
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

test("the script of a text is the script most of its words are in", () => {
  assert.equal(detectScript(ZH_QUESTION), "han");
  assert.equal(detectScript("他们在哪些数据集上评估了BERT？"), "han");
  // A Han letter is a word: eight of them outnumber three Latin words.
  assert.equal(detectScript("BERT模型在SQuAD上的F1是多少？"), "han");
  assert.equal(detectScript("他们用的baseline是什么？"), "han");
  assert.equal(detectScript("What does 带薪年假 mean in this policy?"), "latin");
  assert.equal(detectScript("What does カタカナ mean?"), "latin");
  // Kanji count as Japanese next to kana, hanja as Korean next to Hangul...
  assert.equal(detectScript("東京都庁の所在地は新宿区です"), "kana");
  assert.equal(detectScript("大韓民國의 首都는 서울이다"), "hangul");
  // ...but not next to one quoted Japanese or Korean word.
  assert.equal(detectScript("鲜の每日C的维生素含量是多少？"), "han");
  assert.equal(detectScript("韩国首都首尔（서울）是韩国最大的城市，人口约一千万。"), "han");
  assert.equal(detectScript("Срок уведомления — 30 дней"), "cyrillic");
  assert.equal(detectScript("2024？"), null);
  assert.equal(detectScript(""), null);
});

test("a Chinese question over an English document also searches its English rewrite and answers", async () => {
  const docIds = await ingest("en");
  const response = await chat(docIds, ZH_QUESTION);
  const [trace] = await readRagTraces();

  assert.equal(translationPrompts.length, 1);
  assert.ok(translationPrompts[0].includes(`Example text:\n${DOCUMENTS.en}`));
  assert.ok(translationPrompts[0].includes(`Question:\n${ZH_QUESTION}`));
  assert.deepEqual(trace.queryTranslations, [{ query: REWRITES.latin, script: "latin" }]);
  assert.deepEqual(trace.retrievalQueries.at(-1), {
    id: "translation-latin",
    label: "Question in latin script",
    primary: false,
    query: REWRITES.latin,
  });

  // The gate admitted the English chunk through the rewrite's term coverage.
  const [admitted] = trace.confidence.usableResults;

  assert.equal(response.abstained, false);
  assert.equal(admitted.docId, "leave-policy-en");
  assert.ok(admitted.keywordScore >= 0.51);
  assert.ok(admitted.provenance.queries.some((query) => query.queryId === "translation-latin"));
  assert.equal(response.text, ANSWER);
  assert.equal(response.citations[0].docId, "leave-policy-en");

  // The answer is written for the user's question.
  assert.equal(response.resolvedQuery, ZH_QUESTION);
  assert.equal(answerPrompts.length, 1);
  assert.ok(answerPrompts[0].includes(`User Question:\n${ZH_QUESTION}`));
  assert.ok(!answerPrompts[0].includes(REWRITES.latin));
});

test("an agent's primary plan searches the rewrite after its own queries; its follow-up asks for none", async () => {
  const docIds = await ingest("en");
  const plan = (phase) => ({
    intent: "fact",
    phase,
    retrievalOptions: { profile: "narrow", topK: 4, topKPerDoc: 2 },
    retrievalQueries: buildAgentRetrievalQueries({ intent: "fact", phase, question: ZH_QUESTION }),
  });

  const primary = await chat(docIds, ZH_QUESTION, { memoryWrites: false, retrievalPlan: plan("primary") });

  assert.equal(primary.abstained, false);
  assert.equal(translationPrompts.length, 1);

  await chat(docIds, ZH_QUESTION, { memoryWrites: false, retrievalPlan: plan("follow_up") });

  const [primaryTrace, followUpTrace] = await readRagTraces();

  assert.deepEqual(
    primaryTrace.agentRetrievalPlan.retrievalQueries.map((query) => query.id),
    ["primary", "fact-citation"]
  );
  assert.deepEqual(
    primaryTrace.retrievalQueries.map((query) => query.id),
    ["primary", "fact-citation", "translation-latin"]
  );
  assert.equal(translationPrompts.length, 1, "the follow-up made no call");
  assert.equal(followUpTrace.queryTranslations, undefined);
  assert.ok(followUpTrace.retrievalQueries.every((query) => !query.id.startsWith("translation-")));
});

test("an English question over English documents makes no call and keeps its trace", async () => {
  const docIds = await ingest("en");
  const response = await chat(docIds, "How many paid annual leave days do employees get?");
  const [trace] = await readRagTraces();

  assert.equal(response.abstained, false);
  assert.equal(translationPrompts.length, 0);
  assert.equal(Object.hasOwn(trace, "queryTranslations"), false);
  assert.deepEqual(
    trace.retrievalQueries.map((query) => query.id),
    ["primary"]
  );
});

test("a Chinese question over Chinese and English documents is rewritten into English only", async () => {
  const docIds = await ingest("zh", "en");

  await chat(docIds, ZH_QUESTION);
  const [trace] = await readRagTraces();

  assert.equal(translationPrompts.length, 1);
  assert.ok(translationPrompts[0].includes(`Example text:\n${DOCUMENTS.en}`));
  assert.deepEqual(trace.queryTranslations, [{ query: REWRITES.latin, script: "latin" }]);
});

test("a Russian question over English, Russian and Korean documents is rewritten twice, in document order", async () => {
  const docIds = await ingest("en", "ru", "ko");

  await chat(docIds, "Сколько дней оплачиваемого отпуска получают сотрудники?");
  const [trace] = await readRagTraces();

  assert.deepEqual(
    translationPrompts.map((prompt) => readExample(prompt)).sort(),
    [DOCUMENTS.en, DOCUMENTS.ko].sort()
  );
  assert.deepEqual(trace.queryTranslations, [
    { query: REWRITES.latin, script: "latin" },
    { query: REWRITES.hangul, script: "hangul" },
  ]);
  assert.deepEqual(
    trace.retrievalQueries.slice(-2).map((query) => query.id),
    ["translation-latin", "translation-hangul"]
  );
});

test("a failed or unusable rewrite leaves the question searched alone, without an error", async () => {
  const docIds = await ingest("en");

  for (const rewrite of [
    () => {
      throw new Error("model unavailable");
    },
    () => ZH_QUESTION,
    () => "",
  ]) {
    useModel({ rewrite });
    await writeFile(process.env.RAG_OBSERVABILITY_EVENTS_PATH, "", "utf8");

    const response = await chat(docIds, ZH_QUESTION);
    const [trace] = await readRagTraces();

    assert.equal(response.abstained, true);
    assert.deepEqual(trace.queryTranslations, [{ query: null, script: "latin" }]);
    assert.ok(trace.retrievalQueries.every((query) => !query.id.startsWith("translation-")));
  }

  assert.equal(translationPrompts.length, 3);
});

test("a rewrite that keeps more Latin names than words of its own script is searched", async () => {
  const docIds = await ingest("ko");
  const rewrite = "HR, IT, QA, R&D 팀의 휴가는?";

  useModel({ rewrite: () => rewrite });
  await chat(docIds, "How many leave days do the HR, IT, QA and R&D teams get?");
  const [trace] = await readRagTraces();

  assert.deepEqual(trace.queryTranslations, [{ query: rewrite, script: "hangul" }]);
  assert.equal(trace.retrievalQueries.at(-1).id, "translation-hangul");
});

test("a rewrite longer than the session rewrite's 500 characters is still searched", async () => {
  const docIds = await ingest("en");
  const rewrite = `${REWRITES.latin} ${"Answer from the annual leave policy only. ".repeat(12)}`.trim();

  assert.ok(rewrite.length > 500);
  useModel({ rewrite: () => rewrite });
  await chat(docIds, ZH_QUESTION);
  const [trace] = await readRagTraces();

  assert.deepEqual(trace.queryTranslations, [{ query: rewrite, script: "latin" }]);
});

test("a phrase quoted in the question's script stays an anchor the English chunk lacks (a shortcut in chat())", async () => {
  const docIds = await ingest("en");
  const response = await chat(docIds, "员工每年有多少天“带薪年假”？");
  const [trace] = await readRagTraces();

  assert.deepEqual(trace.queryTranslations, [{ query: REWRITES.latin, script: "latin" }]);
  assert.equal(response.abstained, true);
  assert.deepEqual(
    trace.confidence.missingAnchorGroups.map((group) => group.label),
    ["带薪年假"]
  );
});

test("a question with no letters makes no call", async () => {
  const docIds = await ingest("en", "zh");

  await chat(docIds, "2024？");
  const [trace] = await readRagTraces();

  assert.equal(translationPrompts.length, 0);
  assert.equal(Object.hasOwn(trace, "queryTranslations"), false);
});
