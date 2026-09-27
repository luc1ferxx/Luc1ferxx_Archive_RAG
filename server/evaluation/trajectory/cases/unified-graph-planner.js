import { UNIFIED_GRAPH_RUN_EVENTS } from "../../../rag/agent-unified-graph-run.js";

// What each v3 planning decision of a run looked like: whether the planner's
// own proposal was used, replaced whole by the deterministic graph (and why),
// or refused so V1 answered; and what the planner call cost when the adapter
// measured it (the model adapter does; injected proposals cost nothing), and
// under which prompt template, model route, and response-format schema the
// call ran, so a report's numbers stay tied to what produced them.
// Only the real-model planner run reads this; the pinned trajectory
// projections never include it.
const describeModelRoute = (route) =>
  route && typeof route === "object"
    ? {
        modelId: route.modelId ?? null,
        providerId: route.providerId ?? null,
        routeId: route.routeId ?? null,
        status: route.status ?? null,
      }
    : null;

const describePromptTemplate = (template) =>
  template && typeof template === "object"
    ? {
        fingerprint: template.fingerprint ?? null,
        id: template.id ?? null,
        version: template.version ?? null,
      }
    : null;

export const describeUnifiedPlannerDecisions = (run) =>
  (Array.isArray(run?.events) ? run.events : [])
    .filter((event) => event.type === UNIFIED_GRAPH_RUN_EVENTS.planned)
    .filter((event) => event.payload?.supersedes === undefined)
    .map(({ payload = {} }) => {
      const planner = payload.planner ?? {};
      const call = planner.plannerCall ?? null;

      return {
        admitted: payload.status === "selected",
        errorCodes: [...(payload.errorCodes ?? [])],
        fallback: planner.fallback === true,
        fallbackReason: planner.fallbackReason ?? null,
        fallbackReasonCodes: [...(planner.fallbackReasonCodes ?? [])],
        latencyMs: Number.isFinite(call?.latencyMs) ? call.latencyMs : null,
        modelRoute: describeModelRoute(call?.modelRoute),
        nodeSkillIds: [...(payload.graph?.skillIds ?? [])],
        promptTemplate: describePromptTemplate(call?.promptTemplate),
        requestedPlannerId: planner.requestedPlannerId ?? null,
        responseFormatDigest: call?.responseFormatDigest ?? null,
        selectedPlannerId: planner.selectedPlannerId ?? null,
        status: payload.status ?? null,
        tokens: Number.isFinite(call?.tokens) ? call.tokens : null,
      };
    });
