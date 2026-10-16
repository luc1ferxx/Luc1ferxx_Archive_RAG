// Stands in for rag/langgraph/run-execution-graph.js while a suite runs under
// the AGENT_RUNTIME=native rollback (native-rollback-guard.mjs). Nothing may
// reach the LangGraph executor there, so loading it is counted and refused.
globalThis.__archiveRagNativeRollbackGuard.langGraphExecutorImports += 1;

throw new Error("AGENT_RUNTIME=native reached the LangGraph executor (rag/langgraph/run-execution-graph.js).");
