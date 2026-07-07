import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExecutionBoundaryContext,
  executeWithinExecutionBoundary,
  filterInputForExecutionBoundary,
  resolveExecutionBoundarySecretRefs,
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
    availableRefs: [],
    exposure: "refs_only",
    missingRequiredRefs: [],
    optionalRefs: [],
    requiredRefs: ["TEST_CONNECTOR_API_TOKEN"],
  });
  assert.doesNotMatch(JSON.stringify(context), /sk-test-secret-value/);
  assert.deepEqual(input, {
    message: "hello",
  });
});

test("execution boundary resolves secret refs without exposing values", async () => {
  const resolved = await resolveExecutionBoundarySecretRefs({
    secretPolicy: {
      optionalSecretRefs: ["OPTIONAL_TEST_TOKEN"],
      requiredSecretRefs: ["TEST_CONNECTOR_API_TOKEN"],
    },
    secretResolver: {
      TEST_CONNECTOR_API_TOKEN: "sk-test-secret-value",
    },
  });

  assert.deepEqual(resolved, {
    availableRefs: ["TEST_CONNECTOR_API_TOKEN"],
    missingRequiredRefs: [],
    optionalRefs: ["OPTIONAL_TEST_TOKEN"],
    requiredRefs: ["TEST_CONNECTOR_API_TOKEN"],
  });
  assert.doesNotMatch(JSON.stringify(resolved), /sk-test-secret-value/);

  const missing = await resolveExecutionBoundarySecretRefs({
    secretPolicy: {
      requiredSecretRefs: ["MISSING_TOKEN"],
    },
  });

  assert.deepEqual(missing.missingRequiredRefs, ["MISSING_TOKEN"]);
});

test("execution boundary wraps executors with required secret and output controls", async () => {
  const calls = [];
  const result = await executeWithinExecutionBoundary({
    executor: async ({ executionBoundary, input, services }) => {
      calls.push({
        executionBoundary,
        hasSecretResolver: Boolean(services.secretResolver),
        input,
      });

      return {
        text: input.message,
      };
    },
    payload: {
      input: {
        message: "hello",
      },
    },
    sandboxPolicy: {
      maxOutputBytes: 128,
      profile: "connector_external_read",
      timeoutMs: 1000,
    },
    secretPolicy: {
      requiredSecretRefs: ["TEST_CONNECTOR_API_TOKEN"],
    },
    services: {
      secretResolver: {
        TEST_CONNECTOR_API_TOKEN: "sk-test-secret-value",
      },
    },
  });

  assert.deepEqual(result, {
    text: "hello",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].hasSecretResolver, false);
  assert.deepEqual(calls[0].executionBoundary.secrets.availableRefs, [
    "TEST_CONNECTOR_API_TOKEN",
  ]);
  assert.deepEqual(calls[0].executionBoundary.secrets.missingRequiredRefs, []);
  assert.doesNotMatch(JSON.stringify(calls), /sk-test-secret-value/);

  await assert.rejects(
    () =>
      executeWithinExecutionBoundary({
        executor: async () => ({
          text: "hello",
        }),
        sandboxPolicy: {
          profile: "connector_external_read",
        },
        secretPolicy: {
          requiredSecretRefs: ["MISSING_TOKEN"],
        },
      }),
    /missing required secret refs/
  );

  await assert.rejects(
    () =>
      executeWithinExecutionBoundary({
        executor: async () => ({
          text: "x".repeat(200),
        }),
        sandboxPolicy: {
          maxOutputBytes: 32,
          profile: "connector_external_read",
        },
        secretPolicy: {
          requiredSecretRefs: [],
        },
      }),
    /maxOutputBytes/
  );
});

test("execution boundary delegates execution through an injected sandbox runner", async () => {
  const calls = [];
  const result = await executeWithinExecutionBoundary({
    executor: async ({ input }) => ({
      text: input.message,
    }),
    payload: {
      input: {
        message: "from sandbox",
      },
    },
    sandboxPolicy: {
      profile: "connector_external_read",
    },
    secretPolicy: {
      requiredSecretRefs: [],
    },
    services: {
      sandboxRunner: async ({ execute, executionBoundary, payload }) => {
        calls.push({
          executionBoundary,
          payload,
        });

        return execute();
      },
    },
  });

  assert.deepEqual(result, {
    text: "from sandbox",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executionBoundary.sandbox.profile, "connector_external_read");
  assert.doesNotMatch(JSON.stringify(calls[0]), /sk-test-secret-value/);
});
