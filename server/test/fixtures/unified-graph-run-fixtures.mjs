// Shared, deterministic fixtures for the guarded v3 unified-graph tests (the
// in-memory suite and the PostgreSQL cross-process suite). Every provider is
// a mock; nothing here calls a model.

export const UNIFIED_ACCESS_SCOPE = Object.freeze({
  userId: "unified-graph-user",
  workspaceId: "unified-graph-workspace",
});
export const UNIFIED_DOC_ID = "vendor-msa";
export const UNIFIED_FILE_NAME = "vendor-msa.pdf";
export const UNIFIED_SESSION_ID = "unified-graph-session";
// No Web, risk, or contract-summary wording: the V1 intent is plain `document`,
// so V1 runs its own document loop on exactly the same request.
export const DOCUMENT_LOOP_QUESTION = "What notice period does the vendor require before renewal?";
export const WEB_QUESTION = "What is the latest notice period the vendor requires before renewal?";

const SUPPORTED_EXCERPT = "The vendor requires 30 days written notice before renewal.";
const UNRELATED_EXCERPT = "The agreement covers managed hosting services for the customer.";
const RISK_EXCERPT =
  "The agreement renews automatically unless the customer gives notice before the renewal date.";

export const requestBinding = (field) => ({ field, source: "request" });
export const nodeBinding = (nodeId, output) => ({ nodeId, output, source: "node" });

const citation = (excerpt, pageNumber) => ({
  docId: UNIFIED_DOC_ID,
  excerpt,
  fileName: UNIFIED_FILE_NAME,
  pageNumber,
});

/**
 * Document loop in the graph: a primary answer, its evidence check, a
 * follow-up that runs only when the check recommends one (reading the
 * check's focused question and retrieval plan), and the follow-up's check.
 */
export const createDocumentLoopProposal = () => ({
  nodes: [
    {
      dependsOn: [],
      failurePolicy: "fail_fast",
      inputBindings: {
        docIds: requestBinding("docIds"),
        question: requestBinding("question"),
        retrievalPlan: requestBinding("retrievalPlan"),
      },
      nodeId: "primary",
      skillId: "document_rag",
    },
    {
      dependsOn: ["primary"],
      failurePolicy: "fail_fast",
      inputBindings: {
        docIds: requestBinding("docIds"),
        evidence: nodeBinding("primary", "evidence"),
        question: requestBinding("question"),
      },
      nodeId: "primary_check",
      skillId: "document_evidence_check",
    },
    {
      dependsOn: ["primary_check"],
      failurePolicy: "fail_fast",
      inputBindings: {
        docIds: requestBinding("docIds"),
        question: nodeBinding("primary_check", "followUpQuestion"),
        retrievalPlan: nodeBinding("primary_check", "followUpRetrievalPlan"),
      },
      nodeId: "follow_up",
      skillId: "document_rag",
      when: { equals: true, nodeId: "primary_check", output: "retryRecommended" },
    },
    {
      dependsOn: ["follow_up"],
      failurePolicy: "fail_fast",
      inputBindings: {
        docIds: requestBinding("docIds"),
        evidence: nodeBinding("follow_up", "evidence"),
        question: requestBinding("question"),
      },
      nodeId: "follow_up_check",
      skillId: "document_evidence_check",
    },
  ],
});

/**
 * Conditional Web: the Web node runs only when the primary document answer
 * fails its evidence check, and reads only the user's question. The risk node
 * is ordered after Web (so it is dependency_skipped with it) but reads the
 * documents, never the Web text: Web output reaches only the finalizer.
 */
export const createConditionalWebProposal = () => ({
  nodes: [
    {
      dependsOn: [],
      failurePolicy: "fail_fast",
      inputBindings: { docIds: requestBinding("docIds"), question: requestBinding("question") },
      nodeId: "document",
      skillId: "document_rag",
    },
    {
      dependsOn: ["document"],
      failurePolicy: "fail_fast",
      inputBindings: {
        docIds: requestBinding("docIds"),
        evidence: nodeBinding("document", "evidence"),
        question: requestBinding("question"),
      },
      nodeId: "evidence_check",
      skillId: "document_evidence_check",
    },
    {
      dependsOn: ["evidence_check"],
      failurePolicy: "fail_fast",
      inputBindings: { question: requestBinding("question") },
      nodeId: "web",
      skillId: "web_search",
      when: { equals: false, nodeId: "evidence_check", output: "passed" },
    },
    {
      dependsOn: ["web"],
      failurePolicy: "fail_fast",
      inputBindings: {
        docIds: requestBinding("docIds"),
        question: requestBinding("question"),
      },
      nodeId: "risk",
      skillId: "risk_review",
    },
  ],
});

/** The refused shape: Web text handed to a Skill prompt as priorFindings. */
export const createWebHandOffProposal = () => ({
  nodes: createConditionalWebProposal().nodes.map((node) =>
    node.nodeId === "risk"
      ? {
          ...node,
          inputBindings: { ...node.inputBindings, priorFindings: nodeBinding("web", "text") },
        }
      : node
  ),
});

export const createProposalAdapter = (createProposal, { contexts = [] } = {}) => ({
  createExecutionGraph: (context) => {
    contexts.push(context);
    return createProposal();
  },
  id: "unified_graph_test_proposal",
});

const sameScope = (scope) =>
  scope?.userId === UNIFIED_ACCESS_SCOPE.userId &&
  scope?.workspaceId === UNIFIED_ACCESS_SCOPE.workspaceId;

/**
 * `followUp`: "resolves" answers the follow-up with supported evidence,
 * "unresolved" answers it with another unsupported claim. `primary`:
 * "unsupported" (default) answers with an unsupported claim, so its check
 * recommends a follow-up; "abstain" abstains; "supported" answers with
 * supported evidence, so its check passes.
 * `onChat` observes every call (e.g. to count effects in PostgreSQL) and may
 * return a promise the call waits on.
 */
export const createDocumentLoopRagService = ({
  followUp = "resolves",
  onChat = async () => {},
  primary = "unsupported",
} = {}) => {
  const calls = [];

  return {
    calls,
    chat: async (docIds, question, options = {}) => {
      const phase = options.retrievalPlan?.phase === "follow_up" ? "follow_up" : "primary";
      calls.push({ docIds, phase, question });
      await onChat({ docIds, phase, question });

      if (/Upstream findings from an earlier step/.test(question)) {
        return {
          abstained: false,
          citations: [citation(RISK_EXCERPT, 4)],
          text: ["Risk Review", `- Risk: ${RISK_EXCERPT} [Source 1]`].join("\n"),
        };
      }

      if (phase === "primary" && primary === "abstain") {
        return { abstained: true, citations: [], text: "" };
      }

      if (phase === "primary" && primary === "supported") {
        return {
          abstained: false,
          citations: [citation(SUPPORTED_EXCERPT, 2)],
          text: `${SUPPORTED_EXCERPT} [Source 1]`,
        };
      }

      if (phase === "primary" || followUp === "unresolved") {
        return {
          abstained: false,
          citations: [citation(UNRELATED_EXCERPT, 1)],
          text: "The vendor requires 60 days notice before renewal. [Source 1]",
        };
      }

      return {
        abstained: false,
        citations: [citation(SUPPORTED_EXCERPT, 2)],
        text: `${SUPPORTED_EXCERPT} [Source 1]`,
      };
    },
    getDocument: (docId, scope) =>
      sameScope(scope) && docId === UNIFIED_DOC_ID
        ? { docId, fileName: UNIFIED_FILE_NAME }
        : null,
    listDocuments: (scope) =>
      sameScope(scope) ? [{ docId: UNIFIED_DOC_ID, fileName: UNIFIED_FILE_NAME }] : [],
  };
};

export const createWebChatService = ({ calls = [] } = {}) => async (question) => {
  calls.push(question);
  return {
    citations: [
      {
        excerpt: "Vendor renewal notice: the published terms require 45 days notice before renewal.",
        title: "Vendor terms",
        url: "https://vendor.example/terms",
      },
    ],
    text: "Vendor renewal notice: the published terms require 45 days notice before renewal. [Source 1]",
  };
};

/**
 * A run service proxy that behaves like a process which stops at a chosen
 * write. `crashAfter(method, args, result)` runs after a successful write;
 * `crashBefore(method, args)` runs before one. Once crashed, every later call
 * throws, so nothing the dead process would never have written reaches the
 * shared store (including runAgentRag's failRun).
 */
export const createCrashingRunService = (
  service,
  { crashAfter = () => false, crashBefore = () => false } = {}
) => {
  const state = { crashed: false, runIds: [] };
  const crash = () => {
    state.crashed = true;
    const error = new Error("simulated process exit");
    error.code = "SIMULATED_PROCESS_EXIT";
    return error;
  };
  const proxy = new Proxy(service, {
    get(target, property) {
      const value = target[property];

      if (typeof value !== "function") {
        return value;
      }

      return async (...args) => {
        if (state.crashed || crashBefore(property, args[0] ?? {})) {
          throw crash();
        }

        const result = await value.apply(target, args);

        if (property === "createRun" && result?.runId) {
          state.runIds.push(result.runId);
        }

        if (crashAfter(property, args[0] ?? {}, result)) {
          throw crash();
        }

        return result;
      };
    },
  });

  return { service: proxy, state };
};

export const checkpointHasNodeRun = (checkpoint, nodeId, status = "completed") =>
  (checkpoint?.nodeRuns ?? []).some(
    (nodeRun) => nodeRun.nodeId === nodeId && nodeRun.status === status
  );

/**
 * Restrict a startup recovery scan to the given runs. Recovery lists every
 * tenant's runs by design; concurrently running integration suites share one
 * disposable database, so each suite's worker must only ever touch its own.
 */
export const scopeRecoveryToRuns = (service, runIds) =>
  new Proxy(service, {
    get(target, property) {
      if (property === "listRecoverableRuns") {
        return async (args) => {
          const listed = await target.listRecoverableRuns(args);

          return {
            ...listed,
            runs: (listed?.runs ?? []).filter((run) => runIds.includes(run.runId)),
          };
        };
      }

      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

/** The answer, loop, and working-memory state a restart must reproduce. */
export const describeAnswerState = (response = {}) => {
  const body = response.body ?? {};
  const memory = body.agentWorkingMemory ?? {};
  const loop = body.agentObservability?.executionLoop ?? {};

  return {
    agentAnswer: body.agentAnswer ?? null,
    agentMode: body.agentMode ?? null,
    clarificationReason: body.clarification?.reason ?? null,
    executionLoop: {
      followUpsRun: loop.followUpsRun ?? null,
      gaps: (loop.gaps ?? []).map((gap) => `${gap.type}:${gap.skillId}`),
      gapsIdentified: loop.gapsIdentified ?? null,
      stoppedReason: loop.stoppedReason ?? null,
    },
    ragSources: (body.ragSources ?? []).map((source) =>
      `${source.docId ?? source.url}:${source.pageNumber ?? ""}:${source.rank ?? ""}`
    ),
    status: response.status ?? null,
    workingMemory: {
      resolvedGaps: (memory.resolvedGaps ?? []).map((gap) => `${gap.type}:${gap.resolvedPhase}`),
      supportedClaims: (memory.supportedClaims ?? []).map((claim) => `${claim.phase}:${claim.text}`),
      unresolvedGaps: (memory.unresolvedGaps ?? []).map((gap) => `${gap.type}:${gap.phase}`),
      unsupportedClaims: (memory.unsupportedClaims ?? []).map((claim) => `${claim.phase}:${claim.text}`),
    },
  };
};

// --- Approval-gated Capability inside the graph ------------------------------

// Workspace-action intent (task.create) on a selected document: V1 runs the
// action alone, with the raw question as its input.
export const APPROVAL_TASK_QUESTION =
  "Create a follow-up task for the vendor renewal notice period";
export const APPROVAL_TASK_CAPABILITY_ID = "task.create";

/**
 * The document answer, its evidence check, and a task.create node that runs
 * only when that answer passed the check, with the verified answer as the
 * task description. The Capability is approval-gated: the graph parks it.
 */
export const createApprovalGatedTaskProposal = () => ({
  nodes: [
    {
      dependsOn: [],
      failurePolicy: "fail_fast",
      inputBindings: { docIds: requestBinding("docIds"), question: requestBinding("question") },
      nodeId: "document",
      skillId: "document_rag",
    },
    {
      dependsOn: ["document"],
      failurePolicy: "fail_fast",
      inputBindings: {
        docIds: requestBinding("docIds"),
        evidence: nodeBinding("document", "evidence"),
        question: requestBinding("question"),
      },
      nodeId: "evidence_check",
      skillId: "document_evidence_check",
    },
    {
      dependsOn: ["document", "evidence_check"],
      failurePolicy: "fail_fast",
      inputBindings: {
        description: nodeBinding("document", "text"),
        title: requestBinding("question"),
      },
      nodeId: "task",
      skillId: `capability:${APPROVAL_TASK_CAPABILITY_ID}`,
      when: { equals: true, nodeId: "evidence_check", output: "passed" },
    },
  ],
});

/**
 * The task node declared before an evidence check it does not depend on: the
 * check must still run while the task waits for approval.
 */
export const createTaskBeforeIndependentCheckProposal = () => {
  const [documentNode, checkNode, taskNode] = createApprovalGatedTaskProposal().nodes;
  const { when, ...unconditionalTask } = taskNode;

  return {
    nodes: [
      documentNode,
      { ...unconditionalTask, dependsOn: ["document"] },
      checkNode,
    ],
  };
};

/**
 * A capability registry whose task.create writes go through `onWrite` (which
 * may record the effect durably, or stop the process right after it) and are
 * counted in `writes`. `version` overrides the Capability version, as after a
 * deploy.
 */
export const createTaskCapabilityRegistry = async ({
  onWrite = async () => {},
  ragService,
  version = null,
  webChatService = createWebChatService(),
} = {}) => {
  const [
    { createDefaultCapabilityRegistry, createCapabilityRegistry },
    { createTaskCreateCapability },
  ] = await Promise.all([
    import("../../rag/capabilities/index.js"),
    import("../../rag/capabilities/actions.js"),
  ]);
  const writes = [];
  const actionTaskService = {
    createActionTask: async (task) => {
      writes.push(task);
      await onWrite(task);
      return { id: task.taskId || `task-${writes.length}`, label: task.label, status: task.status };
    },
  };
  const defaults = createDefaultCapabilityRegistry({ actionTaskService, ragService, webChatService });
  const capabilities = defaults.list().map((capability) => defaults.get(capability.id));
  const registry = version
    ? createCapabilityRegistry(
        capabilities.map((capability) =>
          capability.id === APPROVAL_TASK_CAPABILITY_ID
            ? { ...createTaskCreateCapability({ actionTaskService }), version }
            : capability
        )
      )
    : defaults;

  return { registry, writes };
};
