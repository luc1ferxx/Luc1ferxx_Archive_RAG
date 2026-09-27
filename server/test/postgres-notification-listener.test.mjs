import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import pg from "pg";

import {
  createPostgresNotificationListener,
  getPostgresListenRetryDelayMs,
  isValidPostgresChannel,
} from "../rag/postgres-notification-listener.js";
import { createDedicatedPostgresClient } from "../rag/postgres.js";
import { getActiveDatabaseTenant, runWithDatabaseTenant } from "../rag/postgres-tenant.js";

// The dedicated LISTEN session behind ingest-worker wake-ups: it must never
// block or throw into its caller, must retry with backoff, must act as the
// owner, and must close on stop. pg.Client is replaced by a fake with the same
// connect/query/end surface and events.

const ALICE = { userId: "alice", workspaceId: "ws-a" };
const CHANNEL = "jobs_enqueued";

const waitFor = async (predicate, { label = "condition", timeoutMs = 5000 } = {}) => {
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}.`);
    }

    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

const createFakeClients = ({ connectFailures = 0, hangConnect = false } = {}) => {
  const clients = [];
  let failuresLeft = connectFailures;

  return {
    clients,
    create: () => {
      const client = new EventEmitter();

      client.ended = false;
      client.queries = [];
      client.tenantAtCreate = getActiveDatabaseTenant();
      client.connect = async () => {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new Error("connect ECONNREFUSED 127.0.0.1:1");
        }

        if (hangConnect) {
          await new Promise((resolve, reject) => {
            client.abortConnect = () => reject(new Error("Connection terminated"));
          });
        }
      };
      client.query = async (sql) => {
        client.queries.push(sql);
        return { rows: [] };
      };
      client.end = async () => {
        if (!client.ended) {
          client.ended = true;
          client.abortConnect?.();
          client.emit("end");
        }
      };
      clients.push(client);
      return client;
    },
  };
};

const createRecordingLogger = () => {
  const lines = [];

  return {
    lines,
    logger: {
      error: (message) => lines.push(["error", message]),
      warn: (message) => lines.push(["warn", message]),
    },
  };
};

test("backoff doubles from the base up to the cap, and channels are lowercase identifiers", () => {
  assert.equal(getPostgresListenRetryDelayMs(1), 500);
  assert.equal(getPostgresListenRetryDelayMs(2), 1000);
  assert.equal(getPostgresListenRetryDelayMs(4), 4000);
  assert.equal(getPostgresListenRetryDelayMs(20), 30000);
  assert.equal(getPostgresListenRetryDelayMs(3, { baseMs: 10, maxMs: 25 }), 25);

  assert.equal(isValidPostgresChannel("rag_ingest_jobs_enqueued"), true);
  assert.equal(isValidPostgresChannel("Rag_Jobs"), false, "LISTEN would fold it, pg_notify would not");
  assert.equal(isValidPostgresChannel("jobs; DROP TABLE x"), false);
  assert.equal(isValidPostgresChannel("x".repeat(64)), false, "longer than PostgreSQL keeps");
  assert.throws(
    () => createPostgresNotificationListener({ channel: "Bad", onNotification() {} }),
    /lowercase identifier/
  );
  assert.throws(() => createPostgresNotificationListener({ channel: CHANNEL }), /onNotification/);
});

test("the listener LISTENs as the owner on its own session and reports only its channel", async () => {
  const fake = createFakeClients();
  const notifications = [];
  let listened = 0;
  const listener = createPostgresNotificationListener({
    channel: CHANNEL,
    createClient: fake.create,
    logger: createRecordingLogger().logger,
    onListening: () => {
      listened += 1;
    },
    onNotification: (payload) => notifications.push(payload),
  });

  // Started from inside a tenant request, it still acts as the owner.
  runWithDatabaseTenant(ALICE, () => listener.start());
  listener.start();
  assert.equal(listener.running, true);
  await waitFor(() => listener.listening, { label: "LISTEN" });

  const [client] = fake.clients;

  assert.equal(fake.clients.length, 1, "a second start opens nothing");
  assert.equal(client.tenantAtCreate, null);
  assert.deepEqual(client.queries, [`LISTEN "${CHANNEL}"`]);
  assert.equal(listened, 1);
  assert.equal(listener.listenCount, 1);

  client.emit("notification", { channel: CHANNEL, payload: "p1" });
  client.emit("notification", { channel: "someone_else", payload: "p2" });
  client.emit("notification", { channel: CHANNEL });
  assert.deepEqual(notifications, ["p1", ""]);

  await listener.stop();
  assert.equal(client.ended, true);
  assert.equal(listener.listening, false);
  assert.equal(listener.running, false);
  await listener.stop();
});

test("failed connects and dropped sessions are retried with backoff, and handler errors stay contained", async () => {
  const fake = createFakeClients({ connectFailures: 2 });
  const { lines, logger } = createRecordingLogger();
  let listened = 0;
  const listener = createPostgresNotificationListener({
    channel: CHANNEL,
    createClient: fake.create,
    logger,
    onListening: () => {
      listened += 1;
    },
    onNotification: () => {
      throw new Error("subscriber bug");
    },
    retryBaseMs: 1,
  });

  listener.start();
  await waitFor(() => listener.listening, { label: "LISTEN after two refused connects" });
  assert.equal(fake.clients.length, 3);
  assert.equal(listener.failures, 0, "a successful LISTEN resets the backoff");
  assert.equal(
    lines.filter(([level, message]) => level === "error" && /could not LISTEN/.test(message)).length,
    2
  );

  fake.clients[2].emit("notification", { channel: CHANNEL, payload: "x" });
  assert.match(lines.at(-1)[1], /a notification handler failed/);

  // A session that dies after listening reconnects and announces itself again.
  fake.clients[2].emit("error", new Error("server closed the connection unexpectedly"));
  await waitFor(() => fake.clients.length === 4 && listener.listening, { label: "reconnect" });
  assert.equal(fake.clients[2].ended, true);
  assert.equal(listened, 2);

  fake.clients[3].emit("end");
  await waitFor(() => fake.clients.length === 5 && listener.listening, {
    label: "reconnect after an end",
  });

  await listener.stop();
  assert.ok(fake.clients.every((client) => client.ended));
});

test("stop aborts a session that is still connecting and stops retrying; a restart runs one session", async () => {
  const hanging = createFakeClients({ hangConnect: true });
  const listener = createPostgresNotificationListener({
    channel: CHANNEL,
    createClient: hanging.create,
    logger: createRecordingLogger().logger,
    onNotification() {},
    retryBaseMs: 1,
  });

  listener.start();
  await waitFor(() => hanging.clients.length === 1, { label: "the connect attempt" });
  await listener.stop();
  assert.equal(hanging.clients[0].ended, true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(hanging.clients.length, 1, "no retry after stop");

  // A connect that keeps failing backs off; stop cancels the pending retry.
  const refusing = createFakeClients({ connectFailures: Number.POSITIVE_INFINITY });
  const backingOff = createPostgresNotificationListener({
    channel: CHANNEL,
    createClient: refusing.create,
    logger: createRecordingLogger().logger,
    onNotification() {},
    retryBaseMs: 60 * 60 * 1000,
  });

  backingOff.start();
  await waitFor(() => backingOff.failures === 1, { label: "the first failure" });
  await backingOff.stop();
  assert.equal(refusing.clients.length, 1);

  // stop() then start() before the old session wound down: one session only.
  const fake = createFakeClients();
  const restarted = createPostgresNotificationListener({
    channel: CHANNEL,
    createClient: fake.create,
    logger: createRecordingLogger().logger,
    onNotification() {},
    retryBaseMs: 1,
  });

  restarted.start();
  await waitFor(() => restarted.listening, { label: "first LISTEN" });

  const stopping = restarted.stop();

  restarted.start();
  await stopping;
  await waitFor(() => restarted.listening, { label: "LISTEN after the restart" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fake.clients.filter((client) => !client.ended).length, 1);
  await restarted.stop();
});

test("a dedicated client is a pg.Client outside the pool, never created under a tenant", async () => {
  const previous = {
    LONG_MEMORY_DATABASE_URL: process.env.LONG_MEMORY_DATABASE_URL,
    POSTGRES_DATABASE_URL: process.env.POSTGRES_DATABASE_URL,
    POSTGRES_ROW_LEVEL_SECURITY: process.env.POSTGRES_ROW_LEVEL_SECURITY,
  };

  try {
    delete process.env.LONG_MEMORY_DATABASE_URL;
    delete process.env.POSTGRES_DATABASE_URL;
    assert.throws(() => createDedicatedPostgresClient(), /POSTGRES_DATABASE_URL/);

    process.env.POSTGRES_DATABASE_URL = "postgresql://owner@127.0.0.1:1/archive";
    delete process.env.POSTGRES_ROW_LEVEL_SECURITY;

    const client = createDedicatedPostgresClient();

    assert.ok(client instanceof pg.Client);
    assert.equal(client.connectionParameters.host, "127.0.0.1");
    assert.equal(client.connectionParameters.user, "owner");
    assert.throws(
      () => runWithDatabaseTenant(ALICE, () => createDedicatedPostgresClient()),
      /cannot run under a database tenant/
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});
