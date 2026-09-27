import assert from "node:assert/strict";
import net from "node:net";
import test, { after, afterEach, before } from "node:test";

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

const TENANT_SETTINGS_TEXT = /set_config\('role', \$1, true\),\s*set_config\('archive_rag\.user_id', \$2, true\),\s*set_config\('archive_rag\.workspace_id', \$3, true\)/;

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
const errorResponse = ({ code, message: text }) =>
  message(
    "E",
    Buffer.concat([
      Buffer.from("S"), cstring("ERROR"),
      Buffer.from("V"), cstring("ERROR"),
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
  const state = { closed: new Set(), connections: 0, messages: [] };

  const answer = (text, values) => {
    const keyword = text.trim().split(/\s+/)[0]?.toUpperCase();

    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(keyword)) {
      return { command: keyword, control: keyword };
    }

    const answered = respond(text, values);

    if (answered) return answered;

    // set_config returns the value it set, one row, as PostgreSQL does.
    return TENANT_SETTINGS_TEXT.test(text)
      ? { command: "SELECT 1", fields: ["set_config", "set_config", "set_config"], rows: [values] }
      : { command: "SELECT 0", fields: [], rows: [] };
  };

  const server = net.createServer((socket) => {
    const connectionId = ++state.connections;
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
      'Bind ["archive_rag_tenant","alice","ws-a"]',
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
    assert.deepEqual(entry.values, ["archive_rag_tenant", HOSTILE.userId, HOSTILE.workspaceId]);
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
      'Bind ["archive_rag_tenant","alice","ws-a"]',
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
      'Bind ["archive_rag_tenant","alice","ws-a"]',
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
