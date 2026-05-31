# Agent Budget Limits E2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic tool budgets and trace step limits so AgentRAG cannot retry or expand tool use without bounds.

**Architecture:** Add a small budget helper under `server/rag/` and inject an optional `agentBudget` through `createApp()` into `runAgentRag()`. The agent consumes budget before document RAG, retry, web, and research subquestions; skipped actions produce `budget_limit` trace entries instead of silently disappearing.

**Tech Stack:** Node ESM, Express app tests, existing AgentRAG trace format.

---

### Task 1: Budget Behavior Tests

**Files:**
- Modify: `server/test/app.test.mjs`

- [x] Add a chat test where `maxDocumentRagCalls: 1` prevents the self-check retry.
- [x] Add a chat test where `maxWebSearchCalls: 0` prevents web fallback after an abstain.
- [x] Assert `agentTrace` includes `budget_limit` and no forbidden tool call occurred.

### Task 2: Budget Helper

**Files:**
- Create: `server/rag/agent-budget.js`

- [x] Implement `createAgentBudget(overrides)`.
- [x] Implement `consumeBudget(budgetState, key)`.
- [x] Implement `appendTraceStep({ trace, budgetState, step })` with max trace enforcement.
- [x] Implement `buildBudgetLimitStep({ index, tool, reason })`.

### Task 3: App Injection

**Files:**
- Modify: `server/app.js`

- [x] Thread `options.agentBudget` from `createApp()` into `buildChatResponse()`.
- [x] Pass `agentBudget` to `runAgentRag()`.

### Task 4: Agent Integration

**Files:**
- Modify: `server/rag/agent.js`

- [x] Consume document RAG budget before primary lookup and retry.
- [x] Consume web budget before fallback search.
- [x] Limit research questions based on `maxResearchQuestions`.
- [x] Add budget summary in the plan trace detail.

### Task 5: Verification

**Commands:**
- `cd server && npm test`
- `CI=true npm test -- --watchAll=false`
- `npm run build`
- `cd server && npm run quality:gate`

- [x] Run backend tests.
- [x] Run frontend tests in non-watch mode.
- [x] Run production build.
- [x] Run quality gate.
