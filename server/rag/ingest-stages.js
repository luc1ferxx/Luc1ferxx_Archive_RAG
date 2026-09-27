import { RAG_INGEST_STAGES } from "./config.js";

// Names shared by the staged ingestion modules without importing each other:
// rag/index.js (which implements every stage), rag/ingest-pipeline.js (which
// runs them for a job), rag/ingest-job-store.js and rag/ingest-worker.js.

export const INGEST_STAGES = RAG_INGEST_STAGES;

export const INGEST_JOB_KINDS = Object.freeze({
  create: "create",
  replace: "replace",
});

// What each stage leaves behind for the next one (migration 017's outputs).
export const INGEST_STAGE_OUTPUTS = Object.freeze({
  chunks: "chunks",
  documentFile: "document_file",
  embeddings: "embeddings",
  pages: "pages",
});

export const isIngestStage = (value) => INGEST_STAGES.includes(value);

export const getNextIngestStage = (stage) => {
  const index = INGEST_STAGES.indexOf(stage);

  return index >= 0 && index < INGEST_STAGES.length - 1 ? INGEST_STAGES[index + 1] : null;
};

/**
 * Marks an ingestDocument function that can also run as the staged pipeline
 * (rag/ingest-pipeline.js). rag/index.js sets it on its own ingestDocument; a
 * ragService whose ingestDocument lacks it (a test stub, a custom service) is
 * run by the worker as one step, as before the pipeline existed. A registered
 * symbol, so no module has to import rag/index.js to test for it.
 */
export const STAGED_INGEST = Symbol.for("archive-rag.ingest.staged-pipeline");

export const supportsStagedIngest = (ingestDocument) =>
  typeof ingestDocument === "function" && ingestDocument[STAGED_INGEST] === true;
