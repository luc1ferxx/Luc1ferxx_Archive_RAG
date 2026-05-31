# Research Brief C1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add C1 research-brief Agent behavior that decomposes a research request, runs multiple document-grounded RAG lookups, and returns a structured brief with citations and trace metadata.

**Architecture:** Keep research reports inside the existing `/chat` response instead of adding saved report storage. Add a focused research helper for deterministic subquestion planning and brief formatting, wire it into the existing AgentRAG orchestrator as `agentMode=research_brief`, and show the resulting brief details in the current conversation UI.

**Tech Stack:** Node ESM, existing RAG chat service, Express `/chat`, React 18, node:test.

---

### Task 1: Research Contract Tests

**Files:**
- Modify: `server/test/app.test.mjs`

- [x] Add an API test proving a research/analysis prompt returns `agentMode=research_brief`, a `researchBrief` object, aggregated citations, and research trace steps.
- [x] Add a test proving research requests still require selected documents.

### Task 2: Research Brief Helper

**Files:**
- Create: `server/rag/research-brief.js`

- [x] Implement deterministic `buildResearchPlan({ question, documents })` that creates 3-5 subquestions.
- [x] Implement `formatResearchBrief({ question, documents, results })` with Executive Summary, Key Findings, Evidence By Document, Conflicts Or Gaps, and Recommended Next Questions.
- [x] Deduplicate citations across subquestion results.

### Task 3: Agent Orchestration

**Files:**
- Modify: `server/rag/agent.js`

- [x] Add research routing for prompts containing research/brief/report/analyze/risk signals.
- [x] Run the research plan through existing `ragService.chat` per subquestion.
- [x] Return `researchBrief`, `agentAnswer`, `ragSources`, and `agentTrace` while preserving legacy response fields.

### Task 4: Frontend Research Brief UI

**Files:**
- Modify: `src/components/RenderQA.js`
- Modify: `src/App.css`

- [x] Render a compact Research Brief panel below the Agent answer.
- [x] Show planned subquestions and status so users can inspect what the agent did.

### Task 5: Verification

**Commands:**
- `cd server && npm test`
- `CI=true npm test -- --watchAll=false`
- `npm run build`

- [x] Run backend tests.
- [x] Run frontend tests in non-watch mode.
- [x] Run production build.
