import { normalizeScopeId, normalizeScopeIds } from "../access-scope.js";
import {
  getTenantRegistryCacheScope,
  getTenantRegistryCacheTtlMs,
  getTenantRegistryStoreConfigStatus,
} from "./config.js";
import { getTenantRegistryTableNames, runPostgresMigrations } from "./db-migrations.js";
import { queryPostgres } from "./postgres.js";
import { runWithDatabaseTenant } from "./postgres-tenant.js";
import {
  createPostgresTenantRecordMethods,
  summarizeTenantRecords,
  tenantSelectorMatches,
} from "./tenant-records.js";
import { describeWorkspaceRetentionPolicyProblem } from "./workspace-retention-policy.js";

// The tenant registry (migration 036): the workspaces a deployment knows,
// their status, and who belongs to each with which roles.
//
// - Stores: PostgreSQL whenever a database is configured, else an in-process
//   map with the same contract (the profile without a database; per process
//   and empty at every start).
// - The service validates every input (canonical ids, bounded fields), keeps
//   a short per-process cache of the lookups requireApiAuth makes, and drops
//   the entries a write touches at once. Other processes see a write after at
//   most TENANT_REGISTRY_CACHE_TTL_MS.
// - Enforcement (TENANT_MEMBERSHIP=enforce, auth.js) asks decideTenantMembership.
//   Its two lookups bind the tenant they check (runWithDatabaseTenant), so on
//   PostgreSQL they read through migration 036's tenant policies: a workspace
//   row as that workspace, a membership row as that user in that workspace.
// - Every other read and write (the admin routes, the CLI, the tenant erase,
//   the retention sweep's policy read) runs in the caller's context, which
//   binds runAsDatabaseSystem after its own permission check: the tenant role
//   may not write these tables at all. The tenant export reads each page
//   bound to its tenant (createPostgresTenantRecordMethods).
// - A workspace's retention_policy is held to the retention sweep's format
//   (rag/workspace-retention-policy.js; normalizeRetentionPolicy below), at
//   creation and on every later change (setWorkspaceRetentionPolicy).

export const WORKSPACE_STATUSES = Object.freeze({
  active: "active",
  deleting: "deleting",
  suspended: "suspended",
});

const WORKSPACE_STATUS_LIST = Object.freeze(Object.values(WORKSPACE_STATUSES));

export const TENANT_REGISTRY_ERROR_CODES = Object.freeze({
  invalidInput: "TENANT_REGISTRY_INVALID_INPUT",
  memberNotFound: "WORKSPACE_MEMBER_NOT_FOUND",
  unavailable: "TENANT_REGISTRY_UNAVAILABLE",
  workspaceDeleting: "WORKSPACE_DELETING",
  workspaceExists: "WORKSPACE_EXISTS",
  workspaceNotFound: "WORKSPACE_NOT_FOUND",
});

// The 403 codes requireApiAuth answers under TENANT_MEMBERSHIP=enforce.
export const TENANT_MEMBERSHIP_CODES = Object.freeze({
  membershipRequired: "WORKSPACE_MEMBERSHIP_REQUIRED",
  notRegistered: "WORKSPACE_NOT_REGISTERED",
  registryUnavailable: "TENANT_REGISTRY_UNAVAILABLE",
  rolesLimitExceeded: "WORKSPACE_ROLES_LIMIT_EXCEEDED",
  workspaceDeleting: "WORKSPACE_DELETING",
  workspaceSuspended: "WORKSPACE_SUSPENDED",
});

// The most role ids a request's scope may carry for its active workspace once
// a membership's roles are merged into the credential's own: the bound of the
// internal service token (MAX_FORWARDED_WORKSPACE_ROLES in
// rag/service-identity.js, pinned equal by tenant-registry.test.mjs), so a
// scope the monolith accepts is one the split edge can also sign. Members
// themselves are capped at MAX_MEMBER_ROLES (the same number) below.
export const MAX_SCOPE_WORKSPACE_ROLES = 32;

const MEMBERSHIP_MESSAGES = Object.freeze({
  [TENANT_MEMBERSHIP_CODES.membershipRequired]:
    "This credential is not a member of the requested workspace.",
  [TENANT_MEMBERSHIP_CODES.notRegistered]: "This workspace is not registered.",
  [TENANT_MEMBERSHIP_CODES.registryUnavailable]:
    "The tenant registry is unavailable; try again shortly.",
  [TENANT_MEMBERSHIP_CODES.rolesLimitExceeded]: `This credential and its workspace membership grant more than ${MAX_SCOPE_WORKSPACE_ROLES} roles in the workspace; remove some from the membership or the credential.`,
  [TENANT_MEMBERSHIP_CODES.workspaceDeleting]: "This workspace is being deleted.",
  [TENANT_MEMBERSHIP_CODES.workspaceSuspended]: "This workspace is suspended.",
});

export class TenantRegistryError extends Error {
  constructor(message, { code, status = 400 } = {}) {
    super(message);
    this.name = "TenantRegistryError";
    this.code = code ?? TENANT_REGISTRY_ERROR_CODES.invalidInput;
    this.status = status;
    // Written by this module only, never with stored data.
    this.expose = true;
  }
}

export const MAX_TENANT_ID_LENGTH = 256;
export const MAX_WORKSPACE_DESCRIPTOR_LENGTH = 128;
export const MAX_RETENTION_POLICY_BYTES = 16 * 1024;
export const MAX_MEMBER_ROLES = 32;
export const TENANT_REGISTRY_LIST_DEFAULT_LIMIT = 100;
export const TENANT_REGISTRY_LIST_MAX_LIMIT = 1000;
const MAX_LIST_OFFSET = 1_000_000;
const MAX_CACHE_ENTRIES = 10_000;
// GET /auth/me's registry memberships (listMemberWorkspaces): the most it
// lists for one user, and how many workspace lookups it has in flight at once.
export const MAX_MEMBER_WORKSPACES = TENANT_REGISTRY_LIST_MAX_LIMIT;
const MEMBER_WORKSPACE_LOOKUP_BATCH = 16;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const ROLE_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/u;

const invalid = (message) => new TenantRegistryError(message);

const isPlainObject = (value) =>
  Boolean(value) &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const requireIdString = (value, field) => {
  if (typeof value !== "string") {
    throw invalid(`${field} must be a string.`);
  }

  const trimmed = value.trim();

  if (!trimmed) {
    throw invalid(`${field} is required.`);
  }

  if (trimmed.length > MAX_TENANT_ID_LENGTH) {
    throw invalid(`${field} must be at most ${MAX_TENANT_ID_LENGTH} characters.`);
  }

  if (CONTROL_CHARACTERS.test(trimmed)) {
    throw invalid(`${field} must not contain control characters.`);
  }

  return trimmed;
};

/**
 * A workspace id as the registry stores it: trimmed and canonical (lower
 * case, no whitespace runs). That is the form a token's workspace list
 * resolves to (auth.js resolveWorkspaceId), and the only form in which a
 * workspace role applies to the tenant (rag/rbac.js). Anything else is
 * refused rather than rewritten, so an operator never registers "acme" while
 * meaning a tenant that requests resolve as "Acme".
 */
export const normalizeWorkspaceIdInput = (value, field = "workspaceId") => {
  const trimmed = requireIdString(value, field);

  if (normalizeScopeId(trimmed) !== trimmed) {
    throw invalid(`${field} must be lower case without repeated whitespace.`);
  }

  return trimmed;
};

// A user id exactly as the database tenant carries it (trimmed, case kept).
export const normalizeUserIdInput = (value, field = "userId") => requireIdString(value, field);

/**
 * Role ids granted inside one workspace. Admin roles are refused: every
 * admin.* permission reads or acts across tenants, so rag/rbac.js never takes
 * one from a workspace role, and storing one would only mislead.
 */
export const normalizeMemberRolesInput = (value) => {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value) || value.some((role) => typeof role !== "string")) {
    throw invalid("roles must be a list of role ids.");
  }

  const roles = normalizeScopeIds(value);

  if (roles.length > MAX_MEMBER_ROLES) {
    throw invalid(`roles may list at most ${MAX_MEMBER_ROLES} role ids.`);
  }

  for (const role of roles) {
    if (!ROLE_ID_PATTERN.test(role)) {
      throw invalid("Each role id must be 1-64 characters of a-z, 0-9, '.', '_', ':' or '-'.");
    }

    if (role.startsWith("admin.")) {
      throw invalid(
        "Admin roles are deployment-wide and cannot be granted inside a workspace."
      );
    }
  }

  return roles;
};

const normalizeDescriptor = (value, field) => {
  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value !== "string") {
    throw invalid(`${field} must be a string.`);
  }

  const trimmed = value.trim();

  if (trimmed.length > MAX_WORKSPACE_DESCRIPTOR_LENGTH) {
    throw invalid(`${field} must be at most ${MAX_WORKSPACE_DESCRIPTOR_LENGTH} characters.`);
  }

  if (CONTROL_CHARACTERS.test(trimmed)) {
    throw invalid(`${field} must not contain control characters.`);
  }

  return trimmed;
};

// The retention sweep reads this policy (rag/retention.js), so it is held to
// the format rag/workspace-retention-policy.js defines: keys agentRuns, tasks,
// workspaceArtifacts and feedback, each a whole number of days from 0 (keep
// forever) to 36500, e.g. {"agentRuns": 30, "feedback": 0}. Any other key or
// value is refused here instead of being ignored by the sweep.
const normalizeRetentionPolicy = (value) => {
  if (value === undefined || value === null) {
    return {};
  }

  if (!isPlainObject(value)) {
    throw invalid("retentionPolicy must be a JSON object.");
  }

  const problem = describeWorkspaceRetentionPolicyProblem(value);

  if (problem) {
    throw invalid(problem);
  }

  let serialized;

  try {
    serialized = JSON.stringify(value);
  } catch {
    throw invalid("retentionPolicy must be a JSON object.");
  }

  if (Buffer.byteLength(serialized, "utf8") > MAX_RETENTION_POLICY_BYTES) {
    throw invalid(`retentionPolicy must be at most ${MAX_RETENTION_POLICY_BYTES} bytes as JSON.`);
  }

  // jsonb refuses the \u0000 escape.
  if (serialized.includes("\\u0000")) {
    throw invalid("retentionPolicy must not contain U+0000.");
  }

  return JSON.parse(serialized);
};

const normalizeStatusInput = (value, { allowed = WORKSPACE_STATUS_LIST, field = "status" } = {}) => {
  const status = typeof value === "string" ? value.trim().toLowerCase() : "";

  if (!allowed.includes(status)) {
    throw invalid(`${field} must be one of ${allowed.join(", ")}.`);
  }

  return status;
};

const toBoundedInteger = (value, { fallback, max, min }) => {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw invalid(`Expected an integer from ${min} to ${max}.`);
  }

  return parsed;
};

export const normalizeListOptions = ({ limit, offset } = {}) => ({
  limit: toBoundedInteger(limit, {
    fallback: TENANT_REGISTRY_LIST_DEFAULT_LIMIT,
    max: TENANT_REGISTRY_LIST_MAX_LIMIT,
    min: 1,
  }),
  offset: toBoundedInteger(offset, { fallback: 0, max: MAX_LIST_OFFSET, min: 0 }),
});

// A new workspace's id: printable ASCII only. Clients name the workspace in
// the x-workspace-id header, and a header value is a ByteString: a browser
// cannot send an id with a character above U+00FF at all (fetch and XHR throw
// before the request, so the SPA could not act in it), and Node reads header
// bytes as Latin-1, so a UTF-8 id sent by any other client arrives as another
// string than the one registered. Checked at creation only: ids registered
// before keep working wherever they are looked up.
const REGISTRABLE_WORKSPACE_ID = /^[ -~]+$/u;

export const normalizeWorkspaceInput = (input = {}) => {
  if (!isPlainObject(input)) {
    throw invalid("The workspace must be a JSON object.");
  }

  const workspaceId = normalizeWorkspaceIdInput(input.workspaceId);

  if (!REGISTRABLE_WORKSPACE_ID.test(workspaceId)) {
    throw invalid("workspaceId must be printable ASCII: it travels in the x-workspace-id header.");
  }

  return {
    plan: normalizeDescriptor(input.plan, "plan"),
    region: normalizeDescriptor(input.region, "region"),
    retentionPolicy: normalizeRetentionPolicy(input.retentionPolicy),
    status:
      input.status === undefined || input.status === null
        ? WORKSPACE_STATUSES.active
        : normalizeStatusInput(input.status, {
            allowed: [WORKSPACE_STATUSES.active, WORKSPACE_STATUSES.suspended],
          }),
    workspaceId,
  };
};

const copy = (value) => (value === null || value === undefined ? null : structuredClone(value));

const toIso = (value) => {
  if (!value) {
    return "";
  }

  const date = value instanceof Date ? value : new Date(value);

  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
};

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------

const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

/**
 * The store without a database: one map per process, empty at every start.
 * Same contract and the same ordering (ids in code-point order) as the
 * PostgreSQL store.
 */
export const createInMemoryTenantRegistryStore = ({ now = () => Date.now() } = {}) => {
  const workspaces = new Map();
  const members = new Map();
  const memberKey = (workspaceId, userId) => `${workspaceId}\u0000${userId}`;
  const isoNow = () => new Date(now()).toISOString();
  const listTenantRecords = (selector) => {
    const entries = [...members.values()]
      .filter((member) => tenantSelectorMatches(selector, member))
      .sort((left, right) => compareText(left.userId, right.userId))
      .map((member) => ({ record: copy(member), table: TENANT_REGISTRY_RECORD_TABLES.members }));
    const workspace = selector.userId === null ? workspaces.get(selector.workspaceId) : null;

    return workspace
      ? [...entries, { record: copy(workspace), table: TENANT_REGISTRY_RECORD_TABLES.workspaces }]
      : entries;
  };

  return {
    backend: "memory",

    describe() {
      return { backend: "memory", persistent: false };
    },

    async initialize() {
      return true;
    },

    async getWorkspace(workspaceId) {
      return copy(workspaces.get(workspaceId));
    },

    async listWorkspaces({ limit, offset, status = null } = {}) {
      return [...workspaces.values()]
        .filter((workspace) => !status || workspace.status === status)
        .sort((left, right) => compareText(left.workspaceId, right.workspaceId))
        .slice(offset, offset + limit)
        .map(copy);
    },

    async insertWorkspace(record) {
      if (workspaces.has(record.workspaceId)) {
        return null;
      }

      const timestamp = isoNow();
      const workspace = {
        workspaceId: record.workspaceId,
        status: record.status,
        plan: record.plan,
        region: record.region,
        retentionPolicy: copy(record.retentionPolicy) ?? {},
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      workspaces.set(workspace.workspaceId, workspace);
      return copy(workspace);
    },

    async updateWorkspaceStatus({ refuseFrom = [], status, workspaceId }) {
      const workspace = workspaces.get(workspaceId);

      if (!workspace) {
        return { outcome: "missing", workspace: null };
      }

      if (refuseFrom.includes(workspace.status)) {
        return { outcome: "refused", workspace: copy(workspace) };
      }

      workspace.status = status;
      workspace.updatedAt = isoNow();
      return { outcome: "updated", workspace: copy(workspace) };
    },

    async updateWorkspaceRetentionPolicy({ refuseFrom = [], retentionPolicy, workspaceId }) {
      const workspace = workspaces.get(workspaceId);

      if (!workspace) {
        return { outcome: "missing", workspace: null };
      }

      if (refuseFrom.includes(workspace.status)) {
        return { outcome: "refused", workspace: copy(workspace) };
      }

      workspace.retentionPolicy = copy(retentionPolicy) ?? {};
      workspace.updatedAt = isoNow();
      return { outcome: "updated", workspace: copy(workspace) };
    },

    async getMember(workspaceId, userId) {
      return copy(members.get(memberKey(workspaceId, userId)));
    },

    async listMembers({ limit, offset, workspaceId }) {
      return [...members.values()]
        .filter((member) => member.workspaceId === workspaceId)
        .sort((left, right) => compareText(left.userId, right.userId))
        .slice(offset, offset + limit)
        .map(copy);
    },

    async listUserMemberships({ limit, userId }) {
      return [...members.values()]
        .filter((member) => member.userId === userId)
        .sort((left, right) => compareText(left.workspaceId, right.workspaceId))
        .slice(0, limit)
        .map(copy);
    },

    async upsertMember({ roles, userId, workspaceId }) {
      if (!workspaces.has(workspaceId)) {
        return null;
      }

      const key = memberKey(workspaceId, userId);
      const existing = members.get(key);
      const member = {
        workspaceId,
        userId,
        roles: [...roles],
        createdAt: existing?.createdAt ?? isoNow(),
      };

      members.set(key, member);
      return { created: !existing, member: copy(member) };
    },

    async deleteMember({ userId, workspaceId }) {
      return members.delete(memberKey(workspaceId, userId));
    },

    // The tenant erase and export (rag/tenant-lifecycle.js), with the
    // selector rules of TENANT_REGISTRY_RECORD_TABLES below.
    async listTenantRecords(selector) {
      return listTenantRecords(selector);
    },

    async countTenantRecords(selector) {
      const counts = summarizeTenantRecords(listTenantRecords(selector), [
        TENANT_REGISTRY_RECORD_TABLES.members,
        TENANT_REGISTRY_RECORD_TABLES.workspaces,
      ]);

      return selector.userId === null
        ? counts
        : { ...counts, [TENANT_REGISTRY_RECORD_TABLES.workspaces]: { notApplicable: true, records: 0 } };
    },

    async deleteTenantRecords(selector) {
      let deletedMembers = 0;

      for (const [key, member] of [...members.entries()]) {
        if (tenantSelectorMatches(selector, member)) {
          members.delete(key);
          deletedMembers += 1;
        }
      }

      if (selector.userId !== null) {
        return { [TENANT_REGISTRY_RECORD_TABLES.members]: { deleted: deletedMembers } };
      }

      return {
        [TENANT_REGISTRY_RECORD_TABLES.members]: { deleted: deletedMembers },
        [TENANT_REGISTRY_RECORD_TABLES.workspaces]: {
          deleted: workspaces.delete(selector.workspaceId) ? 1 : 0,
        },
      };
    },
  };
};

/**
 * The report keys of the registry's records in a tenant erase or export
 * (rag/tenant-lifecycle.js). A record matches its selector on its owner
 * columns exactly, as in every other store (rag/tenant-records.js):
 *
 *   workspace_members  a workspace selector: every membership of the
 *                      workspace; a user in a workspace: that membership; a
 *                      user outside any workspace: none (a membership always
 *                      names a workspace)
 *   workspaces         a workspace selector only: the workspace's own row,
 *                      deleted after its memberships. A selector naming a user
 *                      never reaches it.
 */
export const TENANT_REGISTRY_RECORD_TABLES = Object.freeze({
  members: "workspace_members",
  workspaces: "workspaces",
});

const WORKSPACE_COLUMNS = "workspace_id, status, plan, region, retention_policy, created_at, updated_at";
const MEMBER_COLUMNS = "workspace_id, user_id, roles, created_at";

export const mapWorkspaceRow = (row = {}) => ({
  workspaceId: row.workspace_id,
  status: row.status,
  plan: row.plan ?? "",
  region: row.region ?? "",
  retentionPolicy:
    row.retention_policy && typeof row.retention_policy === "object" ? row.retention_policy : {},
  createdAt: toIso(row.created_at),
  updatedAt: toIso(row.updated_at),
});

export const mapMemberRow = (row = {}) => ({
  workspaceId: row.workspace_id,
  userId: row.user_id,
  roles: Array.isArray(row.roles) ? [...row.roles] : [],
  createdAt: toIso(row.created_at),
});

const FOREIGN_KEY_VIOLATION = "23503";

/**
 * The PostgreSQL store (migration 036). Statements run in the caller's
 * database context: the enforcement lookups bind the tenant they check, and
 * the admin routes and the CLI bind runAsDatabaseSystem, because the tenant
 * role may only read its own rows and writes nothing.
 */
export const createPostgresTenantRegistryStore = ({
  query = queryPostgres,
  runMigrations = runPostgresMigrations,
  tableNames = getTenantRegistryTableNames(),
} = {}) => {
  const { workspaceMembersTable, workspacesTable } = getTenantRegistryTableNames(tableNames);
  let initialized = false;

  const initialize = async () => {
    if (!initialized) {
      await runMigrations();
      initialized = true;
    }

    return true;
  };

  const selectWorkspace = async (workspaceId) => {
    const result = await query(
      `SELECT ${WORKSPACE_COLUMNS} FROM ${workspacesTable} WHERE workspace_id = $1`,
      [workspaceId]
    );

    return result.rows?.[0] ? mapWorkspaceRow(result.rows[0]) : null;
  };

  // The tenant erase and export (rag/tenant-lifecycle.js), with the selector
  // rules of TENANT_REGISTRY_RECORD_TABLES: memberships first, so a
  // workspace's row goes last. Counting and deleting run in the caller's
  // context (the erase runs as the system); each export page is read bound to
  // its tenant, so migration 036's SELECT policies bound it as well.
  const tenantRecordMethods = createPostgresTenantRecordMethods({
    initialize,
    query,
    tables: () => [
      {
        keyColumns: ["workspace_id", "user_id"],
        mapRow: mapMemberRow,
        name: TENANT_REGISTRY_RECORD_TABLES.members,
        table: workspaceMembersTable,
        userColumn: "user_id",
      },
      {
        keyColumns: ["workspace_id"],
        mapRow: mapWorkspaceRow,
        name: TENANT_REGISTRY_RECORD_TABLES.workspaces,
        table: workspacesTable,
        workspaceOnly: true,
      },
    ],
  });

  return {
    backend: "postgres",

    ...tenantRecordMethods,

    describe() {
      return {
        backend: "postgres",
        membersTable: workspaceMembersTable,
        persistent: true,
        workspacesTable,
      };
    },

    initialize,

    async getWorkspace(workspaceId) {
      await initialize();
      return selectWorkspace(workspaceId);
    },

    async listWorkspaces({ limit, offset, status = null } = {}) {
      await initialize();

      const result = await query(
        `
          SELECT ${WORKSPACE_COLUMNS}
          FROM ${workspacesTable}
          WHERE ($1::text IS NULL OR status = $1::text)
          ORDER BY workspace_id COLLATE "C"
          LIMIT $2 OFFSET $3
        `,
        [status, limit, offset]
      );

      return (result.rows ?? []).map(mapWorkspaceRow);
    },

    async insertWorkspace(record) {
      await initialize();

      const result = await query(
        `
          INSERT INTO ${workspacesTable} (workspace_id, status, plan, region, retention_policy)
          VALUES ($1, $2, $3, $4, $5::jsonb)
          ON CONFLICT (workspace_id) DO NOTHING
          RETURNING ${WORKSPACE_COLUMNS}
        `,
        [
          record.workspaceId,
          record.status,
          record.plan,
          record.region,
          JSON.stringify(record.retentionPolicy ?? {}),
        ]
      );

      return result.rows?.[0] ? mapWorkspaceRow(result.rows[0]) : null;
    },

    async updateWorkspaceStatus({ refuseFrom = [], status, workspaceId }) {
      await initialize();

      const result = await query(
        `
          UPDATE ${workspacesTable}
          SET status = $2, updated_at = NOW()
          WHERE workspace_id = $1 AND NOT (status = ANY($3::text[]))
          RETURNING ${WORKSPACE_COLUMNS}
        `,
        [workspaceId, status, refuseFrom]
      );

      if (result.rows?.[0]) {
        return { outcome: "updated", workspace: mapWorkspaceRow(result.rows[0]) };
      }

      // Nothing updated: either no such workspace or a status the change may
      // not leave. The second read reports which, as it is now.
      const current = await selectWorkspace(workspaceId);

      return current
        ? { outcome: "refused", workspace: current }
        : { outcome: "missing", workspace: null };
    },

    // Replaces the whole policy, like updateWorkspaceStatus refusing the
    // statuses in `refuseFrom`. The system role's UPDATE grant on the table
    // (migration 036) covers the column.
    async updateWorkspaceRetentionPolicy({ refuseFrom = [], retentionPolicy, workspaceId }) {
      await initialize();

      const result = await query(
        `
          UPDATE ${workspacesTable}
          SET retention_policy = $2::jsonb, updated_at = NOW()
          WHERE workspace_id = $1 AND NOT (status = ANY($3::text[]))
          RETURNING ${WORKSPACE_COLUMNS}
        `,
        [workspaceId, JSON.stringify(retentionPolicy ?? {}), refuseFrom]
      );

      if (result.rows?.[0]) {
        return { outcome: "updated", workspace: mapWorkspaceRow(result.rows[0]) };
      }

      const current = await selectWorkspace(workspaceId);

      return current
        ? { outcome: "refused", workspace: current }
        : { outcome: "missing", workspace: null };
    },

    async getMember(workspaceId, userId) {
      await initialize();

      const result = await query(
        `SELECT ${MEMBER_COLUMNS} FROM ${workspaceMembersTable} WHERE workspace_id = $1 AND user_id = $2`,
        [workspaceId, userId]
      );

      return result.rows?.[0] ? mapMemberRow(result.rows[0]) : null;
    },

    async listMembers({ limit, offset, workspaceId }) {
      await initialize();

      const result = await query(
        `
          SELECT ${MEMBER_COLUMNS}
          FROM ${workspaceMembersTable}
          WHERE workspace_id = $1
          ORDER BY user_id COLLATE "C"
          LIMIT $2 OFFSET $3
        `,
        [workspaceId, limit, offset]
      );

      return (result.rows ?? []).map(mapMemberRow);
    },

    // One user's memberships in every workspace. The registry service reads
    // it bound to that user without a workspace, which migration 036's
    // membership policy admits for exactly that user's rows (and its
    // (user_id, workspace_id) index serves).
    async listUserMemberships({ limit, userId }) {
      await initialize();

      const result = await query(
        `
          SELECT ${MEMBER_COLUMNS}
          FROM ${workspaceMembersTable}
          WHERE user_id = $1
          ORDER BY workspace_id COLLATE "C"
          LIMIT $2
        `,
        [userId, limit]
      );

      return (result.rows ?? []).map(mapMemberRow);
    },

    async upsertMember({ roles, userId, workspaceId }) {
      await initialize();

      try {
        const result = await query(
          `
            INSERT INTO ${workspaceMembersTable} (workspace_id, user_id, roles)
            VALUES ($1, $2, $3::text[])
            ON CONFLICT (workspace_id, user_id) DO UPDATE SET roles = EXCLUDED.roles
            RETURNING ${MEMBER_COLUMNS}, (xmax = 0) AS inserted
          `,
          [workspaceId, userId, roles]
        );
        const row = result.rows?.[0];

        return row ? { created: row.inserted === true, member: mapMemberRow(row) } : null;
      } catch (error) {
        // The workspace row does not exist (or went away meanwhile).
        if (error?.code === FOREIGN_KEY_VIOLATION) {
          return null;
        }

        throw error;
      }
    },

    async deleteMember({ userId, workspaceId }) {
      await initialize();

      const result = await query(
        `DELETE FROM ${workspaceMembersTable} WHERE workspace_id = $1 AND user_id = $2`,
        [workspaceId, userId]
      );

      return Number(result.rowCount ?? 0) > 0;
    },
  };
};

export const createDefaultTenantRegistryStore = ({ memory = {}, postgres = {} } = {}) =>
  getTenantRegistryStoreConfigStatus().backend === "postgres"
    ? createPostgresTenantRegistryStore(postgres)
    : createInMemoryTenantRegistryStore(memory);

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

// Under TENANT_REGISTRY_CACHE_SCOPE=tenant a workspace lookup is cached per
// requesting user (`partition`); the bare key is the `shared` scope's.
const workspaceCacheKey = (workspaceId, partition = null) =>
  partition === null ? `w\u0000${workspaceId}` : `w\u0000${workspaceId}\u0000${partition}`;
const memberCacheKey = (workspaceId, userId) => `m\u0000${workspaceId}\u0000${userId}`;
const memberCachePrefix = (workspaceId) => `m\u0000${workspaceId}\u0000`;

/**
 * Validation, the lookup cache and its invalidation over one store.
 *
 * Lookups (lookupWorkspace, lookupMembership) are what enforcement reads:
 * cached for `cacheTtlMs` (found or not; 0 disables the cache), shared while
 * in flight, each bound to the tenant it checks. Everything else reads and
 * writes the store directly in the caller's context and drops the cache
 * entries it may have made stale; a lookup that was in flight across a write
 * is not cached.
 */
export const createTenantRegistryService = ({
  cacheTtlMs = getTenantRegistryCacheTtlMs,
  maxCacheEntries = MAX_CACHE_ENTRIES,
  now = () => Date.now(),
  store = createDefaultTenantRegistryStore(),
} = {}) => {
  const cache = new Map();
  const inFlight = new Map();
  let generation = 0;
  const readTtl = () => Math.max(0, Number(typeof cacheTtlMs === "function" ? cacheTtlMs() : cacheTtlMs) || 0);

  const invalidate = (predicate) => {
    generation += 1;

    for (const key of [...cache.keys()]) {
      if (predicate(key)) {
        cache.delete(key);
      }
    }

    for (const key of [...inFlight.keys()]) {
      if (predicate(key)) {
        inFlight.delete(key);
      }
    }
  };

  const invalidateWorkspace = (workspaceId) => {
    const prefix = memberCachePrefix(workspaceId);
    const workspaceKey = workspaceCacheKey(workspaceId);

    invalidate(
      (key) => key === workspaceKey || key.startsWith(`${workspaceKey}\u0000`) || key.startsWith(prefix)
    );
  };

  const invalidateMember = (workspaceId, userId) => {
    const key = memberCacheKey(workspaceId, userId);

    invalidate((candidate) => candidate === key);
  };

  const remember = (key, value) => {
    const ttl = readTtl();

    if (ttl <= 0) {
      return;
    }

    cache.delete(key);
    cache.set(key, { expiresAt: now() + ttl, value });

    while (cache.size > maxCacheEntries) {
      cache.delete(cache.keys().next().value);
    }
  };

  const cachedLookup = (key, load) => {
    const entry = cache.get(key);

    if (entry && entry.expiresAt > now()) {
      return Promise.resolve(copy(entry.value));
    }

    if (entry) {
      cache.delete(key);
    }

    const pending = inFlight.get(key);

    if (pending) {
      return pending.then(copy);
    }

    const startedAt = generation;
    const promise = Promise.resolve()
      .then(load)
      .then(
        (value) => {
          if (inFlight.get(key) === promise) {
            inFlight.delete(key);
          }

          if (generation === startedAt) {
            remember(key, value);
          }

          return value;
        },
        (error) => {
          if (inFlight.get(key) === promise) {
            inFlight.delete(key);
          }

          throw error;
        }
      );

    inFlight.set(key, promise);
    return promise.then(copy);
  };

  const requireWorkspace = async (workspaceId) => {
    const workspace = await store.getWorkspace(workspaceId);

    if (!workspace) {
      throw new TenantRegistryError("Workspace not found.", {
        code: TENANT_REGISTRY_ERROR_CODES.workspaceNotFound,
        status: 404,
      });
    }

    return workspace;
  };

  const setStatus = async (rawWorkspaceId, rawStatus) => {
    const workspaceId = normalizeWorkspaceIdInput(rawWorkspaceId);
    const status = normalizeStatusInput(rawStatus);
    // Offboarding is one way: once deleting, a workspace is never suspended
    // or re-activated (only the deleting state may be written again).
    const refuseFrom = status === WORKSPACE_STATUSES.deleting ? [] : [WORKSPACE_STATUSES.deleting];
    const result = await store.updateWorkspaceStatus({ refuseFrom, status, workspaceId });

    invalidateWorkspace(workspaceId);

    if (result.outcome === "missing") {
      throw new TenantRegistryError("Workspace not found.", {
        code: TENANT_REGISTRY_ERROR_CODES.workspaceNotFound,
        status: 404,
      });
    }

    if (result.outcome === "refused") {
      throw new TenantRegistryError("This workspace is being deleted; its status cannot change.", {
        code: TENANT_REGISTRY_ERROR_CODES.workspaceDeleting,
        status: 409,
      });
    }

    return result.workspace;
  };

  return {
    store,

    describe() {
      return { ...(store.describe?.() ?? { backend: store.backend ?? "custom" }), cacheTtlMs: readTtl() };
    },

    initialize: () => store.initialize?.() ?? true,

    clearCache() {
      invalidate(() => true);
    },

    /**
     * Enforcement's workspace read: { workspaceId, status } or null, cached.
     * Bound as the workspace itself (no user), which is what migration 036's
     * workspace policy lets read its row. `forUserId` is the requesting user
     * ('' for a credential bound to the workspace): under
     * TENANT_REGISTRY_CACHE_SCOPE=tenant the entry and the in-flight read are
     * that user's alone.
     */
    lookupWorkspace(workspaceId, { forUserId = "" } = {}) {
      const partition =
        getTenantRegistryCacheScope() === "tenant" ? String(forUserId ?? "") : null;

      return cachedLookup(workspaceCacheKey(workspaceId, partition), () =>
        runWithDatabaseTenant({ userId: "", workspaceId }, async () => {
          const workspace = await store.getWorkspace(workspaceId);

          return workspace ? { status: workspace.status, workspaceId: workspace.workspaceId } : null;
        })
      );
    },

    /**
     * Enforcement's membership read: { roles } or null, cached. Bound as that
     * user in that workspace, which is what migration 036's membership policy
     * lets read its row.
     */
    lookupMembership(workspaceId, userId) {
      return cachedLookup(memberCacheKey(workspaceId, userId), () =>
        runWithDatabaseTenant({ userId, workspaceId }, async () => {
          const member = await store.getMember(workspaceId, userId);

          return member ? { roles: [...member.roles] } : null;
        })
      );
    },

    /**
     * The workspaces `userId` may act in under TENANT_MEMBERSHIP=enforce:
     * its memberships (at most MAX_MEMBER_WORKSPACES, in id order) of
     * workspaces that are active, for GET /auth/me (routes/auth-me.js). The
     * memberships are read bound to that user without a workspace (migration
     * 036's membership policy shows exactly that user's rows), each status
     * through lookupWorkspace (cached, bound to the workspace), so nothing is
     * read as the system. A store without the call lists nothing. A fault
     * rejects with TENANT_REGISTRY_UNAVAILABLE (503).
     */
    async listMemberWorkspaces(rawUserId) {
      const userId = normalizeUserIdInput(rawUserId);

      if (typeof store.listUserMemberships !== "function") {
        return [];
      }

      try {
        const memberships = await runWithDatabaseTenant({ userId, workspaceId: "" }, () =>
          store.listUserMemberships({ limit: MAX_MEMBER_WORKSPACES, userId })
        );
        const workspaceIds = [];

        for (let index = 0; index < memberships.length; index += MEMBER_WORKSPACE_LOOKUP_BATCH) {
          const batch = memberships.slice(index, index + MEMBER_WORKSPACE_LOOKUP_BATCH);
          const workspaces = await Promise.all(
            batch.map((member) => this.lookupWorkspace(member.workspaceId, { forUserId: userId }))
          );

          batch.forEach((member, position) => {
            if (workspaces[position]?.status === WORKSPACE_STATUSES.active) {
              workspaceIds.push(member.workspaceId);
            }
          });
        }

        return workspaceIds;
      } catch (error) {
        console.error("Tenant registry lookup failed; listing no memberships.", error);
        throw new TenantRegistryError(MEMBERSHIP_MESSAGES[TENANT_MEMBERSHIP_CODES.registryUnavailable], {
          code: TENANT_REGISTRY_ERROR_CODES.unavailable,
          status: 503,
        });
      }
    },

    async getWorkspace(rawWorkspaceId) {
      return store.getWorkspace(normalizeWorkspaceIdInput(rawWorkspaceId));
    },

    async listWorkspaces({ limit, offset, status } = {}) {
      const options = normalizeListOptions({ limit, offset });
      const statusFilter =
        status === undefined || status === null || status === ""
          ? null
          : normalizeStatusInput(status);

      return store.listWorkspaces({ ...options, status: statusFilter });
    },

    async createWorkspace(input = {}) {
      const record = normalizeWorkspaceInput(input);
      const workspace = await store.insertWorkspace(record);

      invalidateWorkspace(record.workspaceId);

      if (!workspace) {
        throw new TenantRegistryError("A workspace with this id is already registered.", {
          code: TENANT_REGISTRY_ERROR_CODES.workspaceExists,
          status: 409,
        });
      }

      return workspace;
    },

    setWorkspaceStatus: setStatus,

    suspendWorkspace: (workspaceId) => setStatus(workspaceId, WORKSPACE_STATUSES.suspended),

    activateWorkspace: (workspaceId) => setStatus(workspaceId, WORKSPACE_STATUSES.active),

    /**
     * Replaces a workspace's retention_policy with `retentionPolicy` (the
     * create path's validation: rag/workspace-retention-policy.js keys and
     * day counts, anything else refused; null or {} clears every override).
     * Refused for a workspace that is being deleted. The retention sweep
     * reads the policies from the store at the start of each pass
     * (rag/retention.js), never through the lookup cache, which holds only
     * status and memberships; so every instance applies the change from its
     * next pass, at most RETENTION_SWEEP_INTERVAL_MS later.
     * TENANT_REGISTRY_CACHE_TTL_MS does not delay it.
     */
    async setWorkspaceRetentionPolicy(rawWorkspaceId, retentionPolicy) {
      const workspaceId = normalizeWorkspaceIdInput(rawWorkspaceId);
      const policy = normalizeRetentionPolicy(retentionPolicy);

      if (typeof store.updateWorkspaceRetentionPolicy !== "function") {
        throw new TenantRegistryError("This tenant registry store cannot change retention policies.", {
          code: TENANT_REGISTRY_ERROR_CODES.invalidInput,
          status: 501,
        });
      }

      const result = await store.updateWorkspaceRetentionPolicy({
        refuseFrom: [WORKSPACE_STATUSES.deleting],
        retentionPolicy: policy,
        workspaceId,
      });

      invalidateWorkspace(workspaceId);

      if (result.outcome === "missing") {
        throw new TenantRegistryError("Workspace not found.", {
          code: TENANT_REGISTRY_ERROR_CODES.workspaceNotFound,
          status: 404,
        });
      }

      if (result.outcome === "refused") {
        throw new TenantRegistryError("This workspace is being deleted; its retention policy cannot change.", {
          code: TENANT_REGISTRY_ERROR_CODES.workspaceDeleting,
          status: 409,
        });
      }

      return result.workspace;
    },

    async getMember(rawWorkspaceId, rawUserId) {
      return store.getMember(normalizeWorkspaceIdInput(rawWorkspaceId), normalizeUserIdInput(rawUserId));
    },

    async listMembers(rawWorkspaceId, { limit, offset } = {}) {
      const workspaceId = normalizeWorkspaceIdInput(rawWorkspaceId);
      const options = normalizeListOptions({ limit, offset });

      await requireWorkspace(workspaceId);
      return store.listMembers({ ...options, workspaceId });
    },

    /** Adds the member, or replaces its roles. Resolves to { created, member }. */
    async putMember({ roles, userId: rawUserId, workspaceId: rawWorkspaceId } = {}) {
      const workspaceId = normalizeWorkspaceIdInput(rawWorkspaceId);
      const userId = normalizeUserIdInput(rawUserId);
      const memberRoles = normalizeMemberRolesInput(roles);
      const workspace = await requireWorkspace(workspaceId);

      if (workspace.status === WORKSPACE_STATUSES.deleting) {
        throw new TenantRegistryError("This workspace is being deleted; it takes no new members.", {
          code: TENANT_REGISTRY_ERROR_CODES.workspaceDeleting,
          status: 409,
        });
      }

      const result = await store.upsertMember({ roles: memberRoles, userId, workspaceId });

      invalidateMember(workspaceId, userId);

      if (!result) {
        throw new TenantRegistryError("Workspace not found.", {
          code: TENANT_REGISTRY_ERROR_CODES.workspaceNotFound,
          status: 404,
        });
      }

      return result;
    },

    async removeMember(rawWorkspaceId, rawUserId) {
      const workspaceId = normalizeWorkspaceIdInput(rawWorkspaceId);
      const userId = normalizeUserIdInput(rawUserId);
      const removed = await store.deleteMember({ userId, workspaceId });

      invalidateMember(workspaceId, userId);

      if (!removed) {
        throw new TenantRegistryError("Workspace member not found.", {
          code: TENANT_REGISTRY_ERROR_CODES.memberNotFound,
          status: 404,
        });
      }

      return true;
    },

    // The tenant erase and export (rag/tenant-lifecycle.js), when the store
    // keeps the tenant record calls: counted, listed and deleted with the
    // selector rules of TENANT_REGISTRY_RECORD_TABLES, in the caller's
    // database context (the erase binds the system). A delete drops the
    // lookup cache entries it touched.
    ...(typeof store.countTenantRecords === "function" &&
    typeof store.deleteTenantRecords === "function"
      ? {
          countTenantRecords: (selector) => store.countTenantRecords(selector),
          ...(typeof store.iterateTenantRecords === "function"
            ? { iterateTenantRecords: (selector) => store.iterateTenantRecords(selector) }
            : { listTenantRecords: (selector) => store.listTenantRecords(selector) }),

          async deleteTenantRecords(selector) {
            try {
              return await store.deleteTenantRecords(selector);
            } finally {
              if (selector.userId === null) {
                invalidateWorkspace(selector.workspaceId);
              } else {
                invalidateMember(selector.workspaceId, selector.userId);
              }
            }
          },

          /**
           * A workspace erase's first step: sets the workspace `deleting`
           * (from any status), so TENANT_MEMBERSHIP=enforce refuses its
           * requests while its data is erased; this process at once, others
           * once their lookup cache expires (TENANT_REGISTRY_CACHE_TTL_MS).
           * Resolves true when a registered workspace was marked, false when
           * the registry holds no such workspace (an id that is not
           * canonical cannot be registered, so it is not either).
           */
          async markWorkspaceDeleting(rawWorkspaceId) {
            let workspaceId;

            try {
              workspaceId = normalizeWorkspaceIdInput(rawWorkspaceId);
            } catch (error) {
              if (error instanceof TenantRegistryError) {
                return false;
              }

              throw error;
            }

            const result = await store.updateWorkspaceStatus({
              refuseFrom: [],
              status: WORKSPACE_STATUSES.deleting,
              workspaceId,
            });

            invalidateWorkspace(workspaceId);
            return result.outcome === "updated";
          },
        }
      : {}),
  };
};

export const createDefaultTenantRegistryService = (options = {}) =>
  createTenantRegistryService({ store: createDefaultTenantRegistryStore(), ...options });

let defaultRegistry = null;

/**
 * The registry requireApiAuth uses when the app did not put one on
 * app.locals.tenantRegistry (createApp always does): created on first use.
 */
export const getDefaultTenantRegistry = () => {
  defaultRegistry ??= createDefaultTenantRegistryService();
  return defaultRegistry;
};

export const configureDefaultTenantRegistry = (registry) => {
  defaultRegistry = registry ?? null;
};

export const resetDefaultTenantRegistry = () => {
  defaultRegistry = null;
};

// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------

const refuse = (code, status = 403) => ({
  allowed: false,
  code,
  message: MEMBERSHIP_MESSAGES[code],
  status,
});

const statusRefusal = (status) =>
  status === WORKSPACE_STATUSES.active
    ? null
    : status === WORKSPACE_STATUSES.suspended
      ? refuse(TENANT_MEMBERSHIP_CODES.workspaceSuspended)
      : refuse(TENANT_MEMBERSHIP_CODES.workspaceDeleting);

/**
 * TENANT_MEMBERSHIP=enforce's decision for one resolved scope (auth.js calls
 * it only with API auth on, a workspace in the scope and a credential other
 * than the single shared API_AUTH_TOKEN).
 *
 * - With a user: the user must be a member of the workspace and the
 *   workspace active. A non-member learns nothing about the workspace (the
 *   same answer whether it exists, is suspended or not), so membership is
 *   decided first.
 * - Without a user, a workspace the principal is bound to (its fixed
 *   workspace or its workspace list) must be registered and active.
 * - Without a user, a workspace the client chose (x-workspace-id from a
 *   principal with neither) is refused: nothing ties the credential to it.
 *
 * Allowed answers carry the membership's roles (empty without a user). A
 * registry that cannot answer refuses with 503, never allows.
 */
export const decideTenantMembership = async ({
  registry,
  userId = "",
  workspaceBoundByPrincipal = false,
  workspaceId,
} = {}) => {
  try {
    if (userId) {
      const [membership, workspace] = await Promise.all([
        registry.lookupMembership(workspaceId, userId),
        registry.lookupWorkspace(workspaceId, { forUserId: userId }),
      ]);

      if (!membership) {
        return refuse(TENANT_MEMBERSHIP_CODES.membershipRequired);
      }

      if (!workspace) {
        return refuse(TENANT_MEMBERSHIP_CODES.notRegistered);
      }

      return statusRefusal(workspace.status) ?? { allowed: true, roles: [...membership.roles] };
    }

    if (!workspaceBoundByPrincipal) {
      return refuse(TENANT_MEMBERSHIP_CODES.membershipRequired);
    }

    const workspace = await registry.lookupWorkspace(workspaceId);

    if (!workspace) {
      return refuse(TENANT_MEMBERSHIP_CODES.notRegistered);
    }

    return statusRefusal(workspace.status) ?? { allowed: true, roles: [] };
  } catch (error) {
    console.error("Tenant registry lookup failed; refusing the request.", error);
    return refuse(TENANT_MEMBERSHIP_CODES.registryUnavailable, 503);
  }
};

// The refusals decideTenantMembership (and resolveMembershipScope) make only
// once the requester is shown to belong to the registered workspace it named:
// a user's membership row was found first (suspended; the roles bound, which
// only a membership's roles can exceed), or, without a user, the workspace is
// the credential's own and registered (suspended). WORKSPACE_DELETING is
// decided the same way but is left out: the tenant erase clears the ledger
// before the registry, so a row under the workspace would bring its id back
// into the ledger the erase had just cleared. Every other refusal
// (WORKSPACE_MEMBERSHIP_REQUIRED, WORKSPACE_NOT_REGISTERED,
// TENANT_REGISTRY_UNAVAILABLE) is decided before or without that, for a
// workspace id the client may have chosen.
const REFUSALS_CHARGED_TO_THE_WORKSPACE = new Set([
  TENANT_MEMBERSHIP_CODES.rolesLimitExceeded,
  TENANT_MEMBERSHIP_CODES.workspaceSuspended,
]);

/**
 * The tenant a membership refusal is charged to in the usage ledger
 * (requireApiAuth's resolveRefusalLedgerScope, which also checks the registry
 * still holds the workspace), or null when it goes to the metric only.
 *
 * - A requester shown to belong to the workspace (above): the scope's own
 *   (user, workspace) pair, so the workspace's operator sees its members
 *   knocking on a suspended workspace.
 * - Anyone else may name a workspace id the client chose. Charging it to
 *   that pair let one credential create a permanent ledger row per probed id
 *   (x-workspace-id: probe-<n>), and put a non-member's user id into the
 *   named workspace's usage view and export (and into its erase), registered
 *   or not. Such a refusal is charged to the requester's own user-level
 *   tenant (userId, ''), one row per code and hour however many ids it
 *   tries, and, without a user, to nothing (the metric still counts it).
 */
export const resolveMembershipRefusalTenant = (accessScope = {}, decision = {}) => {
  const userId = String(accessScope?.userId ?? "").trim();
  const workspaceId = String(accessScope?.workspaceId ?? "").trim();

  if (REFUSALS_CHARGED_TO_THE_WORKSPACE.has(decision?.code) && workspaceId) {
    return { userId, workspaceId };
  }

  return userId ? { userId, workspaceId: "" } : null;
};

/**
 * The scope with the membership's roles added to its workspaceRoles for the
 * active workspace (keys are canonical ids, as normalizeWorkspaceRoles writes
 * them). Built through a Map, so a workspace named like an Object.prototype
 * member stays plain data. Without roles the scope is returned as it was.
 */
export const mergeMembershipRoles = (accessScope = {}, workspaceId, roles = []) => {
  if (!roles.length) {
    return accessScope;
  }

  const existing =
    accessScope.workspaceRoles && typeof accessScope.workspaceRoles === "object"
      ? Object.entries(accessScope.workspaceRoles)
      : [];
  const merged = new Map(existing);
  const key = normalizeScopeId(workspaceId);

  merged.set(key, [...new Set([...(merged.get(key) ?? []), ...roles])]);

  return { ...accessScope, workspaceRoles: Object.fromEntries(merged) };
};

// The distinct role ids a scope carries for `workspaceId`, collected the way
// rag/rbac.js and the service token collect them (every grant key that
// matches the workspace, ids lower-cased).
const countActiveWorkspaceRoles = (accessScope = {}, workspaceId) => {
  const grants = accessScope.workspaceRoles;
  const key = normalizeScopeId(workspaceId);

  if (!key || !grants || typeof grants !== "object" || Array.isArray(grants)) {
    return 0;
  }

  const roles = new Set();

  for (const [grantKey, value] of Object.entries(grants)) {
    if (normalizeScopeId(grantKey) === key) {
      for (const role of normalizeScopeIds(value)) {
        roles.add(role);
      }
    }
  }

  return roles.size;
};

/**
 * A decision of decideTenantMembership turned into the one requireApiAuth
 * applies: a refusal as it was; an allowance with the scope to use
 * (mergeMembershipRoles). When the merge leaves more than
 * MAX_SCOPE_WORKSPACE_ROLES distinct roles for the workspace (a member with
 * up to 32 roles whose credential carries others there too), the request is
 * refused with 403 WORKSPACE_ROLES_LIMIT_EXCEEDED in every topology, rather
 * than answered by the monolith and failed at the split edge, which cannot
 * sign such a scope, and rather than dropping roles in silence.
 */
export const resolveMembershipScope = (accessScope = {}, workspaceId, decision = {}) => {
  if (!decision.allowed) {
    return decision;
  }

  const roles = decision.roles ?? [];
  const merged = mergeMembershipRoles(accessScope, workspaceId, roles);

  if (roles.length > 0 && countActiveWorkspaceRoles(merged, workspaceId) > MAX_SCOPE_WORKSPACE_ROLES) {
    return refuse(TENANT_MEMBERSHIP_CODES.rolesLimitExceeded);
  }

  return { ...decision, accessScope: merged };
};
