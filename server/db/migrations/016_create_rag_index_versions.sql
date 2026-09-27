-- Versioned pgvector indexes (rag/vector-store-pgvector-versions.js).
--
-- Every version of the retrieval index is one physical chunk table with the
-- schema of migration 012 (its own vector(N) column, HNSW/IVFFlat and GIN
-- indexes, row policy, tenant grant and the owner-run sparse-rank function of
-- migration 014). This registry records each version and holds the single
-- pointer to the one API processes search.
--
-- Status: building (a builder is re-embedding every document into it), ready
-- (complete; still receives every write until it is activated, or for the
-- dual-write grace period after it was deactivated), active (the one the
-- pointer names), retired (its table and function are dropped), failed.
--
-- The existing chunk table becomes version 1 here, in place: no row moves.
-- Version 1 follows the configuration (OPENAI_EMBEDDING_MODEL,
-- RAG_EMBEDDING_DIMENSIONS, the task prefixes) exactly as the single table
-- always did, until another version is activated; that activation pins the
-- embedding space version 1 was verified under, so a rollback to it stays
-- correct whatever the configuration says by then.
--
-- The tenant role reads the registry and the pointer (a scoped ingest, delete
-- or clear decides inside its own transaction which version tables it writes)
-- and never writes them; neither table holds tenant data, so no row policy.
-- The build-progress table lists every tenant's document ids and only the
-- owner-run builder touches it, so the tenant role gets no grant on it.

CREATE TABLE IF NOT EXISTS __INDEX_VERSIONS_TABLE__ (
  version_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL,
  chunk_table TEXT NOT NULL,
  sparse_rank_function TEXT NOT NULL,
  embedding_space_source TEXT NOT NULL DEFAULT 'pinned',
  embedding_model TEXT NOT NULL DEFAULT '',
  embedding_identity TEXT NOT NULL DEFAULT '',
  embedding_document_prefix TEXT NOT NULL DEFAULT '',
  embedding_query_prefix TEXT NOT NULL DEFAULT '',
  embedding_dimensions INTEGER NOT NULL,
  index_params JSONB NOT NULL DEFAULT '{}'::jsonb,
  document_count INTEGER,
  chunk_count BIGINT,
  build_documents_total INTEGER,
  build_documents_done INTEGER NOT NULL DEFAULT 0,
  build_documents_failed INTEGER NOT NULL DEFAULT 0,
  builder_id TEXT,
  lease_expires_at TIMESTAMPTZ,
  dual_write_until TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  build_started_at TIMESTAMPTZ,
  build_completed_at TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,
  deactivated_at TIMESTAMPTZ,
  retired_at TIMESTAMPTZ,
  CONSTRAINT __INDEX_VERSIONS_TABLE___id_positive CHECK (version_id > 0),
  CONSTRAINT __INDEX_VERSIONS_TABLE___chunk_table_unique UNIQUE (chunk_table),
  CONSTRAINT __INDEX_VERSIONS_TABLE___status_check
    CHECK (status IN ('building', 'ready', 'active', 'retired', 'failed')),
  CONSTRAINT __INDEX_VERSIONS_TABLE___space_source_check
    CHECK (embedding_space_source IN ('configuration', 'pinned')),
  CONSTRAINT __INDEX_VERSIONS_TABLE___dimensions_positive CHECK (embedding_dimensions > 0)
);

-- At most one active and one building version, whatever the code does.
CREATE UNIQUE INDEX IF NOT EXISTS __INDEX_VERSIONS_TABLE___one_active_idx
  ON __INDEX_VERSIONS_TABLE__ ((TRUE)) WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS __INDEX_VERSIONS_TABLE___one_building_idx
  ON __INDEX_VERSIONS_TABLE__ ((TRUE)) WHERE status = 'building';

-- The single active pointer. `generation` grows with every switch.
CREATE TABLE IF NOT EXISTS __INDEX_VERSIONS_POINTER_TABLE__ (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE,
  active_version_id INTEGER NOT NULL REFERENCES __INDEX_VERSIONS_TABLE__ (version_id),
  previous_version_id INTEGER REFERENCES __INDEX_VERSIONS_TABLE__ (version_id),
  generation BIGINT NOT NULL DEFAULT 1,
  switched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT __INDEX_VERSIONS_POINTER_TABLE___singleton CHECK (singleton)
);

-- One row per document a builder finished, committed in the same transaction
-- as that document's chunks, so a build resumed after a crash skips exactly
-- the documents that are already in the version table.
CREATE TABLE IF NOT EXISTS __INDEX_VERSION_BUILD_PROGRESS_TABLE__ (
  version_id INTEGER NOT NULL REFERENCES __INDEX_VERSIONS_TABLE__ (version_id) ON DELETE CASCADE,
  doc_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  source_uploaded_at TEXT,
  error TEXT,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (version_id, doc_id),
  CONSTRAINT __INDEX_VERSION_BUILD_PROGRESS_TABLE___outcome_check
    CHECK (outcome IN ('indexed', 'skipped_deleted', 'failed'))
);

-- Version 1 is the chunk table migration 012 created, unchanged. The width
-- recorded here is informational while version 1 follows the configuration.
INSERT INTO __INDEX_VERSIONS_TABLE__ (
  version_id,
  status,
  chunk_table,
  sparse_rank_function,
  embedding_space_source,
  embedding_dimensions,
  activated_at
)
SELECT
  1,
  'active',
  lower('__DOCUMENT_CHUNKS_TABLE__'),
  lower('__DOCUMENT_CHUNKS_TABLE___sparse_rank'),
  'configuration',
  __EMBEDDING_DIMENSIONS__,
  NOW()
WHERE NOT EXISTS (SELECT 1 FROM __INDEX_VERSIONS_TABLE__);

INSERT INTO __INDEX_VERSIONS_POINTER_TABLE__ (singleton, active_version_id)
SELECT TRUE, 1
WHERE NOT EXISTS (SELECT 1 FROM __INDEX_VERSIONS_POINTER_TABLE__)
  AND EXISTS (SELECT 1 FROM __INDEX_VERSIONS_TABLE__ WHERE version_id = 1);

GRANT SELECT ON __INDEX_VERSIONS_TABLE__, __INDEX_VERSIONS_POINTER_TABLE__ TO __TENANT_ROLE__;
