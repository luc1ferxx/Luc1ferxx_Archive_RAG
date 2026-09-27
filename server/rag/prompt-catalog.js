import { getActiveWebAnswerPromptDescriptor, listWebAnswerPromptDescriptors } from "../chat-mcp.js";
import { getDagPlannerPromptDescriptor } from "./agent-dag-planner-adapter.js";
import { getIntentPlannerPromptDescriptor } from "./agent-intent-llm-adapter.js";
import { getExecutionPlannerPromptDescriptor } from "./agent-llm-planner-adapter.js";
import { getReplannerPromptDescriptor } from "./agent-replan-adapter.js";
import { getUnifiedGraphPlannerPromptDescriptor } from "./agent-unified-dag-planner-adapter.js";
import {
  getActiveAnswerPromptDescriptors,
  listAnswerPromptDescriptors,
} from "./answer-writer.js";
import { getActiveRewritePromptDescriptor, listRewritePromptDescriptors } from "./memory.js";
import { hashPromptSet } from "./prompt-registry.js";
import { getClaimJudgePromptDescriptor } from "./self-check/claim-judge.js";

// Every prompt template a production code path can send to a chat model. The
// owning modules define the descriptors next to their templates; this module
// only collects them, for the pinned fingerprint test and for evaluation
// reports. Adding a model call means adding its descriptor here.

const getSingleTemplatePrompts = () => [
  getIntentPlannerPromptDescriptor(),
  getExecutionPlannerPromptDescriptor(),
  getDagPlannerPromptDescriptor(),
  getReplannerPromptDescriptor(),
  getUnifiedGraphPlannerPromptDescriptor(),
  getClaimJudgePromptDescriptor(),
];

const byKey = (left, right) =>
  `${left.id}@${left.version}`.localeCompare(`${right.id}@${right.version}`);

/** All templates, every variant RAG_PROMPT_VERSION can select. */
export const listPromptTemplates = () =>
  [
    ...listAnswerPromptDescriptors(),
    ...listRewritePromptDescriptors(),
    ...listWebAnswerPromptDescriptors(),
    ...getSingleTemplatePrompts(),
  ].sort(byKey);

/** The templates the current configuration would send, one per prompt id. */
export const getActivePromptTemplates = () =>
  [
    ...getActiveAnswerPromptDescriptors(),
    getActiveRewritePromptDescriptor(),
    getActiveWebAnswerPromptDescriptor(),
    ...getSingleTemplatePrompts(),
  ].sort(byKey);

/**
 * What an evaluation report records: the active templates and one hash over
 * them, so two reports can be checked for "same prompts" with one comparison.
 */
export const describeActivePromptTemplates = () => {
  const templates = getActivePromptTemplates().map((template) => ({ ...template }));

  return { setHash: hashPromptSet(templates), templates };
};
