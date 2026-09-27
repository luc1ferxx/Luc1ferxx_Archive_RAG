// The API load test's pgvector mode writes into --database-url and never
// cleans up, so it must refuse a database the app has already run against
// (evaluation/run-api-load-bench.mjs, assertFreshLoadTestDatabase). No
// database here: the guard takes the query function as a parameter.
import assert from "node:assert/strict";
import test from "node:test";
import { assertFreshLoadTestDatabase } from "../evaluation/run-api-load-bench.mjs";

const fakeQuery = (ledger) => {
  const statements = [];
  const query = async (text) => {
    statements.push(text);
    return { rows: [{ ledger }] };
  };

  return { query, statements };
};

test("a database without the app's migration ledger is accepted", async () => {
  const { query, statements } = fakeQuery(null);

  await assertFreshLoadTestDatabase(query);
  assert.equal(statements.length, 1);
  assert.match(statements[0], /to_regclass\('schema_migrations'\)/);
});

test("a database the app has migrated is refused before anything is written", async () => {
  const { query, statements } = fakeQuery("schema_migrations");

  await assert.rejects(assertFreshLoadTestDatabase(query), /not a disposable database/);
  assert.equal(statements.length, 1, "the guard only reads");
});
