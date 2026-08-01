import { createHash } from "node:crypto";

const requireIdentityPart = (value, label) => {
  const normalized = String(value ?? "").trim().normalize("NFC");

  if (!normalized || normalized.toLowerCase() === "unknown") {
    throw new Error(`${label} must be a stable non-empty value.`);
  }

  return normalized;
};

export const buildSyntheticDocumentId = ({
  corpusId,
  corpusVersion,
  docKey,
} = {}) => {
  const identity = JSON.stringify({
    corpusId: requireIdentityPart(corpusId, "corpusId"),
    corpusVersion: requireIdentityPart(corpusVersion, "corpusVersion"),
    docKey: requireIdentityPart(docKey, "docKey"),
  });
  const digest = createHash("sha256").update(identity, "utf8").digest("hex");

  return `synthetic-doc-${digest}`;
};
