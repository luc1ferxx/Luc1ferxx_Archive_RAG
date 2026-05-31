# Archive Curator B1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the recommended B1 archive-curator slice: automatic document summaries, tags, entities, workspace discovery, and frontend metadata display.

**Architecture:** Keep document profiling local and deterministic for B1 so ingestion remains testable without new model calls. Store the profile on the existing document record, expose it through existing document APIs, and let the AgentRAG orchestrator use document profiles for workspace inventory and discovery questions before falling back to document RAG.

**Tech Stack:** Node ESM, PostgreSQL migrations, existing document registry, React 18, Ant Design, node:test.

---

### Task 1: Profile Contract Tests

**Files:**
- Modify: `server/test/rag.test.mjs`
- Modify: `server/test/app.test.mjs`

- [x] Add a RAG ingestion test proving uploaded page text produces `summary`, `tags`, and `entities` on the stored document.
- [x] Add an API test proving `/chat` can answer a no-docId workspace discovery prompt from document metadata.

### Task 2: Deterministic Document Profiler

**Files:**
- Create: `server/rag/document-profiler.js`
- Modify: `server/rag/index.js`

- [x] Implement `buildDocumentProfile({ fileName, pages })` with a bounded summary, keyword tags, and entity extraction.
- [x] Call the profiler during `ingestDocumentPages` and pass `profile` into `registerDocument`.

### Task 3: Registry Persistence

**Files:**
- Create: `server/db/migrations/004_add_document_profile.sql`
- Modify: `server/rag/doc-registry.js`

- [x] Add a JSONB `profile` column with a default empty object.
- [x] Normalize and expose `profile`, `summary`, `tags`, and `entities` in public document objects.
- [x] Preserve legacy/custom test stores that do not provide profile metadata.

### Task 4: Agent Workspace Discovery

**Files:**
- Modify: `server/rag/agent.js`

- [x] Add workspace discovery routing for prompts like “which document covers X” and “哪份文档讲 X”.
- [x] Rank documents by profile text overlap and return document names, tags, and summaries.
- [x] Include a `document_discovery` trace step.

### Task 5: Frontend Metadata Display

**Files:**
- Modify: `src/App.js`
- Modify: `src/App.css`

- [x] Show tags and summaries in workspace and relevant document cards.
- [x] Keep text compact and responsive so long generated tags or summaries do not overflow.

### Task 6: Verification

**Commands:**
- `cd server && npm test`
- `CI=true npm test -- --watchAll=false`
- `npm run build`

- [x] Run backend tests.
- [x] Run frontend tests in non-watch mode.
- [x] Run production build.
