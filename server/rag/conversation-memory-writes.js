import { AsyncLocalStorage } from "node:async_hooks";

// Conversation memory (the session turn and the long-term preferences a user
// message states) records only the user's own messages. A caller that runs a
// whole agent request on text it composed itself -- a background task
// iteration that asks a workflow phase question or the agent's planned next
// question -- wraps that request here, so no chat() inside it writes memory,
// however deep. Reads are unaffected. Per-call opt-out stays `memoryWrites:
// false` on chat(); this covers the calls a whole request makes.
const suppression = new AsyncLocalStorage();

export const runWithoutConversationMemoryWrites = (callback) =>
  suppression.run(true, callback);

export const areConversationMemoryWritesSuppressed = () =>
  suppression.getStore() === true;
