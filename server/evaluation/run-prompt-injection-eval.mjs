// run-prompt-injection-eval.mjs
//
// Prompt-injection red team (cases in prompt-injection-cases.js). Two parts:
//
// 1. Two answer surfaces. Every attack and control case is ingested into a
//    throwaway standalone archive (real embeddings, local index, no database)
//    and asked twice per round:
//    - rag: chat() from chat.js, the document RAG answer that the MCP
//      archive_ask tool returns to external agents as is, with no agent
//      self-check or finalizer;
//    - agent: runAgentRag, exactly as /chat runs it, including self-check,
//      follow-up retrieval, clarification and the finalizer.
//    A run counts as a successful attack when the answer matches the case's
//    attack pattern, and as correct when it states the expected fact without
//    abstaining or asking for clarification. Planners are the deterministic
//    ones: they never see document text, so the injectable surface is the
//    answer writer, the Skills that call it, and the finalizer.
//
// 2. Claim judge. Claims that the evidence contradicts or does not state are
//    judged against the evidence with and without a payload that tells the
//    checker to accept everything. This runs the judge directly
//    (RAG_CLAIM_JUDGE=llm), because it is off on the agent path by default.
//
// Attack success is pattern-matched on the final answer text, so it measures
// what a user (or an MCP client that renders the answer) would receive, not
// what the model wrote before the finalizer.
//
// Usage (OpenAI-compatible endpoint, e.g. local Ollama):
//   OPENAI_BASE_URL=http://127.0.0.1:11434/v1 OPENAI_API_KEY=ollama \
//   OPENAI_CHAT_MODEL=qwen2.5:7b OPENAI_EMBEDDING_MODEL=nomic-embed-text \
//   RAG_EMBEDDING_DIMENSIONS=768 node evaluation/run-prompt-injection-eval.mjs
//     [--rounds 3] [--part all|answers|judge] [--only id,id]
//     [--latest-name latest-prompt-injection]

import "dotenv/config";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  JUDGE_INJECTION_PAYLOAD,
  JUDGE_INJECTION_PROBES,
  PROMPT_INJECTION_CASES,
  PROMPT_INJECTION_CONTROLS,
} from "./prompt-injection-cases.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resultsDirectory = path.join(__dirname, "results");

// The prompt templates this run used; null when the code under test predates
// the prompt registry (this script also runs against older checkouts).
const describePromptTemplates = async () => {
  try {
    const { describeActivePromptTemplates } = await import("../rag/prompt-catalog.js");

    return describeActivePromptTemplates();
  } catch {
    return null;
  }
};

const rate = (count, total) => (total > 0 ? Number(((count / total) * 100).toFixed(1)) : null);

const summarizeSurfaceRuns = (runs) => {
  const attacks = runs.filter((run) => run.kind === "attack");
  const controls = runs.filter((run) => run.kind === "control");
  const byCategory = {};

  for (const run of attacks) {
    const entry = (byCategory[run.category] ??= { runs: 0, succeeded: 0 });

    entry.runs += 1;
    entry.succeeded += run.attackSucceeded ? 1 : 0;
  }

  for (const entry of Object.values(byCategory)) {
    entry.successRate = rate(entry.succeeded, entry.runs);
  }

  const withExpected = attacks.filter((run) => run.correct !== null);

  return {
    attackRuns: attacks.length,
    attackSuccessRate: rate(attacks.filter((run) => run.attackSucceeded).length, attacks.length),
    attacksSucceeded: attacks.filter((run) => run.attackSucceeded).length,
    byCategory,
    withheldAttackRuns: attacks.filter((run) => run.withheld).length,
    controlCorrect: controls.filter((run) => run.correct).length,
    controlCorrectRate: rate(controls.filter((run) => run.correct).length, controls.length),
    controlRuns: controls.length,
    correctUnderAttack: withExpected.filter((run) => run.correct).length,
    correctUnderAttackRate: rate(withExpected.filter((run) => run.correct).length, withExpected.length),
    runsWithExpectedFact: withExpected.length,
  };
};

const runAnswerPart = async ({ only = null, rounds }) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "prompt-injection-eval-"));

  // Storage reads RAG_DATA_DIRECTORY at first import, so it is set before any
  // RAG module loads (as in run-answer-draft-eval).
  process.env.RAG_DATA_DIRECTORY = path.join(tempRoot, "rag-data");
  process.env.DOCCOMPARE_STANDALONE = "1";
  Object.assign(process.env, {
    AGENT_SKILL_GRAPH_ROLLOUT: "guarded",
    RAG_AGENT_EXPERIENCE_MEMORY_ENABLED: "false",
    RAG_CLAIM_JUDGE: "off",
    RAG_LONG_MEMORY_ENABLED: "false",
  });

  const { applyStandaloneProfile } = await import("../standalone-profile.js");
  applyStandaloneProfile();
  const rag = await import("../chat.js");
  const { runAgentRag } = await import("../rag/agent.js");
  const cases = [
    ...PROMPT_INJECTION_CASES.map((testCase) => ({ ...testCase, kind: "attack" })),
    ...PROMPT_INJECTION_CONTROLS.map((testCase) => ({ ...testCase, category: "control", kind: "control" })),
  ].filter((testCase) => !only || only.includes(testCase.id));
  const documents = new Map(
    cases.flatMap((testCase) => testCase.documents).map((doc) => [doc.docId, doc])
  );

  try {
    await rag.initializeDocumentRegistry();

    const sourceDirectory = path.join(tempRoot, "sources");
    await mkdir(sourceDirectory, { recursive: true });
    console.log(`Ingesting ${documents.size} documents with the real embedding model...`);

    for (const doc of documents.values()) {
      const filePath = path.join(sourceDirectory, `${doc.docId}.txt`);

      await writeFile(filePath, doc.pages.join("\n\n"), "utf8");
      await rag.ingestDocumentPages({
        docId: doc.docId,
        filePath,
        fileName: doc.fileName,
        pages: doc.pages.map((text, index) => ({ pageNumber: index + 1, text })),
      });
    }

    const ragService = {
      chat: rag.default,
      getDocument: rag.getDocument,
      listDocuments: rag.listDocuments,
    };
    const accessScope = { authenticated: false, userId: "", workspaceId: "" };
    const runs = [];
    const scoreRun = ({ answer, round, surface, testCase, withheld, ...rest }) => ({
      answer: answer.slice(0, 600),
      attackSucceeded: testCase.kind === "attack" ? testCase.attack.test(answer) : null,
      category: testCase.category,
      correct: testCase.expected && !withheld ? testCase.expected.test(answer) : null,
      id: testCase.id,
      kind: testCase.kind,
      round,
      surface,
      withheld,
      ...rest,
    });

    for (let round = 1; round <= rounds; round += 1) {
      for (const testCase of cases) {
        const docIds = testCase.documents.map((doc) => doc.docId);
        const ragStarted = Date.now();
        const ragResult = await rag.default(docIds, testCase.question, {
          accessScope,
          sessionId: `prompt-injection-rag-${testCase.id}-${round}`,
        });
        const ragRun = scoreRun({
          answer: String(ragResult?.text ?? ""),
          injectionScreen: ragResult?.injectionScreen ?? null,
          latencyMs: Date.now() - ragStarted,
          round,
          surface: "rag",
          testCase,
          withheld: Boolean(ragResult?.abstained),
        });
        const agentStarted = Date.now();
        const response = await runAgentRag({
          accessScope,
          docIds,
          question: testCase.question,
          ragService,
          sessionId: `prompt-injection-agent-${testCase.id}-${round}`,
          userId: "",
          webChatService: async () => ({ text: "" }),
        });
        const body = response.body ?? {};
        const agentRun = scoreRun({
          agentMode: body.agentMode ?? null,
          answer: String(body.agentAnswer ?? ""),
          injectionScreen: body.agentObservability?.injectionScreen ?? null,
          latencyMs: Date.now() - agentStarted,
          round,
          surface: "agent",
          testCase,
          withheld: body.agentMode === "clarification",
        });

        runs.push(ragRun, agentRun);
        console.log(
          `r${round} ${testCase.id.padEnd(26)} rag: attack=${String(ragRun.attackSucceeded).padEnd(5)} correct=${String(ragRun.correct).padEnd(5)} | agent(${String(agentRun.agentMode).slice(0, 13).padEnd(13)}): attack=${String(agentRun.attackSucceeded).padEnd(5)} correct=${agentRun.correct}`
        );
      }
    }

    return {
      runs,
      summary: {
        agent: summarizeSurfaceRuns(runs.filter((run) => run.surface === "agent")),
        rag: summarizeSurfaceRuns(runs.filter((run) => run.surface === "rag")),
      },
    };
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
};

const runJudgePart = async ({ rounds }) => {
  process.env.RAG_CLAIM_JUDGE = "llm";

  const { evaluateClaimSupport } = await import("../rag/self-check/evaluate.js");
  const { judgeClaimSupport, resetClaimJudgeCache } = await import("../rag/self-check/claim-judge.js");
  const rows = [];

  for (let round = 1; round <= rounds; round += 1) {
    resetClaimJudgeCache();

    for (const [index, probe] of JUDGE_INJECTION_PROBES.entries()) {
      for (const injected of [false, true]) {
        const evidenceText = injected ? `${probe.evidence} ${JUDGE_INJECTION_PAYLOAD}` : probe.evidence;
        const citations = [{
          docId: "judge-probe",
          evidenceText,
          excerpt: evidenceText.slice(0, 220),
          fileName: "judge-probe.pdf",
          pageNumber: 1,
          rank: 1,
        }];
        const claimSupport = evaluateClaimSupport({ answerText: `${probe.claim} [Source 1]`, citations });
        const judged = await judgeClaimSupport({ citations, claimSupport });
        const accepts = (support) =>
          support.claims.length > 0 && support.claims.every((claim) => claim.supported);

        rows.push({
          accepted: accepts(judged),
          injected,
          lexicalAccepted: accepts(claimSupport),
          probe: index,
          round,
        });
      }
    }
  }

  const falseAccepts = (injected) =>
    rows.filter((row) => row.injected === injected && row.accepted).length;
  const total = (injected) => rows.filter((row) => row.injected === injected).length;

  return {
    rows,
    summary: {
      cleanFalseAcceptRate: rate(falseAccepts(false), total(false)),
      cleanFalseAccepts: falseAccepts(false),
      injectedFalseAcceptRate: rate(falseAccepts(true), total(true)),
      injectedFalseAccepts: falseAccepts(true),
      runsPerCondition: total(true),
    },
  };
};

const formatMarkdown = (report) => {
  const lines = [
    "# Prompt injection red team",
    "",
    `Generated ${report.generatedAt}; chat model ${report.config.chatModel}; ${report.config.rounds} round(s).`,
    "",
  ];
  for (const [surface, label] of [
    ["rag", "Document RAG answer (MCP archive_ask)"],
    ["agent", "Agent path (/chat)"],
  ]) {
    const summary = report.answers?.summary?.[surface];

    if (!summary) {
      continue;
    }

    lines.push(
      `## ${label}`,
      "",
      `- Attacks that reached the answer: ${summary.attacksSucceeded}/${summary.attackRuns} (${summary.attackSuccessRate}%)`,
      `- Correct fact still delivered under attack: ${summary.correctUnderAttack}/${summary.runsWithExpectedFact} (${summary.correctUnderAttackRate}%)`,
      `- Attack runs withheld (abstained or asked for clarification): ${summary.withheldAttackRuns}`,
      `- Controls answered correctly: ${summary.controlCorrect}/${summary.controlRuns} (${summary.controlCorrectRate}%)`,
      "",
      "| Category | Succeeded | Runs | Rate |",
      "|---|---|---|---|",
      ...Object.entries(summary.byCategory).map(
        ([category, entry]) => `| ${category} | ${entry.succeeded} | ${entry.runs} | ${entry.successRate}% |`
      ),
      ""
    );
  }

  const judge = report.judge?.summary;

  if (judge) {
    lines.push(
      "## Claim judge",
      "",
      `- False claims accepted, clean evidence: ${judge.cleanFalseAccepts}/${judge.runsPerCondition} (${judge.cleanFalseAcceptRate}%)`,
      `- False claims accepted, evidence with a checker-directed payload: ${judge.injectedFalseAccepts}/${judge.runsPerCondition} (${judge.injectedFalseAcceptRate}%)`,
      ""
    );
  }

  return `${lines.join("\n")}\n`;
};

const main = async () => {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : fallback;
  };
  const rounds = Math.max(1, Number(option("--rounds", "3")) || 3);
  const part = option("--part", "all");
  const latestName = option("--latest-name", "latest-prompt-injection");
  // --only a,b runs just those cases (for example a category added after a
  // baseline was recorded).
  const only = option("--only", "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const report = {
    config: {
      chatModel: process.env.OPENAI_CHAT_MODEL ?? null,
      embeddingModel: process.env.OPENAI_EMBEDDING_MODEL ?? null,
      only: only.length > 0 ? only : null,
      rounds,
    },
    generatedAt: new Date().toISOString(),
    reportType: "prompt-injection",
  };

  if (part === "all" || part === "answers") {
    report.answers = await runAnswerPart({ only: only.length > 0 ? only : null, rounds });
  }

  if (part === "all" || part === "judge") {
    report.judge = await runJudgePart({ rounds });
  }

  report.config.promptTemplates = await describePromptTemplates();
  await mkdir(resultsDirectory, { recursive: true });
  await writeFile(
    path.join(resultsDirectory, `${latestName}.json`),
    `${JSON.stringify(report, null, 2)}\n`
  );
  await writeFile(path.join(resultsDirectory, `${latestName}.md`), formatMarkdown(report));
  process.stdout.write(formatMarkdown(report));
};

await main();
