// Stand-in for rag/vector-store.js as rag/index.js imports it in
// test/storage-quota-pool.test.mjs. With `vectorStoreControl.transactional`
// off it is the real module (the local store of the test); on, commitDocument
// takes its pgvector path -- one transaction on the stand-in pool
// (postgres-stand-in.mjs) per commit -- and the chunk write only calls
// `vectorStoreControl.onIndexWrite`.
import * as real from "../../rag/vector-store.js";

export * from "../../rag/vector-store.js";

export const vectorStoreControl = { onIndexWrite: null, transactional: false };

export const isVectorStoreTransactional = () =>
  vectorStoreControl.transactional || real.isVectorStoreTransactional();

export const beginVectorIndexWrite = async ({ client }) =>
  vectorStoreControl.transactional ? client : real.beginVectorIndexWrite({ client });

export const writeDocumentsToIndex = async (args) => {
  if (vectorStoreControl.transactional) {
    await vectorStoreControl.onIndexWrite?.(args);
    return;
  }

  return real.writeDocumentsToIndex(args);
};
