// Imported first by every suite that loads LangGraph or LangChain, before any
// @langchain module.
//
// @langchain/core turns the LangSmith tracer on from the environment alone:
// any of these variables set to "true" adds a LangChainTracer that ships run
// metadata to a third party (node_modules/@langchain/core/dist/utils/callbacks.js).
// The migration rule is that tracing stays on OpenTelemetry and LangSmith never
// runs, and test children inherit the developer's shell environment
// (test/run.test.mjs), so clear them before LangChain can read them.
export const LANGSMITH_TRACING_VARIABLES = Object.freeze([
  "LANGCHAIN_TRACING",
  "LANGCHAIN_TRACING_V2",
  "LANGCHAIN_VERBOSE",
  "LANGSMITH_TRACING",
  "LANGSMITH_TRACING_V2",
]);

for (const name of LANGSMITH_TRACING_VARIABLES) {
  delete process.env[name];
}
