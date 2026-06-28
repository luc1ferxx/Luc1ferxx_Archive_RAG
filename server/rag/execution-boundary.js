import { normalizeText, toArray } from "./capabilities/shared.js";

export const EXECUTION_BOUNDARY_VERSION = "1.0.0";
export const SECRET_EXPOSURE_MODES = Object.freeze({
  refsOnly: "refs_only",
});

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 65_536;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1_048_576;
const SECRET_REF_PATTERN = /^[A-Z][A-Z0-9_]{1,119}$/;

const normalizeBoundedText = (value, maxLength = 320) =>
  normalizeText(value).slice(0, maxLength);

const normalizeRecord = (value, fallback = {}) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fallback;

const normalizeBoolean = (value, fallback = false) =>
  typeof value === "boolean" ? value : fallback;

const normalizePositiveInt = ({ fallback, max, min = 1, value }) => {
  const parsedValue = Number(value);

  if (!Number.isFinite(parsedValue)) {
    return fallback;
  }

  return Math.min(Math.max(min, Math.trunc(parsedValue)), max);
};

const normalizeTextList = (value, maxLength = 120) =>
  toArray(value)
    .map((item) => normalizeBoundedText(item, maxLength))
    .filter(Boolean);

export const normalizeSandboxPolicy = (policy = {}) => {
  const policyRecord = normalizeRecord(policy);

  return {
    allowNetwork: normalizeBoolean(policyRecord.allowNetwork, false),
    allowWorkspaceWrite: normalizeBoolean(
      policyRecord.allowWorkspaceWrite,
      false
    ),
    maxOutputBytes: normalizePositiveInt({
      fallback: DEFAULT_MAX_OUTPUT_BYTES,
      max: MAX_OUTPUT_BYTES,
      value: policyRecord.maxOutputBytes,
    }),
    profile: normalizeBoundedText(policyRecord.profile, 120),
    retryable: normalizeBoolean(policyRecord.retryable, false),
    timeoutMs: normalizePositiveInt({
      fallback: DEFAULT_TIMEOUT_MS,
      max: MAX_TIMEOUT_MS,
      min: 100,
      value: policyRecord.timeoutMs,
    }),
    version:
      normalizeBoundedText(policyRecord.version, 40) ||
      EXECUTION_BOUNDARY_VERSION,
  };
};

export const normalizeSecretPolicy = (policy = {}) => {
  const policyRecord = normalizeRecord(policy);

  return {
    declared: Object.keys(policyRecord).length > 0,
    exposure:
      normalizeBoundedText(policyRecord.exposure, 80) ||
      SECRET_EXPOSURE_MODES.refsOnly,
    optionalSecretRefs: normalizeTextList(policyRecord.optionalSecretRefs),
    requiredSecretRefs: normalizeTextList(policyRecord.requiredSecretRefs),
    version:
      normalizeBoundedText(policyRecord.version, 40) ||
      EXECUTION_BOUNDARY_VERSION,
  };
};

const validateSecretRefs = ({ errors = [], label = "", refs = [] } = {}) => {
  const seenRefs = new Set();

  for (const ref of refs) {
    if (!SECRET_REF_PATTERN.test(ref)) {
      errors.push(`${label} secret ref must be an uppercase secret name: ${ref}`);
    }

    if (seenRefs.has(ref)) {
      errors.push(`${label} secret ref must be unique: ${ref}`);
    }

    seenRefs.add(ref);
  }
};

export const validateExecutionBoundaryPolicy = ({
  approvalPolicy = {},
  capabilityId = "",
  privacyPolicy = {},
  sandboxPolicy = {},
  secretPolicy = {},
} = {}) => {
  const sandbox = normalizeSandboxPolicy(sandboxPolicy);
  const secrets = normalizeSecretPolicy(secretPolicy);
  const errors = [];
  const boundaryLabel = capabilityId
    ? `Execution boundary for ${capabilityId}`
    : "Execution boundary";

  if (!sandbox.profile) {
    errors.push(`${boundaryLabel} requires sandboxPolicy.profile.`);
  }

  if (privacyPolicy.externalCall === true && sandbox.allowNetwork !== true) {
    errors.push(
      `${boundaryLabel} external calls require sandboxPolicy.allowNetwork.`
    );
  }

  if (
    approvalPolicy.writesWorkspace === true &&
    sandbox.allowWorkspaceWrite !== true
  ) {
    errors.push(
      `${boundaryLabel} workspace writes require sandboxPolicy.allowWorkspaceWrite.`
    );
  }

  if (secrets.exposure !== SECRET_EXPOSURE_MODES.refsOnly) {
    errors.push(`${boundaryLabel} secret exposure must be refs_only.`);
  }

  validateSecretRefs({
    errors,
    label: `${boundaryLabel} required`,
    refs: secrets.requiredSecretRefs,
  });
  validateSecretRefs({
    errors,
    label: `${boundaryLabel} optional`,
    refs: secrets.optionalSecretRefs,
  });

  const allRefs = [
    ...secrets.requiredSecretRefs,
    ...secrets.optionalSecretRefs,
  ];
  const duplicateAcrossRequiredAndOptional = secrets.requiredSecretRefs.find(
    (ref) => secrets.optionalSecretRefs.includes(ref)
  );

  if (duplicateAcrossRequiredAndOptional) {
    errors.push(
      `${boundaryLabel} secret ref cannot be both required and optional: ${duplicateAcrossRequiredAndOptional}`
    );
  }

  if (!secrets.declared) {
    errors.push(`${boundaryLabel} requires secretPolicy, even when no secrets are needed.`);
  }

  return {
    errors,
    sandboxPolicy: sandbox,
    secretPolicy: secrets,
    valid: errors.length === 0,
    secretRefCount: allRefs.length,
  };
};

export const buildExecutionBoundaryContext = ({
  sandboxPolicy = {},
  secretPolicy = {},
} = {}) => {
  const sandbox = normalizeSandboxPolicy(sandboxPolicy);
  const secrets = normalizeSecretPolicy(secretPolicy);

  return {
    sandbox,
    secrets: {
      exposure: SECRET_EXPOSURE_MODES.refsOnly,
      optionalRefs: secrets.optionalSecretRefs,
      requiredRefs: secrets.requiredSecretRefs,
    },
    version: EXECUTION_BOUNDARY_VERSION,
  };
};

export const filterInputForExecutionBoundary = ({
  input = {},
  inputSchema = {},
} = {}) => {
  const inputRecord = normalizeRecord(input);
  const properties = normalizeRecord(inputSchema.properties, null);

  if (!properties) {
    return {
      ...inputRecord,
    };
  }

  return Object.fromEntries(
    Object.keys(properties)
      .filter((field) => Object.hasOwn(inputRecord, field))
      .map((field) => [field, inputRecord[field]])
  );
};
