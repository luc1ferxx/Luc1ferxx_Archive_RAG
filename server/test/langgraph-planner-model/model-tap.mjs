// What rag/langgraph/planner-model.js imports as model.js in
// test/langgraph-planner-model.test.mjs (hooks.mjs redirects it here): the
// real ArchiveRagChatModel, counted. Each model call records what the
// LangChain path handed the model, so the suite can show that the adapter
// really ran, that it ran as a root LangChain run (no ambient runnable config,
// even inside a LangGraph node) and that no LangChain signal reached it.
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";

import { ArchiveRagChatModel as RealArchiveRagChatModel } from "../../rag/langgraph/model.js";

export * from "../../rag/langgraph/model.js";

const tap = globalThis.__archiveRagPlannerModelTap;

tap.loads += 1;

export class ArchiveRagChatModel extends RealArchiveRagChatModel {
  constructor(fields) {
    super(fields);
    tap.models.push({ ...fields });
  }

  async _generate(messages, options = {}, runManager) {
    tap.generations.push({
      ambientConfig: AsyncLocalStorageProviderSingleton.getRunnableConfig() !== undefined,
      messageCount: messages.length,
      promptTemplateId: options.promptTemplate?.id ?? null,
      responseFormat: options.responseFormat ?? null,
      signal: options.signal !== undefined,
    });

    return super._generate(messages, options, runManager);
  }
}
