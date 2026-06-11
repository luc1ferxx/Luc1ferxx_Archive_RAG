import {
  getRunCorpusName,
  getWorstStatus,
  toTimestamp,
} from "./quality-shared.js";

const regressionMetricChecks = [
  {
    metric: "overallPassRate",
    label: "Overall pass rate",
    warnDrop: 0.02,
    failDrop: 0.05,
  },
  {
    metric: "qaPageHitRate",
    label: "QA page hit rate",
    warnDrop: 0.05,
    failDrop: 0.1,
  },
  {
    metric: "comparePageHitRate",
    label: "Compare page hit rate",
    warnDrop: 0.05,
    failDrop: 0.1,
  },
  {
    metric: "averageCitationCount",
    label: "Average citations",
    warnDrop: 0.5,
    failDrop: 1,
  },
];

const regressionProfileConfigKeys = [
  "chunkStrategy",
  "chunkSize",
  "chunkOverlap",
  "retrievalTopK",
  "compareTopKPerDoc",
  "maxComparisonSources",
  "minRelevanceScore",
  "nearDuplicateGuardEnabled",
  "rerankProvider",
  "rerankEnabled",
  "hybridEnabled",
  "hybridRrfK",
  "candidateMultiplier",
  "embeddingProvider",
];

const getRegressionProfileKey = (run = {}) => {
  const config = run.config && typeof run.config === "object" ? run.config : {};
  const models = run.models && typeof run.models === "object" ? run.models : {};
  const profileConfig = {};

  for (const key of regressionProfileConfigKeys) {
    if (Object.hasOwn(config, key)) {
      profileConfig[key] = config[key];
    }
  }

  const profileModels = {};

  for (const key of ["embedding", "chat"]) {
    if (Object.hasOwn(models, key)) {
      profileModels[key] = models[key];
    }
  }

  if (
    Object.keys(profileConfig).length === 0 &&
    Object.keys(profileModels).length === 0
  ) {
    return null;
  }

  return JSON.stringify({
    config: profileConfig,
    models: profileModels,
  });
};

const buildRegressionMetricCheck = ({ baselineRun, currentRun, definition }) => {
  const baselineValue = baselineRun.metrics?.[definition.metric];
  const currentValue = currentRun.metrics?.[definition.metric];

  if (typeof baselineValue !== "number" || typeof currentValue !== "number") {
    return {
      metric: definition.metric,
      label: definition.label,
      status: "unknown",
      baselineValue: baselineValue ?? null,
      currentValue: currentValue ?? null,
      delta: null,
    };
  }

  const delta = Number((currentValue - baselineValue).toFixed(4));
  const status =
    delta <= -definition.failDrop
      ? "fail"
      : delta <= -definition.warnDrop
        ? "warn"
        : "pass";

  return {
    metric: definition.metric,
    label: definition.label,
    status,
    baselineValue,
    currentValue,
    delta,
    warnDrop: definition.warnDrop,
    failDrop: definition.failDrop,
  };
};

const buildFailedCaseCheck = ({ baselineRun, currentRun }) => {
  const baselineValue = baselineRun.failedCaseCount ?? 0;
  const currentValue = currentRun.failedCaseCount ?? 0;
  const delta = currentValue - baselineValue;
  const status = delta >= 2 ? "fail" : delta >= 1 ? "warn" : "pass";

  return {
    metric: "failedCaseCount",
    label: "Failed cases",
    status,
    baselineValue,
    currentValue,
    delta,
    warnIncrease: 1,
    failIncrease: 2,
  };
};

const chooseFirstBaseline = ({
  candidates,
  currentCorpusName,
  currentProfileKey,
  strategy,
}) => {
  const matchingRun = candidates.find((run) => {
    const sameCorpus = getRunCorpusName(run) === currentCorpusName;
    const sameProfile =
      currentProfileKey && getRegressionProfileKey(run) === currentProfileKey;

    if (strategy === "same_corpus_same_profile") {
      return sameCorpus && sameProfile;
    }

    if (strategy === "same_corpus") {
      return sameCorpus;
    }

    if (strategy === "same_profile") {
      return sameProfile;
    }

    return true;
  });

  return matchingRun
    ? {
        run: matchingRun,
        strategy,
      }
    : null;
};

const baselineStrategyLabels = {
  same_corpus_same_profile: "same corpus and profile",
  same_corpus: "same corpus",
  same_profile: "same profile",
  previous_run: "previous synthetic run",
  none: "none",
};

export const selectRegressionBaseline = ({
  currentRun = null,
  sortedRuns = [],
} = {}) => {
  if (!currentRun) {
    return {
      run: null,
      selection: {
        strategy: "none",
        label: baselineStrategyLabels.none,
        candidateCount: 0,
        previousCandidateCount: 0,
        corpusName: null,
        profileMatched: false,
      },
    };
  }

  const currentTimestamp = toTimestamp(currentRun.createdAt);
  const candidates = sortedRuns.filter((run) => run.runId !== currentRun.runId);
  const previousCandidates = candidates.filter((run) => {
    const candidateTimestamp = toTimestamp(run.createdAt);

    return currentTimestamp === 0 || candidateTimestamp <= currentTimestamp;
  });
  const orderedCandidates =
    previousCandidates.length > 0 ? previousCandidates : candidates;
  const currentCorpusName = getRunCorpusName(currentRun);
  const currentProfileKey = getRegressionProfileKey(currentRun);
  const strategies = [
    "same_corpus_same_profile",
    "same_corpus",
    "same_profile",
    "previous_run",
  ];
  const matchedBaseline = strategies
    .map((strategy) =>
      chooseFirstBaseline({
        candidates: orderedCandidates,
        currentCorpusName,
        currentProfileKey,
        strategy,
      })
    )
    .find(Boolean);

  if (!matchedBaseline) {
    return {
      run: null,
      selection: {
        strategy: "none",
        label: baselineStrategyLabels.none,
        candidateCount: candidates.length,
        previousCandidateCount: previousCandidates.length,
        corpusName: currentCorpusName,
        profileMatched: false,
      },
    };
  }

  const baselineRun = matchedBaseline.run;
  const baselineProfileKey = getRegressionProfileKey(baselineRun);

  return {
    run: baselineRun,
    selection: {
      strategy: matchedBaseline.strategy,
      label: baselineStrategyLabels[matchedBaseline.strategy],
      candidateCount: candidates.length,
      previousCandidateCount: previousCandidates.length,
      corpusName: getRunCorpusName(baselineRun),
      profileMatched:
        Boolean(currentProfileKey) && baselineProfileKey === currentProfileKey,
    },
  };
};

export const buildRegressionGate = ({
  baselineRun = null,
  baselineSelection = null,
  currentRun = null,
} = {}) => {
  if (!currentRun) {
    return {
      status: "unknown",
      currentRunId: null,
      baselineRunId: null,
      baselineSelection,
      checks: [],
      summary: "No synthetic evaluation run is available yet.",
    };
  }

  if (!baselineRun) {
    return {
      status: "unknown",
      currentRunId: currentRun.runId,
      baselineRunId: null,
      baselineSelection,
      checks: [],
      summary: "No previous synthetic run is available for regression comparison.",
    };
  }

  const checks = [
    ...regressionMetricChecks.map((definition) =>
      buildRegressionMetricCheck({
        baselineRun,
        currentRun,
        definition,
      })
    ),
    buildFailedCaseCheck({
      baselineRun,
      currentRun,
    }),
  ];
  const status = getWorstStatus(checks.map((check) => check.status));
  const summary =
    status === "fail"
      ? "Regression detected against the previous synthetic run."
      : status === "warn"
        ? "Possible quality regression detected against the previous synthetic run."
        : "No regression detected against the previous synthetic run.";

  return {
    status,
    currentRunId: currentRun.runId,
    baselineRunId: baselineRun.runId,
    baselineCreatedAt: baselineRun.createdAt,
    baselineSelection,
    checks,
    summary,
  };
};
