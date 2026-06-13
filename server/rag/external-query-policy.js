export const EXTERNAL_QUERY_POLICY_VERSION = "external_query_policy_v1";

const DEFAULT_MAX_QUERY_TERMS = 8;
const REDACTED_TERM = "[redacted]";

export const EXTERNAL_QUERY_STOP_TERMS = new Set([
  "analysis",
  "approach",
  "approaches",
  "based",
  "client",
  "company",
  "confidential",
  "customer",
  "document",
  "documents",
  "draft",
  "file",
  "files",
  "improve",
  "improved",
  "improves",
  "internal",
  "method",
  "methods",
  "note",
  "notes",
  "pdf",
  "policies",
  "policy",
  "private",
  "project",
  "proprietary",
  "report",
  "roadmap",
  "studies",
  "study",
  "support",
  "supported",
  "supports",
  "system",
  "systems",
  "using",
  "workspace",
  "workspaces",
]);

const INTERNAL_IDENTIFIER_PATTERN =
  /\b(?:[A-Z][A-Z0-9]{1,}[-_][A-Z0-9._-]*\d[A-Z0-9._-]*|[A-Z]{2,}\d{2,}[A-Z0-9]*)\b/g;
const SENSITIVE_PHRASE_PATTERN =
  /\b(?:customer|client|project|codename)\s+[A-Z][A-Za-z0-9._-]*(?:\s+[A-Z][A-Za-z0-9._-]*){0,3}/g;

const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

export const normalizeExternalQueryTerm = (value) =>
  normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, " ")
    .trim();

export const splitExternalQueryTerms = (value) =>
  normalizeExternalQueryTerm(value)
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);

export const isSearchableExternalQueryTerm = (term) =>
  term.length >= 3 && /^[a-z][a-z0-9._-]*$/.test(term) && /[a-z]/.test(term);

const toArray = (value) => (Array.isArray(value) ? value : []);

const uniq = (values) => [...new Set(values.filter(Boolean))];

export const getExternalQueryInternalIdentifiers = (value) =>
  [...String(value ?? "").matchAll(INTERNAL_IDENTIFIER_PATTERN)].map(
    (match) => match[0]
  );

const getSensitivePhrases = (value) =>
  [...String(value ?? "").matchAll(SENSITIVE_PHRASE_PATTERN)].map(
    (match) => match[0]
  );

const addSensitiveValue = (sensitiveTerms, value) => {
  const normalizedValue = normalizeExternalQueryTerm(value);

  if (!normalizedValue) {
    return;
  }

  sensitiveTerms.add(normalizedValue);

  for (const term of splitExternalQueryTerms(normalizedValue)) {
    sensitiveTerms.add(term);
  }

  for (const term of normalizedValue.split(/[\s._-]+/).filter(Boolean)) {
    sensitiveTerms.add(term);
  }
};

export const buildExternalQuerySensitiveTerms = ({
  document = {},
  profile = {},
} = {}) => {
  const sensitiveTerms = new Set();
  const privateSourceText = [
    document.fileName,
    profile.summary,
    ...toArray(profile.tags),
    ...toArray(profile.entities),
  ].join("\n");

  for (const entity of toArray(profile.entities)) {
    addSensitiveValue(sensitiveTerms, entity);
  }

  for (const identifier of getExternalQueryInternalIdentifiers(privateSourceText)) {
    addSensitiveValue(sensitiveTerms, identifier);
  }

  for (const phrase of getSensitivePhrases(privateSourceText)) {
    addSensitiveValue(sensitiveTerms, phrase);
  }

  return sensitiveTerms;
};

const buildRemovedTerm = (reason) => ({
  reason,
  value: REDACTED_TERM,
});

const appendRemovedTerm = (removedTerms, riskFlags, reason, riskFlag) => {
  removedTerms.push(buildRemovedTerm(reason));
  riskFlags.add(riskFlag);
};

const buildPolicySummary = ({
  accessScope = {},
  inputTermCount,
  removedTerms,
  riskFlags,
  sanitizedTerms,
}) => ({
  allowed: sanitizedTerms.length > 0,
  inputTermCount,
  outputTermCount: sanitizedTerms.length,
  policyVersion: EXTERNAL_QUERY_POLICY_VERSION,
  removedTermCount: removedTerms.length,
  removedTerms,
  riskFlags: [...riskFlags].sort(),
  sanitizedQuery: sanitizedTerms.join(" "),
  scopeBound: Boolean(accessScope.userId || accessScope.workspaceId),
});

export const buildExternalQueryPolicy = ({
  accessScope = {},
  candidateQuery = "",
  document = {},
  maxQueryTerms = DEFAULT_MAX_QUERY_TERMS,
  profile = document.profile ?? {},
  stopTerms = EXTERNAL_QUERY_STOP_TERMS,
} = {}) => {
  const sensitiveTerms = buildExternalQuerySensitiveTerms({
    document,
    profile,
  });
  const candidateIdentifiers = getExternalQueryInternalIdentifiers(candidateQuery);
  const internalIdentifierTerms = new Set();

  for (const identifier of candidateIdentifiers) {
    addSensitiveValue(internalIdentifierTerms, identifier);
  }

  const rawTerms = splitExternalQueryTerms(candidateQuery);
  const removedTerms = [];
  const riskFlags = new Set();
  const sanitizedTerms = [];
  const selectedTerms = new Set();

  if (candidateIdentifiers.length > 0) {
    riskFlags.add("internal_identifier_detected");
  }

  for (const term of rawTerms) {
    if (!isSearchableExternalQueryTerm(term)) {
      appendRemovedTerm(
        removedTerms,
        riskFlags,
        "unsafe_query_term",
        "unsafe_query_term_removed"
      );
      continue;
    }

    if (stopTerms.has(term)) {
      appendRemovedTerm(
        removedTerms,
        riskFlags,
        "generic_or_restricted_term",
        "generic_or_restricted_term_removed"
      );
      continue;
    }

    if (sensitiveTerms.has(term)) {
      appendRemovedTerm(
        removedTerms,
        riskFlags,
        "sensitive_profile_term",
        "sensitive_profile_term_removed"
      );
      continue;
    }

    if (internalIdentifierTerms.has(term)) {
      appendRemovedTerm(
        removedTerms,
        riskFlags,
        "internal_identifier",
        "internal_identifier_removed"
      );
      continue;
    }

    if (selectedTerms.has(term)) {
      continue;
    }

    selectedTerms.add(term);
    sanitizedTerms.push(term);

    if (sanitizedTerms.length >= maxQueryTerms) {
      break;
    }
  }

  if (removedTerms.length > 0) {
    riskFlags.add("query_sanitized");
  }

  if (sanitizedTerms.length === 0) {
    riskFlags.add("empty_external_query");
  }

  return buildPolicySummary({
    accessScope,
    inputTermCount: rawTerms.length,
    removedTerms,
    riskFlags,
    sanitizedTerms,
  });
};

export const isExternalQueryPolicyAllowed = (policy = {}) =>
  Boolean(policy.allowed && normalizeText(policy.sanitizedQuery));

export const serializeExternalQueryPolicy = (policy = {}) => ({
  allowed: Boolean(policy.allowed),
  inputTermCount: Number(policy.inputTermCount ?? 0) || 0,
  outputTermCount: Number(policy.outputTermCount ?? 0) || 0,
  policyVersion:
    normalizeText(policy.policyVersion) || EXTERNAL_QUERY_POLICY_VERSION,
  removedTermCount: Number(policy.removedTermCount ?? 0) || 0,
  removedTerms: toArray(policy.removedTerms).map((term) =>
    buildRemovedTerm(normalizeText(term.reason) || "removed")
  ),
  riskFlags: uniq(toArray(policy.riskFlags).map(normalizeText)).sort(),
  sanitizedQuery: normalizeText(policy.sanitizedQuery),
  scopeBound: Boolean(policy.scopeBound),
});
