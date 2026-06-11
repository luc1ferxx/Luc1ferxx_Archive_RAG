#!/usr/bin/env node

import {
  buildQualityGateDecision,
  formatFeedbackSkillFailureLine,
  readQualityHistory,
} from "./quality-report.js";

const usage = `Usage: npm run quality:gate -- [options]

Options:
  --json            Print the full quality history and gate decision as JSON.
  --fail-on-warn    Treat warning-level regressions as failures.
  --allow-unknown   Exit successfully when there is no baseline run yet.
  --limit=<number>  Limit returned run history. Default: 10.
  --help            Show this message.
`;

const parseArgs = (argv) => {
  const options = {
    allowUnknown: false,
    failOnWarn: false,
    json: false,
    help: false,
    limit: 10,
  };

  for (const arg of argv) {
    if (arg === "--allow-unknown") {
      options.allowUnknown = true;
      continue;
    }

    if (arg === "--fail-on-warn") {
      options.failOnWarn = true;
      continue;
    }

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg.startsWith("--limit=")) {
      const limit = Number.parseInt(arg.slice("--limit=".length), 10);

      if (!Number.isInteger(limit) || limit <= 0) {
        throw new Error("--limit must be a positive integer.");
      }

      options.limit = limit;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
};

const formatPercent = (value) =>
  typeof value === "number"
    ? `${value.toFixed(value % 1 === 0 ? 0 : 1)}%`
    : "N/A";

const formatDelta = (value, scale = 1) => {
  if (typeof value !== "number") {
    return "N/A";
  }

  const scaledValue = value * scale;
  const prefix = scaledValue > 0 ? "+" : "";
  return `${prefix}${scaledValue.toFixed(Math.abs(scaledValue) % 1 === 0 ? 0 : 1)}`;
};

const formatCheckDelta = (check) => {
  if (check.metric === "failedCaseCount") {
    return formatDelta(check.delta);
  }

  if (check.metric === "feedbackFailedCaseCount") {
    return formatDelta(check.delta);
  }

  if (check.metric === "feedbackUnsupportedClaimCount") {
    return formatDelta(check.delta);
  }

  if (check.metric === "trajectoryFailedCaseCount") {
    return formatDelta(check.delta);
  }

  if (check.metric === "plannerFailedCaseCount") {
    return formatDelta(check.delta);
  }

  if (check.metric === "plannerFailedCheckCount") {
    return formatDelta(check.delta);
  }

  if (check.metric === "averageCitationCount") {
    return formatDelta(check.delta);
  }

  return `${formatDelta(check.delta, 100)} pts`;
};

const printTextReport = ({ decision, history }) => {
  const qualityGate = history.qualityGate ?? {};
  const gate = history.regressionGate ?? {};
  const feedbackGate = history.feedbackGate ?? {};
  const trajectoryGate = history.trajectoryGate ?? {};
  const plannerGate = history.plannerGate ?? {};
  const latestRun = history.latestRun ?? {};
  const checks = qualityGate.checks ?? gate.checks ?? [];

  console.log(`Quality gate: ${decision.status.toUpperCase()}`);
  console.log(decision.summary);

  if (latestRun.runId) {
    console.log(
      `Latest run: ${latestRun.runId} (${formatPercent(
        latestRun.metrics?.overallPassPercent
      )} pass)`
    );
  }

  if (gate.baselineRunId) {
    console.log(`Baseline run: ${gate.baselineRunId}`);
  }

  if (gate.baselineSelection?.label) {
    console.log(`Baseline selection: ${gate.baselineSelection.label}`);
  }

  for (const check of checks) {
    console.log(`- ${check.label}: ${check.status} (${formatCheckDelta(check)})`);
  }

  if (feedbackGate.status) {
    const suffix = feedbackGate.skipped ? " (skipped)" : "";
    console.log(`Feedback gate: ${feedbackGate.status}${suffix}`);
    console.log(feedbackGate.summary);

    for (const skillFailure of feedbackGate.skillFailures ?? []) {
      console.log(`- ${formatFeedbackSkillFailureLine(skillFailure)}`);
    }
  }

  if (trajectoryGate.status) {
    const suffix = trajectoryGate.skipped ? " (skipped)" : "";
    console.log(`Trajectory gate: ${trajectoryGate.status}${suffix}`);
    console.log(trajectoryGate.summary);

    for (const failedCase of trajectoryGate.failedCases ?? []) {
      const failedCheckLabels = (failedCase.failedChecks ?? [])
        .map((check) => check.label)
        .join(", ");
      console.log(
        `- ${failedCase.id}: ${
          failedCheckLabels || `${failedCase.failedCheckCount ?? 0} failed checks`
        }`
      );
    }
  }

  if (plannerGate.status) {
    const suffix = plannerGate.skipped ? " (skipped)" : "";
    console.log(`Planner gate: ${plannerGate.status}${suffix}`);
    console.log(plannerGate.summary);

    for (const failedCase of plannerGate.failedCases ?? []) {
      const failedCheckLabels = (failedCase.failedChecks ?? [])
        .map((check) => check.label)
        .join(", ");
      console.log(
        `- ${failedCase.id}: ${
          failedCheckLabels || `${failedCase.failedCheckCount ?? 0} failed checks`
        }`
      );
    }
  }
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(usage.trim());
    return;
  }

  const history = await readQualityHistory({
    limit: options.limit,
  });
  const decision = buildQualityGateDecision({
    allowUnknown: options.allowUnknown,
    failOnWarn: options.failOnWarn,
    history,
  });

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          decision,
          history,
        },
        null,
        2
      )
    );
  } else {
    printTextReport({
      decision,
      history,
    });
  }

  process.exitCode = decision.exitCode;
};

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 2;
}
