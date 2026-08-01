import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const normalizeIdentity = (value) => String(value ?? "").trim();

const readCorpusIdentity = (corpus = {}) => ({
  id: normalizeIdentity(
    corpus.id ?? corpus.metadata?.manifestName
  ),
  version: normalizeIdentity(
    corpus.version ?? corpus.metadata?.manifestVersion
  ),
});

const assertExpectedIntegrity = (expected = {}) => {
  if (expected.algorithm !== "sha256") {
    throw new Error("Pinned corpus integrity algorithm must be sha256.");
  }

  if (!SHA256_PATTERN.test(expected.contentHash ?? "")) {
    throw new Error("Pinned corpus contentHash must be a lowercase SHA-256 digest.");
  }

  for (const field of ["id", "version"]) {
    if (!normalizeIdentity(expected[field])) {
      throw new Error(`Pinned corpus ${field} must be a non-empty string.`);
    }
  }
};

export const verifyPinnedCorpus = async ({ filePath, expected } = {}) => {
  assertExpectedIntegrity(expected);

  const content = await readFile(filePath);
  const contentHash = createHash("sha256").update(content).digest("hex");

  if (contentHash !== expected.contentHash) {
    throw new Error(
      `Pinned corpus content hash mismatch: expected ${expected.contentHash}, received ${contentHash}.`
    );
  }

  let corpus;

  try {
    corpus = JSON.parse(content.toString("utf8"));
  } catch {
    throw new Error("Pinned corpus must contain valid JSON.");
  }

  const identity = readCorpusIdentity(corpus);

  if (identity.id !== expected.id || identity.version !== expected.version) {
    throw new Error(
      `Pinned corpus identity mismatch: expected ${expected.id}@${expected.version}, received ${identity.id || "unknown"}@${identity.version || "unknown"}.`
    );
  }

  return {
    algorithm: expected.algorithm,
    contentHash,
    id: identity.id,
    version: identity.version,
  };
};
