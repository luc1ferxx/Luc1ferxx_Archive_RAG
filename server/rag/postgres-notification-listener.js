import { createDedicatedPostgresClient } from "./postgres.js";
import { runAsDatabaseSystem } from "./postgres-tenant.js";

// One dedicated PostgreSQL session that LISTENs on a channel and reports every
// notification on it. It sits outside the pool (a pooled session would hold a
// slot forever and could be handed to a query) and logs in as the owner: LISTEN
// is not tenant data, so it never runs in a tenant transaction.
//
// It is a latency optimisation, never a dependency: start() returns at once and
// connects in the background, a failed or dropped connection is retried with
// exponential backoff, and callers keep polling, so a notification lost while
// no session listened costs them at most one poll interval. onListening runs
// after every successful LISTEN, so a caller can look once for work announced
// while nobody was listening.

const DEFAULT_RETRY_BASE_MS = 500;
const DEFAULT_RETRY_MAX_MS = 30000;
const CLOSE_TIMEOUT_MS = 2000;
// Lowercase so the unquoted and quoted spellings name the same channel, and at
// most 63 bytes, the identifier length PostgreSQL keeps (pg_notify refuses a
// longer channel name, while LISTEN would silently truncate it).
const CHANNEL_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

export const getPostgresListenRetryDelayMs = (
  failures,
  { baseMs = DEFAULT_RETRY_BASE_MS, maxMs = DEFAULT_RETRY_MAX_MS } = {}
) => Math.min(baseMs * 2 ** Math.max(0, Number(failures) - 1), maxMs);

export const isValidPostgresChannel = (channel) => CHANNEL_PATTERN.test(String(channel ?? ""));

export const createPostgresNotificationListener = ({
  channel,
  createClient = createDedicatedPostgresClient,
  logger = console,
  onListening = () => {},
  onNotification,
  retryBaseMs = DEFAULT_RETRY_BASE_MS,
  retryMaxMs = DEFAULT_RETRY_MAX_MS,
} = {}) => {
  if (!isValidPostgresChannel(channel)) {
    throw new Error(
      `A PostgreSQL notification channel must be a lowercase identifier of at most 63 bytes. Received "${channel}".`
    );
  }

  if (typeof onNotification !== "function") {
    throw new Error("createPostgresNotificationListener requires onNotification.");
  }

  let running = false;
  // Bumped by every start(), so a loop still winding down from an earlier
  // stop() never keeps going beside the new one.
  let generation = 0;
  let loop = null;
  let activeClient = null;
  let listening = false;
  let failures = 0;
  let listenCount = 0;
  let cancelRetryDelay = null;

  const report = (callback, label, ...args) => {
    try {
      callback(...args);
    } catch (error) {
      logger.error?.(`[postgres-listen] ${label} failed for channel ${channel}.`, error);
    }
  };

  // end() waits for the server to close the socket; a broken connection may
  // never say so, and stopping must not hang on it.
  const endClient = async (client) => {
    if (!client) {
      return;
    }

    let timer = null;

    try {
      await Promise.race([
        Promise.resolve().then(() => client.end()),
        new Promise((resolve) => {
          timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } catch {
      // Already broken: nothing left to close.
    } finally {
      clearTimeout(timer);
    }
  };

  const waitBeforeRetry = (ms) =>
    new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        cancelRetryDelay = null;
        resolve();
      };
      const timer = setTimeout(done, ms);

      timer.unref?.();
      cancelRetryDelay = done;
    });

  // One session: connect, LISTEN, report notifications until the connection
  // ends or errors. Resolves when the session is over.
  const listenOnce = async (isCurrent) => {
    const client = createClient();
    let settleClosed;
    const closed = new Promise((resolve) => {
      settleClosed = resolve;
    });

    activeClient = client;
    // pg emits 'error' on a session that fails after connecting; unhandled it
    // would crash the process.
    client.on("error", (error) => settleClosed(error));
    client.on("end", () => settleClosed(null));
    client.on("notification", (message) => {
      if (message?.channel === channel) {
        report(onNotification, "a notification handler", message.payload ?? "");
      }
    });

    try {
      await client.connect();

      if (!isCurrent()) {
        return;
      }

      await client.query(`LISTEN "${channel}"`);

      if (!isCurrent()) {
        return;
      }

      listening = true;
      failures = 0;
      listenCount += 1;
      report(onListening, "the listening handler");

      const error = await closed;

      if (isCurrent()) {
        logger.warn?.(
          `[postgres-listen] the LISTEN session on ${channel} closed${error?.message ? ` (${error.message})` : ""}; reconnecting.`
        );
      }
    } finally {
      listening = false;

      if (activeClient === client) {
        activeClient = null;
      }

      await endClient(client);
    }
  };

  const run = async (runGeneration) => {
    const isCurrent = () => running && generation === runGeneration;

    while (isCurrent()) {
      try {
        await listenOnce(isCurrent);
      } catch (error) {
        if (isCurrent()) {
          logger.error?.(
            `[postgres-listen] could not LISTEN on ${channel}; callers poll until it reconnects.`,
            error
          );
        }
      }

      if (!isCurrent()) {
        break;
      }

      failures += 1;
      await waitBeforeRetry(
        getPostgresListenRetryDelayMs(failures, { baseMs: retryBaseMs, maxMs: retryMaxMs })
      );
    }
  };

  return {
    get channel() {
      return channel;
    },
    // Consecutive failed or dropped sessions since the last successful LISTEN.
    get failures() {
      return failures;
    },
    get listenCount() {
      return listenCount;
    },
    get listening() {
      return listening;
    },
    get running() {
      return running;
    },

    /**
     * Starts listening in the background and returns at once. The session
     * acts as the owner even when this is called inside a tenant request.
     */
    start() {
      if (running) {
        return;
      }

      running = true;
      generation += 1;

      const runGeneration = generation;

      loop = runAsDatabaseSystem(() => run(runGeneration));
    },

    /**
     * Stops retrying and closes the session. Resolves once this session's
     * loop has ended; a start() made meanwhile runs a new loop of its own.
     */
    async stop() {
      const stoppingLoop = loop;

      if (!running) {
        await stoppingLoop;
        return;
      }

      running = false;
      cancelRetryDelay?.();
      await endClient(activeClient);
      await stoppingLoop;

      if (loop === stoppingLoop) {
        loop = null;
      }
    },
  };
};
