#!/usr/bin/env node
// Operator commands for the tenant registry (migration 036,
// rag/tenant-registry.js): `npm run tenant:registry -- <command> ...`.
//
// The same validation and store as the admin API (routes/admin-tenants.js),
// on the system path (runAsDatabaseSystem): the registry is platform data the
// tenant role may not write. PostgreSQL only: without a database the server
// keeps an in-process registry no other process can reach.
//
// A running server caches lookups for TENANT_REGISTRY_CACHE_TTL_MS (5 s by
// default), so a change made here reaches requests after at most that long.

import { pathToFileURL } from "node:url";

import { isPostgresDatabaseConfigured } from "./rag/config.js";
import { resetPostgresPool } from "./rag/postgres.js";
import { runAsDatabaseSystem } from "./rag/postgres-tenant.js";
import {
  createPostgresTenantRegistryStore,
  createTenantRegistryService,
} from "./rag/tenant-registry.js";

export const USAGE = `Usage: node tenant-registry.mjs <command> [arguments] [options]

Manages the tenant registry (migration 036). Needs PostgreSQL
(POSTGRES_DATABASE_URL); runs as the system, like the other operator commands.

Commands
  list                                List workspaces (--status, --limit, --offset).
  create <workspaceId>                Register a workspace (--plan, --region,
                                      --retention-policy <json>, --status
                                      active|suspended; default active).
  suspend <workspaceId>               Suspend a workspace: its requests are
                                      refused with WORKSPACE_SUSPENDED under
                                      TENANT_MEMBERSHIP=enforce.
  activate <workspaceId>              Activate a suspended workspace.
  members <workspaceId>               List a workspace's members (--limit, --offset).
  add-member <workspaceId> <userId>   Add a member, or replace its roles
                                      (--roles workspace.member,...; default none).
  remove-member <workspaceId> <userId>
                                      Remove a member.

Options
  --json     Print the result as JSON.
  --help     Show this message.

Workspace ids are canonical: trimmed and lower case.

--retention-policy is the per-workspace retention the sweep applies
(rag/workspace-retention-policy.js): a JSON object with any of the keys
agentRuns, tasks, workspaceArtifacts and feedback, each a whole number of days
from 0 (keep forever) to 36500, e.g. '{"agentRuns": 30, "feedback": 0}'. It only
adjusts a type whose *_RETENTION_DAYS setting is above 0.
`;

const COMMANDS = Object.freeze({
  activate: { args: ["workspaceId"], options: [] },
  "add-member": { args: ["workspaceId", "userId"], options: ["roles"] },
  create: { args: ["workspaceId"], options: ["plan", "region", "retention-policy", "status"] },
  list: { args: [], options: ["limit", "offset", "status"] },
  members: { args: ["workspaceId"], options: ["limit", "offset"] },
  "remove-member": { args: ["workspaceId", "userId"], options: [] },
  suspend: { args: ["workspaceId"], options: [] },
});

const VALUE_OPTIONS = new Set(["limit", "offset", "plan", "region", "retention-policy", "roles", "status"]);

export const parseTenantRegistryArgs = (argv = []) => {
  const options = { help: false, json: false, values: {} };
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index]);

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg.startsWith("--")) {
      const [name, inlineValue] = arg.includes("=")
        ? [arg.slice(2, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
        : [arg.slice(2), undefined];

      if (!VALUE_OPTIONS.has(name)) {
        throw new Error(`Unknown option: --${name}`);
      }

      const value = inlineValue ?? argv[++index];

      if (value === undefined) {
        throw new Error(`--${name} needs a value.`);
      }

      options.values[name] = String(value);
      continue;
    }

    positional.push(arg);
  }

  if (options.help) {
    return { ...options, args: {}, command: null };
  }

  const [command, ...rest] = positional;

  if (!command) {
    throw new Error("A command is required (list, create, suspend, activate, members, add-member, remove-member).");
  }

  const spec = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : null;

  if (!spec) {
    throw new Error(`Unknown command: ${command}`);
  }

  if (rest.length !== spec.args.length) {
    throw new Error(
      `${command} takes ${spec.args.length === 0 ? "no arguments" : spec.args.map((name) => `<${name}>`).join(" ")}.`
    );
  }

  for (const name of Object.keys(options.values)) {
    if (!spec.options.includes(name)) {
      throw new Error(`--${name} does not apply to ${command}.`);
    }
  }

  return {
    ...options,
    args: Object.fromEntries(spec.args.map((name, index) => [name, rest[index]])),
    command,
  };
};

const parseRetentionPolicy = (value) => {
  if (value === undefined) {
    return undefined;
  }

  try {
    return JSON.parse(value);
  } catch {
    throw new Error("--retention-policy must be a JSON object.");
  }
};

const parseRoles = (value) =>
  value === undefined
    ? []
    : value
        .split(",")
        .map((role) => role.trim())
        .filter(Boolean);

const formatWorkspace = (workspace) =>
  `${workspace.workspaceId}\t${workspace.status}\tplan=${workspace.plan || "-"}\tregion=${workspace.region || "-"}`;

const formatMember = (member) =>
  `${member.userId}\t${member.roles.length ? member.roles.join(",") : "(no roles)"}`;

const formatResult = (result) => {
  switch (result.command) {
    case "list":
      return result.workspaces.length
        ? `${result.workspaces.map(formatWorkspace).join("\n")}\n`
        : "No workspaces.\n";
    case "members":
      return result.members.length
        ? `${result.members.map(formatMember).join("\n")}\n`
        : `No members in ${result.workspaceId}.\n`;
    case "create":
      return `Registered ${formatWorkspace(result.workspace)}\n`;
    case "suspend":
    case "activate":
      return `${formatWorkspace(result.workspace)}\n`;
    case "add-member":
      return `${result.created ? "Added" : "Updated"} ${result.member.userId} in ${result.member.workspaceId}: ${
        result.member.roles.length ? result.member.roles.join(",") : "(no roles)"
      }\n`;
    case "remove-member":
      return `Removed ${result.userId} from ${result.workspaceId}.\n`;
    default:
      return `${JSON.stringify(result)}\n`;
  }
};

/**
 * Runs one command and resolves to its result; `write` prints it. The
 * registry and the database check are injectable for tests.
 */
export const runTenantRegistryCommand = async (
  argv,
  {
    createRegistry = () =>
      // A one-shot process keeps no lookup cache.
      createTenantRegistryService({ cacheTtlMs: 0, store: createPostgresTenantRegistryStore() }),
    isConfigured = isPostgresDatabaseConfigured,
    write = (text) => process.stdout.write(text),
  } = {}
) => {
  const options = parseTenantRegistryArgs(argv);

  if (options.help) {
    write(USAGE);
    return null;
  }

  if (!isConfigured()) {
    throw new Error(
      "tenant:registry needs PostgreSQL (POSTGRES_DATABASE_URL): without a database the server keeps an in-process registry this command cannot reach."
    );
  }

  const registry = createRegistry();
  const { args, command, values } = options;
  const run = async () => {
    switch (command) {
      case "list":
        return {
          workspaces: await registry.listWorkspaces({
            limit: values.limit,
            offset: values.offset,
            status: values.status,
          }),
        };
      case "create":
        return {
          workspace: await registry.createWorkspace({
            plan: values.plan,
            region: values.region,
            retentionPolicy: parseRetentionPolicy(values["retention-policy"]),
            status: values.status,
            workspaceId: args.workspaceId,
          }),
        };
      case "suspend":
        return { workspace: await registry.suspendWorkspace(args.workspaceId) };
      case "activate":
        return { workspace: await registry.activateWorkspace(args.workspaceId) };
      case "members":
        return {
          members: await registry.listMembers(args.workspaceId, {
            limit: values.limit,
            offset: values.offset,
          }),
          workspaceId: args.workspaceId,
        };
      case "add-member":
        return registry.putMember({
          roles: parseRoles(values.roles),
          userId: args.userId,
          workspaceId: args.workspaceId,
        });
      case "remove-member":
        await registry.removeMember(args.workspaceId, args.userId);
        return { removed: true, userId: args.userId, workspaceId: args.workspaceId };
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  };
  const result = { command, ...(await runAsDatabaseSystem(run)) };

  write(options.json ? `${JSON.stringify(result, null, 2)}\n` : formatResult(result));
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

  runTenantRegistryCommand(process.argv.slice(2))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(() => resetPostgresPool());
}
