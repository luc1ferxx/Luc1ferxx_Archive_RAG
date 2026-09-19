-- Persistent chunk store for the pgvector retrieval provider.
--
-- One row per chunk, owned by its document through a cascading foreign key so
-- deleting a document (or clearing the registry) removes its vectors in the
-- same transaction. The embedding column is fixed-width: pgvector can only
-- index a typed column, so the width is rendered from the configured embedding
-- dimensions at migration time and re-validated by the provider on startup.
-- `search_text` is the app-side tokenization of the chunk (the same tokenizer
-- the local sparse index uses) and feeds the generated tsvector that backs the
-- lexical route. The lexical route ranks with ts_rank_cd; it is not BM25.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS __DOCUMENT_CHUNKS_TABLE__ (
  chunk_id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES __DOCUMENTS_TABLE__ (doc_id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  page_number INTEGER,
  section_heading TEXT,
  content TEXT NOT NULL,
  search_text TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  owner_user_id TEXT NOT NULL DEFAULT '',
  workspace_id TEXT NOT NULL DEFAULT '',
  embedding_model TEXT NOT NULL,
  embedding_dimensions INTEGER NOT NULL,
  embedding vector(__EMBEDDING_DIMENSIONS__) NOT NULL,
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('__TEXT_SEARCH_CONFIG__'::regconfig, search_text)
  ) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT __DOCUMENT_CHUNKS_TABLE___doc_chunk_unique UNIQUE (doc_id, chunk_index),
  CONSTRAINT __DOCUMENT_CHUNKS_TABLE___dimensions_positive CHECK (embedding_dimensions > 0)
);

CREATE INDEX IF NOT EXISTS __DOCUMENT_CHUNKS_TABLE___doc_id_idx
  ON __DOCUMENT_CHUNKS_TABLE__ (doc_id);

CREATE INDEX IF NOT EXISTS __DOCUMENT_CHUNKS_TABLE___scope_idx
  ON __DOCUMENT_CHUNKS_TABLE__ (owner_user_id, workspace_id);

CREATE INDEX IF NOT EXISTS __DOCUMENT_CHUNKS_TABLE___embedding_model_idx
  ON __DOCUMENT_CHUNKS_TABLE__ (embedding_model, embedding_dimensions);

CREATE INDEX IF NOT EXISTS __DOCUMENT_CHUNKS_TABLE___search_vector_idx
  ON __DOCUMENT_CHUNKS_TABLE__ USING gin (search_vector);

__VECTOR_INDEX_STATEMENT__
