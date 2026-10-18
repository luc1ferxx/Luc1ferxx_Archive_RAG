#!/usr/bin/env node
// Tenant erase and export from the command line (rag/tenant-lifecycle.js).
//
//   npm run tenant:erase -- --workspace <id> [--user <id>] [--apply] [--force]
//                           [--servers-stopped]
//   npm run tenant:export -- --workspace <id> [--user <id>] --output <file>
//
// The erase only counts unless --apply is given. A tenant is a workspace
// (every user of it), a user in a workspace (--workspace and --user), or a
// user outside any workspace (--user alone). Long-term memory belongs to a
// user, so only a command that names --user reaches it. A --user or
// --workspace given with an empty value is refused, never read as "absent".
//
// This process reaches the stores every process shares: PostgreSQL, Qdrant,
// the feedback file and the upload session directory. Stores that live in a
// running server's memory (tasks, runs, artifacts, ingest jobs, the audit log
// and the tenant registry without PostgreSQL; session memory without
// PostgreSQL, the standalone profile's in-memory store included; any server's
// semantic cache, in-process claim-judge verdicts and unflushed usage totals)
// are not reachable from here: the ones that are stores are reported as not
// configured and the erase is not complete. Use POST /admin/tenants/erase on
// the running server for those.
//
// The documents are erased from here only when they are shared too: a
// PostgreSQL document registry with pgvector or Qdrant. A running server (or
// MCP bridge) holds the local vector and sparse index (VECTOR_STORE_PROVIDER=
// local) in memory and writes its whole copy back on its next index write, so
// chunks erased here would come back; and it never re-reads a registry other
// than PostgreSQL (the file-backed one of the standalone profile), so it would
// keep listing and answering from the erased documents. There the erase leaves
// the documents out (reported as not reached; the erase is not complete)
// unless --servers-stopped says that no server or MCP bridge runs against
// this archive; the export reads them either way.

import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import { pathToFileURL } from "node:url";

import { resetPostgresPool } from "./rag/postgres.js";
import { runAsDatabaseSystem } from "./rag/postgres-tenant.js";

export const USAGE = `Usage: node tenant-lifecycle.mjs <erase|export> [options]

Commands
  erase                 Count (default) or, with --apply, erase every record of the tenant.
  export                Write the tenant's records as JSON Lines to --output.

Tenant (at least one)
  --workspace <id>      The workspace (exact). Alone: every user of it.
  --user <id>           The user (exact). With --workspace: that user there; alone: the
                        user's records outside any workspace. Also selects long-term memory.

Options
  --apply               erase: delete instead of counting.
  --force               erase: proceed although the tenant has work in flight.
  --servers-stopped     erase: no server or MCP bridge is running against this archive.
                        Needed to erase the documents of a local vector index
                        (VECTOR_STORE_PROVIDER=local) or of a document registry other
                        than PostgreSQL, which a running server keeps in memory.
  --output <file>       export: the file to create (it must not exist yet).
  --actor <id>          The operator id recorded in the audit event (default: none).
  --json                Print the result as JSON.
  --help                Show this message.
`;

const VALUE_OPTIONS = new Map([
  ["--actor", "actor"],
  ["--output", "output"],
  ["--user", "user"],
  ["--workspace", "workspace"],
]);
const FLAG_OPTIONS = new Map([
  ["--apply", "apply"],
  ["--force", "force"],
  ["--help", "help"],
  ["--json", "json"],
  ["--servers-stopped", "serversStopped"],
  ["-h", "help"],
]);

export const parseTenantLifecycleArgs = (argv = []) => {
  const options = { apply: false, force: false, help: false, json: false, serversStopped: false };
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

      options[VALUE_OPTIONS.get(name)] = String(value);
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  if (options.help) {
    return options;
  }

  const [command, ...extra] = positionals;

  if (!["erase", "export"].includes(command)) {
    throw new Error(`Unknown command "${command ?? ""}". Expected erase or export.`);
  }

  if (extra.length > 0) {
    throw new Error(`Unexpected argument: ${extra[0]}`);
  }

  // A value given but empty (`--user "$UID"` with UID unset, `--user=`) is a
  // mistake, never a selection: an empty --user would otherwise widen a
  // one-user erase to every user of the workspace, and an empty --workspace
  // would move it to the user's records outside any workspace.
  if (options.user !== undefined && !options.user.trim()) {
    throw new Error("--user needs a non-empty value; leave it out to select every user of the workspace.");
  }

  if (options.workspace !== undefined && !options.workspace.trim()) {
    throw new Error(
      "--workspace needs a non-empty value; leave it out to select the user's records outside any workspace."
    );
  }

  if (!String(options.workspace ?? "").trim() && !String(options.user ?? "").trim()) {
    throw new Error("Name the tenant: --workspace <id>, --user <id>, or both.");
  }

  if (command === "export" && !options.output) {
    throw new Error("export needs --output <file>.");
  }

  if (command === "export" && (options.apply || options.force || options.serversStopped)) {
    throw new Error("--apply, --force and --servers-stopped belong to erase.");
  }

  if (command === "erase" && options.output) {
    throw new Error("--output belongs to export.");
  }

  return { ...options, command };
};

const CLI_REQUEST = (command) => ({
  method: "CLI",
  path: "tenant-lifecycle.mjs",
  route: `tenant:${command}`,
});

// Only stores this process shares with the servers: a PostgreSQL store lists a
// tenant through iterateTenantRecords; an in-memory one (listTenantRecords
// only) would be this process's own, empty copy.
const sharedOrNull = (store) =>
  typeof store?.iterateTenantRecords === "function" ? store : null;

// Why the documents cannot be erased from here while a server may run (see
// the header): [] when they can. `registryShared` is
// rag/doc-registry.js isDocumentRegistryShared() (the PostgreSQL registry).
export const describeCliDocumentEraseBlockers = ({ registryShared, vectorStoreProvider }) => [
  ...(registryShared ? [] : ["document_registry_in_server_memory"]),
  ...(vectorStoreProvider === "local" ? ["local_vector_index_in_server_memory"] : []),
];

export const CLI_DOCUMENTS_WITHHELD_HINT =
  "documents: a running server or MCP bridge keeps this archive's document registry or local vector index in memory, so an erase from here would not reach it (and the local index would be written back). Use POST /admin/tenants/erase on the running server, or stop every server and MCP bridge and pass --servers-stopped.";

/**
 * The service over the default stores (the ones createAppServices builds),
 * keeping only those this process shares with running servers. The semantic
 * cache lives in each server's memory, so with RAG_SEMANTIC_CACHE=on it is
 * reported as not reached; the claim-judge cache is reached in Redis
 * (RAG_SHARED_STATE=redis), not in the servers' own memory. Session memory is
 * reached only in PostgreSQL. For `command: "erase"` the documents are left
 * out (`withheldStores.documents` names why) unless they are shared or
 * `serversStopped` is true.
 */
export const createCliTenantLifecycleService = async ({ command = "erase", serversStopped = false } = {}) => {
  const [
    { getDefaultUploadsDirectory },
    { getDefaultFeedbackStore },
    { createDefaultAdminAuditService },
    { createDefaultAgentRunStore },
    { getVectorStoreProvider, isSemanticCacheEnabled },
    { isDocumentRegistryShared },
    { createDefaultIngestJobStore },
    { getSessionMemoryTenantRecordStore },
    { createDefaultTaskStore },
    { createTenantLifecycleService },
    { createDefaultTenantRegistryService },
    { createDefaultWorkspaceArtifactStore },
    { isStandaloneProfileEnabled, applyStandaloneProfile },
    { eraseUploadSessionsForTenant, listUploadSessionsForTenant },
  ] = await Promise.all([
    import("./app.js"),
    import("./feedback.js"),
    import("./rag/admin-audit-store.js"),
    import("./rag/agent-run-store.js"),
    import("./rag/config.js"),
    import("./rag/doc-registry.js"),
    import("./rag/ingest-job-store.js"),
    import("./rag/memory.js"),
    import("./rag/task-store.js"),
    import("./rag/tenant-lifecycle.js"),
    import("./rag/tenant-registry.js"),
    import("./rag/workspace-artifacts/index.js"),
    import("./standalone-profile.js"),
    import("./upload-session-store.js"),
  ]);

  if (isStandaloneProfileEnabled()) {
    applyStandaloneProfile();
  }

  const adminAuditService = createDefaultAdminAuditService();
  // After the standalone profile, which installs the file-backed registry.
  const documentBlockers =
    command === "erase" && serversStopped !== true
      ? describeCliDocumentEraseBlockers({
          registryShared: isDocumentRegistryShared(),
          vectorStoreProvider: getVectorStoreProvider(),
        })
      : [];

  const service = createTenantLifecycleService({
    adminAuditService: sharedOrNull(adminAuditService),
    agentRunStore: sharedOrNull(createDefaultAgentRunStore()),
    // Left out: reported as not reached, and the erase is not complete.
    ...(documentBlockers.length > 0 ? { documents: null } : {}),
    // The feedback file and the PostgreSQL table are both shared.
    feedbackStore: getDefaultFeedbackStore(),
    ingestJobStore: sharedOrNull(createDefaultIngestJobStore()),
    ...(isSemanticCacheEnabled() ? { semanticCache: null } : {}),
    // The PostgreSQL store only: an in-memory one (the standalone profile's)
    // is this process's own, empty copy, not a running server's sessions.
    sessionMemory: () => {
      const resolved = getSessionMemoryTenantRecordStore();

      return resolved.status === "ok" && !sharedOrNull(resolved.store)
        ? { status: "not_configured", store: null }
        : resolved;
    },
    taskStore: sharedOrNull(createDefaultTaskStore()),
    // PostgreSQL only: without a database the registry lives in each
    // server's memory. No lookup cache here, so the mark it writes is what
    // the next read sees; the servers drop theirs within
    // TENANT_REGISTRY_CACHE_TTL_MS. The usage ledger's rows are the default
    // store (this process has no unflushed totals of its own).
    tenantRegistry: sharedOrNull(createDefaultTenantRegistryService({ cacheTtlMs: 0 })),
    uploadStore: { eraseUploadSessionsForTenant, listUploadSessionsForTenant },
    uploadsDirectory: getDefaultUploadsDirectory(),
    workspaceArtifactStore: sharedOrNull(createDefaultWorkspaceArtifactStore()),
  });

  return documentBlockers.length > 0
    ? { ...service, withheldStores: { documents: documentBlockers } }
    : service;
};

const formatEraseResult = (result) => {
  const lines = [
    `${result.dryRun ? "Dry run" : "Erase"} for workspace "${result.tenant.workspaceId}"${
      result.tenant.userId === null ? " (every user)" : `, user "${result.tenant.userId}"`
    }: ${result.status}`,
  ];

  for (const store of result.stores) {
    const tables = Object.entries(store.tables ?? {});

    lines.push(`  ${store.store}: ${store.status}`);

    for (const [table, count] of tables) {
      const parts = [`records ${count.records ?? 0}`];

      if (count.active !== undefined) parts.push(`active ${count.active}`);
      if (count.deleted !== undefined) parts.push(`deleted ${count.deleted}`);
      lines.push(`    ${table}: ${parts.join(", ")}`);
    }
  }

  if (Object.keys(result.activeWork ?? {}).length > 0) {
    lines.push(
      `Work in flight: ${Object.entries(result.activeWork)
        .map(([table, count]) => `${table} ${count}`)
        .join(", ")}${result.status === "refused" ? " (refused; finish or cancel it, or pass --force)" : ""}`
    );
  }

  if (result.skippedStores?.length > 0) {
    lines.push(`Not reached from here: ${result.skippedStores.join(", ")}`);
  }

  // The crypto-shred step (TENANT_ENCRYPTION): key ids and versions only.
  if (result.tenantKeys) {
    const keys = result.tenantKeys;

    lines.push(`  tenant_keys: ${keys.status}${keys.error ? ` (${keys.error.code})` : ""}`);

    for (const key of keys.destroyed ?? []) {
      lines.push(`    destroyed ${key.keyId} (${key.scope}) versions ${key.destroyedVersions.join(", ") || "none"}`);
    }

    for (const key of keys.destroy ?? []) {
      lines.push(
        `    ${result.dryRun ? "would destroy" : "not destroyed"} ${key.keyId} (${key.scope}, ${key.state}) versions ${key.versions.join(", ") || "none"}`
      );
    }

    for (const key of keys.kept ?? []) {
      lines.push(`    kept ${key.keyId} (${key.scope}, shared by the workspace's other members)`);
    }
  }

  if (result.withheldStores?.documents) {
    lines.push(CLI_DOCUMENTS_WITHHELD_HINT);
  }

  if (result.dryRun) {
    lines.push("Nothing was deleted. Pass --apply to erase.");
  }

  return `${lines.join("\n")}\n`;
};

/**
 * Runs one command and resolves to its result. `createService`, `write` and
 * `openOutput` are injectable for tests. Exit codes (set by the caller): 0
 * for a dry run or a complete erase or export, 2 when the erase was refused
 * for work in flight, 1 otherwise.
 */
export const runTenantLifecycleCommand = async (
  argv,
  {
    createService = createCliTenantLifecycleService,
    openOutput = (file) => createWriteStream(file, { flags: "wx", mode: 0o600 }),
    write = (text) => process.stdout.write(text),
  } = {}
) => {
  const options = parseTenantLifecycleArgs(argv);

  if (options.help) {
    write(USAGE);
    return { exitCode: 0, result: null };
  }

  const service = await createService({
    command: options.command,
    serversStopped: options.serversStopped,
  });
  const actor = { userId: options.actor ?? "", workspaceId: "" };
  const tenant = { userId: options.user ?? null, workspaceId: options.workspace ?? "" };

  if (options.command === "erase") {
    const erased = await service.eraseTenant({
      ...tenant,
      actor,
      dryRun: !options.apply,
      force: options.force,
      request: CLI_REQUEST("erase"),
    });
    // Why a store this process left out was not reached (the documents of a
    // registry or local index a running server keeps in memory).
    const result = service.withheldStores
      ? { ...erased, withheldStores: service.withheldStores }
      : erased;

    write(options.json ? `${JSON.stringify(result, null, 2)}\n` : formatEraseResult(result));

    return {
      exitCode:
        result.status === "dry_run" || result.status === "completed"
          ? 0
          : result.status === "refused"
            ? 2
            : 1,
      result,
    };
  }

  const output = openOutput(options.output);
  let summary = null;
  let failure = null;

  try {
    await once(output, "open");

    for await (const line of service.exportTenant({ ...tenant, actor, request: CLI_REQUEST("export") })) {
      const parsed = JSON.parse(line);

      if (parsed.type === "summary") summary = parsed;
      if (parsed.type === "error") failure = parsed;

      if (!output.write(`${line}\n`)) {
        await once(output, "drain");
      }
    }
  } finally {
    output.end();
    // Settled whether the stream finished, failed to open, or already closed.
    await finished(output).catch(() => {});
  }

  const result = { failure, output: options.output, summary };

  write(
    options.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : failure
        ? `Export failed at ${failure.store} (${failure.code}); ${options.output} is incomplete.\n`
        : `Wrote ${summary?.records ?? 0} record(s) to ${options.output}${
            summary?.complete ? "" : `; not reached from here: ${(summary?.skippedStores ?? []).join(", ")}`
          }.\n`
  );

  return { exitCode: !failure && summary?.complete ? 0 : 1, result };
};

const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  // The environment file is read only when this runs as a command, so a test
  // that imports the module never picks one up.
  await import("dotenv/config");

  // System work end to end (the export binds each tenant itself), so
  // POSTGRES_TENANT_CONTEXT=strict accepts the set-up too.
  runAsDatabaseSystem(() => runTenantLifecycleCommand(process.argv.slice(2)))
    .then(({ exitCode }) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(() => resetPostgresPool());
}
