import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import net from "node:net";
import test, { after, afterEach, before } from "node:test";
import express from "express";

import { bindDatabaseTenant } from "../auth.js";

// Protocol-level checks of the tenant transaction in rag/postgres.js, against
// a fake PostgreSQL server on an OS-assigned 127.0.0.1 port: the real pg
// client and pool connect to it, and the server records every frontend message
// it receives. What it proves: which SQL texts and bind values go out, how
// many round trips (Sync or simple Query messages, each answered by one
// ReadyForQuery) a tenant statement or transaction costs, that a hostile id
// only ever travels as a bind value, and how failures end. The server models
// just enough transaction state (implicit block up to Sync, explicit block
// after BEGIN, skip-to-Sync after an error) to answer with the right status;
// that PostgreSQL itself behaves this way is proven by
// postgres-row-level-security.integration.test.mjs on a real database.

const HOSTILE = {
  userId: `o'brien\\'); DROP TABLE rag_tasks; --\nline two $1 "q" é`,
  workspaceId: `ws\\\\'; SELECT set_config('role', 'postgres', false); --\r\n'`,
};
const ALICE = { userId: "alice", workspaceId: "ws-a" };

// The whole settings statement: the tenant role and ids, then the tenant
// work's statement_timeout and idle_in_transaction_session_timeout, which ride
// in the same step as bind parameters $4 and $5 (NULL when off, keeping the
// server's own value) so they cost no round trip of their own.
const TENANT_SETTINGS_TEXT = new RegExp(
  [
    String.raw`set_config\('role', \$1, true\),`,
    String.raw`set_config\('archive_rag\.user_id', \$2, true\),`,
    String.raw`set_config\('archive_rag\.workspace_id', \$3, true\),`,
    String.raw`set_config\('statement_timeout', COALESCE\(\$4::text, current_setting\('statement_timeout'\)\), true\),`,
    String.raw`set_config\(\s*'idle_in_transaction_session_timeout',\s*COALESCE\(\$5::text, current_setting\('idle_in_transaction_session_timeout'\)\),\s*true\s*\)`,
  ].join(String.raw`\s*`)
);
// The settings' bind values with both limits off (the default).
const settingsValues = (scope, { idleInTransaction = null, statement = null } = {}) => [
  "archive_rag_tenant",
  scope.userId,
  scope.workspaceId,
  statement,
  idleInTransaction,
];

// ---- fake server -----------------------------------------------------------

const message = (type, body = Buffer.alloc(0)) => {
  const header = Buffer.alloc(5);

  header.write(type, 0, "latin1");
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
};
const cstring = (value) => Buffer.concat([Buffer.from(value, "utf8"), Buffer.from([0])]);
const int16 = (value) => {
  const buffer = Buffer.alloc(2);

  buffer.writeInt16BE(value);
  return buffer;
};
const int32 = (value) => {
  const buffer = Buffer.alloc(4);

  buffer.writeInt32BE(value);
  return buffer;
};

const rowDescription = (fields) =>
  message(
    "T",
    Buffer.concat([
      int16(fields.length),
      ...fields.map((name) =>
        Buffer.concat([cstring(name), int32(0), int16(0), int32(25), int16(-1), int32(-1), int16(0)])
      ),
    ])
  );
const dataRow = (row) =>
  message(
    "D",
    Buffer.concat([
      int16(row.length),
      ...row.map((value) => {
        if (value === null) return int32(-1);
        const bytes = Buffer.from(String(value), "utf8");

        return Buffer.concat([int32(bytes.length), bytes]);
      }),
    ])
  );
const errorResponse = ({ code, message: text, severity = "ERROR" }) =>
  message(
    "E",
    Buffer.concat([
      Buffer.from("S"), cstring(severity),
      Buffer.from("V"), cstring(severity),
      Buffer.from("C"), cstring(code),
      Buffer.from("M"), cstring(text),
      Buffer.from([0]),
    ])
  );

class Reader {
  constructor(buffer) {
    this.buffer = buffer;
    this.offset = 0;
  }

  cstring() {
    const end = this.buffer.indexOf(0, this.offset);
    const value = this.buffer.toString("utf8", this.offset, end);

    this.offset = end + 1;
    return value;
  }

  int16() {
    const value = this.buffer.readInt16BE(this.offset);

    this.offset += 2;
    return value;
  }

  int32() {
    const value = this.buffer.readInt32BE(this.offset);

    this.offset += 4;
    return value;
  }

  bytes(length) {
    const value = this.buffer.subarray(this.offset, this.offset + length);

    this.offset += length;
    return value;
  }
}

/**
 * `respond(text, values)` answers a statement: { fields, rows, command } or
 * { error: { code, message } }. BEGIN, COMMIT and ROLLBACK are answered here
 * and move the modelled transaction status. `stall: true` never answers the
 * statement (nor anything after it); `readyDelayMs` sends the ReadyForQuery of
 * the statement's Sync that much later than its other replies.
 */
const startFakePostgres = async (respond) => {
  const state = { closed: new Set(), connections: 0, messages: [], sockets: new Map() };

  const answer = (text, values) => {
    const keyword = text.trim().split(/\s+/)[0]?.toUpperCase();

    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(keyword)) {
      return { command: keyword, control: keyword };
    }

    const answered = respond(text, values);

    if (answered) return answered;

    // set_config returns the value it set, one row, as PostgreSQL does.
    return TENANT_SETTINGS_TEXT.test(text)
      ? { command: "SELECT 1", fields: values.map(() => "set_config"), rows: [values] }
      : { command: "SELECT 0", fields: [], rows: [] };
  };

  const server = net.createServer((socket) => {
    const connectionId = ++state.connections;

    state.sockets.set(connectionId, socket);
    let pending = Buffer.alloc(0);
    let started = false;
    let status = "I";
    let skipping = false;
    let statement = null;
    let portal = null;
    let stalled = false;
    let readyDelayMs = 0;
    const record = (entry) => state.messages.push({ connectionId, ...entry });

    // Runs one statement: the rows and tag, or the error; returns false on error.
    const execute = (result, { send, simple }) => {
      if (result.error) {
        send(errorResponse(result.error));
        status = status === "I" ? "I" : "E";
        return false;
      }

      if (status === "E" && result.control !== "ROLLBACK" && result.control !== "COMMIT") {
        send(errorResponse({ code: "25P02", message: "current transaction is aborted" }));
        return false;
      }

      if (result.control === "BEGIN") status = "T";
      if (result.control === "COMMIT" || result.control === "ROLLBACK") status = "I";
      if (simple && result.fields?.length) send(rowDescription(result.fields));
      (result.rows ?? []).forEach((row) => send(dataRow(row)));
      send(message("C", cstring(result.command)));
      return true;
    };

    const handle = (type, body) => {
      const reader = new Reader(body);
      const send = (buffer) => socket.write(buffer);

      if (type === "X") {
        record({ type: "Terminate" });
        socket.end();
        return;
      }

      if (type === "S") {
        record({ type: "Sync" });

        if (stalled) return;
        skipping = false;
        // An implicit block ends at Sync; an explicit one (BEGIN) stays open.
        const ready = message("Z", Buffer.from(status));

        if (readyDelayMs > 0) {
          setTimeout(() => socket.write(ready), readyDelayMs);
          readyDelayMs = 0;
        } else {
          send(ready);
        }

        return;
      }

      if (skipping) {
        record({ type: "skipped", code: type });
        return;
      }

      if (type === "Q") {
        const text = reader.cstring();

        record({ type: "Query", text });
        execute(answer(text, []), { send, simple: true });
        send(message("Z", Buffer.from(status)));
        return;
      }

      if (type === "P") {
        reader.cstring();
        const text = reader.cstring();

        statement = { text };
        record({ type: "Parse", text });
        send(message("1"));
        return;
      }

      if (type === "B") {
        reader.cstring();
        reader.cstring();
        const formats = Array.from({ length: reader.int16() }, () => reader.int16());
        const values = Array.from({ length: reader.int16() }, (_, index) => {
          const length = reader.int32();

          if (length < 0) return null;
          const bytes = reader.bytes(length);

          return (formats[index] ?? formats[0] ?? 0) === 1 ? bytes : bytes.toString("utf8");
        });

        portal = { result: answer(statement.text, values), text: statement.text, values };
        record({ type: "Bind", values });
        send(message("2"));
        return;
      }

      if (type === "D") {
        record({ type: "Describe" });
        send(portal.result.fields?.length ? rowDescription(portal.result.fields) : message("n"));
        return;
      }

      if (type === "E") {
        record({ type: "Execute", text: portal.text });
        readyDelayMs = Math.max(readyDelayMs, portal.result.readyDelayMs ?? 0);

        if (portal.result.stall) {
          stalled = true;
          return;
        }

        if (!execute(portal.result, { send, simple: false })) {
          skipping = true;
        }

        return;
      }

      if (type === "H") {
        return;
      }

      throw new Error(`fake postgres: unhandled message ${type}`);
    };

    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);

      while (true) {
        if (!started) {
          if (pending.length < 8) return;
          const length = pending.readInt32BE(0);

          if (pending.length < length) return;
          pending = pending.subarray(length);
          started = true;
          socket.write(
            Buffer.concat([
              message("R", int32(0)),
              message("S", Buffer.concat([cstring("client_encoding"), cstring("UTF8")])),
              message("K", Buffer.concat([int32(connectionId), int32(42)])),
              message("Z", Buffer.from("I")),
            ])
          );
          continue;
        }

        if (pending.length < 5) return;
        const length = pending.readInt32BE(1);

        if (pending.length < length + 1) return;
        const type = pending.toString("latin1", 0, 1);
        const body = pending.subarray(5, length + 1);

        pending = pending.subarray(length + 1);
        handle(type, body);
      }
    });
    socket.on("close", () => {
      state.closed.add(connectionId);
    });
    socket.on("error", () => {});
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    close: () => new Promise((resolve) => server.close(resolve)),
    // Ends a session the way PostgreSQL does on idle_in_transaction_session_
    // timeout: a FATAL ErrorResponse, then the socket closes.
    terminate: (connectionId) => {
      const socket = state.sockets.get(connectionId);

      socket.end(
        errorResponse({
          code: "25P03",
          message: "terminating connection due to idle-in-transaction timeout",
          severity: "FATAL",
        })
      );
    },
    port: server.address().port,
    state,
  };
};

// ---- helpers ---------------------------------------------------------------

// Round trips of a message slice: every Sync and every simple Query is
// answered by one ReadyForQuery the client waits for.
const roundTrips = (messages) =>
  messages.filter((entry) => entry.type === "Sync" || entry.type === "Query").length;
const connectionIds = (messages) => new Set(messages.map((entry) => entry.connectionId));
const shape = (messages) =>
  messages.map((entry) =>
    entry.type === "Parse" || entry.type === "Query" || entry.type === "Execute"
      ? `${entry.type} ${entry.text.replace(/\s+/g, " ").trim()}`
      : entry.type === "Bind"
        ? `Bind ${JSON.stringify(entry.values)}`
        : entry.type
  );

const POOL_AND_LIMIT_VARIABLES = [
  "POSTGRES_CONNECTION_TIMEOUT_MS",
  "POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS",
  "POSTGRES_POOL_MAX",
  "POSTGRES_STATEMENT_TIMEOUT_MS",
  "POSTGRES_TENANT_CONTEXT",
];

// Sets `overrides` (undefined deletes) for the callback, with a fresh pool on
// both sides so the pool reads the settings it is created with.
const withEnv = async (overrides, callback) => {
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  const apply = (entries) =>
    Object.entries(entries).forEach(([key, value]) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });

  apply(overrides);
  await modules.postgres.resetPostgresPool();

  try {
    return await callback();
  } finally {
    apply(previous);
    await modules.postgres.resetPostgresPool();
  }
};

let fake;
let modules;
let responder = () => undefined;

before(async () => {
  fake = await startFakePostgres((text, values) => responder(text, values));
  process.env.POSTGRES_DATABASE_URL = `postgresql://tester@127.0.0.1:${fake.port}/fake`;
  delete process.env.LONG_MEMORY_DATABASE_URL;
  delete process.env.POSTGRES_SSL_ENABLED;
  delete process.env.LONG_MEMORY_POSTGRES_SSL_ENABLED;
  process.env.POSTGRES_ROW_LEVEL_SECURITY = "enforce";
  process.env.POSTGRES_TENANT_ROLE = "archive_rag_tenant";
  // The pinned messages are the defaults': no limits, lenient context, the
  // default pool. Tests that change one set it themselves (withEnv).
  for (const name of POOL_AND_LIMIT_VARIABLES) {
    delete process.env[name];
  }

  const [postgres, tenant] = await Promise.all([
    import("../rag/postgres.js"),
    import("../rag/postgres-tenant.js"),
  ]);

  modules = { postgres, tenant };
});

// Each test starts with no connection open and an empty log: the pool's
// Terminate messages of the previous test arrive after its end resolves.
afterEach(async () => {
  responder = () => undefined;
  await modules.postgres.resetPostgresPool();
  await new Promise((resolve) => {
    const poll = () => (fake.state.closed.size === fake.state.connections ? resolve() : setImmediate(poll));

    poll();
  });
  fake.state.messages.length = 0;
});

after(async () => {
  await modules?.postgres.resetPostgresPool();
  await fake?.close();
});

const asTenant = (scope, callback) => modules.tenant.runWithDatabaseTenant(scope, callback);
const statementAnswer = (text) =>
  /FROM rag_tasks/.test(text)
    ? { command: "SELECT 1", fields: ["task_id"], rows: [["task-1"]] }
    : undefined;

// ---- tests -----------------------------------------------------------------

test("a tenant statement is one round trip: the settings and the statement share one Sync, with no BEGIN or COMMIT", async () => {
  responder = statementAnswer;

  const result = await asTenant(ALICE, () =>
    modules.postgres.queryPostgres("SELECT task_id FROM rag_tasks WHERE task_id = $1", ["task-1"])
  );

  assert.deepEqual(result.rows, [{ task_id: "task-1" }], "the statement's rows, not set_config's");
  assert.equal(result.command, "SELECT");

  const messages = fake.state.messages;

  assert.equal(roundTrips(messages), 1);
  assert.equal(messages.filter((entry) => entry.type === "Query").length, 0, "nothing goes out as simple-protocol text");
  assert.deepEqual(
    shape(messages).map((line) => line.replace(TENANT_SETTINGS_TEXT, "<tenant settings>")),
    [
      "Parse SELECT <tenant settings>",
      `Bind ${JSON.stringify(settingsValues(ALICE))}`,
      "Execute SELECT <tenant settings>",
      "Parse SELECT task_id FROM rag_tasks WHERE task_id = $1",
      'Bind ["task-1"]',
      "Describe",
      "Execute SELECT task_id FROM rag_tasks WHERE task_id = $1",
      "Sync",
    ]
  );
});

test("hostile ids travel only as exact bind values and never reach any SQL text", async () => {
  responder = statementAnswer;

  await asTenant(HOSTILE, () =>
    modules.postgres.queryPostgres("SELECT task_id FROM rag_tasks")
  );
  await asTenant(HOSTILE, () =>
    modules.postgres.withPostgresTransaction((client) => client.query("SELECT task_id FROM rag_tasks"))
  );

  const settingsBinds = fake.state.messages.filter(
    (entry, index, all) => entry.type === "Bind" && TENANT_SETTINGS_TEXT.test(all[index - 1]?.text ?? "")
  );

  assert.equal(settingsBinds.length, 2, "one settings bind per tenant transaction");
  settingsBinds.forEach((entry) => {
    assert.deepEqual(entry.values, settingsValues(HOSTILE));
  });

  const texts = fake.state.messages.filter((entry) => entry.text).map((entry) => entry.text);

  for (const text of texts) {
    assert.ok(!text.includes("o'brien"), `no id in SQL text: ${text}`);
    assert.ok(!text.includes("DROP TABLE"), `no id in SQL text: ${text}`);
    assert.ok(!text.includes("'postgres'"), `no id in SQL text: ${text}`);
  }
});

test("a tenant transaction sends BEGIN and the settings in one round trip, then the work, then COMMIT", async () => {
  responder = statementAnswer;

  const rows = await asTenant(ALICE, () =>
    modules.postgres.withPostgresTransaction(async (client) => {
      const first = await client.query("SELECT task_id FROM rag_tasks");
      const second = await client.query("SELECT task_id FROM rag_tasks WHERE task_id = $1", ["task-1"]);

      return [...first.rows, ...second.rows];
    })
  );

  assert.deepEqual(rows, [{ task_id: "task-1" }, { task_id: "task-1" }]);
  assert.equal(roundTrips(fake.state.messages), 4, "BEGIN+settings, two statements, COMMIT");
  assert.deepEqual(
    shape(fake.state.messages).map((line) => line.replace(TENANT_SETTINGS_TEXT, "<tenant settings>")),
    [
      "Parse BEGIN",
      "Bind []",
      "Execute BEGIN",
      "Parse SELECT <tenant settings>",
      `Bind ${JSON.stringify(settingsValues(ALICE))}`,
      "Describe",
      "Execute SELECT <tenant settings>",
      "Sync",
      "Query SELECT task_id FROM rag_tasks",
      "Parse SELECT task_id FROM rag_tasks WHERE task_id = $1",
      'Bind ["task-1"]',
      "Describe",
      "Execute SELECT task_id FROM rag_tasks WHERE task_id = $1",
      "Sync",
      "Query COMMIT",
    ]
  );
});

test("the owner path is unchanged: one statement straight on the pool, no settings", async () => {
  responder = statementAnswer;

  const result = await modules.postgres.queryPostgres("SELECT task_id FROM rag_tasks WHERE task_id = $1", ["task-1"]);

  assert.deepEqual(result.rows, [{ task_id: "task-1" }]);
  assert.deepEqual(shape(fake.state.messages), [
    "Parse SELECT task_id FROM rag_tasks WHERE task_id = $1",
    'Bind ["task-1"]',
    "Describe",
    "Execute SELECT task_id FROM rag_tasks WHERE task_id = $1",
    "Sync",
  ]);

  fake.state.messages.length = 0;
  await modules.postgres.withPostgresTransaction((client) => client.query("SELECT task_id FROM rag_tasks"));
  assert.deepEqual(shape(fake.state.messages), [
    "Query BEGIN",
    "Query SELECT task_id FROM rag_tasks",
    "Query COMMIT",
  ]);
});

test("a failing tenant statement rejects with its own error, is rolled back by the Sync, and leaves the connection usable", async () => {
  responder = (text) =>
    /INSERT INTO rag_tasks/.test(text)
      ? { error: { code: "23505", message: "duplicate key value violates unique constraint" } }
      : statementAnswer(text);

  await assert.rejects(
    asTenant(ALICE, () => modules.postgres.queryPostgres("INSERT INTO rag_tasks (task_id) VALUES ($1)", ["t"])),
    (error) => error.code === "23505"
  );

  const failed = shape(fake.state.messages);

  assert.equal(failed.at(-1), "Sync", "the Sync ends the implicit transaction: no ROLLBACK round trip");
  assert.ok(!failed.some((line) => /ROLLBACK|COMMIT/.test(line)));

  const next = await asTenant(ALICE, () => modules.postgres.queryPostgres("SELECT task_id FROM rag_tasks"));

  assert.deepEqual(next.rows, [{ task_id: "task-1" }]);
  assert.equal(connectionIds(fake.state.messages).size, 1, "the pooled connection was reused, not replaced");
});

test("a failed tenant setting skips the statement", async () => {
  responder = (text) =>
    TENANT_SETTINGS_TEXT.test(text)
      ? { error: { code: "42704", message: 'role "archive_rag_tenant" does not exist' } }
      : statementAnswer(text);

  await assert.rejects(
    asTenant(ALICE, () => modules.postgres.queryPostgres("SELECT task_id FROM rag_tasks")),
    (error) => error.code === "42704"
  );
  assert.ok(
    !fake.state.messages.some((entry) => entry.type === "Execute" && /rag_tasks/.test(entry.text)),
    "the statement after the failed setting never runs"
  );
});

test("a failure inside a tenant transaction rolls back, including a failed BEGIN+settings round trip", async () => {
  responder = statementAnswer;

  await assert.rejects(
    asTenant(ALICE, () =>
      modules.postgres.withPostgresTransaction(async (client) => {
        await client.query("SELECT task_id FROM rag_tasks");
        throw new Error("callback failed");
      })
    ),
    /callback failed/
  );
  assert.equal(shape(fake.state.messages).at(-1), "Query ROLLBACK");

  fake.state.messages.length = 0;
  responder = (text) =>
    TENANT_SETTINGS_TEXT.test(text)
      ? { error: { code: "42501", message: "permission denied to set role" } }
      : statementAnswer(text);

  let ran = false;

  await assert.rejects(
    asTenant(ALICE, () =>
      modules.postgres.withPostgresTransaction(async () => {
        ran = true;
      })
    ),
    (error) => error.code === "42501"
  );
  assert.equal(ran, false);
  assert.equal(shape(fake.state.messages).at(-1), "Query ROLLBACK", "the open, failed block is rolled back");

  // The same connection serves the next caller.
  responder = statementAnswer;
  const next = await asTenant(ALICE, () => modules.postgres.queryPostgres("SELECT task_id FROM rag_tasks"));

  assert.deepEqual(next.rows, [{ task_id: "task-1" }]);
  assert.equal(connectionIds(fake.state.messages).size, 1, "the pooled connection was reused, not replaced");
});

test("a tenant statement that leaves a transaction open fails and its connection is destroyed, not pooled", async () => {
  await assert.rejects(
    asTenant(ALICE, () => modules.postgres.queryPostgres("BEGIN")),
    (error) => error.code === modules.postgres.TENANT_PIPELINE_STATUS_ERROR_CODE
  );

  const [openedBy] = connectionIds(fake.state.messages);

  responder = statementAnswer;

  // Asked right away: a pooled connection would be handed out again here
  // (pg-pool closes idle ones only after 10 s).
  const next = await asTenant(ALICE, () => modules.postgres.queryPostgres("SELECT task_id FROM rag_tasks"));

  assert.deepEqual(next.rows, [{ task_id: "task-1" }]);
  assert.notEqual(fake.state.messages.at(-1).connectionId, openedBy, "the next caller got a new connection");
  await new Promise((resolve) => {
    const poll = () => (fake.state.closed.has(openedBy) ? resolve() : setImmediate(poll));

    poll();
  });
  assert.ok(
    fake.state.messages.some((entry) => entry.connectionId === openedBy && entry.type === "Terminate"),
    "the pool ended the connection instead of keeping it"
  );
});

test("a value that cannot be serialized fails before any message is sent and the connection stays usable", async () => {
  responder = statementAnswer;

  const circular = {};

  circular.self = circular;
  await assert.rejects(
    asTenant(ALICE, () =>
      modules.postgres.queryPostgres("UPDATE rag_tasks SET input = $1::jsonb", [circular])
    ),
    /circular/i
  );
  assert.deepEqual(fake.state.messages, [], "no half-sent pipeline");

  const next = await asTenant(ALICE, () => modules.postgres.queryPostgres("SELECT task_id FROM rag_tasks"));

  assert.deepEqual(next.rows, [{ task_id: "task-1" }]);
});

test("concurrent tenant statements on one pool each stay one round trip with their own tenant", async () => {
  responder = statementAnswer;

  const tenants = Array.from({ length: 12 }, (_, index) => ({
    userId: `user-${index}`,
    workspaceId: `ws-${index % 3}`,
  }));

  await Promise.all(
    tenants.map((scope) => asTenant(scope, () => modules.postgres.queryPostgres("SELECT task_id FROM rag_tasks")))
  );

  assert.equal(roundTrips(fake.state.messages), tenants.length);

  const byConnection = new Map();

  for (const entry of fake.state.messages) {
    byConnection.set(entry.connectionId, [...(byConnection.get(entry.connectionId) ?? []), entry]);
  }

  // Per connection, every statement is preceded by its own settings in the
  // same Sync group.
  const seen = [];

  for (const entries of byConnection.values()) {
    let group = [];

    for (const entry of entries) {
      group.push(entry);

      if (entry.type === "Sync") {
        const settings = group.find((item) => item.type === "Bind");

        assert.equal(settings.values[0], "archive_rag_tenant");
        assert.ok(group.some((item) => item.type === "Execute" && /rag_tasks/.test(item.text)));
        seen.push(`${settings.values[1]}|${settings.values[2]}`);
        group = [];
      }
    }
  }

  assert.deepEqual(
    seen.sort(),
    tenants.map((scope) => `${scope.userId}|${scope.workspaceId}`).sort()
  );
});

test("a prelude runs before the statement in the same round trip, on the tenant and the owner path", async () => {
  responder = statementAnswer;

  const lockRow = {
    text: "SELECT 1 FROM rag_tasks WHERE task_id = $1 FOR NO KEY UPDATE",
    values: ["task-1"],
  };
  const update = "UPDATE rag_tasks SET status = $1 WHERE task_id = $2";
  const tenantResult = await asTenant(ALICE, () =>
    modules.postgres.queryPostgres(update, ["done", "task-1"], { prelude: [lockRow] })
  );

  assert.equal(tenantResult.command, "SELECT", "the statement's own result");
  assert.equal(roundTrips(fake.state.messages), 1);
  assert.deepEqual(
    shape(fake.state.messages).map((line) => line.replace(TENANT_SETTINGS_TEXT, "<tenant settings>")),
    [
      "Parse SELECT <tenant settings>",
      `Bind ${JSON.stringify(settingsValues(ALICE))}`,
      "Execute SELECT <tenant settings>",
      "Parse SELECT 1 FROM rag_tasks WHERE task_id = $1 FOR NO KEY UPDATE",
      'Bind ["task-1"]',
      "Execute SELECT 1 FROM rag_tasks WHERE task_id = $1 FOR NO KEY UPDATE",
      "Parse UPDATE rag_tasks SET status = $1 WHERE task_id = $2",
      'Bind ["done","task-1"]',
      "Describe",
      "Execute UPDATE rag_tasks SET status = $1 WHERE task_id = $2",
      "Sync",
    ]
  );

  fake.state.messages.length = 0;
  await modules.postgres.queryPostgres(update, ["done", "task-1"], { prelude: [lockRow] });
  assert.deepEqual(shape(fake.state.messages), [
    "Parse SELECT 1 FROM rag_tasks WHERE task_id = $1 FOR NO KEY UPDATE",
    'Bind ["task-1"]',
    "Execute SELECT 1 FROM rag_tasks WHERE task_id = $1 FOR NO KEY UPDATE",
    "Parse UPDATE rag_tasks SET status = $1 WHERE task_id = $2",
    'Bind ["done","task-1"]',
    "Describe",
    "Execute UPDATE rag_tasks SET status = $1 WHERE task_id = $2",
    "Sync",
  ], "the owner path adds no BEGIN or COMMIT either");
});

test("a client-side query_timeout after the pipeline went out leaves the outcome to the Sync and destroys the connection", async () => {
  const baseUrl = process.env.POSTGRES_DATABASE_URL;

  // pg's own read timeout, not a server statement_timeout.
  process.env.POSTGRES_DATABASE_URL = `${baseUrl}?query_timeout=150`;

  try {
    await modules.postgres.resetPostgresPool();
    responder = (text) => (/^UPDATE rag_tasks/.test(text) ? { stall: true } : statementAnswer(text));

    await assert.rejects(
      asTenant(ALICE, () =>
        modules.postgres.queryPostgres("UPDATE rag_tasks SET status = $1", ["done"])
      ),
      /Query read timeout/
    );

    const [stalledOn] = connectionIds(fake.state.messages);

    // Settings, statement and Sync all went out before the timeout: the server,
    // not a ROLLBACK the client can no longer send in time, decides the outcome
    // (the Sync commits a statement that succeeds), as for pool.query.
    assert.deepEqual(
      shape(fake.state.messages).slice(-2),
      ["Execute UPDATE rag_tasks SET status = $1", "Sync"]
    );
    assert.ok(!shape(fake.state.messages).some((line) => /ROLLBACK/.test(line)));

    // Asked right away: on the stalled connection it would queue behind the
    // unfinished pipeline and time out too.
    responder = statementAnswer;
    const next = await asTenant(ALICE, () => modules.postgres.queryPostgres("SELECT task_id FROM rag_tasks"));

    assert.deepEqual(next.rows, [{ task_id: "task-1" }]);
    assert.notEqual(fake.state.messages.at(-1).connectionId, stalledOn, "the next caller got a new connection");
    await new Promise((resolve) => {
      const poll = () => (fake.state.closed.has(stalledOn) ? resolve() : setImmediate(poll));

      poll();
    });
  } finally {
    process.env.POSTGRES_DATABASE_URL = baseUrl;
  }
});

test("a failed tenant statement keeps an idle connection but destroys one left inside a transaction block", async () => {
  // The ReadyForQuery follows the error in a later packet, as PostgreSQL
  // flushes an ErrorResponse at once: the pipeline must wait for it.
  responder = (text) =>
    /INSERT INTO rag_tasks/.test(text)
      ? { error: { code: "23505", message: "duplicate key value violates unique constraint" }, readyDelayMs: 30 }
      : statementAnswer(text);

  const insert = () =>
    asTenant(ALICE, () => modules.postgres.queryPostgres("INSERT INTO rag_tasks (task_id) VALUES ($1)", ["t"]));

  await assert.rejects(insert(), (error) => error.code === "23505");

  const [healthy] = connectionIds(fake.state.messages);

  // A connection handed back inside a block, as a raw owner session that
  // forgot its ROLLBACK leaves it. The failing tenant statement turns the
  // block into a failed one ('E'): that connection must not be pooled again.
  await modules.postgres.withPostgresClient((client) => client.query("BEGIN"));
  assert.equal(connectionIds(fake.state.messages).size, 1, "the same connection carries the open block");
  await assert.rejects(insert(), (error) => error.code === "23505");

  // Asked right away, before pg-pool's idle timeout could close anything.
  responder = statementAnswer;
  const next = await asTenant(ALICE, () => modules.postgres.queryPostgres("SELECT task_id FROM rag_tasks"));

  assert.deepEqual(next.rows, [{ task_id: "task-1" }], "not 25P02 from the poisoned connection");
  assert.notEqual(fake.state.messages.at(-1).connectionId, healthy, "the next caller got a new connection");
  await new Promise((resolve) => {
    const poll = () => (fake.state.closed.has(healthy) ? resolve() : setImmediate(poll));

    poll();
  });
});

// ---- limits, pool, strict context -----------------------------------------

test("statement and idle-in-transaction limits ride in the tenant settings step: bind values, no extra round trip, never on the owner path", async () => {
  responder = statementAnswer;

  await withEnv(
    { POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS: "60000", POSTGRES_STATEMENT_TIMEOUT_MS: "1500" },
    async () => {
      const limited = settingsValues(ALICE, { idleInTransaction: "60000", statement: "1500" });

      await asTenant(ALICE, () => modules.postgres.queryPostgres("SELECT task_id FROM rag_tasks"));
      assert.equal(roundTrips(fake.state.messages), 1, "still one round trip for a tenant statement");
      assert.deepEqual(
        shape(fake.state.messages).map((line) => line.replace(TENANT_SETTINGS_TEXT, "<tenant settings>")),
        [
          "Parse SELECT <tenant settings>",
          `Bind ${JSON.stringify(limited)}`,
          "Execute SELECT <tenant settings>",
          "Parse SELECT task_id FROM rag_tasks",
          "Bind []",
          "Describe",
          "Execute SELECT task_id FROM rag_tasks",
          "Sync",
        ]
      );

      fake.state.messages.length = 0;
      await asTenant(ALICE, () =>
        modules.postgres.withPostgresTransaction((client) => client.query("SELECT task_id FROM rag_tasks"))
      );
      assert.equal(roundTrips(fake.state.messages), 3, "BEGIN+settings, the statement, COMMIT");
      assert.deepEqual(
        fake.state.messages.find(
          (entry, index, all) => entry.type === "Bind" && TENANT_SETTINGS_TEXT.test(all[index - 1]?.text ?? "")
        )?.values,
        limited
      );

      // The limits only ever travel as bind values.
      for (const entry of fake.state.messages.filter((item) => item.text)) {
        assert.ok(!/1500|60000/.test(entry.text), `no limit in SQL text: ${entry.text}`);
      }

      fake.state.messages.length = 0;
      await modules.postgres.queryPostgres("SELECT task_id FROM rag_tasks");
      await modules.postgres.withPostgresTransaction((client) => client.query("SELECT task_id FROM rag_tasks"));
      assert.ok(
        fake.state.messages.every((entry) => !/statement_timeout|set_config/.test(entry.text ?? "")),
        "owner work (migrations, index builds, recovery scans) gets no tenant limits"
      );
    }
  );
});

test("a limit out of PostgreSQL's range is clamped, and an invalid one leaves the server's value", async () => {
  responder = statementAnswer;

  for (const [raw, expected] of [
    ["99999999999", "2147483647"],
    ["2500.9", "2500"],
    ["0", null],
    ["-5", null],
    ["soon", null],
    ["", null],
  ]) {
    await withEnv({ POSTGRES_STATEMENT_TIMEOUT_MS: raw }, async () => {
      fake.state.messages.length = 0;
      await asTenant(ALICE, () => modules.postgres.queryPostgres("SELECT task_id FROM rag_tasks"));
      assert.deepEqual(
        fake.state.messages.find((entry) => entry.type === "Bind").values,
        settingsValues(ALICE, { statement: expected }),
        `POSTGRES_STATEMENT_TIMEOUT_MS=${JSON.stringify(raw)}`
      );
    });
  }
});

// What POSTGRES_IDLE_IN_TRANSACTION_TIMEOUT_MS makes the server do to a
// tenant transaction whose caller holds it too long between statements. The
// checked-out client has no pg-pool error listener: without the lease's own,
// its 'error' event would be unhandled and end the process (here: fail the
// test as an uncaught exception).
test("a session the server ends while a tenant transaction holds it idle fails that transaction and is discarded, with no unhandled error", async () => {
  responder = statementAnswer;

  let heldOn = null;

  await assert.rejects(
    asTenant(ALICE, () =>
      modules.postgres.withPostgresTransaction(async (client) => {
        await client.query("SELECT task_id FROM rag_tasks");
        heldOn = fake.state.messages.at(-1).connectionId;
        fake.terminate(heldOn);
        await new Promise((resolve) => setTimeout(resolve, 50));

        return client.query("SELECT task_id FROM rag_tasks");
      })
    )
  );
  await new Promise((resolve) => {
    const poll = () => (fake.state.closed.has(heldOn) ? resolve() : setImmediate(poll));

    poll();
  });

  const next = await asTenant(ALICE, () => modules.postgres.queryPostgres("SELECT task_id FROM rag_tasks"));

  assert.deepEqual(next.rows, [{ task_id: "task-1" }]);
  assert.notEqual(fake.state.messages.at(-1).connectionId, heldOn, "the ended session was not pooled again");
});

test("POSTGRES_POOL_MAX and POSTGRES_CONNECTION_TIMEOUT_MS bound the pool; unset they are node-pg's defaults", async () => {
  assert.equal(modules.postgres.getPostgresPool().options.max, 10);
  assert.equal(modules.postgres.getPostgresPool().options.connectionTimeoutMillis, 0);

  await withEnv({ POSTGRES_CONNECTION_TIMEOUT_MS: "150", POSTGRES_POOL_MAX: "1" }, async () => {
    assert.equal(modules.postgres.getPostgresPool().options.max, 1);
    assert.equal(modules.postgres.getPostgresPool().options.connectionTimeoutMillis, 150);

    // One slow statement holds the only connection until its ReadyForQuery;
    // the next caller waits for the slot no longer than the timeout.
    responder = (text) =>
      /pg_sleep/.test(text) ? { command: "SELECT 0", fields: [], readyDelayMs: 600, rows: [] } : statementAnswer(text);

    // With a bind value, so it goes out as Parse/Bind/Execute/Sync and the
    // fake holds back the ReadyForQuery of its Sync.
    const slow = modules.postgres.queryPostgres("SELECT pg_sleep($1)", [0.6]);
    const startedAt = Date.now();

    await assert.rejects(modules.postgres.queryPostgres("SELECT task_id FROM rag_tasks"), /timeout/i);
    assert.ok(Date.now() - startedAt < 550, "gave up on the slot before the slow statement finished");
    await slow;
    assert.equal(fake.state.connections - fake.state.closed.size, 1, "never more than POSTGRES_POOL_MAX connections");
  });

  await withEnv({ POSTGRES_CONNECTION_TIMEOUT_MS: "nope", POSTGRES_POOL_MAX: "0" }, () => {
    assert.equal(modules.postgres.getPostgresPool().options.max, 10, "an invalid size keeps the default");
    assert.equal(modules.postgres.getPostgresPool().options.connectionTimeoutMillis, 0);
  });
});

// The statements a message slice sent, in order: Parse texts (extended
// protocol) and Query texts (simple protocol: an owner statement without bind
// values), with the tenant settings abbreviated.
const statements = (messages) =>
  shape(messages)
    .filter((line) => /^(Parse|Query) /.test(line))
    .map((line) => line.replace(TENANT_SETTINGS_TEXT, "<tenant settings>"));

// A library that resumes a callback from a resource it created before any
// request (a stream, a pool, a parser) runs that callback in the resource's
// context: this one, created at module load, is bound to nothing.
const lostContext = new AsyncResource("ArchiveRagTestLostContext");

const captureConsoleErrors = async (callback) => {
  const original = console.error;
  const lines = [];

  console.error = (...args) => lines.push(args.map(String).join(" "));

  try {
    return { lines, result: await callback() };
  } finally {
    console.error = original;
  }
};

test("strict mode refuses an unbound statement, transaction or session before anything is sent", async () => {
  responder = statementAnswer;

  await withEnv({ POSTGRES_TENANT_CONTEXT: "strict" }, async () => {
    const refused = (error) => {
      assert.equal(error.code, modules.postgres.TENANT_CONTEXT_MISSING_ERROR_CODE);
      assert.equal(error.code, "ARCHIVE_RAG_TENANT_CONTEXT_MISSING");
      return true;
    };
    const { lines } = await captureConsoleErrors(async () => {
      await assert.rejects(modules.postgres.queryPostgres("SELECT task_id FROM rag_tasks"), refused);
      await assert.rejects(
        modules.postgres.withPostgresTransaction((client) => client.query("SELECT 1")),
        refused
      );
      await assert.rejects(modules.postgres.withPostgresClient((client) => client.query("SELECT 1")), refused);
      assert.throws(() => modules.postgres.createDedicatedPostgresClient(), refused);
      // Inside a tenant request, a callback resumed in a lost context.
      await asTenant(ALICE, () =>
        assert.rejects(
          lostContext.runInAsyncScope(() => modules.postgres.queryPostgres("SELECT task_id FROM rag_tasks")),
          refused
        )
      );
    });

    assert.deepEqual(fake.state.messages, [], "nothing reached the server");
    assert.equal(fake.state.connections - fake.state.closed.size, 0, "not even a connection");
    assert.equal(lines.filter((line) => line.includes("ARCHIVE_RAG_TENANT_CONTEXT_MISSING")).length, 5);
    assert.ok(lines.every((line) => !/rag_tasks/.test(line)), "the refusal never logs SQL text");

    // System, unscoped and tenant work all go out: the first two as the owner.
    await modules.tenant.runAsDatabaseSystem(() => modules.postgres.queryPostgres("SELECT task_id FROM rag_tasks"));
    await modules.tenant.runWithDatabaseTenant({}, () =>
      modules.postgres.queryPostgres("SELECT task_id FROM rag_tasks")
    );
    await asTenant(ALICE, () => modules.postgres.queryPostgres("SELECT task_id FROM rag_tasks"));
    assert.deepEqual(statements(fake.state.messages), [
      "Query SELECT task_id FROM rag_tasks",
      "Query SELECT task_id FROM rag_tasks",
      "Parse SELECT <tenant settings>",
      "Parse SELECT task_id FROM rag_tasks",
    ]);
  });
});

test("lenient mode (the default) and row-level security off keep the owner path for unbound work", async () => {
  responder = statementAnswer;

  await lostContext.runInAsyncScope(() => modules.postgres.queryPostgres("SELECT task_id FROM rag_tasks"));
  assert.deepEqual(statements(fake.state.messages), ["Query SELECT task_id FROM rag_tasks"]);

  fake.state.messages.length = 0;
  await withEnv({ POSTGRES_ROW_LEVEL_SECURITY: "off", POSTGRES_TENANT_CONTEXT: "strict" }, () =>
    modules.postgres.queryPostgres("SELECT task_id FROM rag_tasks")
  );
  assert.deepEqual(statements(fake.state.messages), ["Query SELECT task_id FROM rag_tasks"]);

  await withEnv({ POSTGRES_TENANT_CONTEXT: "paranoid" }, async () => {
    await assert.rejects(
      modules.postgres.queryPostgres("SELECT 1"),
      /POSTGRES_TENANT_CONTEXT must be one of lenient, strict/
    );
  });
});

test("strict mode: a request that loses its context in a middleware fails closed; lenient runs it as the owner", async () => {
  responder = statementAnswer;

  const app = express();

  app.use((req, res, next) => {
    req.accessScope = req.get("x-test-tenant") === "alice" ? ALICE : { authenticated: false };
    next();
  });
  app.use(bindDatabaseTenant);
  app.get("/context", (req, res) => res.json({ context: modules.tenant.getDatabaseTenantContext() }));
  // A middleware that resumes the chain in a context of its own, as multer's
  // memory storage does.
  app.use((req, res, next) => lostContext.runInAsyncScope(next));
  app.get("/tasks", async (req, res) => {
    try {
      const result = await modules.postgres.queryPostgres("SELECT task_id FROM rag_tasks");

      res.json({ context: modules.tenant.getDatabaseTenantContext(), rows: result.rows });
    } catch (error) {
      res.status(500).json({ code: error.code ?? null });
    }
  });

  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const url = (pathname) => `http://127.0.0.1:${server.address().port}${pathname}`;

  try {
    // An auth-off request is bound as the explicit unscoped state.
    assert.deepEqual(await (await fetch(url("/context"))).json(), { context: "unscoped" });
    assert.deepEqual(
      await (await fetch(url("/context"), { headers: { "x-test-tenant": "alice" } })).json(),
      { context: "tenant" }
    );

    await withEnv({ POSTGRES_TENANT_CONTEXT: "strict" }, async () => {
      const { result } = await captureConsoleErrors(() =>
        fetch(url("/tasks"), { headers: { "x-test-tenant": "alice" } })
      );

      assert.equal(result.status, 500);
      assert.deepEqual(await result.json(), { code: "ARCHIVE_RAG_TENANT_CONTEXT_MISSING" });
      assert.deepEqual(fake.state.messages, [], "alice's request never reached the owner path");
    });

    const lenient = await fetch(url("/tasks"), { headers: { "x-test-tenant": "alice" } });

    assert.deepEqual(await lenient.json(), { context: "unbound", rows: [{ task_id: "task-1" }] });
    assert.deepEqual(
      statements(fake.state.messages),
      ["Query SELECT task_id FROM rag_tasks"],
      "lenient: the lost context runs as the owner, without tenant settings (the hole strict closes)"
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
