import "dotenv/config";
import { performance } from "node:perf_hooks";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  configureCrossEncoderProvider,
  configureRerankMetricsCollector,
  rerankResultsWithProvider,
  resetCrossEncoderProvider,
  resetRerankMetricsCollector,
} from "../rag/reranker.js";
import { getCrossEncoderEndpoint, getCrossEncoderModel } from "../rag/config.js";

const defaultQuery = "What is the quartz capsule approval policy?";

const parseArgs = (argv) => {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const rawArg = argv[index];

    if (!rawArg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${rawArg}`);
    }

    const [key, inlineValue] = rawArg.slice(2).split("=", 2);
    const nextValue = argv[index + 1];

    if (inlineValue !== undefined) {
      args[key] = inlineValue;
    } else if (nextValue && !nextValue.startsWith("--")) {
      args[key] = nextValue;
      index += 1;
    } else {
      args[key] = true;
    }
  }

  return args;
};

const toPositiveInteger = (value, fallbackValue, name) => {
  if (value === undefined) {
    return fallbackValue;
  }

  const parsedValue = Number(value);

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsedValue;
};

const toNonNegativeNumber = (value, fallbackValue, name) => {
  if (value === undefined) {
    return fallbackValue;
  }

  const parsedValue = Number(value);

  if (!Number.isFinite(parsedValue) || parsedValue < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }

  return parsedValue;
};

const sleep = (durationMs) =>
  new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });

const round = (value) =>
  Number.isFinite(value) ? Number(value.toFixed(3)) : null;

const percentile = (sortedValues, percentileValue) => {
  if (sortedValues.length === 0) {
    return null;
  }

  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sortedValues.length) - 1)
  );

  return round(sortedValues[index]);
};

const summarize = (values) => {
  const safeValues = values
    .filter((value) => Number.isFinite(value))
    .slice()
    .sort((left, right) => left - right);

  if (safeValues.length === 0) {
    return {
      count: 0,
      min: null,
      max: null,
      avg: null,
      p50: null,
      p90: null,
      p95: null,
      p99: null,
    };
  }

  return {
    count: safeValues.length,
    min: round(safeValues[0]),
    max: round(safeValues[safeValues.length - 1]),
    avg: round(
      safeValues.reduce((sum, value) => sum + value, 0) / safeValues.length
    ),
    p50: percentile(safeValues, 50),
    p90: percentile(safeValues, 90),
    p95: percentile(safeValues, 95),
    p99: percentile(safeValues, 99),
  };
};

const buildCandidateText = ({ index, repeat }) => {
  const body = [
    `Candidate ${index}: quartz capsule approval requires finance sign-off.`,
    "Archive notes include reviewer routing, exception windows, and escalation details.",
    index % 3 === 0
      ? "The relevant approval owner is the finance operations lead."
      : "This candidate mostly contains adjacent policy language.",
  ].join(" ");

  return Array.from({ length: repeat }, () => body).join("\n");
};

const buildCandidates = ({ candidateCount, textRepeat }) =>
  Array.from({ length: candidateCount }, (_, index) => ({
    document: {
      id: `candidate-${index + 1}`,
      pageContent: buildCandidateText({
        index: index + 1,
        repeat: textRepeat,
      }),
      metadata: {
        docId: "latency-benchmark",
        fileName: "latency-benchmark.pdf",
        pageNumber: index + 1,
      },
    },
    score: Math.max(0.01, 1 - index * 0.03),
  }));

const configureMockProvider = ({ mockDelayMs }) => {
  configureCrossEncoderProvider({
    score: async ({ pairs }) => {
      if (mockDelayMs > 0) {
        await sleep(mockDelayMs);
      }

      return pairs.map((pair, index) =>
        pair.text.includes("finance operations lead") ? 0.99 : 0.2 - index * 0.001
      );
    },
  });
};

const assertReadyForRealEndpoint = () => {
  if (!getCrossEncoderEndpoint().trim()) {
    throw new Error(
      [
        "RAG_CROSS_ENCODER_ENDPOINT is required for a real Cross-Encoder benchmark.",
        "Set it in server/.env or pass --mock-delay-ms to verify the latency harness.",
      ].join(" ")
    );
  }
};

const runOneIteration = async ({ query, candidates, topK }) => {
  const startedAt = performance.now();

  await rerankResultsWithProvider({
    queryText: query,
    results: candidates,
    topK,
  });

  return performance.now() - startedAt;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const iterations = toPositiveInteger(args.iterations, 20, "--iterations");
  const warmup = toPositiveInteger(args.warmup, 3, "--warmup");
  const candidateCount = toPositiveInteger(args.candidates, 18, "--candidates");
  const topK = toPositiveInteger(
    args["top-k"],
    Math.min(6, candidateCount),
    "--top-k"
  );
  const textRepeat = toPositiveInteger(args["text-repeat"], 1, "--text-repeat");
  const mockDelayMs = toNonNegativeNumber(
    args["mock-delay-ms"],
    null,
    "--mock-delay-ms"
  );
  const query = String(args.query ?? defaultQuery);
  const outputPath = args.output ? path.resolve(String(args.output)) : null;
  const candidates = buildCandidates({
    candidateCount,
    textRepeat,
  });
  const metricSamples = [];
  const totalLatencySamples = [];
  const mode = mockDelayMs === null ? "real-endpoint" : "mock-provider";

  if (topK > candidateCount) {
    throw new Error("--top-k must be less than or equal to --candidates.");
  }

  process.env.RAG_RERANK_ENABLED = "true";
  process.env.RAG_RERANK_PROVIDER = "cross-encoder";
  process.env.RAG_RERANK_WEIGHT = process.env.RAG_RERANK_WEIGHT || "0.6";

  if (mockDelayMs === null) {
    assertReadyForRealEndpoint();
  } else {
    configureMockProvider({
      mockDelayMs,
    });
  }

  configureRerankMetricsCollector((metric) => {
    metricSamples.push(metric);
  });

  try {
    for (let index = 0; index < warmup; index += 1) {
      await runOneIteration({
        query,
        candidates,
        topK,
      });
    }

    metricSamples.length = 0;

    for (let index = 0; index < iterations; index += 1) {
      totalLatencySamples.push(
        await runOneIteration({
          query,
          candidates,
          topK,
        })
      );
    }
  } finally {
    resetCrossEncoderProvider();
    resetRerankMetricsCollector();
  }

  const scoreLatencySamples = metricSamples
    .filter((metric) => metric.stage === "cross-encoder-score")
    .map((metric) => metric.latencyMs);
  const payload = {
    runId: new Date().toISOString().replace(/[:.]/g, "-"),
    createdAt: new Date().toISOString(),
    mode,
    endpointConfigured: Boolean(getCrossEncoderEndpoint().trim()),
    model: getCrossEncoderModel().trim() || null,
    config: {
      iterations,
      warmup,
      candidates: candidateCount,
      topK,
      queryCharacters: query.length,
      totalCandidateTextCharacters: candidates.reduce(
        (sum, result) => sum + result.document.pageContent.length,
        0
      ),
      mockDelayMs,
    },
    metrics: {
      crossEncoderScoreLatencyMs: summarize(scoreLatencySamples),
      totalRerankLatencyMs: summarize(totalLatencySamples),
    },
    samples: metricSamples.map((metric, index) => ({
      iteration: index + 1,
      ...metric,
      totalRerankLatencyMs: round(totalLatencySamples[index]),
    })),
  };
  const serializedPayload = `${JSON.stringify(payload, null, 2)}\n`;

  if (outputPath) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, serializedPayload, "utf8");
  }

  process.stdout.write(serializedPayload);
};

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
