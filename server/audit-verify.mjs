#!/usr/bin/env node
// Verifies the hash chains of the admin audit table (migration 041).
// `npm run audit:verify -- [--workspace <id>] [--json] [--page-size <n>]`.
//
// - Reads every audit row in id order (pages of --page-size, default 1000) as
//   the system, like the other operator commands, and recomputes each chain:
//   one workspace's events, or one user's events without a workspace
//   (rag/admin-audit-chain.js). It writes nothing. Every page comes from one
//   snapshot (a cursor in one transaction): an event committed while the scan
//   runs is simply not part of it, and can never look like a break.
// - Reports the first break of each chain: a changed row (row_hash_mismatch),
//   a row deleted, reordered or rewritten before a row (prev_hash_mismatch),
//   or a row without hashes after the chain started (unchained_row).
// - A chain whose first remaining row names a predecessor is reported as
//   starting after a purge, not as broken: the retention purge
//   (ADMIN_AUDIT_RETENTION_DAYS) removes the oldest rows on purpose, and the
//   chain cannot tell it from someone else removing them. Rows removed from a
//   chain's end are not visible either; --json prints every chain's head hash,
//   which can be kept elsewhere and compared on the next run.
// - Rows written before migration 041 carry no hashes and are counted as
//   legacy rows.
// - A rolling upgrade leaves unhashed rows after a chain started: an instance
//   still on code from before migration 041 keeps inserting without hashes
//   after the first new instance ran it. Such a row is counted as an upgrade
//   row, not verified and not a break, when it and its chain's head were
//   written at or before the upgrade window's end: the time migration 041 ran
//   (schema_migrations, read on the owner login) plus --upgrade-grace-hours
//   (default 24; 0 turns the window off). --upgrade-window-end <time> sets the
//   end instead, for an upgrade or a rollback that kept older instances
//   writing longer, or when that time cannot be read (then, without it, the
//   window is off). After the window an unhashed row is a break again.
// - Exit code 0 when every chain verifies, 1 when one is broken, 2 when the
//   command could not run.

import { pathToFileURL } from "node:url";

import {
  ADMIN_AUDIT_CHAIN_BREAKS,
  createAdminAuditChainVerifier,
} from "./rag/admin-audit-chain.js";
import { isPostgresDatabaseConfigured } from "./rag/config.js";
import { createPostgresAdminAuditStore } from "./rag/postgres-admin-audit-store.js";
import { resetPostgresPool } from "./rag/postgres.js";
import { runAsDatabaseSystem } from "./rag/postgres-tenant.js";

export const USAGE = `Usage: node audit-verify.mjs [options]

Verifies the hash chains of the admin audit events in PostgreSQL (migration
041) and reports the first break of each chain. Reads only.

Options
  --workspace <id>             Verify only that workspace's chain.
  --page-size <n>              Rows read per statement (default 1000, at most
                               10000).
  --upgrade-grace-hours <n>    How long after migration 041 ran an instance on
                               older code may still have written rows without
                               hashes into started chains (default 24; 0: none).
  --upgrade-window-end <time>  The end of that window as an ISO time instead
                               (when older instances kept writing longer, or
                               when the time migration 041 ran cannot be read).
  --json                       Print the report as JSON (with every chain's
                               head hash).
  --help                       Show this message.

Exit code: 0 every chain verifies, 1 a chain is broken, 2 an error.
`;

const DEFAULT_PAGE_SIZE = 1000;
const MAX_PAGE_SIZE = 10000;
const HOUR_MS = 60 * 60 * 1000;
export const DEFAULT_UPGRADE_GRACE_HOURS = 24;
const MAX_UPGRADE_GRACE_HOURS = 24 * 365;

export const parseAuditVerifyArgs = (argv = []) => {
  const options = {
    help: false,
    json: false,
    pageSize: DEFAULT_PAGE_SIZE,
    upgradeGraceHours: DEFAULT_UPGRADE_GRACE_HOURS,
    upgradeWindowEnd: "",
    workspaceId: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index]);
    const [name, inlineValue] =
      arg.startsWith("--") && arg.includes("=")
        ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
        : [arg, undefined];
    const readValue = () => {
      const value = inlineValue ?? argv[++index];

      if (value === undefined || String(value).trim() === "") {
        throw new Error(`${name} needs a value.`);
      }

      return String(value).trim();
    };

    if (name === "--json") {
      options.json = true;
    } else if (name === "--help" || name === "-h") {
      options.help = true;
    } else if (name === "--workspace") {
      options.workspaceId = readValue();
    } else if (name === "--page-size") {
      const pageSize = Number(readValue());

      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
        throw new Error(`--page-size must be an integer from 1 to ${MAX_PAGE_SIZE}.`);
      }

      options.pageSize = pageSize;
    } else if (name === "--upgrade-grace-hours") {
      const hours = Number(readValue());

      if (!Number.isFinite(hours) || hours < 0 || hours > MAX_UPGRADE_GRACE_HOURS) {
        throw new Error(`--upgrade-grace-hours must be a number from 0 to ${MAX_UPGRADE_GRACE_HOURS}.`);
      }

      options.upgradeGraceHours = hours;
    } else if (name === "--upgrade-window-end") {
      const value = readValue();
      const time = Date.parse(value);

      if (!Number.isFinite(time)) {
        throw new Error("--upgrade-window-end must be a time, such as 2026-10-17T12:00:00Z.");
      }

      options.upgradeWindowEnd = new Date(time).toISOString();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
};

/**
 * Walks a store's chain rows in id order through one verifier and resolves to
 * its report. A store with scanChainRows (the PostgreSQL store) hands every
 * page from one snapshot; paging with listChainRows (a statement, and so a
 * snapshot, per page) is the fallback for a store without it, such as the
 * in-memory one, whose pages cannot miss a row. On a live PostgreSQL table
 * per-page snapshots could: ids are taken at INSERT and become visible at
 * COMMIT, so a page could end past a row another chain's writer commits a
 * moment later, never read it, and report that chain's next row as a false
 * prev_hash_mismatch.
 */
export const verifyAdminAuditStoreChains = async (
  store,
  { pageSize = DEFAULT_PAGE_SIZE, upgradeWindowEndsAt = "", workspaceId = "" } = {}
) => {
  const verifier = createAdminAuditChainVerifier({ upgradeWindowEndsAt });

  if (typeof store.scanChainRows === "function") {
    await store.scanChainRows({
      onPage: (rows) => {
        for (const row of rows) {
          verifier.add(row);
        }
      },
      pageSize,
      workspaceId,
    });

    return verifier.report();
  }

  let afterId = 0;

  for (;;) {
    const rows = (await store.listChainRows({ afterId, limit: pageSize, workspaceId })) ?? [];

    for (const row of rows) {
      verifier.add(row);
    }

    if (rows.length < pageSize) {
      break;
    }

    afterId = Number(rows.at(-1).id);
  }

  return verifier.report();
};

/**
 * The rolling-upgrade window: { chainedSince, endsAt, graceHours, source },
 * or null when it is off (--upgrade-grace-hours 0 without
 * --upgrade-window-end) or its start cannot be read. --upgrade-window-end
 * wins over the recorded start.
 */
export const resolveUpgradeWindow = async (
  store,
  { upgradeGraceHours = DEFAULT_UPGRADE_GRACE_HOURS, upgradeWindowEnd = "" } = {}
) => {
  if (upgradeWindowEnd) {
    return { chainedSince: null, endsAt: upgradeWindowEnd, graceHours: null, source: "argument" };
  }

  if (!(upgradeGraceHours > 0) || typeof store.readChainActivation !== "function") {
    return null;
  }

  const chainedSince = Date.parse((await store.readChainActivation()) || "");

  if (!Number.isFinite(chainedSince)) {
    return null;
  }

  return {
    chainedSince: new Date(chainedSince).toISOString(),
    endsAt: new Date(chainedSince + upgradeGraceHours * HOUR_MS).toISOString(),
    graceHours: upgradeGraceHours,
    source: "migration",
  };
};

const describeChain = (chain) => {
  if (chain.workspaceId) {
    return `workspace ${JSON.stringify(chain.workspaceId)}`;
  }

  return chain.userId
    ? `user ${JSON.stringify(chain.userId)} (no workspace)`
    : "events without a workspace or user";
};

const BREAK_DESCRIPTIONS = Object.freeze({
  [ADMIN_AUDIT_CHAIN_BREAKS.prevHashMismatch]:
    "does not follow the row before it: a row before it was deleted, reordered or rewritten",
  [ADMIN_AUDIT_CHAIN_BREAKS.rowHashMismatch]:
    "no longer matches its hash: it was changed after it was written",
  [ADMIN_AUDIT_CHAIN_BREAKS.unchainedRow]:
    "has no hash although its chain had started: it was written around the audit store, or its hashes were removed",
});

export const formatAuditVerifyReport = (report, { table = "" } = {}) => {
  const purged = report.chains.filter((chain) => chain.startsAfterPurge).length;
  const lines = [
    `${table || "admin audit table"}: ${report.rowsScanned} row(s), ${report.chainCount} chain(s), ${report.chainedRows} chained row(s), ${report.legacyRows} row(s) from before migration 041.`,
  ];

  if (purged > 0) {
    lines.push(
      `${purged} chain(s) start after removed rows (the retention purge removes the oldest rows; the chain cannot tell that from other removals).`
    );
  }

  const window = report.upgradeWindow ?? null;

  if (report.upgradeRows > 0 && window) {
    lines.push(
      `${report.upgradeRows} row(s) without hashes were written into started chains by the end of the upgrade window (${window.endsAt}), as an instance still on code from before migration 041 writes them; they are not verified.`
    );
  }

  if (report.status === "ok") {
    lines.push("OK: every chain verifies.");
  } else {
    lines.push(`BROKEN: ${report.brokenChainCount} of ${report.chainCount} chain(s).`);

    for (const chain of report.chains.filter((entry) => entry.break)) {
      lines.push(
        `  ${describeChain(chain)}: row ${chain.break.rowId} (event ${JSON.stringify(chain.break.eventId)}) ${BREAK_DESCRIPTIONS[chain.break.kind] ?? chain.break.kind} [${chain.break.kind}].`
      );
    }

    if (report.chains.some((chain) => chain.break?.kind === ADMIN_AUDIT_CHAIN_BREAKS.unchainedRow)) {
      lines.push(
        window
          ? `  Unchained rows written after the upgrade window (${window.endsAt}) are breaks. If instances on code from before migration 041 kept writing longer (a slow rollout or a rollback), rerun with --upgrade-window-end <time they stopped>.`
          : "  The upgrade window is off (the time migration 041 ran could not be read, or --upgrade-grace-hours is 0). If instances on code from before migration 041 were still writing, rerun with --upgrade-window-end <time they stopped>."
      );
    }
  }

  return `${lines.join("\n")}\n`;
};

/**
 * Runs the verification and resolves to its report (null for --help); `write`
 * prints it. Everything it touches is injectable for tests.
 */
export const runAuditVerifyCommand = async (
  argv,
  {
    createStore = () => createPostgresAdminAuditStore(),
    isConfigured = isPostgresDatabaseConfigured,
    write = (text) => process.stdout.write(text),
  } = {}
) => {
  const options = parseAuditVerifyArgs(argv);

  if (options.help) {
    write(USAGE);
    return null;
  }

  if (!isConfigured()) {
    throw new Error(
      "audit:verify needs PostgreSQL (POSTGRES_DATABASE_URL): without a database the audit trail is kept in process memory only."
    );
  }

  const store = createStore();
  const table = store.describe?.().table ?? "";
  // Every tenant's chains: the system reads them all, as the retention purge
  // and the other operator commands do.
  const { report, upgradeWindow } = await runAsDatabaseSystem(async () => {
    const window = await resolveUpgradeWindow(store, options);

    return {
      report: await verifyAdminAuditStoreChains(store, {
        pageSize: options.pageSize,
        upgradeWindowEndsAt: window?.endsAt ?? "",
        workspaceId: options.workspaceId,
      }),
      upgradeWindow: window,
    };
  });
  const result = { ...report, table, upgradeWindow, workspaceId: options.workspaceId || null };

  write(options.json ? `${JSON.stringify(result, null, 2)}\n` : formatAuditVerifyReport(result, { table }));
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

  runAuditVerifyCommand(process.argv.slice(2))
    .then((result) => {
      if (result?.status === "broken") {
        process.exitCode = 1;
      }
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    })
    .finally(() => resetPostgresPool());
}
