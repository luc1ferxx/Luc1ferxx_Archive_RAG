// Module resolve hook, registered with module.register() by
// test/langgraph-planner-model.test.mjs before it imports any rag module.
//
// It does two things:
//   - reports, through the MessagePort the suite hands over, every resolution
//     of an @langchain/* module requested from outside node_modules (who
//     loaded LangChain first), so the suite can show that a planner on the
//     native runtime loads none;
//   - sends rag/langgraph/planner-model.js's import of rag/langgraph/model.js
//     to the counting stand-in (model-tap.mjs), whose own import of model.js
//     reaches the real module.
let port = null;
let modelUrl = "";
let plannerModelUrl = "";
let tapUrl = "";

export const initialize = (data) => {
  ({ modelUrl, plannerModelUrl, port, tapUrl } = data);
};

export const resolve = async (specifier, context, nextResolve) => {
  const resolved = await nextResolve(specifier, context);
  const parentURL = context.parentURL ?? "";

  if (resolved.url.includes("/node_modules/@langchain/") && !parentURL.includes("/node_modules/")) {
    port?.postMessage({ parentURL, url: resolved.url });
  }

  if (resolved.url === modelUrl && parentURL === plannerModelUrl) {
    return { ...resolved, url: tapUrl };
  }

  return resolved;
};
