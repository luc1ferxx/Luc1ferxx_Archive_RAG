import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  getDocumentStorageTotalsFunctionName,
  getTenantUsageTableName,
  renderMigrationSql,
} from "../rag/db-migrations.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const tableNames = (overrides = {}) => ({
  adminAuditEventsTable: "rag_admin_audit_events",
  agentRunEventsTable: "rag_agent_run_events",
  agentRunsTable: "rag_agent_runs",
  documentsTable: "rag_documents",
  longMemoryTable: "long_memory_items",
  sessionMemoryTable: "rag_session_memory",
  taskEventsTable: "rag_task_events",
  tasksTable: "rag_tasks",
  workspaceArtifactsTable: "rag_workspace_artifacts",
  ...overrides,
});

const readMigration = () =>
  readFile(path.join(__dirname, "..", "db", "migrations", "037_create_tenant_usage.sql"), "utf8");

const render = (sql, names = tableNames()) =>
  renderMigrationSql(sql, names, {
    embeddingDimensions: 8,
    systemRole: "archive_system",
    tenantRole: "archive_tenant",
    vectorIndexStatement: "",
  });

test("migration 037 renders the usage table: tenant SELECT on its exact pair, system writes, whole UTC hours", async () => {
  const rendered = render(await readMigration());

  assert.doesNotMatch(rendered, /__[A-Z_]+__/, "every placeholder is rendered");
  assert.match(rendered, /CREATE TABLE IF NOT EXISTS tenant_usage \(/);
  assert.match(rendered, /PRIMARY KEY \(workspace_id, owner_user_id, metric, period_start\)/);
  assert.match(rendered, /value BIGINT NOT NULL DEFAULT 0/);
  assert.match(rendered, /CONSTRAINT tenant_usage_period_check\s+CHECK \(MOD\(EXTRACT\(EPOCH FROM period_start\)::bigint, 3600\) = 0\)/);
  assert.match(rendered, /CREATE INDEX IF NOT EXISTS tenant_usage_metric_period_idx\s+ON tenant_usage \(metric, period_start\)/);

  // The tenant role reads, never writes.
  assert.match(rendered, /GRANT SELECT ON tenant_usage TO archive_tenant;/);
  assert.doesNotMatch(rendered, /GRANT[^;]*(INSERT|UPDATE|DELETE)[^;]*ON tenant_usage TO archive_tenant/);
  assert.match(rendered, /GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_usage TO archive_system;/);
  assert.match(rendered, /ALTER TABLE tenant_usage ENABLE ROW LEVEL SECURITY;/);
  assert.match(
    rendered,
    /CREATE POLICY tenant_isolation ON tenant_usage\s+TO archive_tenant\s+USING \(\s+owner_user_id = current_setting\('archive_rag\.user_id', true\)\s+AND workspace_id = current_setting\('archive_rag\.workspace_id', true\)\s+\)\s+WITH CHECK \(/
  );
  assert.match(
    rendered,
    /CREATE POLICY system_access ON tenant_usage\s+TO archive_system\s+USING \(true\)\s+WITH CHECK \(true\);/
  );
});

test("migration 037's storage-totals function is owner-run, pinned, schema-qualified and executable by the tenant and system roles only", async () => {
  const rendered = render(await readMigration());

  assert.match(rendered, /CREATE INDEX IF NOT EXISTS rag_documents_workspace_id_idx\s+ON rag_documents \(workspace_id\)/);
  assert.match(rendered, /totals_function CONSTANT text := lower\('rag_documents'\) \|\| '_storage_totals'/);
  assert.match(rendered, /SECURITY DEFINER\s+SET search_path = pg_catalog, pg_temp/);
  assert.match(rendered, /FROM %2\$I\.%3\$I AS d/, "the body names the documents table with its schema");
  assert.match(rendered, /tenant_scoped CONSTANT boolean := current_setting\('role'\) = %1\$L/);
  assert.match(rendered, /USING ERRCODE = '42501'/);
  assert.match(rendered, /REVOKE ALL ON FUNCTION %I\.%I\(text, text\) FROM PUBLIC/);
  assert.match(rendered, /tenant_role CONSTANT text := 'archive_tenant'/);
  assert.match(rendered, /system_role CONSTANT text := 'archive_system'/);
  // The function returns two numbers and nothing else.
  assert.match(rendered, /RETURNS TABLE \(document_count bigint, document_bytes bigint\)/);
  assert.doesNotMatch(rendered, /file_bytes/);
});

test("TENANT_USAGE_POSTGRES_TABLE renames the table and everything named after it, within 63 bytes", async () => {
  const sql = await readMigration();
  const renamed = render(sql, tableNames({ tenantUsageTable: "usage_ledger" }));

  assert.match(renamed, /CREATE TABLE IF NOT EXISTS usage_ledger \(/);
  assert.match(renamed, /usage_ledger_metric_period_idx/);
  assert.doesNotMatch(renamed, /tenant_usage/);
  assert.throws(
    () => render(sql, tableNames({ tenantUsageTable: "usage; DROP TABLE x" })),
    /TENANT_USAGE_POSTGRES_TABLE must be a simple PostgreSQL identifier/
  );
  assert.throws(() => getTenantUsageTableName(`u${"x".repeat(45)}`), /at most 63 bytes/);
  assert.doesNotThrow(() => getTenantUsageTableName(`u${"x".repeat(44)}`));
  assert.equal(getDocumentStorageTotalsFunctionName("Rag_Documents"), "rag_documents_storage_totals");
  assert.throws(() => getDocumentStorageTotalsFunctionName("d".repeat(50)), /63 bytes/);
});
