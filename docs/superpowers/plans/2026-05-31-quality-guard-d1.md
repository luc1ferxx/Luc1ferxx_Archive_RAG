# Quality Guard D1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a D1 quality guard that reads and runs synthetic RAG evaluations, summarizes quality metrics, highlights failures, and suggests tuning actions.

**Architecture:** Keep evaluation execution on the backend and expose compact quality endpoints. A pure quality-report helper reads `evaluation/results/latest.json` and derives status, metrics, failures, and recommendations. The React sidebar gets a manual Quality Guard panel so evaluation runs only when the user asks.

**Tech Stack:** Node ESM, Express, child_process, existing synthetic eval runner, React 18, Ant Design, node:test.

---

### Task 1: Quality API Tests

**Files:**
- Modify: `server/test/app.test.mjs`

- [x] Add a test for `GET /quality/latest` returning quality status, metrics, failures, and recommendations.
- [x] Add a test for `POST /quality/synthetic` invoking an injected runner and returning its report.

### Task 2: Quality Report Helper

**Files:**
- Create: `server/evaluation/quality-report.js`

- [x] Implement `buildQualityReportFromResultPayload(payload)` for deterministic status and recommendations.
- [x] Implement `readLatestQualityReport()`.
- [x] Implement `runSyntheticQualityEvaluation({ corpusPath })` using the existing Node eval script.

### Task 3: Express Quality Routes

**Files:**
- Modify: `server/app.js`

- [x] Inject a default `qualityService`.
- [x] Add authenticated `GET /quality/latest` and `POST /quality/synthetic`.
- [x] Return useful 404/500 errors without leaking raw stack traces.

### Task 4: Frontend Quality Guard Panel

**Files:**
- Modify: `src/App.js`
- Modify: `src/App.css`

- [x] Add a sidebar panel with Load latest and Run eval buttons.
- [x] Display pass rate, citation average, failed cases, and recommendations.
- [x] Keep the panel compact and manually triggered.

### Task 5: Verification

**Commands:**
- `cd server && npm test`
- `CI=true npm test -- --watchAll=false`
- `npm run build`

- [x] Run backend tests.
- [x] Run frontend tests in non-watch mode.
- [x] Run production build.
