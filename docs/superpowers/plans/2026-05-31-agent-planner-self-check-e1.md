# Agent Planner Self-Check E1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic planner and evidence self-check loop so document answers are verified and retried before final synthesis.

**Architecture:** Keep orchestration in `server/rag/agent.js` and extract evidence checking rules into a small helper module. The agent will run initial document RAG, evaluate whether the answer has enough cited evidence, retry once with a focused evidence prompt when useful, and expose all steps in `agentTrace`.

**Tech Stack:** Node ESM, Express app tests, existing RAG service contract, React trace display already present.

---

### Task 1: Agent Behavior Tests

**Files:**
- Modify: `server/test/app.test.mjs`

- [x] Update existing agent trace expectations to include `self_check` after document RAG.
- [x] Add a test where the first document answer has no citations, the agent retries once, and the final answer uses the cited retry result.
- [x] Assert the retry prompt keeps the original question and asks for cited support.

### Task 2: Self-Check Helper

**Files:**
- Create: `server/rag/agent-self-check.js`

- [x] Implement `evaluateDocumentEvidence({ ragResult, docIds })`.
- [x] Implement citation sufficiency for single-doc and multi-doc questions.
- [x] Implement `buildEvidenceRetryQuestion({ question, check })`.
- [x] Implement `selectBetterRagResult({ primary, retry })`.

### Task 3: Agent Retry Loop

**Files:**
- Modify: `server/rag/agent.js`

- [x] Import helper functions.
- [x] Add a planner action list in the plan trace detail.
- [x] Run self-check after initial document RAG.
- [x] Run one focused document retry only when the check says it is useful.
- [x] Re-check retry output and use it only when it is better.

### Task 4: Verification

**Commands:**
- `cd server && npm test`
- `CI=true npm test -- --watchAll=false`
- `npm run build`
- `cd server && npm run quality:gate`

- [x] Run backend tests.
- [x] Run frontend tests in non-watch mode.
- [x] Run production build.
- [x] Run quality gate.
