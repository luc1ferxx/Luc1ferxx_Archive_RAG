// The model call of the five planners (intent, execution, DAG, unified graph
// and replan). Under AGENT_RUNTIME=native it is completeTextWithMetadata, as
// it always was; under AGENT_RUNTIME=langgraph (the default since phase 4) it
// goes through the phase-1 LangChain chat model, ArchiveRagChatModel
// (model.js), which hands the same prompt and options to the same
// completeTextWithMetadata. Either way the planner gets back { modelRoute,
// text } and keeps its own parser and validator: withStructuredOutput is not
// used, because its parser differs from the planners' (a fenced JSON reply
// after prose holding [..] or {..} parses with theirs and fails with
// parseFirstJsonValue), it refuses the null schema the intent planner builds
// when there are no candidates, and the replan call sends no schema at all.
//
// What stays identical on both runtimes, because openai.js does all of it:
// the request the provider or backend receives, retries, backoff, circuit
// breaker, failover, model gateway routing, one LLMOps event per model
// attempted (promptTemplate identity, never prompt text), run-usage charging,
// the model span, and the thrown error (the same object). The request
// deadline still cancels the call: openai.js reads the bound request's signal
// from AsyncLocalStorage (withRequestSignal), which LangChain's own
// AsyncLocalStorage does not touch, and no planner passes a signal of its own.
//
// Two deliberate details of the LangGraph path:
//   - The call is a root LangChain run. A planner can run inside a LangGraph
//     node (the DAG planner and the replanner inside the outer plan graph's
//     custom_skills node under AGENT_OUTER_PLAN_RUNTIME=langgraph); invoked
//     there as is, the model would become a child run of that node and
//     inherit its callbacks and signal, and a "messages" stream mode would
//     emit the planner's whole reply. So it runs under an empty LangChain
//     async context, as the custom-Skill executor's invoke does
//     (run-execution-graph.js), without building a root RunTree.
//   - A LangSmith tracing variable set to "true" (langsmith-guard.js) sends
//     the call down the direct path, completeTextWithMetadata as on native,
//     before LangChain is loaded or configured, so there is no LangChain run
//     a tracer could attach to. It is not refused: a planner call builds no
//     LangGraph graph, and AGENTS.md promises that AGENT_RUNTIME=langgraph
//     alone answers a request that builds none as natively under such a
//     variable; a refusal would turn every LLM planner (the default dials)
//     into its deterministic fallback. The graphs keep their own refusal
//     (the custom-Skill stage, the v3 entry, the outer plan graph), and the
//     chat model still re-checks on every invoke (model.js), so a variable
//     switched on while LangChain is being imported is refused there, and the
//     planner falls back.
//
// model.js and @langchain/core are imported on first use under langgraph, so
// a process on the native runtime, or with a LangSmith tracing variable set,
// never loads LangChain for a planner.
import { getAgentRuntime } from "../config.js";
import { completeTextWithMetadata } from "../openai.js";
import { findEnabledLangSmithTracing } from "./langsmith-guard.js";

export const PLANNER_MODEL_ERROR_CODES = Object.freeze({
  unsupportedOption: "PLANNER_MODEL_UNSUPPORTED_OPTION",
});

// What a planner may pass: what the planners pass today, plus temperature,
// which the chat model carries per call exactly as openai.js reads it. Any
// other key (a signal, a model name, a stream callback) is refused on both
// runtimes, since the LangChain path could not carry it the same way.
// capability and routeId pick the model instance; the rest go per call.
const PLANNER_MODEL_OPTION_KEYS = Object.freeze([
  "capability",
  "promptTemplate",
  "responseFormat",
  "routeId",
  "temperature",
]);

const assertPlannerModelOptions = (options) => {
  const unsupported = Object.keys(options).filter(
    (key) => !PLANNER_MODEL_OPTION_KEYS.includes(key)
  );

  if (unsupported.length > 0) {
    const error = new Error(
      `Planner model calls take ${PLANNER_MODEL_OPTION_KEYS.join(", ")} only; got ` +
        `${unsupported.length} other option(s).`
    );
    error.code = PLANNER_MODEL_ERROR_CODES.unsupportedOption;
    throw error;
  }
};

let langChainModulesPromise = null;

const loadLangChainModules = () =>
  (langChainModulesPromise ??= Promise.all([
    import("./model.js"),
    import("@langchain/core/singletons"),
  ]).then(
    ([{ ArchiveRagChatModel }, { AsyncLocalStorageProviderSingleton }]) => ({
      ArchiveRagChatModel,
      AsyncLocalStorageProviderSingleton,
    }),
    (error) => {
      // A failed load is not cached, so the next call tries again.
      langChainModulesPromise = null;
      throw error;
    }
  ));

// One model per route. A model holds no per-call or per-request state (the
// prompt template, schema and temperature go with each call; the tenant,
// deadline and run usage are read by openai.js from the request's own
// AsyncLocalStorage), so requests share it safely.
const plannerModels = new Map();

const getPlannerModel = (ArchiveRagChatModel, { capability, routeId }) => {
  const key = JSON.stringify([capability ?? null, routeId ?? null]);
  let model = plannerModels.get(key);

  if (!model) {
    model = new ArchiveRagChatModel({
      ...(capability !== undefined ? { capability } : {}),
      ...(routeId !== undefined ? { routeId } : {}),
    });
    plannerModels.set(key, model);
  }

  return model;
};

const completeThroughChatModel = async (prompt, options) => {
  const { ArchiveRagChatModel, AsyncLocalStorageProviderSingleton } =
    await loadLangChainModules();
  const model = getPlannerModel(ArchiveRagChatModel, options);
  const callOptions = {
    promptTemplate: options.promptTemplate,
    responseFormat: options.responseFormat,
    temperature: options.temperature,
  };
  const message = await AsyncLocalStorageProviderSingleton.runWithConfig(
    undefined,
    () => model.invoke(prompt, callOptions),
    true
  );

  // The two fields completeTextWithMetadata returns. A string reply is the
  // message content unchanged; a stand-in provider's undefined or null reply
  // becomes LangChain's empty content ([]), which every planner parser reads
  // as the same empty reply (String(text ?? "")).
  return {
    modelRoute: message.response_metadata?.modelRoute,
    text: message.content,
  };
};

/**
 * completeTextWithMetadata for a planner: the same prompt, options, result
 * ({ modelRoute, text }) and errors, through ArchiveRagChatModel under
 * AGENT_RUNTIME=langgraph and directly under native or while a LangSmith
 * tracing variable is set. `runtime` defaults to the current AGENT_RUNTIME,
 * read per call, as is the environment.
 */
export const completePlannerText = async (
  prompt,
  options = {},
  { runtime = getAgentRuntime() } = {}
) => {
  assertPlannerModelOptions(options);

  if (runtime !== "langgraph" || findEnabledLangSmithTracing().length > 0) {
    return completeTextWithMetadata(prompt, options);
  }

  return completeThroughChatModel(prompt, options);
};
