// DocCompare quality verification. Answers the one question the test suite cannot:
// with a real embedding model and a real chat model, does this product actually
// retrieve the right text, compare it correctly, and refuse when it should?
//
// Everything verified so far used a deterministic stub embedder, which proves
// plumbing and proves nothing about quality. This harness needs a real
// OpenAI-compatible endpoint. It does NOT need PostgreSQL, and it does not need
// OpenAI specifically -- a local runtime serving /v1/embeddings and
// /v1/chat/completions works, which means it can run with no paid API key:
//
//   OPENAI_API_KEY=ollama \
//   OPENAI_BASE_URL=http://127.0.0.1:11434/v1 \
//   OPENAI_EMBEDDING_MODEL=nomic-embed-text \
//   OPENAI_CHAT_MODEL=qwen2.5:7b \
//   npm run verify:quality
//
// DESIGN NOTE ON GRADING. A lenient grader is worse than no grader, because it
// reports success. Two failure modes would sail through naive checks:
//
//   - A system that always abstains passes every abstention check. So the
//     abstention result is only counted as meaningful when the answer paths
//     actually produced answers, and the report says so explicitly.
//   - A system that always claims to find differences looks good on a comparison
//     test. So an identical pair of documents is included as a control, and
//     inventing a divergence there is a failure.
//
// Page numbers are checked against fixture ground truth rather than checked for
// existence: build-doccompare-fixtures.mjs knows which page every sentence is on,
// so a citation pointing at the wrong page is caught, not just a missing one.
//
// Checks are split into blocking and advisory. Advisory checks depend on model
// phrasing rather than on system behaviour, and a small local model failing to word
// something the way a frontier model would is not a product defect. Advisory
// failures are reported and do not fail the run.
//
// EXPECTED SELF-TEST RESULT: 18/18. The comparison answer has three stages
// (answer-writer.js writeComparisonAnswer): use the model's text if it passes
// isSafeStructuredDifferenceAnswer, else fall back to an engine-constructed
// buildGroundedDifferenceAnswer, else abstain. Both the self-test and a real qwen2.5:7b
// run currently pass through the engine fallback; a paraphrasing model's own text
// ("a 12-month period" for "twelve (12) months ... shall not exceed") is still rejected
// by the lexical claim check, which is a known limit, not a harness defect.
//
// This used to score 16/18 with the comparison abstaining, and that was blamed on the
// stand-in model. The real cause was the claim check itself: "vendor-a.pdf" was not
// recognised as a document label (no identity noun, no digit), so "vendor a" was read as
// the fact's subject and the two per-document difference bullets could never pair. Grouped
// citations such as [Source 1, Source 3] were also not parsed. Both are pinned by
// test/claim-support.test.mjs and test/grouped-source-labels.test.mjs. If compare.* fails
// again, find which stage rejected the answer before blaming the model.
//
// Do NOT assume the comparison answer path is covered elsewhere. "the MCP ask tool carries
// a real comparison summary onto the wire" in test/rag.test.mjs runs under that file's stub
// provider, whose completeText returns hand-written canned strings, and asserts only
// engine-derived structured fields. It covers the comparison engine and the MCP
// serialization seam, not a model writing a correct comparison. Whether a real model clears
// isSafeStructuredDifferenceAnswer on these fixtures is exactly what this harness measures
// and what nothing else does.

import "dotenv/config";

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DOCCOMPARE_FIXTURES,
  writeDocCompareFixtures,
} from "./build-doccompare-fixtures.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const resultsDirectory = path.join(__dirname, "results");

// The child writes its payload between markers rather than as bare stdout, because
// the RAG modules log freely and any stray line would corrupt a whole-stream
// JSON.parse -- which would then be reported as a persistence failure.
const CHILD_RESULT_MARKER = "__DOCCOMPARE_CHILD_RESULT__";

// --self-test swaps the real endpoint for the deterministic provider the synthetic
// eval already uses. It proves the harness runs -- ingest, retrieval, comparison,
// the checks, the child process, the report -- without a key or a network, so a
// crash in this file is not discovered on someone's first real run. It is NOT
// evidence of quality: the deterministic "model" stitches sentences out of the
// evidence block, which is why self-test output is written under a different
// filename and stamped with its mode.
const SELF_TEST =
  process.argv.includes("--self-test") || process.env.DOCCOMPARE_VERIFY_SELF_TEST === "1";

const configureDeterministicProvider = async () => {
  process.env.RAG_RERANK_PROVIDER = "heuristic";

  const { configureOpenAIProvider } = await import("../rag/openai.js");
  const { toDeterministicEmbedding } = await import("./eval-case-helpers.js");
  const { buildDeterministicEvidenceAnswer } = await import(
    "./deterministic-evidence-answer.js"
  );

  configureOpenAIProvider({
    embedTexts: async (texts) => texts.map((text) => toDeterministicEmbedding(text)),
    embedQuery: async (query) => toDeterministicEmbedding(query),
    completeText: async (prompt) =>
      String(prompt).includes("preserved_ambiguity")
        ? JSON.stringify({ preserved_ambiguity: true, rewritten_query: "" })
        : buildDeterministicEvidenceAnswer(prompt),
  });
};

const normalize = (value = "") => String(value ?? "").replace(/\s+/g, " ").trim();
const lower = (value = "") => normalize(value).toLowerCase();

// Matches either surface form a model might use ("twelve months" / "12 months"),
// word-bounded so "6" does not match inside "2026".
const valuePattern = (fixture) =>
  new RegExp(`\\b(?:${fixture.liabilityWord}|${fixture.liabilityNumber})\\b`, "i");

const describeEndpoint = () =>
  SELF_TEST
    ? {
        baseUrl: "deterministic (self-test, no network)",
        embeddingModel: "deterministic",
        chatModel: "deterministic",
      }
    : {
        baseUrl:
          process.env.OPENAI_BASE_URL?.trim() ||
          process.env.OPENAI_API_BASE?.trim() ||
          "https://api.openai.com/v1",
        embeddingModel:
          process.env.OPENAI_EMBEDDING_MODEL?.trim() || "text-embedding-3-small",
        chatModel: process.env.OPENAI_CHAT_MODEL?.trim() || "gpt-5",
      };

// ---------------------------------------------------------------------------
// Child mode: a genuinely separate process that only reads the archive, so
// cross-process persistence is proven by a second process rather than by
// resetting module state inside this one.
// ---------------------------------------------------------------------------

const runChildQuery = async ({ docIds, question }) => {
  const { applyStandaloneProfile } = await import("../standalone-profile.js");
  applyStandaloneProfile();

  if (SELF_TEST) {
    await configureDeterministicProvider();
  }

  const { default: chat, initializeDocumentRegistry, listDocuments } = await import("../chat.js");
  await initializeDocumentRegistry();

  const documents = await listDocuments();
  const response = await chat(docIds, question);

  const payload = JSON.stringify({
    documentCount: documents.length,
    abstained: Boolean(response.abstained),
    verdictOverridden: response.verdictOverridden === true,
    text: response.text ?? "",
    citations: (response.citations ?? []).map((citation) => ({
      docId: citation.docId,
      fileName: citation.fileName,
      pageNumber: citation.pageNumber,
      excerpt: citation.excerpt,
    })),
  });

  // Await the flush: on a pipe, an immediate process.exit can truncate the write.
  await new Promise((resolve) => {
    process.stdout.write(`\n${CHILD_RESULT_MARKER}${payload}\n`, resolve);
  });
};

if (process.env.DOCCOMPARE_VERIFY_CHILD === "1") {
  await runChildQuery(JSON.parse(process.argv[2]));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const checks = [];

const record = ({ id, description, passed, detail, severity = "blocking" }) => {
  checks.push({ id, description, passed, detail: normalize(detail), severity });
  const label = passed ? "PASS" : severity === "blocking" ? "FAIL" : "warn";
  console.log(`  [${label}] ${description}`);

  if (!passed) {
    console.log(`         ${normalize(detail).slice(0, 400)}`);
  }

  return passed;
};

const passedCheck = (id) => checks.find((check) => check.id === id)?.passed === true;

// Ground-truth page check. A citation is honest only if the page it names actually
// contains the text it quotes -- checkable because the fixture generator decided
// what goes on every page.
const citationPageIsHonest = (citation, fixture) => {
  const pageIndex = Number(citation.pageNumber) - 1;
  const pageLines = fixture.pages[pageIndex];

  if (!pageLines) {
    return {
      honest: false,
      reason: `cites page ${citation.pageNumber}, which does not exist in ${fixture.fileName}`,
    };
  }

  const pageText = lower(pageLines.join(" "));
  const excerpt = lower(citation.excerpt ?? "");

  if (!excerpt) {
    return { honest: false, reason: "citation carries no excerpt to verify" };
  }

  // Compared on distinctive words rather than as an exact substring: extraction
  // collapses line breaks and the excerpt is truncated at 220 characters.
  const words = [...new Set(excerpt.match(/[a-z]{4,}/g) ?? [])];

  if (words.length === 0) {
    return { honest: false, reason: `excerpt has no comparable words: "${excerpt.slice(0, 60)}"` };
  }

  const matched = words.filter((word) => pageText.includes(word));
  const ratio = matched.length / words.length;

  return ratio >= 0.6
    ? { honest: true, ratio }
    : {
        honest: false,
        reason:
          `excerpt attributed to ${fixture.fileName} page ${citation.pageNumber} but only ` +
          `${Math.round(ratio * 100)}% of its distinctive words appear on that page`,
      };
};

const fixtureByFileName = new Map(
  Object.values(DOCCOMPARE_FIXTURES).map((fixture) => [fixture.fileName, fixture])
);

const auditCitations = (citations = []) => {
  const problems = [];

  for (const citation of citations) {
    const fixture = fixtureByFileName.get(citation.fileName);

    if (!fixture) {
      problems.push(`citation names unknown file "${citation.fileName}"`);
      continue;
    }

    const verdict = citationPageIsHonest(citation, fixture);

    if (!verdict.honest) {
      problems.push(verdict.reason);
    }
  }

  return problems;
};

// The check that matters most for a comparison product: each document's value must
// be bound to that document. A confident answer that attributes B's number to A is
// worse than no answer, and reads exactly like a correct one.
const auditValueBinding = ({ text, subjects }) => {
  const problems = [];
  const statements = normalize(text)
    .split(/(?:^|\s)[-*•]\s+|(?<=[.;:])\s+|\n/)
    .map(normalize)
    .filter(Boolean);

  for (const subject of subjects) {
    const owned = statements.filter((statement) =>
      subject.aliases.some((alias) => lower(statement).includes(lower(alias)))
    );

    if (owned.length === 0) {
      problems.push(`answer never attributes anything to ${subject.label}`);
      continue;
    }

    if (!owned.some((statement) => subject.correctValue.test(statement))) {
      problems.push(
        `no statement about ${subject.label} carries its actual value (${subject.valueLabel})`
      );
    }

    const leaked = owned.find((statement) => subject.foreignValue.test(statement));

    if (leaked) {
      problems.push(
        `a statement about ${subject.label} carries the other document's value: "${leaked.slice(0, 120)}"`
      );
    }
  }

  return problems;
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const main = async () => {
  const endpoint = describeEndpoint();

  if (!SELF_TEST && !normalize(process.env.OPENAI_API_KEY)) {
    console.error(
      "OPENAI_API_KEY is empty.\n\n" +
        "This harness needs an OpenAI-compatible endpoint, but not necessarily a paid\n" +
        "one. Against a local runtime any non-empty string works as the key:\n\n" +
        "  OPENAI_API_KEY=ollama \\\n" +
        "  OPENAI_BASE_URL=http://127.0.0.1:11434/v1 \\\n" +
        "  OPENAI_EMBEDDING_MODEL=nomic-embed-text \\\n" +
        "  OPENAI_CHAT_MODEL=qwen2.5:7b \\\n" +
        "  npm run verify:quality\n"
    );
    process.exitCode = 1;
    return;
  }

  console.log("DocCompare quality verification");
  if (SELF_TEST) {
    console.log("  MODE            self-test (harness plumbing only, not quality evidence)");
  }
  console.log(`  endpoint        ${endpoint.baseUrl}`);
  console.log(`  embedding model ${endpoint.embeddingModel}`);
  console.log(`  chat model      ${endpoint.chatModel}`);
  console.log("");

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "doccompare-verify-"));
  const dataDirectory = path.join(tempRoot, "rag-data");
  const fixtureDirectory = path.join(tempRoot, "fixtures");

  // Ordering here is load-bearing, and is the trap standalone-profile.js warns
  // about: rag/storage.js captures RAG_DATA_DIRECTORY when it is first imported and
  // vector-store-local.js loads its index at import time. So the assignment has to
  // precede the first RAG import, which is why every import below is dynamic.
  process.env.RAG_DATA_DIRECTORY = dataDirectory;
  process.env.DOCCOMPARE_STANDALONE = "1";

  const { applyStandaloneProfile } = await import("../standalone-profile.js");
  applyStandaloneProfile();

  if (SELF_TEST) {
    await configureDeterministicProvider();
  }

  const { default: chat, ingestDocument, initializeDocumentRegistry } = await import("../chat.js");
  const { describeAnswerRateFlags, isQaAnswerVerdictEnabled } = await import("../rag/config.js");

  try {
    const fixtures = await writeDocCompareFixtures(fixtureDirectory);
    await initializeDocumentRegistry();

    console.log("Ingesting fixtures with the real embedding model...");

    for (const fixture of fixtures) {
      const ingested = await ingestDocument({
        docId: fixture.docId,
        filePath: fixture.filePath,
        fileName: fixture.fileName,
      });
      console.log(
        `  ${fixture.fileName}: ${ingested.pageCount} pages, ${ingested.chunkCount} chunks`
      );
    }

    console.log("");

    const { vendorA, vendorB, twinLeft, twinRight } = DOCCOMPARE_FIXTURES;
    const vendorAValue = valuePattern(vendorA);
    const vendorBValue = valuePattern(vendorB);

    // --- Path 1: single-document QA with page-accurate citations ------------
    console.log("Path 1 - single document, page-accurate citations");
    const single = await chat([vendorA.docId], "What is the limitation of liability?");
    const singleCitations = single.citations ?? [];
    const singleCitationProblems = auditCitations(singleCitations);

    record({
      id: "single.answers",
      description: "answers a question its corpus can support",
      passed: !single.abstained && normalize(single.text).length > 0,
      // verdictOverridden: answered through RAG_QA_VERDICT_OVERRIDE although the
      // answer model opened with NOT_IN_EVIDENCE: (answer-verdict-override.js).
      detail:
        `abstained=${single.abstained} reason=${single.abstainReason ?? "-"}` +
        (single.verdictOverridden === true ? " verdictOverridden=true" : ""),
    });
    record({
      id: "single.cites",
      description: "produces at least one citation",
      passed: singleCitations.length > 0,
      detail: `citations=${singleCitations.length}`,
    });
    record({
      id: "single.correct-value",
      description: `states the actual liability term (${vendorA.liabilityValue} months)`,
      passed: vendorAValue.test(normalize(single.text)),
      detail: `answer: ${normalize(single.text).slice(0, 240)}`,
    });
    record({
      id: "single.no-foreign-value",
      description: "does not state a value from a document it was not given",
      passed: !vendorBValue.test(normalize(single.text)),
      detail:
        `answer mentions ${vendorB.liabilityValue}, a value that exists only in ` +
        `${vendorB.fileName}, which was not selected`,
    });
    record({
      id: "single.page-honest",
      description: `cites the page the clause is really on (page ${vendorA.liabilityPage})`,
      passed:
        singleCitations.some(
          (citation) => Number(citation.pageNumber) === vendorA.liabilityPage
        ) && singleCitationProblems.length === 0,
      detail:
        `pages cited: ${singleCitations.map((c) => c.pageNumber).join(", ") || "none"}; ` +
        `problems: ${singleCitationProblems.join(" | ") || "none"}`,
    });

    // --- Path 2: comparison across two documents ---------------------------
    console.log("\nPath 2 - comparison across two documents");
    const comparison = await chat(
      [vendorA.docId, vendorB.docId],
      "Compare the limitation of liability in these two contracts."
    );
    const comparisonCitations = comparison.citations ?? [];
    const comparisonCitedFiles = new Set(
      comparisonCitations.map((citation) => citation.fileName)
    );
    const comparisonSummary = comparison.comparisonAnalysisSummary ?? null;
    const comparisonProblems = auditCitations(comparisonCitations);

    record({
      id: "compare.answers",
      description: "produces a comparison instead of abstaining",
      passed: !comparison.abstained && normalize(comparison.text).length > 0,
      detail: `abstained=${comparison.abstained} reason=${comparison.abstainReason ?? "-"}`,
    });
    record({
      id: "compare.both-cited",
      description: "cites both documents",
      passed:
        comparisonCitedFiles.has(vendorA.fileName) &&
        comparisonCitedFiles.has(vendorB.fileName),
      detail: `cited: ${[...comparisonCitedFiles].join(", ") || "none"}`,
    });
    record({
      id: "compare.structured-field",
      description: "populates the structured comparison summary for both documents",
      passed: comparisonSummary?.comparedDocIds?.length === 2,
      detail: JSON.stringify(comparisonSummary),
    });
    record({
      id: "compare.pages-honest",
      description: "every citation names a page that really contains its excerpt",
      passed: comparisonProblems.length === 0,
      detail: comparisonProblems.join(" | ") || "none",
    });

    const bindingProblems = auditValueBinding({
      text: comparison.text,
      subjects: [
        {
          label: vendorA.fileName,
          aliases: [vendorA.fileName, "vendor a", "vendor-a"],
          correctValue: vendorAValue,
          foreignValue: vendorBValue,
          valueLabel: `${vendorA.liabilityValue} months`,
        },
        {
          label: vendorB.fileName,
          aliases: [vendorB.fileName, "vendor b", "vendor-b"],
          correctValue: vendorBValue,
          foreignValue: vendorAValue,
          valueLabel: `${vendorB.liabilityValue} months`,
        },
      ],
    });

    record({
      id: "compare.value-binding",
      description: "binds each value to the document it came from, with no cross-leak",
      passed: bindingProblems.length === 0,
      detail:
        `${bindingProblems.join(" | ") || "none"} — answer: ` +
        `${normalize(comparison.text).slice(0, 400)}`,
    });

    // --- Control: identical documents must not yield invented differences ---
    console.log("\nControl - identical documents must not produce invented differences");
    const twins = await chat(
      [twinLeft.docId, twinRight.docId],
      "Compare the remote work allowance in these two policies."
    );
    const twinSummary = twins.comparisonAnalysisSummary ?? null;
    const twinConflicts = twinSummary?.explicitConflictPairs ?? [];
    const twinText = normalize(twins.text);

    // The structured field is the authority here: the comparison engine either
    // found a divergence between two byte-identical clauses or it did not.
    record({
      id: "control.no-invented-conflict",
      description: "reports no explicit conflict between identical documents",
      passed: twinConflicts.length === 0,
      detail: `explicitConflictPairs=${JSON.stringify(twinConflicts).slice(0, 300)}`,
    });
    record({
      id: "control.no-invented-number",
      description: "does not introduce an allowance figure neither policy contains",
      passed: !/\b(?:one|three|four|five|1|3|4|5)\s*\(?\d*\)?\s*days?\b/i.test(twinText),
      detail: `answer: ${twinText.slice(0, 300)}`,
    });
    // Prose wording is advisory: phrasing varies by model, and a weak model failing
    // to say "identical" is not the same defect as the engine inventing a conflict.
    record({
      id: "control.asserts-sameness",
      description: "says in prose that the two policies match",
      passed:
        twinSummary?.shouldShortCircuitNoMaterialDifference === true ||
        /identical|the same|no material difference|no differences?\b|match/i.test(twinText),
      detail:
        `shortCircuit=${twinSummary?.shouldShortCircuitNoMaterialDifference} ` +
        `answer: ${twinText.slice(0, 300)}`,
      severity: "advisory",
    });

    // --- Path 3: abstention outside the corpus -----------------------------
    console.log("\nPath 3 - abstention outside the corpus");
    const outside = await chat(
      [vendorA.docId, vendorB.docId],
      "What is the parental leave entitlement for part-time staff?"
    );

    record({
      id: "abstain.refuses",
      description: "abstains on a question the corpus cannot answer",
      passed: Boolean(outside.abstained),
      detail: `abstained=${outside.abstained} answer: ${normalize(outside.text).slice(0, 240)}`,
    });
    record({
      id: "abstain.no-citations",
      description: "returns no citations when abstaining",
      passed: (outside.citations ?? []).length === 0,
      detail: `citations=${(outside.citations ?? []).length}`,
    });

    // --- Path 4: a genuinely separate process reads the same archive --------
    console.log("\nPath 4 - a second process reads the same archive");
    const childPayload = JSON.stringify({
      docIds: [vendorA.docId],
      question: "What is the limitation of liability?",
    });
    const child = await new Promise((resolve) => {
      const proc = spawn(process.execPath, [__filename, childPayload], {
        env: {
          ...process.env,
          DOCCOMPARE_VERIFY_CHILD: "1",
          DOCCOMPARE_VERIFY_SELF_TEST: SELF_TEST ? "1" : "",
          RAG_DATA_DIRECTORY: dataDirectory,
          DOCCOMPARE_STANDALONE: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      proc.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      proc.on("close", (code) => resolve({ code, stdout, stderr }));
    });

    const markerIndex = child.stdout.lastIndexOf(CHILD_RESULT_MARKER);
    let childResult = null;

    if (markerIndex !== -1) {
      try {
        childResult = JSON.parse(
          child.stdout.slice(markerIndex + CHILD_RESULT_MARKER.length).trim()
        );
      } catch {
        childResult = null;
      }
    }

    const childFailureDetail =
      `child exited ${child.code}: ${normalize(child.stderr).slice(0, 400)}`;
    const expectedDocumentCount = Object.keys(DOCCOMPARE_FIXTURES).length;

    record({
      id: "persistence.child-sees-archive",
      description: `a second process sees all ${expectedDocumentCount} ingested documents`,
      passed: childResult?.documentCount === expectedDocumentCount,
      detail: childResult ? `documentCount=${childResult.documentCount}` : childFailureDetail,
    });
    record({
      id: "persistence.child-answers",
      description: "a second process answers correctly from the persisted index",
      passed: Boolean(
        childResult &&
          !childResult.abstained &&
          childResult.citations.length > 0 &&
          vendorAValue.test(normalize(childResult.text))
      ),
      detail: childResult
        ? `abstained=${childResult.abstained} citations=${childResult.citations.length} ` +
          (childResult.verdictOverridden === true ? "verdictOverridden=true " : "") +
          `answer: ${normalize(childResult.text).slice(0, 240)}`
        : childFailureDetail,
    });

    // --- Honesty cross-check on the abstention result ----------------------
    // Recorded as a check rather than left as prose so it lands in the report:
    // refusing everything would otherwise show up as two green abstention checks.
    record({
      id: "meta.abstention-is-discriminating",
      description: "abstention is selective, not a system that refuses everything",
      passed: passedCheck("single.answers") || passedCheck("compare.answers"),
      detail:
        "the abstention checks above are only meaningful if the answer paths produced " +
        "answers; neither did, so what was observed is a system that refuses every question",
    });

    // --- Report -----------------------------------------------------------
    const blockingFailures = checks.filter(
      (check) => !check.passed && check.severity === "blocking"
    );
    const advisoryFailures = checks.filter(
      (check) => !check.passed && check.severity === "advisory"
    );
    const summary = {
      generatedAt: new Date().toISOString(),
      mode: SELF_TEST ? "self-test" : "real-endpoint",
      endpoint,
      // The answer settings this run used, so a report shows which flags were on.
      config: {
        answerRateFlags: describeAnswerRateFlags(),
        claimJudge: process.env.RAG_CLAIM_JUDGE || "off",
        qaAnswerVerdict: isQaAnswerVerdictEnabled(),
      },
      totalChecks: checks.length,
      passed: checks.filter((check) => check.passed).length,
      blockingFailures: blockingFailures.length,
      advisoryFailures: advisoryFailures.length,
      // Recorded in the artifact itself so a green run is not over-read later.
      scope:
        (SELF_TEST
          ? "SELF-TEST RUN -- deterministic stand-in provider, NOT quality evidence. " +
            "It only shows the harness executes end to end. "
          : "") +
        "Verifies retrieval, citation page accuracy, comparison value binding, " +
        "abstention, and cross-process persistence against four fixed synthetic " +
        "fixtures. Does NOT measure answer quality on real-world documents, does " +
        "not compare models, and does not exercise the PostgreSQL deployment.",
      checks,
      answers: {
        single: normalize(single.text),
        comparison: normalize(comparison.text),
        identicalPair: twinText,
        outsideCorpus: normalize(outside.text),
      },
    };

    await mkdir(resultsDirectory, { recursive: true });
    // Self-test output goes to its own filename so it can never be mistaken for,
    // or silently overwrite, a real verification report.
    const reportSlug = SELF_TEST
      ? "latest-doccompare-selftest"
      : "latest-doccompare-verification";
    const jsonPath = path.join(resultsDirectory, `${reportSlug}.json`);
    const markdownPath = path.join(resultsDirectory, `${reportSlug}.md`);

    await writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`);
    await writeFile(
      markdownPath,
      [
        "# DocCompare quality verification",
        "",
        ...(SELF_TEST
          ? [
              "> **Self-test run.** Deterministic stand-in provider, no network. This",
              "> shows the harness executes; it is not evidence about answer quality.",
              "",
            ]
          : []),
        `- generated: ${summary.generatedAt}`,
        `- endpoint: \`${endpoint.baseUrl}\``,
        `- embedding model: \`${endpoint.embeddingModel}\``,
        `- chat model: \`${endpoint.chatModel}\``,
        `- result: **${
          blockingFailures.length === 0 ? "PASS" : `FAIL (${blockingFailures.length} blocking)`
        }** — ${summary.passed}/${summary.totalChecks} checks passed` +
          (advisoryFailures.length > 0 ? `, ${advisoryFailures.length} advisory` : ""),
        "",
        `> ${summary.scope}`,
        "",
        "| check | severity | result | detail |",
        "| --- | --- | --- | --- |",
        ...checks.map(
          (check) =>
            `| ${check.description} | ${check.severity} | ${check.passed ? "pass" : "FAIL"} | ` +
            `${check.detail.slice(0, 200).replace(/\|/g, "\\|")} |`
        ),
        "",
        "## Answers produced",
        "",
        ...Object.entries(summary.answers).flatMap(([key, value]) => [
          `### ${key}`,
          "",
          "```",
          value || "(empty)",
          "```",
          "",
        ]),
      ].join("\n")
    );

    console.log("");
    console.log(
      `${blockingFailures.length === 0 ? "PASS" : `FAIL (${blockingFailures.length} blocking)`}` +
        ` — ${summary.passed}/${summary.totalChecks} checks passed` +
        (advisoryFailures.length > 0
          ? `, ${advisoryFailures.length} advisory failure(s) (not fatal)`
          : "")
    );
    console.log(`Report: ${markdownPath}`);

    if (blockingFailures.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
};

await main();
