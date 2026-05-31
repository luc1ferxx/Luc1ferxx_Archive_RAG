# Agent Trace Detail UI E3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the AgentRAG execution detail that the backend already returns so users can inspect plan actions, evidence checks, retry questions, research subquestions, and budget limits directly in the chat trace.

**Architecture:** Keep the existing `agentTrace` response contract unchanged. Add a compact renderer in `RenderQA` that recognizes known trace detail shapes and falls back safely for simple unknown values. Style it as inline trace-card metadata without adding modals or new API calls.

**Tech Stack:** React 18 / Create React App, Testing Library, existing archive CSS.

---

### Task 1: Trace Detail Renderer

**Files:**
- Modify: `src/components/RenderQA.js`

- [x] Add helper formatting for trace statuses, detail values, and budget counters.
- [x] Add a reusable detail component for known AgentRAG trace detail types.
- [x] Render plan actions, research questions, self-check metrics, retry questions, budget-limit reasons, and final budget snapshots.
- [x] Keep unknown detail values safe and compact.

### Task 2: Trace Detail Styling

**Files:**
- Modify: `src/App.css`

- [x] Add responsive inline layouts for detail rows, lists, chips, and budget counters.
- [x] Preserve current trace card density without text overlap on narrow cards.

### Task 3: Component Test

**Files:**
- Create: `src/components/RenderQA.test.js`

- [x] Render a conversation containing plan, self-check, budget-limit, and retry trace detail.
- [x] Assert the user-visible detail fields are present.

### Task 4: Verification

**Commands:**
- `CI=true npm test -- --watchAll=false`
- `npm run build`
- `cd server && npm test`
- `cd server && npm run quality:gate`

- [x] Run frontend tests in non-watch mode.
- [x] Run production build.
- [x] Run backend tests.
- [x] Run quality gate.
- [x] Run a browser smoke check against the local frontend.
