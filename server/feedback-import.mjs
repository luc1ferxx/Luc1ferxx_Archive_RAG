#!/usr/bin/env node
// One-shot import of answer feedback from the JSONL file into PostgreSQL.
// `npm run feedback:import -- [--input <file>] [--apply] [--json]`.
//
// Before migration 034 every tenant's feedback went into one JSONL file
// (FEEDBACK_DIRECTORY/feedback.jsonl, by default server/data/feedback). With a
// database configured the server now writes and reads the rag_feedback table
// instead and no longer looks at the file, so records written before the
// upgrade stay out of GET /feedback and feedback:corpus until imported.
//
// - Dry run unless --apply: it reads and checks the file and counts what is
//   already in the table, and writes nothing.
// - Each record keeps its own userId / workspaceId as its owner columns, so
//   after the import each tenant sees exactly the records the file filter
//   showed it. It runs as the table owner, like the other operator commands.
// - A record whose feedbackId is already in the table is left as it is, so the
//   import can be run again (after an interruption, or for a second file).
// - Lines that are not a JSON object with a feedbackId, a known feedbackType,
//   a question and a parseable createdAt are skipped and counted, never
//   guessed at; a feedbackId seen earlier in the same file is skipped too.
// - The file is left untouched; remove it once the import is done.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  configureFeedbackDirectory,
  FEEDBACK_TYPES,
  getFeedbackFilePath,
} from "./feedback.js";
import { isPostgresDatabaseConfigured } from "./rag/config.js";
import { createPostgresFeedbackStore } from "./rag/postgres-feedback-store.js";
import { resetPostgresPool } from "./rag/postgres.js";
import { runAsDatabaseSystem } from "./rag/postgres-tenant.js";

export const USAGE = `Usage: node feedback-import.mjs [options]

Copies answer feedback from a JSONL file into the PostgreSQL feedback table
(migration 034). Dry run unless --apply.

Options
  --input <file>   The JSONL file (default: the file the server wrote without a
                   database, FEEDBACK_DIRECTORY/feedback.jsonl).
  --apply          Write the records. Records already in the table are kept.
  --json           Print the result as JSON.
  --help           Show this message.
`;

const ALLOWED_FEEDBACK_TYPES = new Set(FEEDBACK_TYPES);

export const parseFeedbackImportArgs = (argv = []) => {
  const options = { apply: false, help: false, input: null, json: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index]);
    const [name, inlineValue] =
      arg.startsWith("--") && arg.includes("=")
        ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
        : [arg, undefined];

    if (name === "--apply" || name === "--json" || name === "--help" || name === "-h") {
      options[name === "-h" ? "help" : name.slice(2)] = true;
    } else if (name === "--input") {
      const value = inlineValue ?? argv[++index];

      if (value === undefined || String(value).trim() === "") {
        throw new Error("--input needs a file path.");
      }

      options.input = String(value);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
};

const isPlainObject = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

// PostgreSQL's timestamptz holds years 0001-9999 as the insert normalizes them
// (toISOString): year 0, or a value that becomes "+010000-..." in UTC, would
// fail the insert (or be replaced by now), so such a line is skipped.
const isStorableTimestamp = (value) => {
  const time = Date.parse(value);

  if (Number.isNaN(time)) {
    return false;
  }

  return /^(?!0000)\d{4}-/.test(new Date(time).toISOString());
};

const isStorableId = (value) => typeof value === "string" && !value.includes("\u0000");

/**
 * Splits a file's lines into the records to import and the skipped ones,
 * counted by reason. Only what the table cannot hold or a record the server
 * would never have written is skipped; every other field is kept as written.
 */
export const prepareFeedbackImport = (lines = []) => {
  const records = [];
  const skipped = {};
  const seen = new Set();
  const skip = (reason) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };

  for (const line of lines) {
    let record;

    try {
      record = JSON.parse(line);
    } catch {
      skip("invalid_json");
      continue;
    }

    if (!isPlainObject(record)) {
      skip("not_an_object");
    } else if (!isStorableId(record.feedbackId) || !record.feedbackId.trim()) {
      skip("missing_feedback_id");
    } else if (!ALLOWED_FEEDBACK_TYPES.has(record.feedbackType)) {
      skip("unknown_feedback_type");
    } else if (typeof record.question !== "string" || !record.question.trim()) {
      skip("missing_question");
    } else if (
      typeof record.createdAt !== "string" ||
      !/^\d{4}-/.test(record.createdAt) ||
      !isStorableTimestamp(record.createdAt)
    ) {
      skip("invalid_created_at");
    } else if (
      !isStorableId(record.userId ?? "") ||
      !isStorableId(record.workspaceId ?? "")
    ) {
      skip("invalid_owner");
    } else if (seen.has(record.feedbackId)) {
      skip("duplicate_in_file");
    } else {
      seen.add(record.feedbackId);
      records.push(record);
    }
  }

  return { records, skipped };
};

const readLines = async (filePath) => {
  try {
    return (await readFile(filePath, "utf8"))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
};

const formatResult = (result) => {
  if (result.missing) {
    return `No feedback file at ${result.input}; nothing to import.\n`;
  }

  const skipped = Object.entries(result.skipped)
    .map(([reason, count]) => `  ${reason}: ${count}`)
    .join("\n");
  const lines = [
    `${result.input}: ${result.lines} line(s), ${result.valid} record(s) to import into ${result.table}.`,
    ...(skipped ? ["Skipped:", skipped] : []),
    result.apply
      ? `Imported ${result.inserted}; ${result.alreadyPresent} already in the table.`
      : `Dry run: ${result.wouldInsert} would be imported, ${result.alreadyPresent} already in the table. Run again with --apply to write them.`,
  ];

  return `${lines.join("\n")}\n`;
};

/**
 * Runs the import and resolves to its result; `write` prints it. Everything
 * it touches is injectable for tests.
 */
export const runFeedbackImportCommand = async (
  argv,
  {
    createStore = () => createPostgresFeedbackStore(),
    defaultInputPath = getFeedbackFilePath,
    isConfigured = isPostgresDatabaseConfigured,
    write = (text) => process.stdout.write(text),
  } = {}
) => {
  const options = parseFeedbackImportArgs(argv);

  if (options.help) {
    write(USAGE);
    return null;
  }

  if (!isConfigured()) {
    throw new Error(
      "feedback:import needs PostgreSQL (POSTGRES_DATABASE_URL): without a database the server keeps reading the JSONL file, so there is nothing to import into."
    );
  }

  const input = path.resolve(process.cwd(), options.input ?? defaultInputPath());
  const store = createStore();
  const table = store.describe?.().table ?? "";
  const lines = await readLines(input);
  const print = (result) =>
    write(options.json ? `${JSON.stringify(result, null, 2)}\n` : formatResult(result));

  if (lines === null) {
    const result = { apply: options.apply, input, missing: true, table };

    print(result);
    return result;
  }

  const { records, skipped } = prepareFeedbackImport(lines);
  const base = {
    apply: options.apply,
    input,
    lines: lines.length,
    missing: false,
    skipped,
    table,
    valid: records.length,
  };
  let result;

  // Owner path: the records belong to every tenant, and the row policy would
  // refuse a record that is not the bound tenant's.
  if (options.apply) {
    const imported = await runAsDatabaseSystem(() => store.importFeedback(records));

    result = { ...base, ...imported };
  } else {
    const alreadyPresent = await runAsDatabaseSystem(() =>
      store.countExistingFeedbackIds(records.map((record) => record.feedbackId))
    );

    result = { ...base, alreadyPresent, wouldInsert: records.length - alreadyPresent };
  }

  print(result);
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

  // feedback.js resolved its directory when this module was imported, before
  // the environment file was read.
  if (process.env.FEEDBACK_DIRECTORY?.trim()) {
    configureFeedbackDirectory(process.env.FEEDBACK_DIRECTORY.trim());
  }

  runFeedbackImportCommand(process.argv.slice(2))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(() => resetPostgresPool());
}
