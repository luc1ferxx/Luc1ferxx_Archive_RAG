#!/usr/bin/env node
// Zero-downtime pgvector index versions (VECTOR_STORE_PROVIDER=pgvector).
//
//   status                 the registry: active version, build progress, drift
//   build [space/index]    create a version (own table, width, indexes, policy,
//                          sparse-rank function) and re-embed every document
//                          from the PDF bytes the registry stores, in batches
//   resume                 continue a build whose builder died, once its lease
//                          has expired
//   validate <id>          the activation gate alone, read-only
//   activate <id>          the gate, then one atomic pointer switch; every API
//                          instance follows within RAG_INDEX_VERSION_POINTER_TTL_MS
//   rollback               switch back to the previous version while it is still
//                          inside its dual-write grace period
//   retire <id> [--force]  retire a non-active version (it stops taking writes at
//                          once), then drop its table and function a short lock
//                          attempt at a time; run it again if the drop reports
//                          that it is still pending
//
// While a version builds, and for the grace period after it is replaced,
// every ingest, delete and clear writes it too, so nothing is lost between the
// build's snapshot and the switch, nor between a switch and a rollback. See
// rag/vector-store-pgvector-versions.js for the lock protocol.

import { readFile } from "fs/promises";
import { pathToFileURL } from "url";

import { resetPostgresPool } from "./rag/postgres.js";
import {
  activateIndexVersion,
  assertIndexVersionsSupported,
  resolveBuildEmbeddingSpace,
  resumeIndexVersionBuild,
  retireIndexVersion,
  rollbackIndexVersion,
  startIndexVersionBuild,
  validateIndexVersion,
} from "./rag/vector-store-pgvector-version-lifecycle.js";
import { describeIndexVersions } from "./rag/vector-store-pgvector-versions.js";

const USAGE = `Usage: node vector-index.mjs <command> [options]

Commands
  status                        Show every index version, the active pointer, build progress and drift.
  build                         Create a new version and build it.
  resume                        Continue the building version after its builder died (lease expired).
  validate <versionId>          Run the activation gate without switching.
  activate <versionId>          Validate, then switch the active pointer to the version.
  rollback                      Validate and switch back to the previous version (inside its grace period).
  retire <versionId>            Retire a non-active version and drop its table and sparse-rank function
                                (again on a retired version whose drop is still pending).

Build options (default: the configured embedding model and index settings)
  --model <name>                Embedding model of the new version.
  --dimensions <n>              Its vector width (required when the model's width is not known).
  --document-prefix <text>      Document task prefix (default: the model's documented one).
  --query-prefix <text>         Query task prefix (default: the model's documented one).
  --index-type hnsw|ivfflat     ANN index method.
  --hnsw-m <n>  --hnsw-ef-construction <n>  --ivfflat-lists <n>
  --text-search-config <name>   PostgreSQL text search configuration of the lexical route.
  --batch-size <n>              Documents per batch (RAG_INDEX_VERSION_BUILD_BATCH_SIZE).
  --lease-ms <n>                Builder lease (RAG_INDEX_VERSION_BUILD_LEASE_MS).

Activation options (activate, validate, rollback)
  --allow-chunk-count-drift     Accept per-document chunk counts that differ from the active version
                                (a rebuild under another chunking), as long as no document loses all chunks.
  --active-unreadable           The active version's table is gone: skip the comparisons with it and
                                judge the target on its own checks; the old active version is marked failed.
  --probe-sample <n>            Recall probe: embed n stored chunks as queries; each must find itself in the top K.
  --probe-queries <file.json>   Recall probe: stored queries (strings or {"query": ...}); the new version must
                                return the active version's top K.
  --probe-top-k <k>             K for the probe (default 5).
  --min-recall <0..1>           Probe minimum (default 0.8).
  --grace-ms <n>                How long the replaced version keeps receiving writes
                                (RAG_INDEX_VERSION_DUAL_WRITE_GRACE_MS; never below twice the pointer TTL).

Other
  --force                       retire: also inside the rollback window, or abort a live build.
  --json                        Print the result as JSON.
  --help                        Show this message.

Only the pgvector provider has versions. The local and Qdrant providers keep one
index that npm run vector:reindex rewrites in place.
`;

const COMMANDS = new Set(["status", "build", "resume", "validate", "activate", "rollback", "retire"]);
const VALUE_OPTIONS = new Map([
  ["--model", "model"],
  ["--dimensions", "dimensions"],
  ["--document-prefix", "documentPrefix"],
  ["--query-prefix", "queryPrefix"],
  ["--index-type", "indexType"],
  ["--hnsw-m", "hnswM"],
  ["--hnsw-ef-construction", "hnswEfConstruction"],
  ["--ivfflat-lists", "ivfflatLists"],
  ["--text-search-config", "textSearchConfig"],
  ["--batch-size", "batchSize"],
  ["--lease-ms", "leaseMs"],
  ["--probe-sample", "probeSample"],
  ["--probe-queries", "probeQueries"],
  ["--probe-top-k", "probeTopK"],
  ["--min-recall", "minRecall"],
  ["--grace-ms", "graceMs"],
]);
const FLAG_OPTIONS = new Map([
  ["--active-unreadable", "allowUnreadableActive"],
  ["--allow-chunk-count-drift", "allowChunkCountDrift"],
  ["--force", "force"],
  ["--json", "json"],
  ["--help", "help"],
  ["-h", "help"],
]);
const NUMERIC_OPTIONS = new Set([
  "dimensions",
  "hnswM",
  "hnswEfConstruction",
  "ivfflatLists",
  "batchSize",
  "leaseMs",
  "probeSample",
  "probeTopK",
  "minRecall",
  "graceMs",
]);

export const parseArgs = (argv = []) => {
  const options = {
    allowChunkCountDrift: false,
    allowUnreadableActive: false,
    command: null,
    force: false,
    help: false,
    json: false,
    versionId: null,
  };
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index]);
    const [name, inlineValue] = arg.startsWith("--") && arg.includes("=")
      ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
      : [arg, undefined];

    if (FLAG_OPTIONS.has(name)) {
      options[FLAG_OPTIONS.get(name)] = true;
    } else if (VALUE_OPTIONS.has(name)) {
      const value = inlineValue ?? argv[++index];

      if (value === undefined) {
        throw new Error(`${name} needs a value.`);
      }

      const key = VALUE_OPTIONS.get(name);

      if (NUMERIC_OPTIONS.has(key)) {
        const parsed = Number(value);

        if (!Number.isFinite(parsed) || parsed < 0) {
          throw new Error(`${name} must be a non-negative number. Received "${value}".`);
        }

        options[key] = parsed;
      } else {
        options[key] = String(value);
      }
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  if (options.help) {
    return options;
  }

  const [command = "status", versionId = null, ...extra] = positionals;

  if (!COMMANDS.has(command)) {
    throw new Error(`Unknown command "${command}". Expected one of ${[...COMMANDS].join(", ")}.`);
  }

  if (extra.length > 0) {
    throw new Error(`Unexpected argument: ${extra[0]}`);
  }

  if (["validate", "activate", "retire"].includes(command)) {
    const parsed = Number(versionId);

    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`${command} needs a version id (a positive integer).`);
    }

    options.versionId = parsed;
  } else if (versionId !== null) {
    throw new Error(`${command} takes no version id.`);
  }

  if (options.indexType !== undefined && !["hnsw", "ivfflat"].includes(options.indexType)) {
    throw new Error(`--index-type must be hnsw or ivfflat. Received "${options.indexType}".`);
  }

  if (options.minRecall !== undefined && options.minRecall > 1) {
    throw new Error("--min-recall is a fraction between 0 and 1.");
  }

  options.command = command;
  return options;
};

const readProbeQueries = async (filePath) => {
  const parsed = JSON.parse(await readFile(filePath, "utf8"));
  const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.queries) ? parsed.queries : null;

  if (!entries) {
    throw new Error(`${filePath} must hold a JSON array of queries (strings or {"query": ...}).`);
  }

  return entries;
};

const buildProbe = async (options) => {
  const queries = options.probeQueries ? await readProbeQueries(options.probeQueries) : [];

  if (!options.probeSample && queries.length === 0) {
    return null;
  }

  return {
    minRecall: options.minRecall ?? 0.8,
    queries,
    sampleSize: options.probeSample ?? 0,
    topK: options.probeTopK ?? 5,
  };
};

const pickDefined = (entries) =>
  Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined));

const formatStatus = (status) => {
  if (status.registry !== "present") {
    return `Index version registry: ${status.registry} (run the migrations; version 1 is the existing chunk table).\n`;
  }

  const lines = [
    `Active version: ${status.active?.versionId ?? "none"} (pointer generation ${status.generation}, switched ${status.switchedAt ?? "never"})`,
    `Previous version: ${status.previousVersionId ?? "none"}`,
  ];

  if (status.building) {
    lines.push(
      `Building: version ${status.building.versionId} -- ${status.building.documentsDone}/${status.building.documentsTotal ?? "?"} document(s), ${status.building.documentsFailed} failed, builder ${status.building.builderId ?? "none"} (lease ${status.building.leaseExpired ? "expired" : `until ${status.building.leaseExpiresAt}`})`
    );
  }

  lines.push("");

  for (const version of status.versions) {
    lines.push(
      `${String(version.versionId).padStart(4)}  ${version.status.padEnd(9)} ${version.chunkTable.padEnd(32)} ${version.embedding.identity}/${version.embedding.dimensions} (${version.embedding.source})  chunks=${version.chunkCount ?? "?"}${version.dualWriteUntil ? `  dual-write until ${version.dualWriteUntil}` : ""}`
    );
  }

  for (const warning of status.warnings) {
    lines.push(`WARNING ${warning.code}: ${warning.message}`);
  }

  for (const problem of status.problems) {
    lines.push(`PROBLEM: ${problem}`);
  }

  return `${lines.join("\n")}\n`;
};

const formatValidation = (report) =>
  [
    `Version ${report.versionId} against active version ${report.activeVersionId}: ${report.ok ? "PASS" : "FAIL"}`,
    report.totals
      ? `  ${report.totals.documents} document(s); ${report.totals.activeChunks ?? "?"} chunk(s) active, ${report.totals.targetChunks} in version ${report.versionId}; ${
          report.mismatchedDocuments ?? "unknown (active table unreadable)"
        } document(s) with a different chunk count, ${report.staleDocuments ?? 0} with stale content`
      : null,
    report.probe?.selfRetrieval
      ? `  self-retrieval recall@${report.probe.topK}: ${report.probe.selfRetrieval.recall} over ${report.probe.selfRetrieval.sampled} chunk(s)`
      : null,
    report.probe?.queryAgreement
      ? `  agreement@${report.probe.topK} with the active version: ${report.probe.queryAgreement.meanAgreement} over ${report.probe.queryAgreement.queries} quer(ies)`
      : null,
    ...report.reasons.map((reason) => `  - ${reason}`),
  ]
    .filter(Boolean)
    .join("\n") + "\n";

export const main = async ({ argv = process.argv.slice(2), stdout = process.stdout } = {}) => {
  const options = parseArgs(argv);
  const write = (text) => stdout.write(text);
  const print = (result, format) => write(options.json ? `${JSON.stringify(result, null, 2)}\n` : format(result));

  if (options.help) {
    write(USAGE);
    return null;
  }

  assertIndexVersionsSupported();

  if (options.command === "status") {
    const status = await describeIndexVersions();

    print(status, formatStatus);
    return status;
  }

  if (options.command === "build" || options.command === "resume") {
    const logger = options.json ? null : (line) => write(`${line}\n`);
    const buildOptions = pickDefined({ batchSize: options.batchSize, leaseMs: options.leaseMs, logger });
    const result =
      options.command === "build"
        ? await startIndexVersionBuild({
            ...buildOptions,
            indexParams: pickDefined({
              hnswEfConstruction: options.hnswEfConstruction,
              hnswM: options.hnswM,
              indexType: options.indexType,
              ivfflatLists: options.ivfflatLists,
              textSearchConfig: options.textSearchConfig,
            }),
            space: resolveBuildEmbeddingSpace({
              dimensions: options.dimensions ?? null,
              documentPrefix: options.documentPrefix ?? null,
              model: options.model ?? null,
              queryPrefix: options.queryPrefix ?? null,
            }),
          })
        : await resumeIndexVersionBuild(buildOptions);

    print(result, (entry) =>
      `Version ${entry.versionId} is ready: ${entry.indexed} document(s) indexed, ${entry.skippedDeleted} deleted during the build, ${entry.failed} failed. Validate and activate it with: npm run vector:index -- activate ${entry.versionId}\n`
    );
    return result;
  }

  const probe = await buildProbe(options);
  const gateOptions = pickDefined({
    allowChunkCountDrift: options.allowChunkCountDrift,
    allowUnreadableActive: options.allowUnreadableActive,
    graceMs: options.graceMs,
    probe,
  });

  if (options.command === "validate") {
    const report = await validateIndexVersion({ ...gateOptions, versionId: options.versionId });

    print(report, formatValidation);

    if (!report.ok) {
      process.exitCode = 1;
    }

    return report;
  }

  if (options.command === "activate" || options.command === "rollback") {
    const result =
      options.command === "activate"
        ? await activateIndexVersion({ ...gateOptions, versionId: options.versionId })
        : await rollbackIndexVersion(gateOptions);

    print(result, (entry) =>
      `${formatValidation(entry.validation)}Active version is now ${entry.activeVersionId} (was ${entry.previousVersionId}; ${
        entry.previousFailed
          ? "its table was unreadable, so it is marked failed and takes no writes"
          : `it keeps receiving writes until ${entry.previousDualWriteUntil}`
      }). API instances follow within the pointer TTL.\n`
    );
    return result;
  }

  const result = await retireIndexVersion({ force: options.force, versionId: options.versionId });

  print(result, (entry) =>
    entry.dropPending
      ? `Version ${entry.versionId} retired: it takes no writes. Dropping ${entry.chunkTable} did not get its lock on the documents table in ${entry.dropAttempts} short attempt(s) (a long reader holds it); run retire ${entry.versionId} again to finish.\n`
      : `Version ${entry.versionId} retired (${entry.droppedTable ? `dropped ${entry.chunkTable} and its sparse-rank function` : `emptied ${entry.chunkTable}, which the migrations own`}).\n`
  );

  if (result.dropPending) {
    process.exitCode = 1;
  }

  return result;
};

// Run only when invoked as a script. Importing the module for tests must not
// execute a command.
const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  // The environment file is read only when this runs as a command, so a test
  // that imports the module never picks one up.
  await import("dotenv/config");

  main()
    .catch((error) => {
      const validation = error?.details?.validation;

      if (validation) {
        process.stderr.write(formatValidation(validation));
      }

      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(() => resetPostgresPool());
}
