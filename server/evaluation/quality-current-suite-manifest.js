export const CURRENT_QUALITY_SUITE_MANIFEST_VERSION = "1.13.0";

// The retrieval architecture every synthetic/feedback report must have run on.
// It is checked against `summary.retrieval`, which the runner derives from the
// per-case route evidence rather than from configuration, so a run that fell
// back to another provider or skipped a route cannot pass by declaration.
const deterministicSyntheticRetrieval = {
  hybridEnabled: true,
  hybridFusion: "rrf",
  vectorStoreProvider: "pgvector",
};
export const CURRENT_QUALITY_EVIDENCE_PROFILE = "quality-current";

const deepFreeze = (value) => {
  if (!value || typeof value !== "object") {
    return value;
  }

  for (const nestedValue of Object.values(value)) {
    deepFreeze(nestedValue);
  }

  return Object.isFrozen(value) ? value : Object.freeze(value);
};

const deterministicSyntheticConfig = {
  chunkStrategy: "structured",
  chunkSize: 900,
  chunkOverlap: 180,
  retrievalTopK: 6,
  compareTopKPerDoc: 3,
  maxComparisonSources: 8,
  minRelevanceScore: 0.32,
  nearDuplicateGuardEnabled: true,
  uploadChunkSizeBytes: 180,
};

const syntheticDocuments = {
  handbook_alpha: {
    chunkCount: 2,
    fileName: "handbook-alpha.pdf",
    pageCount: 2,
    pages: [
      "Remote Work Policy\nEmployees may work remotely 2 days per week with manager approval.\nSecurity checklists must be completed before each remote day.",
      "Badge Renewal Window\nRenew access badges every 12 months after the last successful audit.",
    ],
    totalBytes: 1108,
  },
  handbook_beta: {
    chunkCount: 2,
    fileName: "handbook-beta.pdf",
    pageCount: 2,
    pages: [
      "Remote Work Policy\nEmployees may work remotely 2 days per week with manager approval.\nSecurity checklists must be completed before each remote day.",
      "Badge Renewal Window\nRenew access badges every 12 months after the last successful audit.",
    ],
    totalBytes: 1108,
  },
  handbook_gamma: {
    chunkCount: 2,
    fileName: "handbook-gamma.pdf",
    pageCount: 2,
    pages: [
      "Remote Work Policy\nEmployees may work remotely 3 days per week with manager approval.\nSecurity checklists must be completed before each remote day.",
      "Badge Renewal Window\nRenew access badges every 14 months after the last successful audit.",
    ],
    totalBytes: 1108,
  },
  handbook_epsilon: {
    chunkCount: 2,
    fileName: "handbook-epsilon.pdf",
    pageCount: 2,
    pages: [
      "Remote Work Policy\nEmployees may work remotely 2 days per week with manager approval.\nSecurity checklists must be completed before each remote day.",
      "Badge Renewal Window\nRenew access badges every 12 months after the last successful audit.",
    ],
    totalBytes: 1108,
  },
  travel_manual: {
    chunkCount: 2,
    fileName: "travel-manual.pdf",
    pageCount: 2,
    pages: [
      "Travel Reimbursement Policy\nMeals are capped at 40 dollars per day.\nHotel reimbursement requires pre-approval.",
      "Conference Travel\nFlights above 500 dollars require director approval.",
    ],
    totalBytes: 1052,
  },
};

const syntheticAnswerClaims = {
  qa_remote_alpha: [
    {
      text: "Remote Work Policy Employees may work remotely 2 days per week with manager approval",
      sourceRanks: [1],
    },
  ],
  qa_badge_gamma: [
    {
      text: "Badge Renewal Window Renew access badges every 14 months after the last successful audit",
      sourceRanks: [1],
    },
  ],
  compare_remote_no_material_difference_2way: [
    {
      text: "- No evidence-backed material differences were found across the selected documents based on the retrieved evidence",
      sourceRanks: [1, 2],
    },
    {
      text: "- The retrieved evidence aligns on the key facts below",
      sourceRanks: [1, 2],
    },
    {
      text: "- Remote Work Policy",
      sourceRanks: [1],
    },
    {
      text: "- Employees may work remotely 2 days per week with manager approval",
      sourceRanks: [1],
    },
    {
      text: "- Remote Work Policy",
      sourceRanks: [2],
    },
    {
      text: "- Employees may work remotely 2 days per week with manager approval",
      sourceRanks: [2],
    },
    {
      text: "- Remote Work Policy",
      sourceRanks: [1, 2],
    },
    {
      text: "- Employees may work remotely 2 days per week with manager approval",
      sourceRanks: [1, 2],
    },
    {
      text: "- Security checklists must be completed before each remote day",
      sourceRanks: [1, 2],
    },
    {
      text: "- No conflicting values or conditions were detected in the retrieved evidence",
      sourceRanks: [1, 2],
    },
  ],
  compare_remote_no_material_difference_3way: [
    {
      text: "- No evidence-backed material differences were found across the selected documents based on the retrieved evidence",
      sourceRanks: [1, 2, 3],
    },
    {
      text: "- The retrieved evidence aligns on the key facts below",
      sourceRanks: [1, 2, 3],
    },
    {
      text: "- Remote Work Policy",
      sourceRanks: [1],
    },
    {
      text: "- Employees may work remotely 2 days per week with manager approval",
      sourceRanks: [1],
    },
    {
      text: "- Remote Work Policy",
      sourceRanks: [2],
    },
    {
      text: "- Employees may work remotely 2 days per week with manager approval",
      sourceRanks: [2],
    },
    {
      text: "- Remote Work Policy",
      sourceRanks: [3],
    },
    {
      text: "- Employees may work remotely 2 days per week with manager approval",
      sourceRanks: [3],
    },
    {
      text: "- Remote Work Policy",
      sourceRanks: [1, 2, 3],
    },
    {
      text: "- Employees may work remotely 2 days per week with manager approval",
      sourceRanks: [1, 2, 3],
    },
    {
      text: "- Security checklists must be completed before each remote day",
      sourceRanks: [1, 2, 3],
    },
    {
      text: "- No conflicting values or conditions were detected in the retrieved evidence",
      sourceRanks: [1, 2, 3],
    },
  ],
  compare_remote_numeric_conflict: [
    {
      text: "Remote Work Policy Employees may work remotely 2 days per week with manager approval",
      sourceRanks: [1],
    },
    {
      text: "Remote Work Policy Employees may work remotely 3 days per week with manager approval",
      sourceRanks: [2],
    },
  ],
  compare_remote_mixed_duplicate_conflict: [
    {
      text: "Remote Work Policy Employees may work remotely 2 days per week with manager approval",
      sourceRanks: [1],
    },
    {
      text: "Remote Work Policy Employees may work remotely 2 days per week with manager approval",
      sourceRanks: [2],
    },
    {
      text: "Remote Work Policy Employees may work remotely 3 days per week with manager approval",
      sourceRanks: [3],
    },
  ],
};

const syntheticCaseSemantics = {
  qa_remote_alpha: {
    type: "qa",
    docKeys: ["handbook_alpha"],
    question: "What is the remote work policy?",
    shouldAbstain: false,
    expectedEvidence: [
      {
        docKey: "handbook_alpha",
        pages: [1],
      },
    ],
    expectedAnswerIncludes: ["2", "manager approval"],
  },
  qa_badge_gamma: {
    type: "qa",
    docKeys: ["handbook_gamma"],
    question: "What is the badge renewal window?",
    shouldAbstain: false,
    expectedEvidence: [
      {
        docKey: "handbook_gamma",
        pages: [2],
      },
    ],
    expectedAnswerIncludes: ["14", "months"],
  },
  compare_remote_no_material_difference_2way: {
    type: "compare",
    docKeys: ["handbook_alpha", "handbook_beta"],
    question: "Compare the remote work policy in these documents.",
    shouldAbstain: false,
    expectedEvidence: [
      {
        docKey: "handbook_alpha",
        pages: [1],
      },
      {
        docKey: "handbook_beta",
        pages: [1],
      },
    ],
    expectedAnswerIncludes: [
      "No evidence-backed material differences were found",
    ],
  },
  compare_remote_no_material_difference_3way: {
    type: "compare",
    docKeys: [
      "handbook_alpha",
      "handbook_beta",
      "handbook_epsilon",
    ],
    question: "Compare the remote work policy in these documents.",
    shouldAbstain: false,
    expectedEvidence: [
      {
        docKey: "handbook_alpha",
        pages: [1],
      },
      {
        docKey: "handbook_beta",
        pages: [1],
      },
      {
        docKey: "handbook_epsilon",
        pages: [1],
      },
    ],
    expectedAnswerIncludes: [
      "No evidence-backed material differences were found",
    ],
  },
  compare_remote_numeric_conflict: {
    type: "compare",
    docKeys: ["handbook_alpha", "handbook_gamma"],
    question: "Compare the remote work policy in these documents.",
    shouldAbstain: false,
    expectedEvidence: [
      {
        docKey: "handbook_alpha",
        pages: [1],
      },
      {
        docKey: "handbook_gamma",
        pages: [1],
      },
    ],
    expectedAnswerIncludes: ["2", "3"],
  },
  compare_remote_mixed_duplicate_conflict: {
    type: "compare",
    docKeys: [
      "handbook_alpha",
      "handbook_beta",
      "handbook_gamma",
    ],
    question: "Compare the remote work policy in these documents.",
    shouldAbstain: false,
    expectedEvidence: [
      {
        docKey: "handbook_alpha",
        pages: [1],
      },
      {
        docKey: "handbook_beta",
        pages: [1],
      },
      {
        docKey: "handbook_gamma",
        pages: [1],
      },
    ],
    expectedAnswerIncludes: ["2", "3"],
  },
  qa_satellite_stipend_abstain: {
    type: "qa",
    docKeys: ["handbook_alpha"],
    question: "What is the satellite relocation stipend?",
    shouldAbstain: true,
    expectedEvidence: [],
    expectedAnswerIncludes: [],
  },
  compare_remote_single_doc_abstain: {
    type: "compare",
    docKeys: ["handbook_alpha", "travel_manual"],
    question: "Compare the remote work policy in these documents.",
    shouldAbstain: true,
    expectedEvidence: [
      {
        docKey: "handbook_alpha",
        pages: [1],
      },
    ],
    expectedAnswerIncludes: [],
  },
};

const feedbackDocuments = {
  seed_citation_remote_approval_seed_remote_policy: {
    chunkCount: 1,
    fileName: "seed-remote-policy.pdf",
    pageCount: 1,
    pages: [
      "Remote work requires manager approval before the first remote day.",
    ],
    totalBytes: 641,
  },
  seed_incomplete_renewal_window_seed_badge_policy: {
    chunkCount: 1,
    fileName: "seed-badge-policy.pdf",
    pageCount: 1,
    pages: [
      "Badge renewal must happen within 30 days after audit completion.",
    ],
    totalBytes: 639,
  },
};

const feedbackAnswerClaims = {
  feedback_citation_error_seed_citation_remote_approval: [
    {
      text: "Remote work requires manager approval before the first remote day",
      sourceRanks: [1],
    },
  ],
  feedback_incomplete_seed_incomplete_renewal_window: [
    {
      text: "Badge renewal must happen within 30 days after audit completion",
      sourceRanks: [1],
    },
  ],
};

const feedbackCaseSemantics = {
  feedback_citation_error_seed_citation_remote_approval: {
    type: "qa",
    docKeys: [
      "seed_citation_remote_approval_seed_remote_policy",
    ],
    question: "What approval is required before the first remote day?",
    shouldAbstain: false,
    expectedEvidence: [
      {
        docKey: "seed_citation_remote_approval_seed_remote_policy",
        pages: [1],
      },
    ],
    expectedAnswerIncludes: ["manager approval", "first remote day"],
  },
  feedback_incomplete_seed_incomplete_renewal_window: {
    type: "qa",
    docKeys: [
      "seed_incomplete_renewal_window_seed_badge_policy",
    ],
    question: "When must badge renewal happen after audit completion?",
    shouldAbstain: false,
    expectedEvidence: [
      {
        docKey: "seed_incomplete_renewal_window_seed_badge_policy",
        pages: [1],
      },
    ],
    expectedAnswerIncludes: ["30", "days", "audit completion"],
  },
};

const trajectoryChecks = {
  skill_chain_contract_review: [
    "mode_is_skill_chain",
    "expected_chain_order",
    "skill_chain_trace_step",
    "both_custom_skills_ran",
  ],
  document_follow_up_retrieval: [
    "self_check_failed_then_passed",
    "gap_analysis_recorded",
    "follow_up_retrieval_ran",
    "working_memory_resolved_gap",
    "document_budget_bounded",
  ],
  comparison_requires_clarification: [
    "agent_mode_clarification",
    "comparison_reason",
    "clarification_trace",
    "no_tool_execution_before_clarification",
  ],
  custom_skill_access_scope: [
    "risk_review_selected",
    "list_documents_scoped",
    "chat_scoped",
    "selected_doc_count_scoped",
  ],
  budget_exhaustion_clarification: [
    "budget_reason_clarification",
    "budget_limit_trace",
    "no_follow_up_after_budget_exhaustion",
  ],
  capability_approval_resume: [
    "web_skill_selected_before_gate",
    "approval_gate_pauses_execution",
    "approval_preview_is_sanitized",
    "approval_resumes_same_run",
    "capability_step_completed_after_approval",
    "approval_resume_events_recorded",
  ],
  custom_skill_retry: [
    "failed_custom_step_persisted_input",
    "retry_completed_same_run",
    "retry_step_completed",
    "custom_skill_was_retried_once",
  ],
  memory_not_evidence: [
    "memory_not_promoted_to_evidence",
    "memory_claim_failed_support",
    "memory_gap_not_evidence",
  ],
  web_approval_deny: [
    "web_gate_created_without_call",
    "deny_skips_capability",
    "deny_event_recorded",
  ],
  multi_doc_conflict: [
    "compare_skill_selected",
    "conflict_answered",
    "both_documents_cited",
  ],
  planner_fallback: [
    "intent_planner_fell_back",
    "execution_planner_fell_back",
    "fallback_runs_document_rag",
  ],
  privacy_sanitization: [
    "approval_required_for_import",
    "selection_token_not_previewed",
    "safe_preview_fields_remain",
    "risk_flags_visible",
  ],
  agent_goal_lifecycle_completion: [
    "pending_approval_blocks_goal_completion",
    "goal_completion_passes_after_delivery",
    "goal_lifecycle_plan_completed",
    "goal_lifecycle_no_unresolved_gaps",
    "goal_lifecycle_deliverables_created",
    "goal_lifecycle_workflow_contract_recorded",
    "goal_lifecycle_no_pending_approval",
  ],
  skill_graph_guarded_execution: [
    "graph_executed_in_guarded_mode",
    "graph_nodes_are_atomic_skills",
    "dependent_node_bound_upstream_output",
    "node_steps_persist_replay_contract",
    "chat_contract_unchanged_under_graph",
  ],
  skill_graph_shadow_comparison: [
    "shadow_answers_from_v1_chain",
    "shadow_graph_planned_without_execution",
    "shadow_comparison_recorded",
    "shadow_budget_charged_once",
  ],
  skill_graph_illegal_plan_rejected: [
    "illegal_graph_rejected_before_any_node_ran",
    "rejection_reason_codes_recorded",
    "planner_saw_only_redacted_context",
    "fallback_graph_answered_within_scope",
  ],
  skill_graph_bounded_replan: [
    "replan_triggered_by_insufficient_evidence",
    "replan_reran_only_affected_node",
    "replan_is_bounded",
    "replanner_saw_status_only_context",
    "retry_node_bound_upstream_output",
  ],
  // The v3 unfreeze case: deterministic injected proposal and mock providers,
  // runtime-contract evidence only (never real-model planning evidence), with
  // V1 (chain and V2 DAG) measured on the same request.
  unified_graph_evidence_gated_skill_hand_off: [
    "unified_graph_took_request",
    "skill_gated_on_document_evidence",
    "skill_received_verified_document_answer",
    "v1_same_request_runs_skill_first_and_unconditionally",
    "web_to_skill_hand_off_refused",
    "graph_answer_finalized_with_receipt",
    "graph_budget_charged_per_executed_node",
  ],
};

const plannerChecks = {
  planner_inventory: [
    "llm_planner_selected",
    "inventory_mode",
    "selected_inventory_skill",
  ],
  planner_document_rag: [
    "llm_planner_selected_document_rag",
    "llm_planner_kept_conditional_web_fallback",
    "document_trace_ran",
    "web_fallback_not_executed_when_document_sufficient",
    "no_planner_fallback",
  ],
  planner_web_search: [
    "llm_planner_selected_web_search",
    "web_action_boundary_gate",
    "selected_web_skill",
  ],
  planner_custom_chain: [
    "llm_planner_selected_custom_skills",
    "custom_chain_order",
    "custom_skill_trace",
  ],
  planner_dynamic_skill_graph: [
    "compare_only_intent_selected",
    "real_dag_planner_selected",
    "dag_composed_compare_then_risk",
    "dag_selected_skills_observed",
    "dag_kept_document_scope",
  ],
  planner_invalid_fallback: [
    "fallback_to_deterministic",
    "fallback_reason_records_validator_error",
    "fallback_still_executes",
  ],
};

const recoveryChecks = {
  startup_recovery_summary: [
    "recoverable_runs_recorded",
    "manual_recovery_required",
    "auto_recovery_attempted",
    "auto_replay_success_rate_clean",
    "auto_replay_failures_zero",
  ],
  primary_step_lifecycle: [
    "primary_step_started",
    "primary_step_completed",
    "primary_step_failed",
  ],
  manual_recovery_actions: [
    "manual_actions_recorded",
    "resume_after_partial_step_recorded",
    "retry_after_failed_step_recorded",
    "cancel_action_recorded",
    "manual_action_failures_zero",
  ],
  step_replay_actions: [
    "retry_step_recorded",
    "resume_step_recorded",
    "step_replay_failures_zero",
  ],
  agent_task_recovery: [
    "agent_task_recovery_recorded",
    "agent_task_resume_failures_zero",
  ],
  planner_fallback_signal: ["planner_fallbacks_zero"],
  skill_graph_signal: [
    "graph_reused_nodes_not_rerun",
    "graph_replan_applied_recorded",
    "graph_fallback_after_execution_zero",
  ],
  skill_graph_startup_resume: [
    "graph_startup_resume_production_observed",
    "graph_startup_resume_claim_once",
    "graph_startup_auto_recovery_completed",
    "graph_startup_same_run_completed",
    "graph_startup_completed_node_not_rerun",
    "graph_startup_pending_node_once",
    "graph_startup_no_second_claim_or_partial_fallback",
  ],
};

const skillIds = (...ids) => ids.map((skillId) => ({ skillId }));

const completedSkillIds = (...ids) =>
  ids.map((skillId) => ({
    skillId,
    status: "completed",
  }));

const trajectoryResponseProjection = ({
  agentMode,
  agentSkills = [],
  budget = undefined,
  clarification = undefined,
  executionLoop = undefined,
  observed = undefined,
  selectedSkills = [],
  skillChain = [],
  telemetry = {
    chatCallCount: 0,
    listDocumentCallCount: 0,
  },
  traceTypes = [],
  workingMemory = undefined,
}) => ({
  agentMode,
  agentSkills,
  ...(budget !== undefined ? { budget } : {}),
  ...(clarification !== undefined ? { clarification } : {}),
  ...(executionLoop !== undefined ? { executionLoop } : {}),
  ...(observed !== undefined ? { observed } : {}),
  selectedSkills,
  skillChain,
  status: 200,
  telemetry,
  traceTypes,
  ...(workingMemory !== undefined ? { workingMemory } : {}),
});

const trajectoryResponseProjections = {
  skill_chain_contract_review: trajectoryResponseProjection({
    agentMode: "skill_chain",
    agentSkills: completedSkillIds(
      "summarize_contract",
      "risk_review"
    ),
    budget: {
      used: {
        customSkillCalls: 2,
        documentRagCalls: 0,
        webSearchCalls: 0,
      },
    },
    executionLoop: {
      followUpsRun: 0,
      gapsIdentified: 0,
      stoppedReason: "not_needed",
    },
    selectedSkills: skillIds("summarize_contract", "risk_review"),
    skillChain: skillIds("summarize_contract", "risk_review"),
    telemetry: {
      chatCallCount: 2,
      listDocumentCallCount: 2,
    },
    traceTypes: [
      "plan",
      "query_planner",
      "skill_chain",
      "custom_skill",
      "custom_skill",
      "synthesis",
      "self_check",
      "answer_finalizer",
    ],
  }),
  document_follow_up_retrieval: trajectoryResponseProjection({
    agentMode: "document",
    agentSkills: completedSkillIds("document_rag"),
    budget: {
      limits: {
        maxDocumentRagCalls: 2,
      },
      used: {
        documentRagCalls: 2,
      },
    },
    executionLoop: {
      followUpsRun: 1,
      gapsIdentified: 2,
      stoppedReason: "follow_up_resolved",
    },
    observed: {
      documentAttempts: 2,
      documentBudgetUsed: 2,
      documentRunPhases: ["primary", "follow_up"],
      gapTypes: ["unsupported_claim", "unsupported_claim"],
      selfCheckStatuses: ["failed", "completed"],
    },
    selectedSkills: skillIds("document_rag"),
    telemetry: {
      chatCallCount: 2,
      listDocumentCallCount: 0,
    },
    traceTypes: [
      "plan",
      "query_planner",
      "document_rag",
      "self_check",
      "gap_analysis",
      "follow_up_retrieval",
      "self_check",
      "synthesis",
      "answer_finalizer",
    ],
    workingMemory: {
      resolvedGapCount: 2,
      unresolvedGapCount: 0,
      unsupportedClaimCount: 2,
    },
  }),
  comparison_requires_clarification: trajectoryResponseProjection({
    agentMode: "clarification",
    clarification: {
      needed: true,
      reason: "comparison_requires_multiple_documents",
    },
    selectedSkills: skillIds("compare_documents"),
    traceTypes: ["plan", "clarification_gate"],
  }),
  custom_skill_access_scope: trajectoryResponseProjection({
    agentMode: "risk_review",
    agentSkills: completedSkillIds("risk_review"),
    observed: {
      chatScopes: [
        {
          userId: "trajectory-user",
          workspaceId: "trajectory-workspace",
        },
      ],
      listDocumentScopes: [
        {
          userId: "trajectory-user",
          workspaceId: "trajectory-workspace",
        },
      ],
      selectedDocumentCount: 1,
    },
    selectedSkills: skillIds("risk_review"),
    telemetry: {
      chatCallCount: 1,
      listDocumentCallCount: 1,
    },
    traceTypes: [
      "plan",
      "query_planner",
      "custom_skill",
      "synthesis",
      "self_check",
      "answer_finalizer",
    ],
  }),
  budget_exhaustion_clarification: trajectoryResponseProjection({
    agentMode: "clarification",
    agentSkills: completedSkillIds("document_rag"),
    budget: {
      limits: {
        maxDocumentRagCalls: 1,
      },
      used: {
        documentRagCalls: 1,
      },
    },
    clarification: {
      needed: true,
      reason: "document_follow_up_budget_exhausted",
    },
    executionLoop: {
      followUpsRun: 0,
      gapsIdentified: 2,
      stoppedReason: "budget_exhausted",
    },
    observed: {
      documentAttempts: 1,
      documentBudgetUsed: 1,
    },
    selectedSkills: skillIds("document_rag"),
    telemetry: {
      chatCallCount: 1,
      listDocumentCallCount: 0,
    },
    traceTypes: [
      "plan",
      "query_planner",
      "document_rag",
      "self_check",
      "gap_analysis",
      "budget_limit",
      "clarification_gate",
    ],
  }),
  capability_approval_resume: trajectoryResponseProjection({
    agentMode: "web",
    clarification: {
      needed: false,
      reason: null,
    },
    observed: {
      approvalGate: {
        capabilityId: "web.search",
        inputPreviewKeys: ["question"],
        inputQuestion: "Search the web for the current launch date",
        riskFlags: ["external_call"],
      },
      capabilityStep: {
        approvalGateMatches: true,
        capabilityId: "web.search",
        decision: "approve",
        status: "completed",
      },
      eventTypes: [
        "run_created",
        "run_prepared",
        "execution_planned",
        "step_started",
        "step_paused",
        "approval_gate_created",
        "approval_gate_approved",
        "step_started",
        "step_completed",
        "run_completed",
      ],
      pending: {
        agentMode: "clarification",
        clarificationReason: "capability_approval_required",
        runStatus: "waiting_for_user",
        webSearchCalls: 0,
      },
      resumed: {
        agentMode: "web",
        responseStatus: "completed",
        runStatus: "completed",
        sameRun: true,
        webSearchCalls: 1,
      },
      selectedSkillIds: ["web_search"],
    },
    traceTypes: [
      "plan",
      "capability_approval_gate",
      "web_search",
      "capability_call",
    ],
  }),
  custom_skill_retry: trajectoryResponseProjection({
    agentMode: "risk_review",
    agentSkills: completedSkillIds("risk_review"),
    observed: {
      chatCallCount: 2,
      failedStep: {
        errorMessage: "Transient custom skill failure.",
        hasQuestion: true,
        skillId: "risk_review",
        status: "failed",
      },
      retry: {
        attempt: 2,
        citationCount: 1,
        retryError: null,
        retryOfOriginalStep: true,
        runStatus: "completed",
        sameRun: true,
        stepStatus: "completed",
      },
    },
    selectedSkills: skillIds("risk_review"),
    telemetry: {
      chatCallCount: 2,
      listDocumentCallCount: 2,
    },
    traceTypes: [
      "plan",
      "query_planner",
      "custom_skill",
      "synthesis",
      "custom_skill",
    ],
  }),
  memory_not_evidence: trajectoryResponseProjection({
    agentMode: "clarification",
    agentSkills: completedSkillIds("document_rag"),
    clarification: {
      needed: true,
      reason: "document_follow_up_budget_exhausted",
    },
    executionLoop: {
      gapsIdentified: 2,
      stoppedReason: "budget_exhausted",
    },
    observed: {
      clarificationReason: "document_follow_up_budget_exhausted",
      ragAbstained: true,
      ragMemoryApplied: false,
      selfCheckStatus: "failed",
      sourceDocIds: [],
      traceTypes: [
        "plan",
        "query_planner",
        "document_rag",
        "self_check",
        "gap_analysis",
        "budget_limit",
        "clarification_gate",
      ],
      unsupportedClaimTexts: [
        "Remote work requires manager approval",
        "Alice prefers 20 remote days",
      ],
    },
    selectedSkills: skillIds("document_rag"),
    telemetry: {
      chatCallCount: 1,
      listDocumentCallCount: 0,
    },
    traceTypes: [
      "plan",
      "query_planner",
      "document_rag",
      "self_check",
      "gap_analysis",
      "budget_limit",
      "clarification_gate",
    ],
    workingMemory: {
      unresolvedGapCount: 2,
      unsupportedClaimCount: 2,
    },
  }),
  web_approval_deny: trajectoryResponseProjection({
    agentMode: "clarification",
    budget: {
      used: {
        webSearchCalls: 1,
      },
    },
    clarification: {
      needed: true,
      reason: "capability_approval_required",
    },
    observed: {
      denied: {
        approvalDenied: true,
        runStatus: "completed",
        skippedCapabilityStatus: "skipped",
        skippedPrimaryStatus: "skipped",
        webSearchCalls: 0,
      },
      eventTypes: [
        "run_created",
        "run_prepared",
        "execution_planned",
        "step_started",
        "step_paused",
        "approval_gate_created",
        "approval_gate_denied",
      ],
      pending: {
        clarificationReason: "capability_approval_required",
        runStatus: "waiting_for_user",
        webSearchCalls: 0,
      },
    },
    selectedSkills: skillIds("web_search"),
    traceTypes: ["plan", "capability_approval_gate"],
  }),
  multi_doc_conflict: trajectoryResponseProjection({
    agentMode: "compare_documents",
    agentSkills: completedSkillIds("compare_documents"),
    observed: {
      agentMode: "compare_documents",
      answerHasConflict: true,
      citationDocIds: ["policy-a", "policy-b"],
      selectedDocumentCount: 2,
      selectedSkillIds: ["compare_documents"],
    },
    selectedSkills: skillIds("compare_documents"),
    telemetry: {
      chatCallCount: 1,
      listDocumentCallCount: 1,
    },
    traceTypes: [
      "plan",
      "query_planner",
      "custom_skill",
      "synthesis",
      "self_check",
      "answer_finalizer",
    ],
  }),
  planner_fallback: trajectoryResponseProjection({
    agentMode: "document",
    agentSkills: completedSkillIds("document_rag"),
    observed: {
      executionPlanner: {
        fallback: true,
        fallbackReason:
          "Invalid AgentRAG execution plan: unknown execution step shell_exec.",
        requestedPlannerId: "unsafe_execution_adapter",
        selectedPlannerId: "deterministic",
        status: "fallback",
        stepIds: [
          "arxiv_import",
          "workspace_action",
          "research_brief",
          "inventory",
          "document_discovery",
          "document_rag",
          "web_search",
        ],
      },
      intentPlanner: {
        fallback: true,
        fallbackReason: "Invalid AgentRAG intent selection: shell.exec.",
        requestedPlannerId: "unsafe_intent_adapter",
        selectedIntentId: "document",
        selectedMode: "document",
        selectedPlannerId: "deterministic",
        status: "fallback",
      },
      selectedSkillIds: ["document_rag"],
      traceTypes: [
        "plan",
        "query_planner",
        "document_rag",
        "self_check",
        "synthesis",
        "answer_finalizer",
      ],
    },
    selectedSkills: skillIds("document_rag"),
    telemetry: {
      chatCallCount: 1,
      listDocumentCallCount: 0,
    },
    traceTypes: [
      "plan",
      "query_planner",
      "document_rag",
      "self_check",
      "synthesis",
      "answer_finalizer",
    ],
  }),
  privacy_sanitization: trajectoryResponseProjection({
    agentMode: "capability_privacy",
    observed: {
      approvalCapabilityId: "recommendation.import_selected",
      decision: "needs_approval",
      preview: {
        docId: "doc-1",
        provider: "arxiv",
        selectedIds: ["2401.00001v1"],
      },
      previewKeys: ["docId", "provider", "selectedIds"],
      riskFlags: [
        "external_call",
        "writes_workspace",
        "stores_result",
      ],
      selectionTokenPresent: false,
    },
  }),
  agent_goal_lifecycle_completion: trajectoryResponseProjection({
    agentMode: "agent_goal",
    observed: {
      completed: {
        completionChecks: [
          {
            id: "terminal_status_completed",
            passed: true,
          },
          {
            id: "plan_steps_completed",
            passed: true,
          },
          {
            id: "evidence_gaps_resolved",
            passed: true,
          },
          {
            id: "deliverables_created",
            passed: true,
          },
          {
            id: "no_pending_user_action",
            passed: true,
          },
          {
            id: "research_phases_completed",
            passed: true,
          },
          {
            id: "workflow_lifecycle_recorded",
            passed: true,
          },
        ],
        completionStatus: "completed",
        requiredUserAction: "",
        taskStatus: "completed",
      },
      deliverables: {
        capabilityIds: [
          "report.export",
          "summary.create",
          "task.create",
        ],
        planned: 3,
        storedArtifactCount: 2,
      },
      pending: {
        completionStatus: "pending",
        noPendingUserActionPassed: false,
        requiredUserAction: "approve_deliverables",
        taskStatus: "waiting_for_user",
      },
      workflow: {
        completedCount: 6,
        completionChecks: [
          "terminal_status_completed",
          "plan_steps_completed",
          "evidence_gaps_resolved",
          "deliverables_created",
          "no_pending_user_action",
          "research_phases_completed",
        ],
        currentPhaseId: null,
        id: "research_dossier",
        reportExportPlanned: true,
        validationPassed: true,
        version: "1.0.0",
      },
    },
  }),
  skill_graph_guarded_execution: trajectoryResponseProjection({
    agentMode: "skill_chain",
    agentSkills: completedSkillIds("summarize_contract", "risk_review"),
    budget: {
      used: {
        customSkillCalls: 2,
        documentRagCalls: 0,
        webSearchCalls: 0,
      },
    },
    executionLoop: {
      followUpsRun: 0,
      gapsIdentified: 0,
      stoppedReason: "not_needed",
    },
    observed: {
      eventCount: 1,
      graph: {
        executed: true,
        fallback: null,
        mode: "guarded",
        nodeIds: [
          "summarize_contract",
          "risk_review",
        ],
        plannerFallback: false,
        requestedPlannerId: "deterministic_dag",
        selectedPlannerId: "deterministic_dag",
        status: "completed",
      },
      graphFieldsInResponse: [],
      nodeRuns: [
        {
          citationCount: 1,
          dependsOn: [],
          nodeId: "summarize_contract",
          status: "completed",
          stepId: "custom_skill:summarize_contract",
        },
        {
          citationCount: 1,
          dependsOn: [
            "summarize_contract",
          ],
          nodeId: "risk_review",
          status: "completed",
          stepId: "custom_skill:risk_review",
        },
      ],
      questions: [
        {
          chained: false,
          typedUpstream: false,
        },
        {
          chained: false,
          typedUpstream: true,
        },
      ],
      replayContracts: [
        {
          effects: "read_only",
          hasPriorFindings: false,
          idempotency: "read_only_rag",
          stepId: "custom_skill:summarize_contract",
        },
        {
          effects: "read_only",
          hasPriorFindings: true,
          idempotency: "read_only_rag",
          stepId: "custom_skill:risk_review",
        },
      ],
      traceStepIds: [
        "custom_skill:summarize_contract",
        "custom_skill:risk_review",
      ],
    },
    selectedSkills: skillIds("summarize_contract", "risk_review"),
    skillChain: skillIds("summarize_contract", "risk_review"),
    telemetry: {
      chatCallCount: 2,
      listDocumentCallCount: 2,
    },
    traceTypes: [
      "plan",
      "query_planner",
      "skill_chain",
      "custom_skill",
      "custom_skill",
      "synthesis",
      "self_check",
      "answer_finalizer",
    ],
  }),
  skill_graph_shadow_comparison: trajectoryResponseProjection({
    agentMode: "skill_chain",
    agentSkills: completedSkillIds("summarize_contract", "risk_review"),
    budget: {
      used: {
        customSkillCalls: 2,
        documentRagCalls: 0,
        webSearchCalls: 0,
      },
    },
    executionLoop: {
      followUpsRun: 0,
      gapsIdentified: 0,
      stoppedReason: "not_needed",
    },
    observed: {
      eventCount: 1,
      graph: {
        executed: false,
        fallback: null,
        mode: "shadow",
        nodeIds: [
          "summarize_contract",
          "risk_review",
        ],
        plannerFallback: false,
        requestedPlannerId: "deterministic_dag",
        selectedPlannerId: "deterministic_dag",
        status: "selected",
      },
      questions: [
        {
          chained: false,
          typedUpstream: false,
        },
        {
          chained: true,
          typedUpstream: false,
        },
      ],
      replayContracts: [
        {
          effects: "read_only",
          hasPriorFindings: false,
          idempotency: "read_only_rag",
          stepId: "custom_skill:summarize_contract",
        },
        {
          effects: "read_only",
          hasPriorFindings: false,
          idempotency: "read_only_rag",
          stepId: "custom_skill:risk_review",
        },
      ],
      shadow: {
        diverged: false,
        error: null,
        nodeRunCount: 0,
        replanCount: 0,
        requestedPlannerId: "deterministic_dag",
      },
      traceStepIds: [
        "custom_skill:summarize_contract",
        "custom_skill:risk_review",
      ],
    },
    selectedSkills: skillIds("summarize_contract", "risk_review"),
    skillChain: skillIds("summarize_contract", "risk_review"),
    telemetry: {
      chatCallCount: 2,
      listDocumentCallCount: 2,
    },
    traceTypes: [
      "plan",
      "query_planner",
      "skill_chain",
      "custom_skill",
      "custom_skill",
      "synthesis",
      "self_check",
      "answer_finalizer",
    ],
  }),
  skill_graph_illegal_plan_rejected: trajectoryResponseProjection({
    agentMode: "skill_chain",
    agentSkills: completedSkillIds("summarize_contract", "risk_review"),
    budget: {
      used: {
        customSkillCalls: 2,
        documentRagCalls: 0,
        webSearchCalls: 0,
      },
    },
    executionLoop: {
      followUpsRun: 0,
      gapsIdentified: 0,
      stoppedReason: "not_needed",
    },
    observed: {
      chatDocIds: [
        [
          "contract-1",
        ],
        [
          "contract-1",
        ],
      ],
      eventCount: 1,
      forgedNodeIdsRan: [],
      graph: {
        executed: true,
        fallback: null,
        mode: "guarded",
        nodeIds: [
          "summarize_contract",
          "risk_review",
        ],
        plannerFallback: true,
        requestedPlannerId: "llm_dag",
        selectedPlannerId: "deterministic_dag",
        status: "completed",
      },
      nodeRuns: [
        {
          citationCount: 1,
          dependsOn: [],
          nodeId: "summarize_contract",
          status: "completed",
          stepId: "custom_skill:summarize_contract",
        },
        {
          citationCount: 1,
          dependsOn: [
            "summarize_contract",
          ],
          nodeId: "risk_review",
          status: "completed",
          stepId: "custom_skill:risk_review",
        },
      ],
      plannerView: {
        authorizedDocIds: [
          "contract-1",
        ],
        callCount: 1,
        capabilityIds: [
          "extract_timeline",
          "risk_review",
          "summarize_contract",
          "compare_documents",
        ],
        keys: [
          "authorizedDocIds",
          "capabilities",
          "documentCount",
          "goal",
          "intentPlan",
          "limits",
          "taskMemoryPlanningContext",
        ],
        leaks: false,
      },
      reasonCodes: [
        "forged_approval",
        "out_of_scope_document",
        "unregistered_capability",
      ],
    },
    selectedSkills: skillIds("summarize_contract", "risk_review"),
    skillChain: skillIds("summarize_contract", "risk_review"),
    telemetry: {
      chatCallCount: 2,
      listDocumentCallCount: 2,
    },
    traceTypes: [
      "plan",
      "query_planner",
      "skill_chain",
      "custom_skill",
      "custom_skill",
      "synthesis",
      "self_check",
      "answer_finalizer",
    ],
  }),
  skill_graph_bounded_replan: trajectoryResponseProjection({
    agentMode: "skill_chain",
    agentSkills: completedSkillIds("summarize_contract", "risk_review"),
    budget: {
      used: {
        customSkillCalls: 3,
        documentRagCalls: 0,
        webSearchCalls: 0,
      },
    },
    executionLoop: {
      followUpsRun: 0,
      gapsIdentified: 0,
      stoppedReason: "not_needed",
    },
    observed: {
      budgetUsed: 3,
      eventCount: 1,
      graph: {
        executed: true,
        fallback: null,
        mode: "guarded",
        nodeIds: [
          "summarize_contract",
          "risk_review",
          "risk_review_retry",
        ],
        plannerFallback: false,
        requestedPlannerId: "deterministic_dag",
        selectedPlannerId: "deterministic_dag",
        status: "completed",
      },
      nodeRuns: [
        {
          citationCount: 1,
          dependsOn: [],
          nodeId: "summarize_contract",
          status: "reused",
          stepId: "custom_skill:summarize_contract",
        },
        {
          citationCount: 0,
          dependsOn: [
            "summarize_contract",
          ],
          nodeId: "risk_review",
          status: "reused",
          stepId: "custom_skill:risk_review",
        },
        {
          citationCount: 1,
          dependsOn: [
            "summarize_contract",
          ],
          nodeId: "risk_review_retry",
          status: "completed",
          stepId: "custom_skill:risk_review_retry",
        },
      ],
      questions: [
        {
          chained: false,
          typedUpstream: false,
        },
        {
          chained: false,
          typedUpstream: true,
        },
        {
          chained: false,
          typedUpstream: true,
        },
      ],
      replannerView: {
        authorizedDocIds: [
          "contract-1",
        ],
        callCount: 1,
        keys: [
          "authorizedDocIds",
          "capabilities",
          "goal",
          "graph",
          "limits",
          "nodeRuns",
          "trigger",
        ],
        leaks: false,
        nodeRunKeys: [
          [
            "abstained",
            "citationCount",
            "nodeId",
            "reason",
            "skillId",
            "status",
          ],
          [
            "abstained",
            "citationCount",
            "nodeId",
            "reason",
            "skillId",
            "status",
          ],
        ],
        trigger: "insufficient_evidence",
      },
      replans: [
        {
          decision: "applied",
          nodeIds: [
            "summarize_contract",
            "risk_review",
            "risk_review_retry",
          ],
          reasonCode: null,
          replanCount: 1,
          trigger: "insufficient_evidence",
        },
        {
          decision: "abstain",
          nodeIds: [],
          reasonCode: "replan_limit_reached",
          replanCount: 1,
          trigger: "insufficient_evidence",
        },
      ],
      replayContracts: [
        {
          effects: "read_only",
          hasPriorFindings: false,
          idempotency: "read_only_rag",
          stepId: "custom_skill:summarize_contract",
        },
        {
          effects: "read_only",
          hasPriorFindings: true,
          idempotency: "read_only_rag",
          stepId: "custom_skill:risk_review",
        },
        {
          effects: "read_only",
          hasPriorFindings: true,
          idempotency: "read_only_rag",
          stepId: "custom_skill:risk_review_retry",
        },
      ],
      traceStepIds: [
        "custom_skill:summarize_contract",
        "custom_skill:risk_review",
        "custom_skill:risk_review_retry",
      ],
    },
    selectedSkills: skillIds("summarize_contract", "risk_review"),
    skillChain: skillIds("summarize_contract", "risk_review"),
    telemetry: {
      chatCallCount: 3,
      listDocumentCallCount: 3,
    },
    traceTypes: [
      "plan",
      "query_planner",
      "skill_chain",
      "custom_skill",
      "custom_skill",
      "custom_skill",
      "synthesis",
      "self_check",
      "answer_finalizer",
    ],
  }),
  unified_graph_evidence_gated_skill_hand_off: trajectoryResponseProjection({
    agentMode: "risk_review",
    agentSkills: completedSkillIds(
      "document_rag",
      "document_evidence_check",
      "risk_review"
    ),
    budget: {
      used: {
        customSkillCalls: 1,
        documentRagCalls: 1,
        webSearchCalls: 0,
      },
    },
    executionLoop: {
      followUpsRun: 0,
      gapsIdentified: 0,
      stoppedReason: "not_needed",
    },
    observed: {
      answer: {
        agentMode: "risk_review",
        includesDocumentAnswer: true,
        includesRiskFinding: true,
        sourceKinds: ["document", "document"],
      },
      checkpoint: {
        finalizationMatchesResponse: true,
        graphVersion: "v3",
        hasFinalizationReceipt: true,
        phase: "completed",
        version: "v2",
      },
      externalHandOff: {
        graphNodeStepCount: 0,
        plannedEvents: [
          {
            errorCodes: ["external_output_hand_off"],
            fallback: "v1",
            mode: "guarded",
            nodeIds: ["document", "evidence_check", "web", "risk"],
            requestedPlannerId: "trajectory_web_hand_off_proposal",
            status: "rejected",
          },
        ],
        unifiedCheckpointWritten: false,
        v1OuterPlanRan: true,
        webTextReachedAnySkill: false,
      },
      gating: {
        insufficient: {
          agentMode: "clarification",
          checkPassed: false,
          clarificationNeeded: true,
          customSkillCalls: 0,
          documentRagCalls: 1,
          nodeRuns: [
            {
              dependsOn: [],
              nodeId: "document",
              reason: null,
              skillId: "document_rag",
              status: "completed",
            },
            {
              dependsOn: ["document"],
              nodeId: "evidence_check",
              reason: null,
              skillId: "document_evidence_check",
              status: "completed",
            },
            {
              dependsOn: ["document", "evidence_check"],
              nodeId: "risk",
              reason: "condition_not_met",
              skillId: "risk_review",
              status: "skipped",
            },
          ],
          riskCallCount: 0,
        },
        sufficient: {
          checkPassed: true,
          customSkillCalls: 1,
          documentRagCalls: 1,
          riskStatus: "completed",
        },
      },
      handOff: {
        priorFindingsIsDocumentAnswer: true,
        riskDependsOn: ["document", "evidence_check"],
        riskQuestionCarriesDocumentAnswer: true,
        riskStartedAfterCheckCompleted: true,
      },
      nodeRuns: [
        {
          dependsOn: [],
          nodeId: "document",
          reason: null,
          skillId: "document_rag",
          status: "completed",
        },
        {
          dependsOn: ["document"],
          nodeId: "evidence_check",
          reason: null,
          skillId: "document_evidence_check",
          status: "completed",
        },
        {
          dependsOn: ["document", "evidence_check"],
          nodeId: "risk",
          reason: null,
          skillId: "risk_review",
          status: "completed",
        },
      ],
      path: {
        executedEventCount: 1,
        executedStatus: "completed",
        outerPlanEventCount: 0,
        plannedEvents: [
          {
            errorCodes: [],
            fallback: null,
            mode: "guarded",
            nodeIds: ["document", "evidence_check", "risk"],
            requestedPlannerId: "trajectory_evidence_gated_skill_proposal",
            status: "selected",
          },
        ],
        runStatus: "completed",
      },
      planner: {
        callCount: 1,
        evidenceKind: "deterministic_injected_proposal",
        graphVersion: "v3",
        requestedPlannerId: "trajectory_evidence_gated_skill_proposal",
      },
      v1Runs: [
        {
          customSkillCalls: 1,
          customStageBeforeDocumentRag: true,
          documentRagCalls: 0,
          documentSufficient: true,
          riskCallCount: 1,
          riskCallsWithUpstreamSection: 0,
          skillGraphRollout: "off",
          unifiedEventCount: 0,
        },
        {
          customSkillCalls: 1,
          customStageBeforeDocumentRag: true,
          documentRagCalls: 0,
          documentSufficient: false,
          riskCallCount: 1,
          riskCallsWithUpstreamSection: 0,
          skillGraphRollout: "off",
          unifiedEventCount: 0,
        },
        {
          customSkillCalls: 1,
          customStageBeforeDocumentRag: true,
          documentRagCalls: 0,
          documentSufficient: true,
          riskCallCount: 1,
          riskCallsWithUpstreamSection: 0,
          skillGraphRollout: "guarded",
          unifiedEventCount: 0,
        },
        {
          customSkillCalls: 1,
          customStageBeforeDocumentRag: true,
          documentRagCalls: 0,
          documentSufficient: false,
          riskCallCount: 1,
          riskCallsWithUpstreamSection: 0,
          skillGraphRollout: "guarded",
          unifiedEventCount: 0,
        },
      ],
    },
    selectedSkills: skillIds(
      "risk_review",
      "document_rag",
      "document_evidence_check"
    ),
    skillChain: [],
    telemetry: {
      chatCallCount: 2,
      listDocumentCallCount: 3,
    },
    traceTypes: [
      "plan",
      "query_planner",
      "graph_node",
      "graph_node",
      "graph_node",
      "self_check",
      "synthesis",
      "self_check",
      "answer_finalizer",
    ],
  }),
};

const plannerResponseProjection = ({
  agentMode,
  fallback = false,
  fallbackReason = null,
  intentId,
  plannerStatus = fallback ? "fallback" : "selected",
  selectedPlannerId = fallback ? "deterministic" : "llm",
  selectedSkills = [],
  skillGraph = undefined,
  skillChain = [],
  stepIds,
  telemetry,
  traceTypes,
}) => ({
  agentMode,
  intentPlanner: {
    fallback: false,
    fallbackReason: null,
    requestedPlannerId: "deterministic",
    selectedIntentId: intentId,
    selectedMode: agentMode === "clarification" ? "web" : agentMode,
    selectedPlannerId: "deterministic",
    status: "selected",
  },
  planner: {
    fallback,
    fallbackReason,
    requestedPlannerId: "llm",
    selectedPlannerId,
    status: plannerStatus,
    stepIds,
  },
  selectedSkills: skillIds(...selectedSkills),
  ...(skillGraph === undefined ? {} : { skillGraph }),
  skillChain: skillIds(...skillChain),
  status: 200,
  telemetry,
  traceTypes,
});

const plannerResponseProjections = {
  planner_inventory: plannerResponseProjection({
    agentMode: "inventory",
    intentId: "inventory",
    selectedSkills: ["inventory"],
    stepIds: ["inventory"],
    telemetry: {
      chatCallCount: 0,
      listDocumentCallCount: 1,
    },
    traceTypes: ["plan", "inventory", "synthesis"],
  }),
  planner_document_rag: plannerResponseProjection({
    agentMode: "document",
    intentId: "document",
    selectedSkills: ["document_rag"],
    stepIds: ["document_rag", "web_search"],
    telemetry: {
      chatCallCount: 1,
      listDocumentCallCount: 0,
    },
    traceTypes: [
      "plan",
      "query_planner",
      "document_rag",
      "self_check",
      "synthesis",
      "answer_finalizer",
    ],
  }),
  planner_web_search: plannerResponseProjection({
    agentMode: "clarification",
    intentId: "web",
    selectedSkills: ["web_search"],
    stepIds: ["web_search"],
    telemetry: {
      chatCallCount: 0,
      listDocumentCallCount: 0,
    },
    traceTypes: ["plan", "capability_approval_gate"],
  }),
  planner_custom_chain: plannerResponseProjection({
    agentMode: "skill_chain",
    intentId: "skill_chain_contract_review",
    selectedSkills: ["summarize_contract", "risk_review"],
    skillChain: ["summarize_contract", "risk_review"],
    stepIds: ["custom_skills"],
    telemetry: {
      chatCallCount: 2,
      listDocumentCallCount: 2,
    },
    traceTypes: [
      "plan",
      "query_planner",
      "skill_chain",
      "custom_skill",
      "custom_skill",
      "synthesis",
      "self_check",
      "gap_analysis",
      "answer_finalizer",
    ],
  }),
  planner_dynamic_skill_graph: plannerResponseProjection({
    agentMode: "compare_documents",
    intentId: "compare_documents",
    selectedSkills: ["compare_documents", "risk_review"],
    skillGraph: {
      errorCodes: [],
      executed: true,
      fallback: null,
      mode: "guarded",
      nodeStatuses: ["completed", "completed"],
      nodeSkills: ["compare_documents", "risk_review"],
      plannerFallback: false,
      plannerFallbackReason: null,
      selectedPlannerId: "llm_dag",
      status: "completed",
      riskDependsOnCompare: true,
    },
    stepIds: ["custom_skills"],
    telemetry: {
      chatCallCount: 2,
      listDocumentCallCount: 2,
    },
    traceTypes: [
      "plan",
      "query_planner",
      "custom_skill",
      "custom_skill",
      "synthesis",
      "self_check",
      "gap_analysis",
      "answer_finalizer",
    ],
  }),
  planner_invalid_fallback: plannerResponseProjection({
    agentMode: "inventory",
    fallback: true,
    fallbackReason:
      "Invalid AgentRAG execution plan: unknown execution step shell_tool.",
    intentId: "inventory",
    selectedPlannerId: "deterministic",
    selectedSkills: ["inventory"],
    stepIds: [
      "arxiv_import",
      "workspace_action",
      "research_brief",
      "inventory",
      "document_discovery",
      "document_rag",
      "web_search",
    ],
    telemetry: {
      chatCallCount: 0,
      listDocumentCallCount: 1,
    },
    traceTypes: ["plan", "inventory", "synthesis"],
  }),
};

export const CURRENT_QUALITY_SUITE_MANIFEST = deepFreeze({
  "quality-synthetic": Object.freeze({
    kind: "synthetic",
    caseSource: "corpus",
    enforceRequiredAnswerClaims: false,
    expectedAbstainAnswers: Object.freeze({
      qa_satellite_stipend_abstain:
        "I have not found reliable evidence that directly answers satellite relocation stipend.",
      compare_remote_single_doc_abstain:
        "I only found strong evidence in 1 of the 2 selected documents, so the comparison would be unreliable.",
    }),
    requiredAnswerClaims: Object.freeze(syntheticAnswerClaims),
    requiredCaseSemantics: Object.freeze(syntheticCaseSemantics),
    requiredConfig: Object.freeze(deterministicSyntheticConfig),
    requiredRetrieval: Object.freeze(deterministicSyntheticRetrieval),
    requiredCaseIds: Object.freeze([
      "qa_remote_alpha",
      "qa_badge_gamma",
      "compare_remote_no_material_difference_2way",
      "compare_remote_no_material_difference_3way",
      "compare_remote_numeric_conflict",
      "compare_remote_mixed_duplicate_conflict",
      "qa_satellite_stipend_abstain",
      "compare_remote_single_doc_abstain",
    ]),
    requiredDocuments: Object.freeze(syntheticDocuments),
  }),
  feedback: Object.freeze({
    kind: "synthetic",
    caseSource: "corpus",
    requiredAnswerClaims: Object.freeze(feedbackAnswerClaims),
    requiredCaseSemantics: Object.freeze(feedbackCaseSemantics),
    requiredConfig: Object.freeze(deterministicSyntheticConfig),
    requiredRetrieval: Object.freeze(deterministicSyntheticRetrieval),
    requiredCaseIds: Object.freeze([
      "feedback_citation_error_seed_citation_remote_approval",
      "feedback_incomplete_seed_incomplete_renewal_window",
    ]),
    requiredDocuments: Object.freeze(feedbackDocuments),
  }),
  trajectory: Object.freeze({
    kind: "checks",
    checksByCase: Object.freeze(trajectoryChecks),
    responseProjectionByCase: Object.freeze(
      trajectoryResponseProjections
    ),
  }),
  "planner-mock": Object.freeze({
    kind: "checks",
    checksByCase: Object.freeze(plannerChecks),
    responseProjectionByCase: Object.freeze(
      plannerResponseProjections
    ),
  }),
  "planner-real": Object.freeze({
    kind: "checks",
    checksByCase: Object.freeze(plannerChecks),
    responseProjectionByCase: Object.freeze(
      plannerResponseProjections
    ),
  }),
  recovery: Object.freeze({
    kind: "checks",
    checksByCase: Object.freeze(recoveryChecks),
  }),
});
