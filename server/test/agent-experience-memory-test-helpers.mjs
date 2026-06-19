import { resetAgentExperienceMemoryStore } from "../rag/agent-experience-memory.js";

export const withAgentExperienceMemoryEnabled = async (callback) => {
  const originalLongMemoryEnabled = process.env.RAG_LONG_MEMORY_ENABLED;
  const originalExperienceMemoryEnabled =
    process.env.RAG_AGENT_EXPERIENCE_MEMORY_ENABLED;

  process.env.RAG_LONG_MEMORY_ENABLED = "true";
  process.env.RAG_AGENT_EXPERIENCE_MEMORY_ENABLED = "true";

  try {
    return await callback();
  } finally {
    resetAgentExperienceMemoryStore();

    if (originalLongMemoryEnabled === undefined) {
      delete process.env.RAG_LONG_MEMORY_ENABLED;
    } else {
      process.env.RAG_LONG_MEMORY_ENABLED = originalLongMemoryEnabled;
    }

    if (originalExperienceMemoryEnabled === undefined) {
      delete process.env.RAG_AGENT_EXPERIENCE_MEMORY_ENABLED;
    } else {
      process.env.RAG_AGENT_EXPERIENCE_MEMORY_ENABLED =
        originalExperienceMemoryEnabled;
    }
  }
};
