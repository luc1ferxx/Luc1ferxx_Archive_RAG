// npm run feedback:import (feedback-import.mjs): the one-shot copy of the
// JSONL feedback file into the PostgreSQL table. The store is a stand-in that
// records which database tenant each call ran under; the real statements are
// covered by feedback-store.test.mjs and the RLS integration suite.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import {
  parseFeedbackImportArgs,
  prepareFeedbackImport,
  runFeedbackImportCommand,
  USAGE,
} from "../feedback-import.mjs";
import { getActiveDatabaseTenant, runWithDatabaseTenant } from "../rag/postgres-tenant.js";

const record = (overrides = {}) => ({
  createdAt: "2026-10-01T10:00:00.000Z",
  feedbackId: "f-1",
  feedbackType: "incomplete",
  question: "What does the policy require?",
  userId: "alice",
  workspaceId: "ws-a",
  ...overrides,
});

let directory;

before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "feedback-import-"));
});

after(async () => {
  await rm(directory, { force: true, recursive: true });
});

const createStandInStore = ({ existing = [] } = {}) => {
  const stored = new Set(existing);
  const calls = [];

  return {
    calls,
    store: {
      async countExistingFeedbackIds(ids) {
        calls.push({ ids, method: "count", tenant: getActiveDatabaseTenant() });
        return ids.filter((id) => stored.has(id)).length;
      },
      describe: () => ({ backend: "postgres", table: "rag_feedback" }),
      async importFeedback(records) {
        calls.push({ method: "import", records, tenant: getActiveDatabaseTenant() });

        let inserted = 0;

        for (const entry of records) {
          if (!stored.has(entry.feedbackId)) {
            stored.add(entry.feedbackId);
            inserted += 1;
          }
        }

        return { alreadyPresent: records.length - inserted, inserted };
      },
    },
  };
};

test("arguments: --input, --apply, --json and --help; anything else is refused", () => {
  assert.deepEqual(parseFeedbackImportArgs([]), { apply: false, help: false, input: null, json: false });
  assert.deepEqual(parseFeedbackImportArgs(["--input", "a.jsonl", "--apply", "--json"]), {
    apply: true,
    help: false,
    input: "a.jsonl",
    json: true,
  });
  assert.equal(parseFeedbackImportArgs(["--input=b.jsonl"]).input, "b.jsonl");
  assert.equal(parseFeedbackImportArgs(["-h"]).help, true);
  assert.throws(() => parseFeedbackImportArgs(["--input"]), /--input needs a file path/);
  assert.throws(() => parseFeedbackImportArgs(["--force"]), /Unknown argument: --force/);
  assert.throws(() => parseFeedbackImportArgs(["extra.jsonl"]), /Unknown argument: extra.jsonl/);
});

test("prepareFeedbackImport keeps what the server wrote and counts what it skips", () => {
  const { records, skipped } = prepareFeedbackImport([
    JSON.stringify(record()),
    JSON.stringify(record({ expectedAnswerIncludes: ["approval"], feedbackId: "f-2", userId: "", workspaceId: "" })),
    "not json",
    "[1, 2]",
    JSON.stringify(record({ feedbackId: "" })),
    JSON.stringify(record({ feedbackId: "f-3", feedbackType: "thumbs_up" })),
    JSON.stringify(record({ feedbackId: "f-4", question: " " })),
    JSON.stringify(record({ createdAt: "yesterday", feedbackId: "f-5" })),
    JSON.stringify(record({ createdAt: "+010000-01-01T00:00:00.000Z", feedbackId: "f-6" })),
    JSON.stringify(record({ feedbackId: "f-7", userId: "ali\u0000ce" })),
    JSON.stringify(record({ feedbackId: "f-8", workspaceId: 7 })),
    JSON.stringify(record({ note: "second copy" })),
  ]);

  assert.deepEqual(
    records.map((entry) => entry.feedbackId),
    ["f-1", "f-2"]
  );
  assert.deepEqual(records[1].expectedAnswerIncludes, ["approval"], "fields are kept as written");
  assert.deepEqual(skipped, {
    duplicate_in_file: 1,
    invalid_created_at: 2,
    invalid_json: 1,
    invalid_owner: 2,
    missing_feedback_id: 1,
    missing_question: 1,
    not_an_object: 1,
    unknown_feedback_type: 1,
  });
});

test("a dry run counts what is already stored and writes nothing; --apply imports on the owner path", async () => {
  const input = path.join(directory, "feedback.jsonl");

  await writeFile(
    input,
    `${[record(), record({ feedbackId: "f-2", userId: "bob", workspaceId: "ws-b" }), "garbage"]
      .map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)))
      .join("\n")}\n\n`,
    "utf8"
  );

  const { calls, store } = createStandInStore({ existing: ["f-1"] });
  const output = [];
  const options = {
    createStore: () => store,
    isConfigured: () => true,
    write: (text) => output.push(text),
  };

  // Even from inside a tenant's context the import acts as the owner.
  const dryRun = await runWithDatabaseTenant({ userId: "alice", workspaceId: "ws-a" }, () =>
    runFeedbackImportCommand(["--input", input], options)
  );

  assert.deepEqual(dryRun, {
    alreadyPresent: 1,
    apply: false,
    input,
    lines: 3,
    missing: false,
    skipped: { invalid_json: 1 },
    table: "rag_feedback",
    valid: 2,
    wouldInsert: 1,
  });
  assert.deepEqual(calls, [{ ids: ["f-1", "f-2"], method: "count", tenant: null }]);
  assert.match(output.join(""), /Dry run: 1 would be imported, 1 already in the table/);

  const applied = await runFeedbackImportCommand(["--input", input, "--apply", "--json"], options);

  assert.equal(applied.inserted, 1);
  assert.equal(applied.alreadyPresent, 1);
  assert.equal(calls[1].method, "import");
  assert.equal(calls[1].tenant, null);
  assert.deepEqual(
    calls[1].records.map((entry) => [entry.feedbackId, entry.userId, entry.workspaceId]),
    [
      ["f-1", "alice", "ws-a"],
      ["f-2", "bob", "ws-b"],
    ]
  );
  assert.deepEqual(JSON.parse(output.at(-1)), applied);

  // Running it again imports nothing new.
  assert.equal((await runFeedbackImportCommand(["--input", input, "--apply"], options)).inserted, 0);
  assert.match(output.at(-1), /Imported 0; 2 already in the table/);
});

test("the default input is the file store's file, a missing file imports nothing, and no database is an error", async () => {
  const { calls, store } = createStandInStore();
  const output = [];
  const missing = path.join(directory, "nowhere", "feedback.jsonl");
  const result = await runFeedbackImportCommand(["--apply"], {
    createStore: () => store,
    defaultInputPath: () => missing,
    isConfigured: () => true,
    write: (text) => output.push(text),
  });

  assert.deepEqual(result, { apply: true, input: missing, missing: true, table: "rag_feedback" });
  assert.deepEqual(calls, []);
  assert.match(output.join(""), /No feedback file at .*nothing to import/);

  await assert.rejects(
    runFeedbackImportCommand([], { isConfigured: () => false, write: () => {} }),
    /feedback:import needs PostgreSQL/
  );

  const help = [];

  assert.equal(await runFeedbackImportCommand(["--help"], { write: (text) => help.push(text) }), null);
  assert.deepEqual(help, [USAGE]);
});
