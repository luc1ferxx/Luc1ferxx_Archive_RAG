import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildObservabilityReport,
  formatObservabilityReport,
  readObservabilityEventsFromPath,
} from "../evaluation/observability-report.js";

const writeJsonl = async (filePath, events) => {
  await writeFile(
    filePath,
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8"
  );
};

test("observability report aggregates per-skill agent metrics", () => {
  const report = buildObservabilityReport({
    events: [
      {
        traceType: "agent",
        agentObservability: {
          skills: [
            {
              skillId: "document_rag",
              skillVersion: "1.0.0",
              label: "Document RAG",
              selected: true,
              attempts: 2,
              retryCount: 1,
              skippedCount: 0,
              totalDurationMs: 240,
              citationCount: 5,
              abstained: false,
              errorCount: 0,
              budgetUsed: 2,
              budgetLimit: 2,
              budgetRemaining: 0,
            },
            {
              skillId: "web_search",
              skillVersion: "1.0.0",
              label: "Web Search",
              selected: true,
              attempts: 1,
              retryCount: 0,
              skippedCount: 0,
              totalDurationMs: 90,
              citationCount: 0,
              abstained: false,
              errorCount: 1,
            },
          ],
        },
      },
      {
        traceType: "agent",
        agentObservability: {
          skills: [
            {
              skillId: "document_rag",
              skillVersion: "1.0.0",
              label: "Document RAG",
              selected: true,
              attempts: 1,
              retryCount: 0,
              skippedCount: 0,
              totalDurationMs: 60,
              citationCount: 1,
              abstained: true,
              errorCount: 0,
              budgetUsed: 1,
              budgetLimit: 2,
              budgetRemaining: 1,
            },
          ],
        },
      },
    ],
  });

  assert.equal(report.eventCount, 2);
  assert.deepEqual(report.skills.map((skill) => skill.skillKey), [
    "document_rag@1.0.0",
    "web_search@1.0.0",
  ]);
  assert.deepEqual(report.skills[0], {
    skillKey: "document_rag@1.0.0",
    skillId: "document_rag",
    skillVersion: "1.0.0",
    label: "Document RAG",
    selectedCount: 2,
    attempts: 3,
    skippedCount: 0,
    retryCount: 1,
    errorCount: 0,
    abstainCount: 1,
    totalDurationMs: 300,
    avgDurationMs: 100,
    citationCount: 6,
    avgCitations: 2,
    retryRate: 0.3333,
    failureRate: 0,
    abstainRate: 0.3333,
    lastBudgetUsed: 1,
    lastBudgetLimit: 2,
    lastBudgetRemaining: 1,
  });
  assert.equal(report.skills[1].failureRate, 1);

  const formatted = formatObservabilityReport(report);

  assert.match(formatted, /AgentRAG Observability Report/);
  assert.match(formatted, /document_rag@1\.0\.0/);
  assert.match(formatted, /avg latency: 100ms/);
  assert.match(formatted, /abstain rate: 33\.3%/);
});

test("observability report aggregates query planner and rag trace metrics", () => {
  const report = buildObservabilityReport({
    events: [
      {
        routeMode: "qa",
        latencyMs: 120,
        abstained: false,
        finalSourceBundle: {
          citations: [{ rank: 1 }, { rank: 2 }],
        },
        agentRetrievalPlan: {
          intent: "fact",
          retrievalQueries: [{ id: "primary" }, { id: "fact-citation" }],
          retrievalOptions: {
            profile: "narrow",
            topK: 4,
          },
        },
      },
      {
        routeMode: "qa",
        latencyMs: 180,
        abstained: true,
        finalSourceBundle: {
          citations: [],
        },
        agentRetrievalPlan: {
          intent: "timeline",
          retrievalQueries: [{ id: "primary" }, { id: "dates" }, { id: "gaps" }],
          retrievalOptions: {
            profile: "timeline",
            topK: 9,
          },
        },
      },
    ],
  });

  assert.equal(report.rag.eventCount, 2);
  assert.equal(report.rag.avgLatencyMs, 150);
  assert.equal(report.rag.avgCitations, 1);
  assert.equal(report.rag.abstainRate, 0.5);
  assert.deepEqual(report.rag.routeModes, {
    qa: 2,
  });
  assert.deepEqual(report.queryPlanner.intentCounts, {
    fact: 1,
    timeline: 1,
  });
  assert.equal(report.queryPlanner.avgRetrievalQueries, 2.5);
  assert.deepEqual(report.queryPlanner.topKProfiles, {
    narrow: 1,
    timeline: 1,
  });
  assert.deepEqual(report.queryPlanner.topKValues, {
    4: 1,
    9: 1,
  });

  const formatted = formatObservabilityReport(report);

  assert.match(formatted, /Query Planner/);
  assert.match(formatted, /fact: 1/);
  assert.match(formatted, /timeline: 1/);
  assert.match(formatted, /avg retrieval queries: 2\.5/);
});

test("observability report aggregates execution planner metrics", () => {
  const report = buildObservabilityReport({
    events: [
      {
        traceType: "agent",
        agentMode: "document",
        agentObservability: {
          executionPlanner: {
            fallback: false,
            fallbackReason: null,
            requestedPlannerId: "deterministic",
            selectedPlannerId: "deterministic",
            status: "selected",
            stepIds: ["document_rag"],
          },
        },
      },
      {
        traceType: "agent",
        agentMode: "inventory",
        agentObservability: {
          executionPlanner: {
            fallback: false,
            fallbackReason: null,
            requestedPlannerId: "llm",
            selectedPlannerId: "llm",
            status: "selected",
            stepIds: ["inventory"],
          },
        },
      },
      {
        traceType: "agent",
        agentMode: "inventory",
        agentObservability: {
          executionPlanner: {
            fallback: true,
            fallbackReason: "Invalid AgentRAG execution plan: unknown step.",
            requestedPlannerId: "llm",
            selectedPlannerId: "deterministic",
            status: "fallback",
            stepIds: ["inventory"],
          },
        },
      },
    ],
  });

  assert.equal(report.planner.eventCount, 3);
  assert.equal(report.planner.llmSelectedCount, 1);
  assert.equal(report.planner.fallbackCount, 1);
  assert.equal(report.planner.fallbackRate, 0.3333);
  assert.deepEqual(report.planner.requestedPlannerCounts, {
    deterministic: 1,
    llm: 2,
  });
  assert.deepEqual(report.planner.selectedPlannerCounts, {
    deterministic: 2,
    llm: 1,
  });
  assert.deepEqual(report.planner.statusCounts, {
    fallback: 1,
    selected: 2,
  });
  assert.deepEqual(report.planner.topFallbackReasons, [
    {
      count: 1,
      value: "Invalid AgentRAG execution plan: unknown step.",
    },
  ]);
  assert.deepEqual(report.planner.agentModeStepSequences, {
    document: {
      document_rag: 1,
    },
    inventory: {
      inventory: 2,
    },
  });

  const formatted = formatObservabilityReport(report);

  assert.match(formatted, /Execution Planner/);
  assert.match(formatted, /llm selected: 1/);
  assert.match(formatted, /fallback rate: 33\.3%/);
  assert.match(formatted, /Invalid AgentRAG execution plan: unknown step\.: 1/);
  assert.match(formatted, /inventory:\n      inventory: 2/);
});

test("observability report aggregates LLMOps metrics by operation and route", () => {
  const report = buildObservabilityReport({
    events: [
      {
        traceType: "llmops",
        eventType: "llmops_metric",
        operation: "llm_completion",
        stage: "complete_text",
        status: "ok",
        latencyMs: 100,
        latencySloMs: 150,
        inputCharacters: 400,
        outputCharacters: 120,
        inputTokens: 40,
        outputTokens: 12,
        totalTokens: 52,
        tokenSource: "actual",
        estimatedCostUsd: 0.00012,
        pricingSource: "model_contract",
        costCurrency: "USD",
        itemCount: 1,
        annotations: [
          {
            category: "budget",
            id: "llmops_budget_exceeded",
            severity: "warn",
          },
        ],
        alerts: [
          {
            category: "budget",
            id: "llmops_budget_exceeded",
            severity: "warn",
          },
        ],
        budget: {
          exceededKeys: ["estimated_cost_usd"],
          status: "exceeded",
        },
        modelRoute: {
          capability: "chat",
          modelId: "openai.chat",
          providerId: "openai",
          routeId: "chat.default",
          status: "selected",
        },
      },
      {
        traceType: "llmops",
        eventType: "llmops_metric",
        operation: "embedding",
        stage: "embed_documents",
        status: "ok",
        latencyMs: 50,
        latencySloMs: 40,
        inputCharacters: 200,
        inputTokens: 20,
        outputTokens: 0,
        totalTokens: 20,
        tokenSource: "estimated",
        estimatedCostUsd: 0.00002,
        pricingSource: "model_contract",
        costCurrency: "USD",
        itemCount: 2,
        annotations: [
          {
            category: "usage",
            id: "llmops_usage_estimated",
            severity: "info",
          },
        ],
        budget: {
          status: "ok",
        },
        modelRoute: {
          capability: "embedding",
          modelId: "openai.embedding",
          providerId: "openai",
          routeId: "embedding.default",
          status: "selected",
        },
      },
      {
        traceType: "llmops",
        eventType: "llmops_metric",
        operation: "llm_completion",
        stage: "complete_text",
        status: "error",
        latencyMs: 300,
        inputCharacters: 250,
        inputTokens: 25,
        outputTokens: 0,
        totalTokens: 25,
        tokenSource: "estimated",
        pricingSource: "unavailable",
        itemCount: 1,
        errorName: "RateLimitError",
        errorMessage: "rate limited",
        annotations: [
          {
            category: "status",
            id: "llmops_status_error",
            severity: "error",
          },
        ],
        alerts: [
          {
            category: "status",
            id: "llmops_status_error",
            severity: "error",
          },
        ],
        budget: {
          status: "unavailable",
        },
        modelRoute: {
          capability: "chat",
          modelId: "openai.chat",
          providerId: "openai",
          routeId: "chat.default",
          status: "selected",
        },
      },
    ],
  });

  assert.equal(report.llmops.eventCount, 3);
  assert.equal(report.llmops.okCount, 2);
  assert.equal(report.llmops.errorCount, 1);
  assert.equal(report.llmops.errorRate, 0.3333);
  assert.equal(report.llmops.avgLatencyMs, 150);
  assert.equal(report.llmops.totalInputCharacters, 850);
  assert.equal(report.llmops.totalInputTokens, 85);
  assert.equal(report.llmops.totalOutputTokens, 12);
  assert.equal(report.llmops.totalTokens, 97);
  assert.equal(report.llmops.avgTotalTokens, 32.33);
  assert.equal(report.llmops.estimatedCostUsd, 0.00014);
  assert.equal(report.llmops.alertEventCount, 2);
  assert.equal(report.llmops.budgetExceededCount, 1);
  assert.equal(report.llmops.budgetExceededRate, 0.3333);
  assert.equal(report.llmops.latencySloObservedCount, 2);
  assert.equal(report.llmops.latencySloBreachedCount, 1);
  assert.equal(report.llmops.latencySloBreachRate, 0.5);
  assert.deepEqual(report.llmops.statusCounts, {
    error: 1,
    ok: 2,
  });
  assert.deepEqual(report.llmops.tokenSourceCounts, {
    actual: 1,
    estimated: 2,
  });
  assert.deepEqual(report.llmops.pricingSourceCounts, {
    model_contract: 2,
    unavailable: 1,
  });
  assert.deepEqual(report.llmops.latencySloStatusCounts, {
    breach: 1,
    pass: 1,
    unavailable: 1,
  });
  assert.deepEqual(report.llmops.budgetStatusCounts, {
    exceeded: 1,
    ok: 1,
    unavailable: 1,
  });
  assert.deepEqual(report.llmops.annotationCounts, {
    llmops_budget_exceeded: 1,
    llmops_status_error: 1,
    llmops_usage_estimated: 1,
  });
  assert.deepEqual(report.llmops.alertCounts, {
    llmops_budget_exceeded: 1,
    llmops_status_error: 1,
  });
  assert.equal(report.llmops.byOperation.llm_completion.eventCount, 2);
  assert.equal(report.llmops.byOperation.llm_completion.errorRate, 0.5);
  assert.equal(report.llmops.byOperation.llm_completion.totalTokens, 77);
  assert.equal(report.llmops.byOperation.llm_completion.estimatedCostUsd, 0.00012);
  assert.equal(report.llmops.byOperation.embedding.avgItemCount, 2);
  assert.equal(report.llmops.byOperation.embedding.latencySloBreachRate, 1);
  assert.equal(
    report.llmops.byRoute["openai:chat.default:openai.chat"].eventCount,
    2
  );
  assert.equal(
    report.llmops.byRoute["openai:embedding.default:openai.embedding"].avgLatencyMs,
    50
  );

  const formatted = formatObservabilityReport(report);

  assert.match(formatted, /LLMOps Metrics/);
  assert.match(formatted, /total tokens: 97/);
  assert.match(formatted, /estimated cost: \$0\.000140/);
  assert.match(formatted, /latency SLO breach rate: 50%/);
  assert.match(formatted, /alert events: 2/);
  assert.match(formatted, /budget exceeded rate: 33\.3%/);
  assert.match(formatted, /actual: 1/);
  assert.match(formatted, /model_contract: 2/);
  assert.match(formatted, /breach: 1/);
  assert.match(formatted, /exceeded: 1/);
  assert.match(formatted, /llmops_budget_exceeded: 1/);
  assert.match(formatted, /llmops_status_error: 1/);
  assert.match(
    formatted,
    /llm_completion: 2 event\(s\), avg latency: 200ms, error rate: 50%, tokens: 77, cost: \$0\.000120, SLO breach rate: 0%/
  );
  assert.match(
    formatted,
    /embedding: 1 event\(s\), avg latency: 50ms, error rate: 0%, tokens: 20, cost: \$0\.000020, SLO breach rate: 100%/
  );
  assert.match(formatted, /openai:chat\.default:openai\.chat: 2 event\(s\)/);
});

test("observability report aggregates recovery and replay metrics", () => {
  const report = buildObservabilityReport({
    events: [
      {
        traceType: "agent_run_recovery",
        eventType: "startup_recovery_completed",
        recoverableRunCount: 3,
        manualRecoveryCount: 1,
        autoReplayAttemptCount: 2,
        autoReplaySuccessCount: 1,
        autoReplayFailureCount: 1,
      },
      {
        traceType: "agent_run_recovery",
        eventType: "manual_recovery_action",
        action: "cancel",
        status: "completed",
      },
      {
        traceType: "agent_run_recovery",
        eventType: "manual_recovery_action",
        action: "resume_from_step",
        status: "failed",
        error: {
          message: "Step failed.",
        },
      },
      {
        type: "step_started",
        payload: {
          status: "running",
          stepId: "document_rag:primary",
        },
      },
      {
        type: "step_completed",
        payload: {
          status: "completed",
          stepId: "document_rag:primary",
        },
      },
      {
        type: "step_failed",
        payload: {
          status: "failed",
          stepId: "document_rag:primary",
        },
      },
      {
        traceType: "agent_run_step_replay",
        action: "retry_step",
        status: "completed",
      },
      {
        traceType: "agent_run_step_replay",
        action: "resume_step",
        status: "failed",
        error: {
          message: "Replay failed.",
        },
      },
      {
        traceType: "agent",
        agentObservability: {
          executionPlanner: {
            fallback: true,
            fallbackReason: "validator_rejected",
            requestedPlannerId: "llm",
            selectedPlannerId: "deterministic",
            status: "fallback",
            stepIds: ["document_rag"],
          },
        },
      },
    ],
  });

  assert.equal(report.recovery.eventCount, 8);
  assert.equal(report.recovery.recoverableRunCount, 3);
  assert.equal(report.recovery.manualRecoveryCount, 1);
  assert.equal(report.recovery.manualRecoveryActionCount, 2);
  assert.equal(report.recovery.manualRecoveryActionFailureCount, 1);
  assert.equal(report.recovery.autoReplayAttemptCount, 2);
  assert.equal(report.recovery.autoReplaySuccessCount, 1);
  assert.equal(report.recovery.autoReplayFailureCount, 1);
  assert.equal(report.recovery.autoReplaySuccessRate, 0.5);
  assert.equal(report.recovery.stepLifecycleEventCount, 3);
  assert.equal(report.recovery.primaryStepStartedCount, 1);
  assert.equal(report.recovery.primaryStepCompletedCount, 1);
  assert.equal(report.recovery.primaryStepFailedCount, 1);
  assert.equal(report.recovery.stepRetryCount, 1);
  assert.equal(report.recovery.stepResumeCount, 1);
  assert.equal(report.recovery.stepReplayFailureCount, 1);
  assert.equal(report.recovery.plannerFallbackCount, 1);
  assert.deepEqual(report.recovery.actionCounts, {
    cancel: 1,
    resume_from_step: 1,
  });

  const formatted = formatObservabilityReport(report);

  assert.match(formatted, /Recovery \/ Replay/);
  assert.match(formatted, /recoverable runs: 3/);
  assert.match(formatted, /auto replay success rate: 50%/);
  assert.match(formatted, /primary step completed: 1/);
  assert.match(formatted, /step retry count: 1/);
  assert.match(formatted, /planner fallback count: 1/);
});

test("observability report aggregates agent task recovery metrics", () => {
  const report = buildObservabilityReport({
    events: [
      {
        traceType: "agent_task_recovery",
        eventType: "task_recovery_scheduled",
        scheduledCount: 2,
        taskRefs: [
          {
            runnerId: "agent_task",
            status: "queued",
            taskId: "task-queued",
          },
          {
            runnerId: "agent_task",
            status: "running",
            taskId: "task-running",
          },
        ],
      },
      {
        traceType: "agent_task_recovery",
        eventType: "task_resume_action",
        action: "confirm",
        resultStatus: "queued",
        runnerId: "agent_task",
        status: "completed",
        taskId: "task-waiting",
      },
      {
        traceType: "agent_task_recovery",
        eventType: "task_resume_action",
        action: "confirm",
        errorStatus: 409,
        resultStatus: "waiting_for_user",
        runnerId: "agent_task",
        status: "failed",
        taskId: "task-failed",
      },
      {
        traceType: "agent_task_recovery",
        eventType: "task_recovery_run",
        resultStatus: "completed",
        runnerId: "agent_task",
        status: "completed",
        taskId: "task-queued",
      },
    ],
  });

  assert.equal(report.recovery.taskRecoveryScheduledCount, 2);
  assert.equal(report.recovery.taskRecoveryResumeActionCount, 2);
  assert.equal(report.recovery.taskRecoveryResumeFailureCount, 1);
  assert.equal(report.recovery.taskRecoveryCompletedCount, 1);
  assert.deepEqual(report.recovery.taskRecoveryActionCounts, {
    confirm: 2,
  });

  const formatted = formatObservabilityReport(report);

  assert.match(formatted, /task recovery scheduled: 2/);
  assert.match(formatted, /task recovery resume actions: 2/);
  assert.match(formatted, /task recovery resume failures: 1/);
  assert.match(formatted, /task recovery completed: 1/);
});

test("observability report only counts scoped run step lifecycle events", () => {
  const report = buildObservabilityReport({
    events: [
      {
        traceType: "agent_run_recovery",
        eventType: "step_failed",
        payload: {
          stepId: "document_rag:primary",
        },
      },
      {
        type: "step_completed",
        phase: "primary",
      },
      {
        type: "step_started",
        payload: {
          stepId: "document_rag:primary",
        },
      },
      {
        traceType: "agent_run_step_lifecycle",
        eventType: "step_completed",
        stepId: "custom_skill:primary",
      },
      {
        traceType: "agent_run_step_lifecycle",
        eventType: "step_failed",
      },
    ],
  });

  assert.equal(report.recovery.stepLifecycleEventCount, 2);
  assert.equal(report.recovery.primaryStepStartedCount, 1);
  assert.equal(report.recovery.primaryStepCompletedCount, 1);
  assert.equal(report.recovery.primaryStepFailedCount, 0);
});

test("observability report reads jsonl from a file or directory", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "observability-report-"));
  const eventsPath = path.join(tempRoot, "events.jsonl");
  const extraPath = path.join(tempRoot, "extra.jsonl");

  await writeJsonl(eventsPath, [
    {
      routeMode: "qa",
      latencyMs: 50,
    },
  ]);
  await writeJsonl(extraPath, [
    {
      routeMode: "compare",
      latencyMs: 100,
    },
  ]);

  const fileRead = await readObservabilityEventsFromPath(eventsPath);
  const directoryRead = await readObservabilityEventsFromPath(tempRoot);

  assert.equal(fileRead.events.length, 1);
  assert.equal(fileRead.fileCount, 1);
  assert.equal(directoryRead.events.length, 2);
  assert.equal(directoryRead.fileCount, 2);
});
