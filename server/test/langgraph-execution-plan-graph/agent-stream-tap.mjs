// Stands in for rag/langgraph/agent-stream.js inside routes/ while
// test/langgraph-chat-stream.test.mjs and test/langgraph-routes.test.mjs run
// (redirect-hooks.mjs of the phase-2 parity suite does the redirect;
// routes/chat.js imports the module on demand). Since the phase-3 load test
// the /chat/stream route uses the LangGraph relay only under
// AGENT_OUTER_PLAN_RUNTIME=langgraph, and identical SSE bytes cannot show
// which branch of the route answered, so every streamAgentRun call the route
// makes is counted here. Nothing of the request is recorded. The real module
// does all the work, and rag/ keeps importing the real module, so the relay
// key and the chunk forwarding are the same objects on both sides.
import { streamAgentRun as streamOnLangGraph } from "../../rag/langgraph/agent-stream.js";

export * from "../../rag/langgraph/agent-stream.js";

let calls = 0;

export const streamAgentRun = (options) => {
  calls += 1;

  return streamOnLangGraph(options);
};

/** The number of streamAgentRun calls since the last take. Resets it. */
export const takeAgentStreamRelayCalls = () => {
  const taken = calls;

  calls = 0;
  return taken;
};
