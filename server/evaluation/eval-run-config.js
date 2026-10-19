// What an evaluation report records about the code and settings behind its
// chunks, so two runs that differ there can be told apart (1dcc8467 changed
// the structured chunker's output and no report showed it):
//
//   config.chunking  { strategy, size, overlap, chunkerVersion } this run cut
//                    its chunks with (rag/chunk-profile.js);
//   config.pdf       { parser, paragraphDetection } where the run parses PDFs;
//   config.git       { sha, dirty, changedPaths } of the checkout, or null
//                    when git cannot say (eval-evidence.js).
//
// Additive fields: older reports lack them, and nothing gates on them.
// rag/ modules are imported when called, after a runner has set its own
// environment (storage reads RAG_DATA_DIRECTORY on first import).

import { describeEvaluationCheckout } from "./eval-evidence.js";

export const describeChunkingConfig = async () => {
  const [{ CHUNKER_VERSION }, config] = await Promise.all([
    import("../rag/chunk-profile.js"),
    import("../rag/config.js"),
  ]);

  return {
    chunkerVersion: CHUNKER_VERSION,
    overlap: config.getChunkOverlap(),
    size: config.getChunkSize(),
    strategy: config.getChunkStrategy(),
  };
};

export const describePdfConfig = async () => {
  const config = await import("../rag/config.js");

  return {
    paragraphDetection: config.isPdfParagraphDetectionEnabled(),
    parser: config.getPdfParser(),
  };
};

export { describeEvaluationCheckout };

/** Characters of text over `items` (chunks, contexts), read by `readText`. */
export const sumTextChars = (items, readText = (item) => item) =>
  (Array.isArray(items) ? items : []).reduce((total, item) => total + String(readText(item) ?? "").length, 0);

const CHUNKING_FIELDS = Object.freeze(["strategy", "size", "overlap", "chunkerVersion"]);

/**
 * Where this run's chunking and checkout differ from another report's, for a
 * paired comparison: `[{ field, current, other }]`, null for a side that
 * cannot say (a report from before the field, or git unavailable): unknown,
 * so listed.
 *
 * The checkout: `git.sha` when the commits differ or either one is unknown,
 * and `git.changedPaths` (the uncommitted path counts) whenever either run
 * had uncommitted changes, also at the same commit and the same count: a
 * commit does not say which code a dirty work tree ran. An empty list means
 * both runs cut their chunks the same way from the same clean commit.
 */
export const describeRunConfigDifferences = (config = {}, otherConfig = {}) => {
  const differences = [];
  const list = (field, current, other) => differences.push({ current: current ?? null, field, other: other ?? null });
  const compare = (field, current, other) => {
    if (!Object.is(current ?? null, other ?? null)) {
      list(field, current, other);
    }
  };

  for (const field of CHUNKING_FIELDS) {
    compare(`chunking.${field}`, config.chunking?.[field], otherConfig?.chunking?.[field]);
  }

  const git = config.git ?? null;
  const otherGit = otherConfig?.git ?? null;

  if (!git?.sha || !otherGit?.sha || git.sha !== otherGit.sha) {
    list("git.sha", git?.sha, otherGit?.sha);
  }

  if (git?.dirty === true || otherGit?.dirty === true) {
    list("git.changedPaths", git?.changedPaths, otherGit?.changedPaths);
  }

  return differences;
};
