// The throwaway archive an evaluation ingests into.
//
// rag/storage.js resolves its data directory once, when it is first imported:
// RAG_DATA_DIRECTORY if set, else server/data/rag when that directory exists
// (the developer's local archive), else a user data directory. A runner that
// only sets process.env.RAG_DATA_DIRECTORY after something it imported
// statically has already loaded storage.js ingests into, and computes BM25
// statistics over, the local archive instead of its temporary directory: on
// 2026-10-18 the QASPER retrieval eval run from the main checkout left 664
// papers in server/data/rag and measured candidate coverage 0.663 against 0.704
// for the same commit in a clean worktree (docs/evaluation.md "按句子装块").
// useEvaluationDataDirectory sets the variable for child processes and modules
// not loaded yet, points the already-loaded storage module at the directory,
// and refuses to go on if it does not take.

import path from "node:path";
import { configureRagDataDirectory, getRagDataDirectory } from "../rag/storage.js";

export const useEvaluationDataDirectory = (directory) => {
  const resolved = path.resolve(directory);

  process.env.RAG_DATA_DIRECTORY = resolved;
  configureRagDataDirectory(resolved);

  if (getRagDataDirectory() !== resolved) {
    throw new Error(`The evaluation data directory did not take: storage uses ${getRagDataDirectory()}, not ${resolved}.`);
  }

  return resolved;
};
