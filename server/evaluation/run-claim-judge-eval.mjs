// run-claim-judge-eval.mjs
//
// Calibration gate for the claim judge (rag/self-check/claim-judge.js): runs a
// contrast set through the lexical claim check alone and through lexical +
// judge, and reports how many correct paraphrases each accepts and, more
// importantly, how many unsupported claims each wrongly accepts.
//
// The set is built from the verify:quality contract fixtures. Every label was
// written by construction: a paraphrase that keeps every fact is "supported";
// a variant that breaks exactly one thing -- a number, the entity, who acts,
// an added or dropped condition, negation, may/must, direction, outside
// knowledge -- is "unsupported". It is a contrast set, not human labels on real
// model answers; those belong in eval:judge with --labels.
//
// Usage (OpenAI-compatible endpoint, e.g. local Ollama):
//   OPENAI_BASE_URL=http://127.0.0.1:11434/v1 OPENAI_API_KEY=ollama \
//   OPENAI_CHAT_MODEL=qwen2.5:7b node evaluation/run-claim-judge-eval.mjs [--rounds 3]

import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The prompt templates this run used; null when the code under test predates
// the prompt registry (these scripts also run against older checkouts).
const describePromptTemplates = async () => {
  try {
    const { describeActivePromptTemplates } = await import("../rag/prompt-catalog.js");

    return describeActivePromptTemplates();
  } catch {
    return null;
  }
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resultsDirectory = path.join(__dirname, "results");

const EVIDENCE = {
  lawA: { docId: "vendor-a", text: "This agreement is governed by the laws of Delaware." },
  lawB: { docId: "vendor-b", text: "This agreement is governed by the laws of New York." },
  liabilityA: {
    docId: "vendor-a",
    text: "The total liability of Vendor A shall not exceed the fees paid in the twelve (12) months preceding the claim.",
  },
  liabilityB: {
    docId: "vendor-b",
    text: "The total liability of Vendor B shall not exceed the fees paid in the six (6) months preceding the claim.",
  },
  noticeA: {
    docId: "vendor-a",
    text: "Either party may terminate this agreement on thirty (30) days written notice to the other party.",
  },
  noticeB: {
    docId: "vendor-b",
    text: "Either party may terminate this agreement on ninety (90) days written notice to the other party.",
  },
  remote: {
    docId: "policy-v1",
    text: "Employees may work remotely two (2) days per week with manager approval.",
  },
  scopeA: { docId: "vendor-a", text: "Vendor A shall provide cloud hosting and support services." },
};

// [evidence key, claim, label, category]
export const CLAIM_JUDGE_CONTRAST_SET = [
  ["liabilityA", "Vendor A's liability is capped at the fees paid over the previous 12 months.", "supported", "paraphrase"],
  ["liabilityA", "According to the agreement, Vendor A cannot be liable for more than the fees paid in the twelve months before a claim.", "supported", "paraphrase"],
  ["liabilityA", "The limitation of liability caps Vendor A's total liability at twelve months of fees preceding the claim.", "supported", "paraphrase"],
  ["noticeA", "The agreement can be terminated by either party with 30 days' written notice.", "supported", "paraphrase"],
  ["noticeA", "Either side may end the agreement by giving the other party thirty days of written notice.", "supported", "paraphrase"],
  ["lawA", "Delaware law governs the agreement.", "supported", "paraphrase"],
  ["lawA", "The agreement is subject to the laws of Delaware.", "supported", "paraphrase"],
  ["liabilityB", "Vendor B's liability is limited to the fees paid during the six months before the claim.", "supported", "paraphrase"],
  ["noticeB", "Terminating the agreement requires ninety days of written notice to the other party.", "supported", "paraphrase"],
  ["lawB", "The agreement is governed by New York law.", "supported", "paraphrase"],
  ["remote", "Employees can work from home two days a week if their manager approves.", "supported", "paraphrase"],
  ["remote", "With their manager's approval, employees may work remotely two days per week.", "supported", "paraphrase"],
  ["scopeA", "Vendor A provides cloud hosting and support services.", "supported", "paraphrase"],
  ["scopeA", "Vendor A is responsible for providing cloud hosting and support services.", "supported", "paraphrase"],

  ["liabilityA", "Vendor A's liability is capped at the fees paid over the previous 6 months.", "unsupported", "wrong_number"],
  ["noticeA", "Either party may terminate the agreement with 60 days' written notice.", "unsupported", "wrong_number"],
  ["lawA", "New York law governs the agreement.", "unsupported", "wrong_entity"],
  ["liabilityB", "Vendor A's liability is limited to six months of fees.", "unsupported", "wrong_entity"],
  ["noticeA", "Only Vendor A may terminate the agreement on 30 days' written notice.", "unsupported", "swapped_actor"],
  ["noticeA", "Either party may terminate the agreement on 30 days' written notice, and the notice must be sent by registered mail.", "unsupported", "added_detail"],
  ["liabilityA", "Vendor A's liability is capped at twelve months of fees, except in cases of gross negligence.", "unsupported", "added_detail"],
  ["remote", "Employees may work remotely two days per week without needing approval.", "unsupported", "dropped_condition"],
  ["remote", "Employees may not work remotely.", "unsupported", "negation"],
  ["noticeA", "Either party must terminate the agreement after 30 days' written notice.", "unsupported", "may_to_must"],
  ["liabilityA", "Vendor A has unlimited liability.", "unsupported", "contradiction"],
  ["lawA", "Delaware law governs the agreement, which is common for companies incorporated in the United States.", "unsupported", "outside_knowledge"],
  ["scopeA", "Vendor A receives cloud hosting and support services.", "unsupported", "reversed_relation"],
  ["remote", "Managers may work remotely two days per week.", "unsupported", "wrong_subject"],
].map(([evidence, claim, label, category], index) => ({
  category,
  claim,
  evidence,
  heldOut: false,
  id: `${String(index + 1).padStart(2, "0")}_${category}`,
  label,
}));

// Written after the first calibration run and before the judge's prompt and
// schema changed in response to it, so they measure the change on claims it
// was not shaped around. Reported separately.
export const CLAIM_JUDGE_HELD_OUT_SET = [
  ["noticeB", "Either party can end the agreement with ninety days' written notice to the other party.", "supported", "paraphrase"],
  ["liabilityB", "The total liability of Vendor B is limited to the fees paid in the six months preceding the claim.", "supported", "paraphrase"],
  ["lawB", "New York law applies to this agreement.", "supported", "paraphrase"],
  ["scopeA", "Vendor A will provide cloud hosting and support services.", "supported", "paraphrase"],
  ["remote", "Employees may work remotely two days per week with manager approval, and must be in the office on Mondays.", "unsupported", "added_detail"],
  ["lawB", "The agreement is governed by New York law, and disputes go to arbitration.", "unsupported", "added_detail"],
  ["liabilityB", "Vendor B's liability is capped at six months of fees unless the claim involves data loss.", "unsupported", "added_detail"],
  ["noticeB", "Vendor B alone may terminate the agreement with ninety days' notice.", "unsupported", "swapped_actor"],
].map(([evidence, claim, label, category], index) => ({
  category,
  claim,
  evidence,
  heldOut: true,
  id: `h${index + 1}_${category}`,
  label,
}));

const rate = (numerator, denominator) =>
  denominator > 0 ? Number(((numerator / denominator) * 100).toFixed(1)) : null;

export const summarizeJudgeRuns = (rows) => {
  const supported = rows.filter((row) => row.label === "supported");
  const unsupported = rows.filter((row) => row.label === "unsupported");
  const accepted = (subset, key) => subset.filter((row) => row[key]).length;

  return {
    hybrid: {
      falseAccept: accepted(unsupported, "hybrid"),
      falseAcceptRate: rate(accepted(unsupported, "hybrid"), unsupported.length),
      recall: rate(accepted(supported, "hybrid"), supported.length),
      supportedAccepted: accepted(supported, "hybrid"),
    },
    judgeFailures: rows.filter((row) => row.judgeStatus === "failed").length,
    lexical: {
      falseAccept: accepted(unsupported, "lexical"),
      falseAcceptRate: rate(accepted(unsupported, "lexical"), unsupported.length),
      recall: rate(accepted(supported, "lexical"), supported.length),
      supportedAccepted: accepted(supported, "lexical"),
    },
    numberGuardBlocked: rows.filter((row) => row.numberGuardBlocked).length,
    supportedCount: supported.length,
    unsupportedCount: unsupported.length,
    wrongAccepts: unsupported
      .filter((row) => row.hybrid)
      .map((row) => ({ category: row.category, claim: row.claim, reason: row.judgeReason })),
  };
};

const main = async () => {
  const args = process.argv.slice(2);
  const roundsIndex = args.indexOf("--rounds");
  const rounds = roundsIndex >= 0 ? Number(args[roundsIndex + 1]) : 3;
  process.env.RAG_CLAIM_JUDGE = "llm";

  const { evaluateClaimSupport } = await import("../rag/self-check/evaluate.js");
  const { judgeClaimSupport, resetClaimJudgeCache } = await import("../rag/self-check/claim-judge.js");
  const rows = [];

  for (let round = 1; round <= rounds; round += 1) {
    resetClaimJudgeCache();

    for (const item of [...CLAIM_JUDGE_CONTRAST_SET, ...CLAIM_JUDGE_HELD_OUT_SET]) {
      const evidence = EVIDENCE[item.evidence];
      const citations = [{
        docId: evidence.docId,
        evidenceText: evidence.text,
        excerpt: evidence.text.slice(0, 220),
        fileName: `${evidence.docId}.pdf`,
        pageNumber: 1,
        rank: 1,
      }];
      const claimSupport = evaluateClaimSupport({ answerText: `${item.claim} [Source 1]`, citations });
      const judged = await judgeClaimSupport({ citations, claimSupport });
      // The checker may split one sentence into several claims ("X, and Y");
      // the item is accepted only if every part is, as the finalizer would
      // otherwise drop the unsupported part.
      const accepts = (support) =>
        support.claims.length > 0 && support.claims.every((claim) => claim.supported);
      const judgeReason = judged.claims
        .map((claim) => claim.judge?.reason)
        .filter(Boolean)
        .join(" | ") || null;

      rows.push({
        ...item,
        claimCount: claimSupport.claims.length,
        hybrid: accepts(judged),
        judgeReason,
        judgeStatus: judged.judge?.status ?? "not_needed",
        lexical: accepts(claimSupport),
        numberGuardBlocked: (judged.judge?.numberGuardRejectedCount ?? 0) > 0,
        round,
      });
      console.log(
        `r${round} ${item.id.padEnd(24)} ${item.label.padEnd(11)} claims=${claimSupport.claims.length} lexical=${String(accepts(claimSupport)).padEnd(5)} hybrid=${accepts(judged)}${judgeReason ? `  (${judgeReason.slice(0, 120)})` : ""}`
      );
    }
  }

  const summary = summarizeJudgeRuns(rows.filter((row) => !row.heldOut));
  const heldOutSummary = summarizeJudgeRuns(rows.filter((row) => row.heldOut));
  const report = {
    config: {
      chatModel: process.env.OPENAI_CHAT_MODEL ?? null,
      promptTemplates: await describePromptTemplates(),
      rounds,
    },
    generatedAt: new Date().toISOString(),
    reportType: "claim-judge-contrast",
    heldOutSummary,
    rows,
    summary,
  };
  const markdown = [
    "# Claim judge contrast set",
    "",
    `- Generated: ${report.generatedAt}; judge model: ${report.config.chatModel}; rounds: ${rounds}`,
    `- ${summary.supportedCount / rounds} supported paraphrases and ${summary.unsupportedCount / rounds} unsupported variants per round; labels by construction, not human labels`,
    "",
    "| Checker | Paraphrases accepted | Unsupported wrongly accepted |",
    "|---|---|---|",
    `| Lexical only | ${summary.lexical.supportedAccepted}/${summary.supportedCount} (${summary.lexical.recall}%) | ${summary.lexical.falseAccept}/${summary.unsupportedCount} (${summary.lexical.falseAcceptRate}%) |`,
    `| Lexical + judge | ${summary.hybrid.supportedAccepted}/${summary.supportedCount} (${summary.hybrid.recall}%) | ${summary.hybrid.falseAccept}/${summary.unsupportedCount} (${summary.hybrid.falseAcceptRate}%) |`,
    "",
    `Number guard blocked ${summary.numberGuardBlocked} claims before the judge; judge failures: ${summary.judgeFailures}.`,
    "",
    `Held-out set (${heldOutSummary.supportedCount / rounds} supported, ${heldOutSummary.unsupportedCount / rounds} unsupported per round, written before the judge changed): paraphrases accepted ${heldOutSummary.hybrid.supportedAccepted}/${heldOutSummary.supportedCount}, unsupported wrongly accepted ${heldOutSummary.hybrid.falseAccept}/${heldOutSummary.unsupportedCount} (lexical alone: ${heldOutSummary.lexical.supportedAccepted}/${heldOutSummary.supportedCount} and ${heldOutSummary.lexical.falseAccept}/${heldOutSummary.unsupportedCount}).`,
    "",
    "Wrong accepts:",
    ...([...summary.wrongAccepts, ...heldOutSummary.wrongAccepts].length === 0
      ? ["- none"]
      : [...summary.wrongAccepts, ...heldOutSummary.wrongAccepts].map(
          (row) => `- ${row.category}: ${row.claim} (judge: ${row.reason})`
        )),
    "",
  ].join("\n");

  await mkdir(resultsDirectory, { recursive: true });
  await writeFile(path.join(resultsDirectory, "latest-claim-judge.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(resultsDirectory, "latest-claim-judge.md"), markdown);
  console.log(`\n${markdown}`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
