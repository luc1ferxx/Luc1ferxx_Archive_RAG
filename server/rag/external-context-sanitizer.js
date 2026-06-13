import {
  buildExternalQuerySensitiveTerms,
  getExternalQueryInternalIdentifiers,
  splitExternalQueryTerms,
} from "./external-query-policy.js";

const DEFAULT_SAFE_DOCUMENT_LABEL = "Uploaded document";

const LABEL_SENSITIVE_TERMS = new Set([
  "client",
  "codename",
  "confidential",
  "customer",
  "internal",
  "private",
  "project",
  "proprietary",
]);

const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const getProfile = (document = {}, profile = document.profile ?? {}) =>
  profile && typeof profile === "object" ? profile : {};

export const hasSensitiveExternalContextValue = ({
  document = {},
  profile = document.profile ?? {},
  value = "",
} = {}) => {
  const normalizedValue = normalizeText(value);

  if (!normalizedValue) {
    return false;
  }

  if (getExternalQueryInternalIdentifiers(normalizedValue).length > 0) {
    return true;
  }

  const resolvedProfile = getProfile(document, profile);
  const sensitiveTerms = buildExternalQuerySensitiveTerms({
    document,
    profile: resolvedProfile,
  });

  return splitExternalQueryTerms(normalizedValue).some(
    (term) => LABEL_SENSITIVE_TERMS.has(term) || sensitiveTerms.has(term)
  );
};

export const buildSafeExternalDocumentSummary = ({
  document = {},
  fallbackFileName = DEFAULT_SAFE_DOCUMENT_LABEL,
  profile = document.profile ?? {},
} = {}) => {
  const docId = normalizeText(document.docId);
  const fileName = normalizeText(document.fileName);
  const safeFileName = hasSensitiveExternalContextValue({
    document,
    profile,
    value: fileName,
  })
    ? fallbackFileName
    : fileName;

  return {
    docId,
    fileName: normalizeText(safeFileName) || docId || fallbackFileName,
  };
};
