import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExecutionBoundaryContext,
  filterInputForExecutionBoundary,
  validateExecutionBoundaryPolicy,
} from "../rag/execution-boundary.js";

test("execution boundary validates sandbox and refs-only secret policy", () => {
  const validation = validateExecutionBoundaryPolicy({
    approvalPolicy: {
      writesWorkspace: false,
    },
    capabilityId: "connector.test_echo",
    privacyPolicy: {
      externalCall: true,
    },
    sandboxPolicy: {
      allowNetwork: true,
      allowWorkspaceWrite: false,
      profile: "connector_external_read",
      timeoutMs: 30_000,
    },
    secretPolicy: {
      exposure: "refs_only",
      optionalSecretRefs: ["OPTIONAL_TEST_TOKEN"],
      requiredSecretRefs: ["TEST_CONNECTOR_API_TOKEN"],
    },
  });

  assert.equal(validation.valid, true, validation.errors.join("\n"));
  assert.equal(validation.secretRefCount, 2);
  assert.deepEqual(validation.sandboxPolicy, {
    allowNetwork: true,
    allowWorkspaceWrite: false,
    maxOutputBytes: 65536,
    profile: "connector_external_read",
    retryable: false,
    timeoutMs: 30000,
    version: "1.0.0",
  });
});

test("execution boundary rejects missing sandbox, secret values, and write mismatch", () => {
  const validation = validateExecutionBoundaryPolicy({
    approvalPolicy: {
      writesWorkspace: true,
    },
    capabilityId: "connector.write",
    privacyPolicy: {
      externalCall: true,
    },
    sandboxPolicy: {
      allowNetwork: false,
      allowWorkspaceWrite: false,
    },
    secretPolicy: {
      exposure: "values",
      requiredSecretRefs: ["sk-live-secret"],
    },
  });

  assert.equal(validation.valid, false);
  assert.ok(
    validation.errors.some((error) => /sandboxPolicy\.profile/.test(error)),
    validation.errors.join("\n")
  );
  assert.ok(
    validation.errors.some((error) => /allowNetwork/.test(error)),
    validation.errors.join("\n")
  );
  assert.ok(
    validation.errors.some((error) => /allowWorkspaceWrite/.test(error)),
    validation.errors.join("\n")
  );
  assert.ok(
    validation.errors.some((error) => /refs_only/.test(error)),
    validation.errors.join("\n")
  );
  assert.ok(
    validation.errors.some((error) => /uppercase secret name/.test(error)),
    validation.errors.join("\n")
  );
});

test("execution boundary context exposes secret refs only and filters extra input", () => {
  const context = buildExecutionBoundaryContext({
    sandboxPolicy: {
      allowNetwork: true,
      profile: "connector_external_read",
    },
    secretPolicy: {
      requiredSecretRefs: ["TEST_CONNECTOR_API_TOKEN"],
    },
  });
  const input = filterInputForExecutionBoundary({
    input: {
      apiKey: "sk-test-secret-value",
      message: "hello",
    },
    inputSchema: {
      properties: {
        message: {
          type: "string",
        },
      },
      type: "object",
    },
  });

  assert.deepEqual(context.secrets, {
    exposure: "refs_only",
    optionalRefs: [],
    requiredRefs: ["TEST_CONNECTOR_API_TOKEN"],
  });
  assert.doesNotMatch(JSON.stringify(context), /sk-test-secret-value/);
  assert.deepEqual(input, {
    message: "hello",
  });
});
