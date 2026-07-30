import { createHash, timingSafeEqual } from "node:crypto";

import { normalizeTaskAccessScope } from "../tasks.js";
import { normalizeText } from "../../lib/normalize-text.js";

export const APPROVAL_EXECUTION_SNAPSHOT_VERSION = 1;
const MAX_CANONICAL_JSON_DEPTH = 64;
const MAX_CANONICAL_JSON_NODES = 100_000;

export const APPROVAL_EXECUTION_SNAPSHOT_ERROR_CODES = Object.freeze({
  hashMismatch: "approval_object_hash_mismatch",
  invalidJson: "approval_snapshot_invalid_json",
  invalidMetadata: "approval_snapshot_invalid_metadata",
  missingSnapshot: "approval_snapshot_missing",
  unsupportedVersion: "approval_snapshot_version_unsupported",
});

const createSnapshotError = (code, message) => {
  const error = new Error(message);
  error.name = "ApprovalExecutionSnapshotError";
  error.code = code;
  error.status = 409;
  return error;
};

const throwInvalidJson = (path, reason) => {
  throw createSnapshotError(
    APPROVAL_EXECUTION_SNAPSHOT_ERROR_CODES.invalidJson,
    `Approval execution snapshot contains invalid JSON at ${path}: ${reason}.`
  );
};

const canonicalizeJsonValue = (
  value,
  {
    ancestors = new Set(),
    depth = 0,
    path = "$",
    state = {
      nodeCount: 0,
    },
  } = {}
) => {
  state.nodeCount += 1;

  if (depth > MAX_CANONICAL_JSON_DEPTH) {
    throwInvalidJson(path, "maximum nesting depth exceeded");
  }

  if (state.nodeCount > MAX_CANONICAL_JSON_NODES) {
    throwInvalidJson(path, "maximum value count exceeded");
  }

  if (value === null) {
    return "null";
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throwInvalidJson(path, "number must be finite");
    }

    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throwInvalidJson(path, "cyclic references are not supported");
    }

    if (Object.getOwnPropertySymbols(value).length > 0) {
      throwInvalidJson(path, "symbol keys are not supported");
    }

    const expectedPropertyNames = new Set(["length"]);
    for (let index = 0; index < value.length; index += 1) {
      expectedPropertyNames.add(String(index));
    }

    for (const propertyName of Object.getOwnPropertyNames(value)) {
      if (!expectedPropertyNames.has(propertyName)) {
        throwInvalidJson(
          `${path}.${propertyName}`,
          "custom array properties are not supported"
        );
      }
    }

    ancestors.add(value);
    const items = [];

    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));

      if (!descriptor) {
        throwInvalidJson(`${path}[${index}]`, "sparse array entries are not supported");
      }

      if (!("value" in descriptor) || !descriptor.enumerable) {
        throwInvalidJson(
          `${path}[${index}]`,
          "array entries must be enumerable data properties"
        );
      }

      items.push(
        canonicalizeJsonValue(descriptor.value, {
          ancestors,
          depth: depth + 1,
          path: `${path}[${index}]`,
          state,
        })
      );
    }

    ancestors.delete(value);
    return `[${items.join(",")}]`;
  }

  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);

    if (prototype !== Object.prototype && prototype !== null) {
      throwInvalidJson(path, "only plain JSON objects are supported");
    }

    if (ancestors.has(value)) {
      throwInvalidJson(path, "cyclic references are not supported");
    }

    const symbolKeys = Object.getOwnPropertySymbols(value);

    if (symbolKeys.length > 0) {
      throwInvalidJson(path, "symbol keys are not supported");
    }

    ancestors.add(value);
    const entries = Object.getOwnPropertyNames(value)
      .sort()
      .map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);

        if (!descriptor || !("value" in descriptor)) {
          throwInvalidJson(`${path}.${key}`, "accessor properties are not supported");
        }

        if (!descriptor.enumerable) {
          throwInvalidJson(
            `${path}.${key}`,
            "non-enumerable properties are not supported"
          );
        }

        return `${JSON.stringify(key)}:${canonicalizeJsonValue(descriptor.value, {
          ancestors,
          depth: depth + 1,
          path: `${path}.${key}`,
          state,
        })}`;
      });

    ancestors.delete(value);
    return `{${entries.join(",")}}`;
  }

  throwInvalidJson(path, `${typeof value} values are not supported`);
};

const cloneCanonicalJson = (value) => JSON.parse(canonicalizeJsonValue(value));

const normalizeBindingMetadata = ({
  accessScope = {},
  capabilityId,
  capabilityVersion,
} = {}) => {
  const normalizedCapabilityId = normalizeText(capabilityId);
  const normalizedCapabilityVersion = normalizeText(capabilityVersion);

  if (!normalizedCapabilityId || !normalizedCapabilityVersion) {
    throw createSnapshotError(
      APPROVAL_EXECUTION_SNAPSHOT_ERROR_CODES.invalidMetadata,
      "Approval execution snapshot requires capabilityId and capabilityVersion."
    );
  }

  return {
    accessScope: normalizeTaskAccessScope(accessScope),
    capabilityId: normalizedCapabilityId,
    capabilityVersion: normalizedCapabilityVersion,
  };
};

const buildApprovalObjectHash = ({
  accessScope,
  capabilityId,
  capabilityVersion,
  executionInput,
  inputPreview,
  snapshotVersion,
} = {}) => {
  const canonicalSubject = canonicalizeJsonValue({
    accessScope,
    capabilityId,
    capabilityVersion,
    executionInput,
    inputPreview,
    snapshotVersion,
  });

  return `sha256:${createHash("sha256").update(canonicalSubject, "utf8").digest("hex")}`;
};

const assertPrivateSnapshot = (privateSnapshot) => {
  if (
    !privateSnapshot ||
    typeof privateSnapshot !== "object" ||
    Array.isArray(privateSnapshot) ||
    !Object.hasOwn(privateSnapshot, "executionInput")
  ) {
    throw createSnapshotError(
      APPROVAL_EXECUTION_SNAPSHOT_ERROR_CODES.missingSnapshot,
      "Approval execution snapshot is missing."
    );
  }

  if (
    privateSnapshot.snapshotVersion !==
    APPROVAL_EXECUTION_SNAPSHOT_VERSION
  ) {
    throw createSnapshotError(
      APPROVAL_EXECUTION_SNAPSHOT_ERROR_CODES.unsupportedVersion,
      "Approval execution snapshot version is not supported."
    );
  }
};

const hashesMatch = (left, right) => {
  const leftBuffer = Buffer.from(String(left ?? ""), "utf8");
  const rightBuffer = Buffer.from(String(right ?? ""), "utf8");

  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
};

export const createApprovalExecutionSnapshot = ({
  accessScope = {},
  capabilityId,
  capabilityVersion,
  executionInput = {},
  inputPreview = {},
} = {}) => {
  const metadata = normalizeBindingMetadata({
    accessScope,
    capabilityId,
    capabilityVersion,
  });
  const normalizedExecutionInput = cloneCanonicalJson(executionInput);
  const normalizedInputPreview = cloneCanonicalJson(inputPreview);
  const approvalObjectHash = buildApprovalObjectHash({
    ...metadata,
    executionInput: normalizedExecutionInput,
    inputPreview: normalizedInputPreview,
    snapshotVersion: APPROVAL_EXECUTION_SNAPSHOT_VERSION,
  });

  return {
    approvalObjectHash,
    snapshotVersion: APPROVAL_EXECUTION_SNAPSHOT_VERSION,
    privateSnapshot: {
      executionInput: normalizedExecutionInput,
      snapshotVersion: APPROVAL_EXECUTION_SNAPSHOT_VERSION,
    },
  };
};

export const cloneApprovalExecutionInput = (privateSnapshot) => {
  assertPrivateSnapshot(privateSnapshot);
  return cloneCanonicalJson(privateSnapshot.executionInput);
};

export const verifyApprovalExecutionSnapshot = ({
  accessScope = {},
  approvalObjectHash,
  capabilityId,
  capabilityVersion,
  inputPreview = {},
  privateSnapshot,
} = {}) => {
  assertPrivateSnapshot(privateSnapshot);
  const metadata = normalizeBindingMetadata({
    accessScope,
    capabilityId,
    capabilityVersion,
  });
  const executionInput = cloneApprovalExecutionInput(privateSnapshot);
  const normalizedInputPreview = cloneCanonicalJson(inputPreview);
  const expectedHash = buildApprovalObjectHash({
    ...metadata,
    executionInput,
    inputPreview: normalizedInputPreview,
    snapshotVersion: privateSnapshot.snapshotVersion,
  });

  if (!hashesMatch(approvalObjectHash, expectedHash)) {
    throw createSnapshotError(
      APPROVAL_EXECUTION_SNAPSHOT_ERROR_CODES.hashMismatch,
      "Approval object does not match the persisted execution snapshot."
    );
  }

  return executionInput;
};
