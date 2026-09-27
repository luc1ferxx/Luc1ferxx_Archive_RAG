#!/usr/bin/env node
// Fills sparse_length (migration 029) on chunk rows written before it, in every
// live index version's table (VECTOR_STORE_PROVIDER=pgvector).
//
// Until a row has its length, a BM25 search counts the positions of its
// tsvector every time it scores it, and a delete of it counts them again to
// log the length it takes away. Batches are short transactions with a lock
// timeout and SKIP LOCKED, so a batch never queues behind a writer; each run
// starts over the rows still NULL, so it can be stopped and run again. The
// value written is the count the NULL stood for: no statistic changes and the
// statement trigger logs nothing (migration 030). Every updated row is a new
// row version that the table's indexes, HNSW included, index again: run it
// like a reindex, off-peak.
//
//   node sparse-length-backfill.mjs [--dry-run] [--batch-size 500]
//        [--lock-timeout-ms 2000] [--max-batches <n>]

import { pathToFileURL } from "url";

import { runPostgresMigrations } from "./rag/db-migrations.js";
import { queryPostgres, resetPostgresPool, withPostgresTransaction } from "./rag/postgres.js";
import { runAsDatabaseSystem } from "./rag/postgres-tenant.js";
import { listLivePgvectorVersionTables } from "./rag/vector-store-pgvector.js";
import { backfillPgvectorSparseLength } from "./rag/vector-store-pgvector-sparse.js";

const USAGE = `Usage: node sparse-length-backfill.mjs [--dry-run] [--batch-size <n>] [--lock-timeout-ms <n>] [--max-batches <n>]

Fills sparse_length on chunk rows written before migration 029, in every live
index version's table, a short transaction per batch.`;

const positiveInteger = (flag, value) => {
  const number = Number(value);

  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${flag} needs a positive integer. Received "${value}".`);
  }

  return number;
};

export const parseSparseLengthBackfillArgs = (argv = []) => {
  const options = { batchSize: 500, dryRun: false, help: false, lockTimeoutMs: 2000, maxBatches: Number.POSITIVE_INFINITY };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];

    if (flag === "--dry-run") {
      options.dryRun = true;
    } else if (flag === "--help" || flag === "-h") {
      options.help = true;
    } else if (flag === "--batch-size") {
      options.batchSize = positiveInteger(flag, argv[(index += 1)]);
    } else if (flag === "--lock-timeout-ms") {
      options.lockTimeoutMs = positiveInteger(flag, argv[(index += 1)]);
    } else if (flag === "--max-batches") {
      options.maxBatches = positiveInteger(flag, argv[(index += 1)]);
    } else {
      throw new Error(`Unknown option "${flag}".\n${USAGE}`);
    }
  }

  return options;
};

export const main = async ({ argv = process.argv.slice(2), stdout = process.stdout } = {}) => {
  const options = parseSparseLengthBackfillArgs(argv);

  if (options.help) {
    stdout.write(`${USAGE}\n`);
    return null;
  }

  return runAsDatabaseSystem(async () => {
    await runPostgresMigrations();

    const report = await backfillPgvectorSparseLength({
      ...options,
      chunkTables: await listLivePgvectorVersionTables(),
      onBatch: ({ batches, table, updated }) => {
        if (batches % 20 === 0) {
          stdout.write(`${table}: ${updated} rows after ${batches} batches\n`);
        }
      },
      query: queryPostgres,
      withTransaction: (callback) =>
        withPostgresTransaction((client) => callback((sql, values) => client.query(sql, values))),
    });

    for (const entry of report) {
      stdout.write(
        `${entry.table}: ${entry.missingBefore} rows without sparse_length${
          options.dryRun ? " (dry run)" : `, ${entry.updated} filled, ${entry.missingAfter} left`
        }\n`
      );
    }

    return report;
  });
};

const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  await import("dotenv/config");

  main()
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(() => resetPostgresPool());
}
