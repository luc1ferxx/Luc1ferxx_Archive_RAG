# Quality History D2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add quality history and regression gate support so AgentRAG changes can be checked against previous synthetic evaluation runs.

**Architecture:** Extend the existing `server/evaluation/quality-report.js` helper to read timestamped JSON results, build compact run summaries, and compare the latest run against the previous run. Expose the result through an authenticated Express route and show the gate plus recent runs inside the existing frontend Quality Guard panel.

**Tech Stack:** Node ESM, Express, `node:test`, React 18, Ant Design, existing synthetic evaluation result files.

---

### Task 1: Backend Tests

**Files:**
- Modify: `server/test/app.test.mjs`

- [x] Add a pure helper test that builds two synthetic result payloads and verifies the latest run is compared against the previous run.
- [x] Add an Express route test for `GET /quality/history` using an injected `qualityService.readQualityHistory`.

### Task 2: Quality History Helper

**Files:**
- Modify: `server/evaluation/quality-report.js`

- [x] Add compact run summary helpers for result payloads.
- [x] Add regression gate comparison for pass-rate, page-hit, citation, and failed-case regressions.
- [x] Add `readQualityHistory({ limit })` that reads `server/evaluation/results/*.json`, skips `latest*.json` and ragas files, and returns sorted runs plus gate status.

### Task 3: Express Route

**Files:**
- Modify: `server/app.js`

- [x] Inject `readQualityHistory` in the default `qualityService`.
- [x] Add authenticated `GET /quality/history`.
- [x] Return the same compact JSON error shape used by other quality routes.

### Task 4: Frontend Quality Guard History

**Files:**
- Modify: `src/App.js`
- Modify: `src/App.css`
- Modify: `src/App.test.js`

- [x] Add `fetchQualityHistory()` and Quality Guard state.
- [x] Add a History button and load history after latest/synthetic actions.
- [x] Render regression gate status, delta, and the three most recent runs.
- [x] Keep the panel compact and stable in the existing sidebar.

### Task 5: Verification

**Commands:**
- `cd server && npm test`
- `CI=true npm test -- --watchAll=false`
- `npm run build`
- `curl -s http://localhost:5001/quality/history`

- [x] Run backend tests.
- [x] Run frontend tests in non-watch mode.
- [x] Run production build.
- [x] Verify the backend route and local UI.
