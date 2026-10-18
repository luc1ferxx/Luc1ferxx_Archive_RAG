#!/usr/bin/env node
// Tenant keys for encryption at rest (TENANT_ENCRYPTION, rag/tenant-encryption.js).
//
//   npm run tenant:keys -- status [--workspace <id> | --user <id> | --unscoped]
//   npm run tenant:keys -- rotate (--workspace <id> | --user <id> | --unscoped) [--apply]
//   npm run tenant:keys -- rewrap [--apply] [--batch-size <n>]
//   npm run tenant:keys -- encrypt-existing [--apply] [--batch-size <n>]
//   npm run tenant:keys -- destroy (--workspace <id> | --user <id> | --unscoped) --apply
//
// A key belongs to a workspace, to a user outside any workspace, or (`--unscoped`)
// to the records with no owner at all (auth off, the single shared token).
// Everything but status only reports unless --apply is given; destroy refuses
// without it. Keys are named by their id (a hash of the scope) and versions,
// never by material.
//
// rotate makes a new version for new writes; older versions stay readable.
// rewrap then moves stored envelopes' data keys to the newest version without
// re-encrypting their payloads (only the header changes); it does not protect
// against someone who already copied an old version together with the
// database, because the data keys stay the same. encrypt-existing encrypts the
// legacy plaintext file bytes in PostgreSQL (documents, ingest jobs, stage
// outputs) on the system path, a row per short transaction, skipping rows a
// writer holds and running ingest jobs (run it again for those). destroy is
// the crypto-shred a tenant erase does by itself; on its own it makes the
// scope's encrypted files unreadable everywhere while their rows remain.

import { pathToFileURL } from "node:url";

import { resetPostgresPool } from "./rag/postgres.js";
import { runAsDatabaseSystem } from "./rag/postgres-tenant.js";

export const USAGE = `Usage: node tenant-keys.mjs <command> [options]

Commands
  status                Keystore and master key status, every key, and how many stored
                        files are encrypted; with a scope, that key only.
  rotate                A new key version for new writes (older versions stay readable).
  rewrap                Move stored envelopes to their key's newest version (headers only).
  encrypt-existing      Encrypt legacy plaintext file bytes in PostgreSQL (needs
                        TENANT_ENCRYPTION=on with --apply).
  destroy               Destroy every version of a key (refused without --apply).

Scope (rotate, destroy; optional for status)
  --workspace <id>      The workspace's key.
  --user <id>           The key of the user's records outside any workspace.
  --unscoped            The key of records with no owner.

Options
  --apply               Write instead of reporting.
  --batch-size <n>      rewrap, encrypt-existing: rows listed per page (default 50).
  --json                Print the result as JSON.
  --help                Show this message.
`;

const COMMANDS = ["status", "rotate", "rewrap", "encrypt-existing", "destroy"];
const VALUE_OPTIONS = new Map([
  ["--batch-size", "batchSize"],
  ["--user", "user"],
  ["--workspace", "workspace"],
]);
const FLAG_OPTIONS = new Map([
  ["--apply", "apply"],
  ["--help", "help"],
  ["--json", "json"],
  ["--unscoped", "unscoped"],
  ["-h", "help"],
]);

export const parseTenantKeysArgs = (argv = []) => {
  const options = { apply: false, help: false, json: false, unscoped: false };
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

  if (!COMMANDS.includes(command)) {
    throw new Error(`Unknown command "${command ?? ""}". Expected ${COMMANDS.join(", ")}.`);
  }

  if (extra.length > 0) {
    throw new Error(`Unexpected argument: ${extra[0]}`);
  }

  for (const option of ["user", "workspace"]) {
    if (options[option] !== undefined && !options[option].trim()) {
      throw new Error(`--${option} needs a non-empty value.`);
    }
  }

  const scopes = [options.workspace !== undefined, options.user !== undefined, options.unscoped].filter(Boolean);

  if (scopes.length > 1) {
    throw new Error(
      "Name one key: --workspace <id>, --user <id> (outside any workspace) or --unscoped. A user's records inside a workspace use the workspace's key."
    );
  }

  if (["rotate", "destroy"].includes(command) && scopes.length === 0) {
    throw new Error(`${command} needs a key: --workspace <id>, --user <id> or --unscoped.`);
  }

  if (["rewrap", "encrypt-existing"].includes(command) && scopes.length > 0) {
    throw new Error(`${command} walks every stored file; it takes no scope.`);
  }

  if (command === "status" && options.apply) {
    throw new Error("status only reads; --apply does not apply.");
  }

  if (options.batchSize !== undefined) {
    const batchSize = Number(options.batchSize);

    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10000) {
      throw new Error("--batch-size must be an integer from 1 to 10000.");
    }

    options.batchSize = batchSize;
  }

  return { ...options, command };
};

const describeScopeOption = (options) =>
  options.workspace !== undefined
    ? { workspaceId: options.workspace.trim() }
    : options.user !== undefined
      ? { userId: options.user.trim() }
      : options.unscoped
        ? {}
        : null;

const formatKey = (key) =>
  `${key.keyId} (${key.scopeKind ?? key.scope ?? "?"}) ${key.state}${
    key.currentVersion ? `, current version ${key.currentVersion}` : ""
  }, versions ${key.versions?.join(", ") || "none"}${
    key.destroyedThroughVersion ? `, destroyed through ${key.destroyedThroughVersion}` : ""
  }`;

const formatTables = (tables = {}) =>
  Object.entries(tables).map(
    ([table, counts]) =>
      `  ${table}: ${Object.entries(counts)
        .map(([name, value]) => `${name} ${typeof value === "object" ? JSON.stringify(value) : value}`)
        .join(", ")}`
  );

const formatResult = (command, result) => {
  const lines = [];

  if (command === "status") {
    if (result.key !== undefined) {
      lines.push(result.key ? formatKey(result.key) : `No key for this scope (${result.keyId}).`);
    } else {
      lines.push(
        `Tenant encryption: ${result.mode}, provider ${result.kms.provider}: ${result.kms.status}`,
        `  keystore: ${result.kms.keystore.state}${result.kms.keystore.keys !== undefined ? `, ${result.kms.keystore.keys} key(s)` : ""}`,
        `  master key: ${result.kms.masterKey.state}${result.kms.masterKey.masterKeyId ? ` (${result.kms.masterKey.masterKeyId})` : ""}`
      );

      for (const error of result.kms.errors ?? []) {
        lines.push(`  error ${error.code}: ${error.message}`);
      }

      for (const key of result.keys ?? []) {
        lines.push(`  ${formatKey(key)}`);
      }

      if (result.files) {
        lines.push("Stored files:", ...formatTables(result.files));
      } else {
        lines.push("Stored files: no PostgreSQL configured, not counted.");
      }
    }
  } else if (command === "rotate") {
    lines.push(
      `${result.dryRun ? "Would rotate" : "Rotated"} ${result.keyId}: version ${result.previousVersion ?? "none"} -> ${result.version}`
    );
  } else if (command === "destroy") {
    lines.push(
      result.refused
        ? `Refused: destroy needs --apply. It would destroy ${result.keyId} versions ${result.destroyedVersions.join(", ") || "none"}; every file encrypted under it becomes unreadable for good.`
        : result.existed
          ? `Destroyed ${result.keyId} versions ${result.destroyedVersions.join(", ") || "none (already destroyed)"}.`
          : `No key ${result.keyId}; nothing to destroy.`
    );
  } else {
    if (result.refused) {
      lines.push(`Refused: ${result.reason}`);
    } else {
      lines.push(`${command} (${result.apply ? "applied" : "dry run"}):`, ...formatTables(result.tables));

      if (!result.apply) {
        lines.push("Nothing was written. Pass --apply to write.");
      }
    }
  }

  return `${lines.join("\n")}\n`;
};

/**
 * Runs one command and resolves to { exitCode, result }. `kms`, the
 * maintenance calls and `write` are injectable for tests. Exit codes: 0 done
 * (or a dry run), 2 refused (destroy without --apply, encrypt-existing
 * --apply with encryption off), 1 otherwise.
 */
export const runTenantKeysCommand = async (
  argv,
  {
    loadDependencies = async () => {
      const [config, kms, maintenance] = await Promise.all([
        import("./rag/config.js"),
        import("./rag/kms/index.js"),
        import("./rag/tenant-encryption-maintenance.js"),
      ]);

      return {
        countFiles: maintenance.countTenantFileEncryption,
        databaseConfigured: config.isPostgresDatabaseConfigured(),
        encryptExisting: maintenance.encryptExistingTenantFiles,
        encryptionMode: config.getTenantEncryptionMode(),
        kms: kms.getTenantKmsProvider(),
        resolveScope: kms.resolveTenantKeyScope,
        rewrap: maintenance.rewrapTenantFiles,
      };
    },
    write = (text) => process.stdout.write(text),
  } = {}
) => {
  const options = parseTenantKeysArgs(argv);

  if (options.help) {
    write(USAGE);
    return { exitCode: 0, result: null };
  }

  const deps = await loadDependencies();
  const scopeOption = describeScopeOption(options);
  const scope = scopeOption ? deps.resolveScope(scopeOption) : null;
  let result;
  let exitCode = 0;

  if (options.command === "status") {
    if (scope) {
      result = { key: await deps.kms.describeKey(scope.keyId), keyId: scope.keyId };
    } else {
      const kmsStatus = await deps.kms.status();

      result = {
        files: deps.databaseConfigured ? await deps.countFiles() : null,
        keys: kmsStatus.status === "error" && kmsStatus.keystore.state === "error" ? [] : await deps.kms.listKeys(),
        kms: kmsStatus,
        mode: deps.encryptionMode,
      };
      exitCode = kmsStatus.status === "error" ? 1 : 0;
    }
  } else if (options.command === "rotate") {
    result = await deps.kms.rotateKey(scope, { dryRun: !options.apply });
  } else if (options.command === "destroy") {
    if (!options.apply) {
      result = { ...(await deps.kms.destroyKey(scope.keyId, { dryRun: true })), refused: true };
      exitCode = 2;
    } else {
      result = await deps.kms.destroyKey(scope.keyId);
    }
  } else if (!deps.databaseConfigured) {
    result = { refused: true, reason: "no PostgreSQL is configured (POSTGRES_DATABASE_URL)." };
    exitCode = 1;
  } else if (options.command === "encrypt-existing" && options.apply && deps.encryptionMode !== "on") {
    result = {
      refused: true,
      reason: "TENANT_ENCRYPTION is not on, so new writes would stay plaintext; turn it on before encrypting what is stored.",
    };
    exitCode = 2;
  } else {
    const run = options.command === "rewrap" ? deps.rewrap : deps.encryptExisting;

    result = await run({ apply: options.apply, ...(options.batchSize ? { batchSize: options.batchSize } : {}) });
    exitCode = Object.values(result.tables ?? {}).some((counts) => counts.failed > 0) ? 1 : 0;
  }

  write(options.json ? `${JSON.stringify(result, null, 2)}\n` : formatResult(options.command, result));
  return { exitCode, result };
};

const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  // The environment file is read only when this runs as a command, so a test
  // that imports the module never picks one up.
  await import("dotenv/config");

  // System work end to end, so POSTGRES_TENANT_CONTEXT=strict accepts it.
  runAsDatabaseSystem(() => runTenantKeysCommand(process.argv.slice(2)))
    .then(({ exitCode }) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(() => resetPostgresPool());
}
