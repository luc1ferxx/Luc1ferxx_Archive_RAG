// Stands in for lib/prompt-template.js while test/langgraph-prompts-adapter.test.mjs
// loads the production prompt modules (prompt-template-capture-hooks.mjs does
// the redirect). answer-writer.js, memory.js and chat-mcp.js keep their
// templates module-private; recording each template as it is built lets the
// test convert the exact objects production renders, without exporting them.
// The real constructors build every template; this module only keeps a
// reference to each one.
import {
  createChatPromptTemplate as createInHouseChatPromptTemplate,
  createPromptTemplate as createInHousePromptTemplate,
} from "../../lib/prompt-template.js";

export const capturedPromptTemplates = [];

export const createPromptTemplate = (template) => {
  const created = createInHousePromptTemplate(template);

  capturedPromptTemplates.push(created);
  return created;
};

export const createChatPromptTemplate = (messages) => {
  const created = createInHouseChatPromptTemplate(messages);

  capturedPromptTemplates.push(created);
  return created;
};
