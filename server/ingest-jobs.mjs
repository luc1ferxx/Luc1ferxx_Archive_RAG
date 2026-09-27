#!/usr/bin/env node
// Operator commands for the staged ingest queue (RAG_INGEST_MODE=async,
// PostgreSQL). `npm run ingest:jobs -- <command>`.
//
//   counts                        jobs per status over every tenant
//   dead-letter list              jobs whose stage ran out of attempts, with the
//                                 stage and the reason, newest first
//   dead-letter requeue <jobId>   put one back in the queue at the stage it died
//                                 in, with that stage's full budget again
//   backfill-hashes               compute content_sha256 for documents stored
//                                 before migration 018, so identical uploads are
//                                 recognised as duplicates of them too
//
// The dead-letter commands are owner-scoped: name the owner (--user and/or
// --workspace, matched exactly; an omitted one means the empty value) or pass
// --all to act across every tenant. They run as the table owner, like the
// worker, so the row policies do not narrow them.

import { pathToFileURL } from "url";

import { isPostgresDatabaseConfigured } from "./rag/config.js";
import { backfillDocumentContentHashes } from "./rag/doc-registry.js";
import {
  createPostgresIngestJobStore,
  toDeadLetterIngestJob,
} from "./rag/ingest-job-store.js";
import { resetPostgresPool } from "./rag/postgres.js";
import { runAsDatabaseSystem } from "./rag/postgres-tenant.js";

export const USAGE = `Usage: node ingest-jobs.mjs <command> [options]

Commands
  counts                              Jobs per status, every tenant.
  dead-letter list                    Dead-letter jobs (stage, reason, attempts), newest first.
  dead-letter requeue <jobId>         Requeue one dead-letter job at the stage it died in.
  backfill-hashes                     Hash documents stored before content hashes existed.

Scope (dead-letter commands; one of them is required)
  --user <id>                         The owner user id (exact).
  --workspace <id>                    The owner workspace id (exact).
  --all                               Every tenant.

Other
  --limit <n>                         dead-letter list: at most n jobs (default 50, at most 500).
  --batch-size <n>                    backfill-hashes: documents per statement (default 100).
  --dry-run                           backfill-hashes: only count what is missing.
  --json                              Print the result as JSON.
  --help                              Show this message.
`;

const VALUE_OPTIONS = new Map([
  ["--user", "user"],
  ["--workspace", "workspace"],
  ["--limit", "limit"],
  ["--batch-size", "batchSize"],
]);
const FLAG_OPTIONS = new Map([
  ["--all", "all"],
  ["--dry-run", "dryRun"],
  ["--json", "json"],
  ["--help", "help"],
  ["-h", "help"],
]);
const NUMERIC_OPTIONS = new Set(["limit", "batchSize"]);

export const parseIngestJobsArgs = (argv = []) => {
  const options = { all: false, dryRun: false, help: false, json: false };
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index]);
    const [name, inlineValue] =
      arg.startsWith("--") && arg.includes("=")
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

        if (!Number.isInteger(parsed) || parsed <= 0) {
          throw new Error(`${name} must be a positive integer. Received "${value}".`);
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

  const [command, subcommand, jobId, ...extra] = positionals;

  if (command === "dead-letter") {
    if (!["list", "requeue"].includes(subcommand)) {
      throw new Error('dead-letter needs "list" or "requeue <jobId>".');
    }

    if (subcommand === "requeue" && !jobId) {
      throw new Error("dead-letter requeue needs a job id.");
    }

    if (subcommand === "list" && jobId) {
      throw new Error(`Unexpected argument: ${jobId}`);
    }

    if (extra.length > 0) {
      throw new Error(`Unexpected argument: ${extra[0]}`);
    }

    const named = options.user !== undefined || options.workspace !== undefined;

    if (named === options.all) {
      throw new Error(
        named
          ? "Pass either an owner (--user/--workspace) or --all, not both."
          : "Name the owner whose jobs to act on (--user and/or --workspace), or pass --all for every tenant."
      );
    }

    return {
      ...options,
      command: `dead-letter ${subcommand}`,
      jobId: jobId ?? null,
      owner: named ? { ownerUserId: options.user ?? "", workspaceId: options.workspace ?? "" } : null,
    };
  }

  if (!["counts", "backfill-hashes"].includes(command)) {
    throw new Error(
      `Unknown command "${command ?? ""}". Expected counts, dead-letter list, dead-letter requeue or backfill-hashes.`
    );
  }

  if (subcommand !== undefined) {
    throw new Error(`Unexpected argument: ${subcommand}`);
  }

  return { ...options, command };
};

const formatDeadLetter = (job) =>
  [
    `${job.jobId}  ${job.kind}  doc ${job.requestedDocId}  owner "${job.ownerUserId}" / workspace "${job.workspaceId}"`,
    `  stage ${job.deadLetter?.stage ?? job.stage}, dead-lettered ${job.deadLetter?.deadLetteredAt ?? "?"}, requeued ${job.requeueCount} time(s)`,
    `  ${job.deadLetter?.reason ?? job.error ?? "no reason recorded"}`,
  ].join("\n");

/**
 * Runs one command and resolves to its result; `write` prints it. Everything
 * the command touches is injectable for tests.
 */
export const runIngestJobsCommand = async (
  argv,
  {
    backfill = backfillDocumentContentHashes,
    createStore = () => createPostgresIngestJobStore(),
    isConfigured = isPostgresDatabaseConfigured,
    write = (text) => process.stdout.write(text),
  } = {}
) => {
  const options = parseIngestJobsArgs(argv);

  if (options.help) {
    write(USAGE);
    return null;
  }

  if (!isConfigured()) {
    throw new Error(
      "ingest:jobs needs PostgreSQL (POSTGRES_DATABASE_URL): without it the ingest queue lives in the API process's memory."
    );
  }

  const print = (result, format) => write(options.json ? `${JSON.stringify(result, null, 2)}\n` : format(result));

  if (options.command === "backfill-hashes") {
    const result = await backfill({ batchSize: options.batchSize, dryRun: options.dryRun });

    print(result, (entry) =>
      entry.dryRun
        ? `${entry.missing} document(s) have no content hash yet.\n`
        : `Hashed ${entry.hashed} document(s); ${entry.remaining} still without a hash.\n`
    );
    return result;
  }

  const store = createStore();

  await store.initialize?.();

  if (options.command === "counts") {
    const counts = await store.countByStatus();

    print(counts, (entry) =>
      `${Object.entries(entry)
        .map(([status, count]) => `${status}: ${count}`)
        .join("\n")}\n`
    );
    return counts;
  }

  if (options.command === "dead-letter list") {
    const jobs = (
      await runAsDatabaseSystem(() => store.listDeadLetters({ limit: options.limit ?? 50, owner: options.owner }))
    ).map(toDeadLetterIngestJob);

    print(jobs, (entries) =>
      entries.length === 0 ? "No dead-letter jobs.\n" : `${entries.map(formatDeadLetter).join("\n\n")}\n`
    );
    return jobs;
  }

  const requeued = await runAsDatabaseSystem(() =>
    store.requeue({ jobId: options.jobId, owner: options.owner })
  );

  if (!requeued) {
    throw new Error(
      `No dead-letter job ${options.jobId}${options.owner ? " for that owner" : ""}. List them with: dead-letter list.`
    );
  }

  const result = toDeadLetterIngestJob(requeued);

  print(result, (entry) =>
    `Requeued ${entry.jobId} at stage ${entry.stage} (${entry.maxAttempts} attempt(s)); workers pick it up at once.\n`
  );
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

  runIngestJobsCommand(process.argv.slice(2))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(() => resetPostgresPool());
}
