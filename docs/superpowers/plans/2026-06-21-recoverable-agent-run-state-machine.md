# Recoverable Agent Run State Machine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AgentRAG primary execution recoverable by persisting every replayable tool step's input, output, error, status, and event timeline before final `/chat` response assembly.

**Architecture:** Keep `server/rag/agent-run-step-replay-safety.js` as the single replay-safety source of truth. Add one primary step recording path that uses the existing `agentRunService`, step transition rules, and replay executors instead of creating a second state machine. The final run snapshot may still include trace-derived decision/observation steps, but replayable tool steps must be persisted as they start and finish.

**Tech Stack:** Node ESM, Express, `node:test`, current AgentRAG modules under `server/rag/`, PostgreSQL-backed agent run store.

---

## Current State

The repo already has:

- Run status transitions in `server/rag/agent-run-state-machine.js`.
- Step status transitions and trace-to-step normalization in `server/rag/agent-run-steps.js`.
- Replay safety matrix in `server/rag/agent-run-step-replay-safety.js`.
- Step executor and retry/resume handlers in `server/rag/agent-run-step-executor.js` and `server/rag/agent-run-step-handlers/`.
- Startup recovery and manual recovery actions in `server/rag/agent-run-recovery.js` and `server/rag/agent-run-recovery-actions.js`.
- PostgreSQL restart-style tests in `server/test/postgres-agent-run-store.test.mjs`.

The gap is primary `/chat` execution: many replayable steps are only reconstructed from `agentTrace` during final `completeRun()`. If the server dies after a tool call starts but before final response assembly, the run may not contain the step input/output/error needed for safe resume or retry.

## File Map

- Modify `server/rag/agent-runs.js`
  - Add a public `recordRunStep()` service method for idempotent primary step creation/update.
- Create `server/rag/agent-run-step-lifecycle.js`
  - Central helper for starting, completing, failing, and pausing primary steps.
  - Used by primary execution and later reusable by retry paths if we want to dedupe.
- Modify `server/rag/agent.js`
  - Create a step lifecycle recorder after `agentRunId` exists.
  - Pass it into `runAgentExecutionPlan()`.
  - Merge final trace-derived steps without overwriting persisted tool-step input/output/error.
- Modify `server/rag/agent-execution-plan-runner.js`
  - Accept `stepLifecycle`.
  - Pass it into tool-running modules.
- Modify `server/rag/agent-document-loop.js`
  - Record primary `document_rag` and `follow_up_retrieval` steps as they execute.
- Modify `server/rag/agent-custom-skill-runner.js`
  - Record `custom_skill` steps with persisted `skillId`, `docIds`, `question`, `retrievalPlan`, `sessionId`, and `userId`.
- Modify `server/rag/agent-built-in-skill-runners.js`
  - Record built-in replayable steps where they execute: `arxiv_import`, `document_discovery`, `inventory`, `research_brief`.
- Modify `server/rag/agent-web-runner.js`
  - Record `web_search` input and failure/output through capability-backed policy.
- Add `server/test/agent-run-step-lifecycle.test.mjs`
  - Unit tests for new primary step lifecycle helper.
- Add targeted tests to `server/test/agent-run-step-executor.test.mjs`
  - Ensure primary-persisted steps remain retryable using existing executor.
- Add targeted tests to `server/test/postgres-agent-run-store.test.mjs`
  - Simulate restart after started primary step and after completed first step / pending second step.
- Add targeted tests to `server/test/app.test.mjs` or a new `server/test/agent-primary-run-persistence.test.mjs`
  - Exercise `/chat` or `runAgentRag()` with stub services and assert persisted primary `document_rag` input/output/error.
- Update docs only if behavior changes user-facing recovery semantics:
  - `docs/agent-rag.md`
  - `docs/development.md`

---

## Task 1: Lock Step Lifecycle Contract

**Files:**
- Create: `server/rag/agent-run-step-lifecycle.js`
- Modify: `server/rag/agent-runs.js`
- Test: `server/test/agent-run-step-lifecycle.test.mjs`

- [ ] **Step 1: Write failing tests for primary step recording**

Add tests that expect a service-level method to create and update a step before final run completion:

```js
import assert from "node:assert/strict";
import test from "node:test";

import { createAgentRunStepLifecycle } from "../rag/agent-run-step-lifecycle.js";
import {
  AGENT_RUN_STATUSES,
  createAgentRunService,
  createInMemoryAgentRunStore,
} from "../rag/agent-runs.js";

const accessScope = {
  userId: "alice",
  workspaceId: "workspace-a",
};

test("primary step lifecycle persists input, output, and event order", async () => {
  const agentRunService = createAgentRunService({
    agentRunStore: createInMemoryAgentRunStore({
      now: () => "2026-06-21T00:00:00.000Z",
    }),
  });

  await agentRunService.createRun({
    accessScope,
    goal: "Answer from docs",
    runId: "run-primary-step",
  });

  const lifecycle = createAgentRunStepLifecycle({
    accessScope,
    agentRunService,
    runId: "run-primary-step",
  });

  await lifecycle.startStep({
    id: "primary-document-rag",
    type: "document_rag",
    label: "Document RAG",
    input: {
      docIds: ["doc-1"],
      question: "What changed?",
    },
  });

  await lifecycle.completeStep({
    id: "primary-document-rag",
    output: {
      citationCount: 1,
      text: "Answer.",
    },
  });

  const run = await agentRunService.getRun({
    accessScope,
    runId: "run-primary-step",
  });
  const step = run.steps.find((item) => item.id === "primary-document-rag");

  assert.equal(run.status, AGENT_RUN_STATUSES.running);
  assert.equal(step.status, "completed");
  assert.deepEqual(step.input.docIds, ["doc-1"]);
  assert.equal(step.output.citationCount, 1);
  assert.deepEqual(
    run.events.map((event) => event.type),
    ["run_created", "step_started", "step_completed"]
  );
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
cd server
node --test test/agent-run-step-lifecycle.test.mjs
```

Expected: FAIL because `agent-run-step-lifecycle.js` and `recordRunStep()` do not exist yet.

- [ ] **Step 3: Implement `recordRunStep()` in `agent-runs.js`**

Add a service method that creates missing steps and updates existing steps using existing normalization and transition helpers.

Implementation constraints:

- New primary steps may start as `running`, `pending`, or `paused`.
- Existing steps must obey `assertAgentRunStepStatusTransition()`.
- The method appends one event per status update: `step_started`, `step_completed`, `step_failed`, `step_paused`, or explicit `eventType`.
- It must preserve previous `input`, `output`, and `error` unless the patch intentionally replaces them.

- [ ] **Step 4: Implement `createAgentRunStepLifecycle()`**

Expected public methods:

```js
createAgentRunStepLifecycle({
  accessScope,
  agentRunService,
  runId,
}).startStep({ id, type, label, input, detail });

createAgentRunStepLifecycle(...).completeStep({ id, output, detail });
createAgentRunStepLifecycle(...).failStep({ id, error, output, detail });
createAgentRunStepLifecycle(...).pauseStep({ id, detail });
```

Each method should no-op safely when `agentRunService` or `runId` is missing, so existing tests that do not configure agent runs remain simple.

- [ ] **Step 5: Verify the lifecycle tests pass**

Run:

```bash
cd server
node --test test/agent-run-step-lifecycle.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/rag/agent-runs.js server/rag/agent-run-step-lifecycle.js server/test/agent-run-step-lifecycle.test.mjs
git commit -m "feat: add agent run step lifecycle recorder"
```

---

## Task 2: Persist Primary Document RAG Steps

**Files:**
- Modify: `server/rag/agent.js`
- Modify: `server/rag/agent-execution-plan-runner.js`
- Modify: `server/rag/agent-document-loop.js`
- Test: `server/test/agent-primary-run-persistence.test.mjs`

- [ ] **Step 1: Write failing primary persistence test**

Create a test that runs `runAgentRag()` with stub `ragService.chat()` and an in-memory `agentRunService`, then asserts the run has a completed `document_rag` step with replayable input and output.

Minimum assertion shape:

```js
assert.equal(documentStep.type, "document_rag");
assert.equal(documentStep.status, "completed");
assert.deepEqual(documentStep.input.docIds, ["doc-1"]);
assert.equal(documentStep.input.question, "What is annual leave?");
assert.equal(documentStep.output.citationCount, 1);
assert.match(documentStep.output.text, /annual leave/i);
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
cd server
node --test test/agent-primary-run-persistence.test.mjs
```

Expected: FAIL because primary `document_rag` is still only trace-derived at final completion.

- [ ] **Step 3: Thread lifecycle recorder through the execution plan**

In `server/rag/agent.js`:

- Import `createAgentRunStepLifecycle`.
- After `agentRunId` is available, create `stepLifecycle`.
- Pass `stepLifecycle` into `runAgentExecutionPlan()`.

In `server/rag/agent-execution-plan-runner.js`:

- Accept `stepLifecycle`.
- Pass it to `runDocumentRagLoop()`.

- [ ] **Step 4: Record `document_rag` and `follow_up_retrieval`**

In `server/rag/agent-document-loop.js`:

- Before primary `ragService.chat`, call `stepLifecycle.startStep()` with a stable id such as `document_rag:primary`.
- Persist input: `docIds`, `question`, `retrievalPlan`, `sessionId`, `userId`.
- On success, call `completeStep()` with `text`, `citationCount`, `abstained`.
- On error or failed `Result`, call `failStep()` with serialized error and then rethrow.
- Do the same for each follow-up retrieval with deterministic ids like `follow_up_retrieval:${executionLoop.followUpsRun + 1}`.

- [ ] **Step 5: Preserve final trace merge behavior**

In `buildRunCompletionPayload()` or the merge around `buildAgentRunStepsFromTrace()`:

- Existing persisted tool steps must keep their `input`, `output`, and `error`.
- Trace-derived steps may add `detail`, labels, decisions, and observations.
- Do not overwrite a completed primary tool step with a lower-fidelity trace step.

- [ ] **Step 6: Verify document primary persistence**

Run:

```bash
cd server
node --test test/agent-primary-run-persistence.test.mjs
node --test test/agent-run-step-executor.test.mjs
node --test test/agent-run-recovery.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/rag/agent.js server/rag/agent-execution-plan-runner.js server/rag/agent-document-loop.js server/test/agent-primary-run-persistence.test.mjs
git commit -m "feat: persist primary document agent steps"
```

---

## Task 3: Persist Primary Skill and Capability Steps

**Files:**
- Modify: `server/rag/agent-custom-skill-runner.js`
- Modify: `server/rag/agent-built-in-skill-runners.js`
- Modify: `server/rag/agent-web-runner.js`
- Modify: `server/rag/agent-execution-plan-runner.js`
- Test: `server/test/agent-primary-run-persistence.test.mjs`

- [ ] **Step 1: Add failing tests for primary custom/web/arXiv persistence**

Extend the primary persistence tests so each replayable step type has durable input:

```js
assert.equal(customStep.type, "custom_skill");
assert.equal(customStep.input.skillId, "risk_review");
assert.deepEqual(customStep.input.docIds, ["doc-1"]);

assert.equal(webStep.type, "web_search");
assert.equal(webStep.input.question, "What changed?");

assert.equal(arxivStep.type, "arxiv_import");
assert.equal(arxivStep.input.topic, "retrieval augmented generation");
```

For external/write-capable steps, assert they are not auto replay safe using the existing safety matrix rather than expecting auto resume.

- [ ] **Step 2: Run the failing test**

Run:

```bash
cd server
node --test test/agent-primary-run-persistence.test.mjs
```

Expected: FAIL for step types not yet recorded during primary execution.

- [ ] **Step 3: Record custom skills**

In `server/rag/agent-custom-skill-runner.js`:

- Start a `custom_skill` step before each custom skill executes.
- Persist `skillId`, `skillVersion`, `docIds`, `question`, `retrievalPlan`, `sessionId`, `userId`.
- Complete with `text`, `citationCount`, `abstained`.
- Fail with serialized error.

- [ ] **Step 4: Record built-in capabilities**

In `server/rag/agent-built-in-skill-runners.js`:

- `arxiv_import`: persist sanitized topic/maxResults/selection metadata, never raw sensitive query data outside the existing query policy output.
- `document_discovery`: persist question/docIds/access scope-safe input.
- `inventory`: persist minimal input and output counts.
- `research_brief`: persist sub-question inputs and output summary metadata.

- [ ] **Step 5: Record web search**

In `server/rag/agent-web-runner.js`:

- Persist `question` and provider-safe search input.
- Complete with `text` and citation count.
- Mark failed step if capability policy, approval, or external search fails.

- [ ] **Step 6: Verify all primary persistence tests**

Run:

```bash
cd server
node --test test/agent-primary-run-persistence.test.mjs
node --test test/agent-run-step-replay-safety.test.mjs
node --test test/agent-run-step-executor.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/rag/agent-custom-skill-runner.js server/rag/agent-built-in-skill-runners.js server/rag/agent-web-runner.js server/rag/agent-execution-plan-runner.js server/test/agent-primary-run-persistence.test.mjs
git commit -m "feat: persist primary agent tool steps"
```

---

## Task 4: Strengthen PostgreSQL Restart Recovery

**Files:**
- Modify: `server/test/postgres-agent-run-store.test.mjs`
- Modify: `server/rag/agent-run-recovery.js`
- Modify: `server/rag/agent-run-recovery-actions.js`
- Modify if needed: `server/rag/postgres-agent-run-store.js`

- [ ] **Step 1: Add restart tests for primary persisted state**

Add tests for three restart points:

1. Service restarts with a `document_rag` step in `running` and complete input.
2. Service restarts after step 1 completed and step 2 is `pending`.
3. Service restarts after external/write step is `running`, where safety requires manual recovery.

Assertions:

```js
assert.equal(recoveredRun.status, AGENT_RUN_STATUSES.waitingForUser);
assert.equal(recoveredRun.recovery.replaySafety.steps[0].canAutoReplay, false);
assert.ok(recoveredRun.recovery.replaySafety.reasonCodes.includes("requires_approval"));
```

- [ ] **Step 2: Run the failing restart tests**

Run:

```bash
cd server
node --test test/postgres-agent-run-store.test.mjs
```

Expected: Either PASS if existing recovery already covers it, or FAIL where primary persisted step states expose missing behavior.

- [ ] **Step 3: Fix recovery selection without duplicating safety policy**

If failing:

- Keep `server/rag/agent-run-step-replay-safety.js` as the only place that derives missing input, approval, idempotency, and unsafe policy reasons.
- Make `findAutoRecoverableStep()` and recovery actions choose only from persisted step input and gate state.
- Never infer replay safety from trace summary text.

- [ ] **Step 4: Verify restart tests**

Run:

```bash
cd server
node --test test/postgres-agent-run-store.test.mjs
node --test test/agent-run-recovery.test.mjs
node --test test/recovery-observability-eval.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/test/postgres-agent-run-store.test.mjs server/rag/agent-run-recovery.js server/rag/agent-run-recovery-actions.js server/rag/postgres-agent-run-store.js
git commit -m "test: cover postgres agent run restart recovery"
```

---

## Task 5: Wire Observability and Quality Gates

**Files:**
- Modify: `server/evaluation/recovery-observability-eval.js`
- Modify if needed: `server/evaluation/quality-recovery-gate.js`
- Modify if user-facing docs change: `docs/agent-rag.md`, `docs/development.md`

- [ ] **Step 1: Add recovery observability cases for primary persisted steps**

The recovery report must include:

- primary step started
- primary step completed
- primary step failed
- auto recovery attempted
- manual recovery required
- retry after failed step
- resume after partial step

- [ ] **Step 2: Run targeted eval**

Run:

```bash
cd server
npm run eval:recovery-observability
```

Expected: latest recovery report includes the new primary-step cases.

- [ ] **Step 3: Ensure quality gate consumes the new report**

Run:

```bash
cd server
npm run quality:gate
```

Expected: no recovery gate failures; failures should list concrete failed case/check names.

- [ ] **Step 4: Update docs only for changed semantics**

If the API response or recovery UI semantics changed, update:

- `docs/agent-rag.md`
- `docs/development.md`

If only internals changed, skip docs.

- [ ] **Step 5: Commit**

```bash
git add server/evaluation/recovery-observability-eval.js server/evaluation/quality-recovery-gate.js docs/agent-rag.md docs/development.md
git commit -m "test: gate primary agent run recovery"
```

---

## Task 6: Final Verification

**Files:**
- No new files unless previous tasks changed docs.

- [ ] **Step 1: Run focused backend tests**

```bash
cd server
node --test test/agent-run-step-lifecycle.test.mjs
node --test test/agent-primary-run-persistence.test.mjs
node --test test/agent-run-step-executor.test.mjs
node --test test/agent-run-recovery.test.mjs
node --test test/agent-run-recovery-actions.test.mjs
node --test test/agent-run-step-replay-safety.test.mjs
node --test test/postgres-agent-run-store.test.mjs
```

- [ ] **Step 2: Run aggregate backend tests**

```bash
cd server
npm test
```

- [ ] **Step 3: Run AgentRAG eval gates**

```bash
cd server
npm run eval:trajectory
npm run eval:recovery-observability
npm run quality:gate
```

- [ ] **Step 4: Check formatting**

```bash
git diff --check
```

- [ ] **Step 5: Final commit if any verification/doc fixes were needed**

```bash
git add .
git commit -m "chore: verify recoverable agent run state machine"
```

---

## Acceptance Criteria

- During primary `/chat`, each replayable tool step is persisted before execution starts.
- Each persisted tool step has stable `id`, `type`, `status`, `input`, and later `output` or `error`.
- If the server restarts while a safe read-only step is pending/running, auto recovery can resume it using persisted input.
- If the server restarts while an approval or external/write step is pending/running, recovery stays manual and exposes replay safety reasons.
- Approval after restart resumes only the approved capability step; it does not replay the entire `/chat`.
- Retry after failed run creates a retry step with copied input and cleared output/error.
- Final response still includes `agentRunId`, `agentRunStatus`, `agentRunSteps`, `agentTrace`, `agentObservability`, and `agentWorkingMemory`.
- `server/rag/agent-run-step-replay-safety.js` remains the only source of replay-safety policy.
- Verification commands in Task 6 pass.

## Commit Strategy

Commit after each task. Do not batch all work into one large commit. The preferred review order is:

1. lifecycle recorder
2. primary document RAG persistence
3. remaining primary tool persistence
4. PostgreSQL restart recovery coverage
5. eval/quality gate coverage
