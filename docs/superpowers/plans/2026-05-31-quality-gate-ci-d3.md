# Quality Gate CI D3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the AgentRAG quality regression gate executable from CLI and CI so quality regressions fail automatically.

**Architecture:** Reuse the D2 `readQualityHistory()` regression gate and add a small CLI wrapper that converts gate status into process exit codes. Wire that CLI into npm scripts and a minimal GitHub Actions workflow that checks saved evaluation artifacts without running expensive model evals.

**Tech Stack:** Node ESM, npm scripts, `node:test`, GitHub Actions.

---

### Task 1: Gate Decision Tests

**Files:**
- Modify: `server/test/app.test.mjs`

- [x] Add pure tests for pass, fail, warn, unknown, `failOnWarn`, and `allowUnknown` gate decisions.

### Task 2: Gate Decision Helper

**Files:**
- Modify: `server/evaluation/quality-report.js`

- [x] Add `buildQualityGateDecision({ history, failOnWarn, allowUnknown })`.
- [x] Keep default behavior CI-safe: `fail` exits `1`, `unknown` exits `2`, `warn` exits `0` unless `failOnWarn` is enabled.

### Task 3: CLI Wrapper

**Files:**
- Create: `server/evaluation/check-quality-gate.mjs`

- [x] Parse `--json`, `--fail-on-warn`, `--allow-unknown`, and `--help`.
- [x] Read quality history and print either compact text or JSON.
- [x] Set `process.exitCode` from `buildQualityGateDecision`.

### Task 4: Scripts And CI

**Files:**
- Modify: `server/package.json`
- Modify: `package.json`
- Create: `.github/workflows/quality-gate.yml`

- [x] Add `quality:gate` script inside `server/package.json`.
- [x] Add root `quality:gate` delegating to the server script.
- [x] Add a GitHub Actions workflow that runs `npm ci` in `server/` and then `npm run quality:gate -- --fail-on-warn`.

### Task 5: Verification

**Commands:**
- `cd server && npm test`
- `cd server && npm run quality:gate`
- `cd server && npm run quality:gate -- --json`
- `CI=true npm test -- --watchAll=false`
- `npm run build`

- [x] Run backend tests.
- [x] Run quality gate CLI in text mode.
- [x] Run quality gate CLI in JSON mode.
- [x] Run frontend tests in non-watch mode.
- [x] Run production build.
