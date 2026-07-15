import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  attachEvaluationEvidence,
  buildEvaluationEvidence,
  buildSourceReportReference,
  getCorpusIdentity,
  getEvaluationSuiteContext,
  getPublicEvaluationConfig,
  hashCanonicalJson,
  hashCorpusContent,
  resolveEvaluationGitState,
  resolveEvaluationProfile,
  sanitizeEvidenceConfig,
  toRepoRelativePath,
} from "../evaluation/eval-evidence.js";

test("evaluation evidence config hash is independent of object field order", () => {
  const first = {
    provider: {
      mode: "real",
      id: "openai",
    },
    retrieval: {
      topK: 6,
      hybrid: true,
    },
  };
  const second = {
    retrieval: {
      hybrid: true,
      topK: 6,
    },
    provider: {
      id: "openai",
      mode: "real",
    },
  };

  assert.equal(hashCanonicalJson(first), hashCanonicalJson(second));
});

test("evaluation evidence profile honors the release workflow override", () => {
  assert.equal(
    resolveEvaluationProfile("robust", {
      EVAL_EVIDENCE_PROFILE: "release",
    }),
    "release"
  );
  assert.equal(resolveEvaluationProfile("robust", {}), "robust");
});

test("evaluation evidence corpus hash changes with corpus content", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eval-evidence-corpus-"));
  const firstPath = path.join(directory, "first.json");
  const secondPath = path.join(directory, "second.json");

  try {
    await writeFile(firstPath, JSON.stringify({ cases: [{ id: "case-a" }] }));
    await writeFile(secondPath, JSON.stringify({ cases: [{ id: "case-b" }] }));

    assert.notEqual(
      await hashCorpusContent(firstPath),
      await hashCorpusContent(secondPath)
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("evaluation evidence corpus hash excludes volatile build metadata", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eval-evidence-corpus-"));
  const firstPath = path.join(directory, "first.json");
  const secondPath = path.join(directory, "second.json");
  const content = {
    cases: [{ id: "case-a" }],
    documents: [{ key: "doc-a", pages: ["stable content"] }],
  };

  try {
    await writeFile(
      firstPath,
      JSON.stringify({
        ...content,
        buildReport: { documents: [{ pdfPath: "/private/first.pdf" }] },
        metadata: {
          casesSource: "/private/first-cases.json",
          generatedAt: "2026-07-14T00:00:00.000Z",
          manifestName: "arxiv-seed",
          manifestVersion: 1,
        },
      })
    );
    await writeFile(
      secondPath,
      JSON.stringify({
        metadata: {
          manifestVersion: 1,
          manifestName: "arxiv-seed",
          generatedAt: "2026-07-15T00:00:00.000Z",
          casesSource: "C:\\private\\second-cases.json",
        },
        buildReport: { documents: [{ pdfPath: "C:\\private\\second.pdf" }] },
        ...content,
      })
    );

    assert.equal(
      await hashCorpusContent(firstPath),
      await hashCorpusContent(secondPath)
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("evaluation evidence paths are repo-relative and never expose outside absolute paths", () => {
  const repoRoot = path.join(os.tmpdir(), "archive-rag-repo");
  const corpusPath = path.join(
    repoRoot,
    "server",
    "evaluation",
    "synthetic-corpus.json"
  );

  assert.equal(
    toRepoRelativePath(corpusPath, { repoRoot }),
    "server/evaluation/synthetic-corpus.json"
  );
  assert.equal(
    toRepoRelativePath(path.join(os.tmpdir(), "outside", "secret.json"), {
      repoRoot,
    }),
    "unknown"
  );
  assert.equal(
    toRepoRelativePath("C:\\Users\\alice\\secret.json", {
      repoRoot: path.resolve(process.cwd(), ".."),
    }),
    "unknown"
  );
});

test("evaluation evidence config excludes secret-like and prompt fields", () => {
  const sanitized = sanitizeEvidenceConfig({
    apiKey: "sk-private",
    authHeader: "Bearer private",
    authorizationHeader: "Bearer private",
    env: { PATH: "/private/bin" },
    model: "gpt-internal",
    prompt: "private instructions",
    provider: {
      mode: "real",
      routeId: "chat.default",
      token: "private-token",
    },
    topK: 6,
  });
  const serialized = JSON.stringify(sanitized);

  assert.deepEqual(sanitized, {
    provider: {
      mode: "real",
      routeId: "chat.default",
    },
    topK: 6,
  });
  assert.doesNotMatch(serialized, /private|apiKey|authorization|prompt|token/i);
  assert.doesNotMatch(serialized, /gpt-internal/);
});

test("evaluation evidence consumes an explicit public config allowlist", () => {
  const config = getPublicEvaluationConfig({
    reportType: "synthetic",
    report: {
      summary: {
        config: {
          chunkSize: 900,
          internalModel: "gpt-private",
          privateExperiment: "do-not-hash",
          retrievalTopK: 6,
        },
      },
    },
  });

  assert.deepEqual(config, {
    chunkSize: 900,
    retrievalTopK: 6,
  });
});

test("evaluation evidence builder records sanitized reproducible lineage", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "eval-evidence-repo-"));
  const corpusPath = path.join(repoRoot, "server", "evaluation", "corpus.json");

  try {
    await mkdir(path.dirname(corpusPath), { recursive: true });
    await writeFile(
      corpusPath,
      JSON.stringify({ cases: [{ id: "case-a" }], documents: [] }),
      { flag: "wx" }
    );
    const evidence = await buildEvaluationEvidence({
      command: "npm run eval:synthetic",
      corpus: {
        id: "compare-hard",
        path: corpusPath,
        version: "1",
      },
      generatedAt: "2026-07-15T00:00:00.000Z",
      gitState: {
        commitSha: "a".repeat(40),
        dirty: false,
      },
      modelRouteId: "chat.default",
      profile: "robust",
      provider: {
        id: "openai",
        mode: "real",
      },
      publicConfig: {
        apiKey: "sk-private",
        chunkSize: 900,
      },
      repoRoot,
      reportId: "compare-hard-synthetic",
      reportType: "synthetic",
      runId: "synthetic-run",
      suite: {
        configHash: "f".repeat(64),
        id: "robust",
        runId: "robust-run",
      },
    });

    assert.equal(evidence.schemaVersion, "1.0.0");
    assert.equal(evidence.reportType, "synthetic");
    assert.equal(evidence.reportId, "compare-hard-synthetic");
    assert.equal(evidence.runId, "synthetic-run");
    assert.deepEqual(evidence.git, {
      commitSha: "a".repeat(40),
      dirty: false,
    });
    assert.deepEqual(evidence.corpus, {
      contentHash: await hashCorpusContent(corpusPath),
      id: "compare-hard",
      relativePath: "server/evaluation/corpus.json",
      version: "1",
    });
    assert.equal(
      evidence.configHash,
      hashCanonicalJson({ chunkSize: 900 })
    );
    assert.deepEqual(evidence.provider, {
      id: "openai",
      mode: "real",
    });
    assert.equal(evidence.modelRouteId, "chat.default");
    assert.deepEqual(evidence.sourceReports, []);
    assert.deepEqual(evidence.suite, {
      configHash: "f".repeat(64),
      id: "robust",
      runId: "robust-run",
    });
    assert.equal(evidence.generatorVersion, "1.0.0");
    assert.doesNotMatch(JSON.stringify(evidence), /sk-private|apiKey/);
  } finally {
    await rm(repoRoot, { force: true, recursive: true });
  }
});

test("evaluation Git state ignores controlled evaluation outputs but detects source changes", async () => {
  const commitSha = "b".repeat(40);
  const runGit = async (args) => {
    if (args.join(" ") === "rev-parse HEAD") {
      return `${commitSha}\n`;
    }

    if (args.join(" ") === "status --porcelain --untracked-files=all") {
      return [
        " M server/evaluation/results/latest.json",
        "?? server/evaluation/generated/arxiv-corpus.json",
      ].join("\n");
    }

    throw new Error(`Unexpected git args: ${args.join(" ")}`);
  };

  assert.deepEqual(
    await resolveEvaluationGitState({ runGit }),
    {
      commitSha,
      dirty: false,
    }
  );

  assert.deepEqual(
    await resolveEvaluationGitState({
      runGit: async (args) =>
        args[0] === "rev-parse"
          ? `${commitSha}\n`
          : " M server/evaluation/eval-evidence.js\n",
    }),
    {
      commitSha,
      dirty: true,
    }
  );
});

test("evaluation source references retain only release lineage fields", () => {
  const reference = buildSourceReportReference({
    evidence: {
      reportType: "planner",
      reportId: "planner-real",
      runId: "planner-real-run",
      generatedAt: "2026-07-15T00:00:00.000Z",
      git: {
        commitSha: "c".repeat(40),
        dirty: false,
      },
      configHash: "d".repeat(64),
      corpus: {
        id: "unknown",
      },
      provider: {
        id: "openai",
        mode: "real",
      },
      prompt: "must not survive",
    },
    cases: [{ prompt: "must not survive" }],
  });

  assert.deepEqual(reference, {
    reportType: "planner",
    reportId: "planner-real",
    runId: "planner-real-run",
    commitSha: "c".repeat(40),
    generatedAt: "2026-07-15T00:00:00.000Z",
    configHash: "d".repeat(64),
    corpusId: "unknown",
    providerMode: "real",
  });
});

test("evaluation evidence attaches additively without changing report semantics", async () => {
  const report = {
    summary: {
      config: {
        retrievalTopK: 6,
      },
      createdAt: "2026-07-15T01:00:00.000Z",
      metrics: {
        overallPassRate: 1,
      },
      runId: "synthetic-run",
    },
    cases: [{ id: "case-a", passed: true }],
  };
  const attached = await attachEvaluationEvidence(report, {
    command: "npm run eval:synthetic",
    gitState: {
      commitSha: "e".repeat(40),
      dirty: false,
    },
    provider: {
      id: "deterministic",
      mode: "deterministic",
    },
    reportId: "synthetic-default",
    reportType: "synthetic",
  });

  assert.notEqual(attached, report);
  assert.deepEqual(attached.summary, report.summary);
  assert.deepEqual(attached.cases, report.cases);
  assert.equal(attached.evidence.runId, "synthetic-run");
  assert.equal(
    attached.evidence.configHash,
    hashCanonicalJson(report.summary.config)
  );
});

test("evaluation corpus identity uses declared manifest version over machine paths", () => {
  assert.deepEqual(
    getCorpusIdentity({
      corpus: {
        metadata: {
          casesSource: "/private/cases.json",
          manifestName: "arxiv-computer-science-rerank-seed",
          manifestVersion: 1,
        },
      },
      corpusPath: "/private/generated/arxiv-corpus.json",
    }),
    {
      id: "arxiv-computer-science-rerank-seed",
      version: "1",
    }
  );
});

test("evaluation suite context is accepted only when the full public lineage is present", () => {
  assert.deepEqual(
    getEvaluationSuiteContext({
      EVAL_EVIDENCE_SUITE_CONFIG_HASH: "f".repeat(64),
      EVAL_EVIDENCE_SUITE_ID: "robust",
      EVAL_EVIDENCE_SUITE_RUN_ID: "robust-run",
    }),
    {
      configHash: "f".repeat(64),
      id: "robust",
      runId: "robust-run",
    }
  );
  assert.equal(
    getEvaluationSuiteContext({ EVAL_EVIDENCE_SUITE_ID: "robust" }),
    null
  );
});
