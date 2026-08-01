#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveEvaluationGitState } from "./eval-evidence.js";
import { robustEvalSuite } from "./eval-suite.js";
import {
  buildRobustSuiteChildEnvironment,
  buildRobustSuiteExecutionPlan,
} from "./robust-suite-execution.js";
import { verifyPinnedCorpus } from "./pinned-corpus-validation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverDirectory = path.join(__dirname, "..");

const usage = `Usage: npm run eval:robust-suite -- [options]

Options:
  --suite <name>                  Evaluation suite to run. Defaults to robust.
  --synthetic-provider <mode>     Provider for synthetic answer eval: real or deterministic. Defaults to real.
  --help                          Show this message.
`;

export const parseRobustSuiteArgs = (argv) => {
  const options = {
    help: false,
    suite: "robust",
    syntheticProvider: "real",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const rawArg = argv[index];

    if (rawArg === "--help" || rawArg === "-h") {
      options.help = true;
      continue;
    }

    const option = rawArg.slice(2);
    const equalsIndex = option.indexOf("=");
    const key = equalsIndex === -1 ? option : option.slice(0, equalsIndex);
    const inlineValue =
      equalsIndex === -1 ? undefined : option.slice(equalsIndex + 1);
    const nextValue = argv[index + 1];
    const value = inlineValue ?? nextValue;

    if (!rawArg.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Unknown or incomplete option: ${rawArg}`);
    }

    if (key === "suite") {
      options.suite = value;
      if (inlineValue === undefined) {
        index += 1;
      }
      continue;
    }

    if (key === "synthetic-provider") {
      options.syntheticProvider = value;
      if (inlineValue === undefined) {
        index += 1;
      }
      continue;
    }

    throw new Error(`Unknown option: ${rawArg}`);
  }

  if (options.suite !== robustEvalSuite.id) {
    throw new Error(`Unknown evaluation suite: ${options.suite}`);
  }

  if (!["deterministic", "real"].includes(options.syntheticProvider)) {
    throw new Error("--synthetic-provider must be either deterministic or real.");
  }

  return options;
};

const runNodeStep = async ({ args, environment, label }) => {
  console.log(`\n==> ${label}`);
  console.log(`node ${args.join(" ")}`);

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: serverDirectory,
      env: environment ?? process.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${label} failed with exit code ${code}.`));
    });
  });
};

export const verifyPinnedCorpora = async (executionPlan) => {
  for (const report of executionPlan.contract.reports) {
    if (!report.corpusIntegrity) {
      continue;
    }

    const verification = await verifyPinnedCorpus({
      expected: report.corpusIntegrity,
      filePath: path.resolve(serverDirectory, report.corpusPath),
    });

    console.log(
      `Verified pinned corpus ${verification.id}@${verification.version} (${verification.contentHash}).`
    );
  }
};

const main = async () => {
  const options = parseRobustSuiteArgs(process.argv.slice(2));

  if (options.help) {
    console.log(usage.trim());
    return;
  }

  const executionPlan = buildRobustSuiteExecutionPlan({
    options,
    suite: robustEvalSuite,
  });
  await verifyPinnedCorpora(executionPlan);
  const gitState = await resolveEvaluationGitState({
    targetCommit: process.env.EVAL_TARGET_COMMIT_SHA ?? "",
  });
  const suiteRunId = `robust-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const suiteConfigHash = executionPlan.configHash;
  const evidenceEnvironment = {
    EVAL_EVIDENCE_SUITE_CONFIG_HASH: suiteConfigHash,
    EVAL_EVIDENCE_SUITE_ID: robustEvalSuite.id,
    EVAL_EVIDENCE_SUITE_RUN_ID: suiteRunId,
  };

  if (gitState.commitSha !== "unknown") {
    evidenceEnvironment.EVAL_TARGET_COMMIT_SHA = gitState.commitSha;
  }

  for (const step of executionPlan.steps) {
    await runNodeStep({
      ...step,
      environment: buildRobustSuiteChildEnvironment({
        baseEnvironment: process.env,
        evidenceEnvironment,
        step,
      }),
    });
  }

  console.log(
    JSON.stringify(
      {
        suite: robustEvalSuite.id,
        suiteRunId,
        suiteConfigHash,
        reports: robustEvalSuite.reports.map((report) => ({
          id: report.id,
          latestName: report.latestName,
        })),
      },
      null,
      2
    )
  );
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
