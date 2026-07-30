import assert from "node:assert/strict";
import test from "node:test";

import {
  APPROVAL_EXECUTION_SNAPSHOT_ERROR_CODES,
  APPROVAL_EXECUTION_SNAPSHOT_VERSION,
  createApprovalExecutionSnapshot,
  verifyApprovalExecutionSnapshot,
} from "../rag/capabilities/approval-execution-snapshot.js";

const accessScope = {
  userId: "alice",
  workspaceId: "workspace-a",
};

test("approval execution snapshots bind the complete JSON input independent of object key insertion order", () => {
  const longDescription = "x".repeat(300);
  const first = createApprovalExecutionSnapshot({
    accessScope,
    capabilityId: "task.create",
    capabilityVersion: "1.0.0",
    executionInput: {
      description: longDescription,
      metadata: {
        owner: "alice",
        priority: 1,
      },
      tags: Array.from({ length: 12 }, (_, index) => `tag-${index + 1}`),
      title: "Review renewal risk",
    },
    inputPreview: {
      description: longDescription.slice(0, 240),
      tags: Array.from({ length: 10 }, (_, index) => `tag-${index + 1}`),
      title: "Review renewal risk",
    },
  });
  const reordered = createApprovalExecutionSnapshot({
    accessScope: {
      workspaceId: "workspace-a",
      userId: "alice",
    },
    capabilityId: "task.create",
    capabilityVersion: "1.0.0",
    executionInput: {
      title: "Review renewal risk",
      tags: Array.from({ length: 12 }, (_, index) => `tag-${index + 1}`),
      metadata: {
        priority: 1,
        owner: "alice",
      },
      description: longDescription,
    },
    inputPreview: {
      title: "Review renewal risk",
      tags: Array.from({ length: 10 }, (_, index) => `tag-${index + 1}`),
      description: longDescription.slice(0, 240),
    },
  });

  assert.equal(first.snapshotVersion, APPROVAL_EXECUTION_SNAPSHOT_VERSION);
  assert.match(first.approvalObjectHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.approvalObjectHash, reordered.approvalObjectHash);
  assert.equal(first.privateSnapshot.executionInput.description.length, 300);
  assert.equal(first.privateSnapshot.executionInput.tags.length, 12);
  assert.deepEqual(first.privateSnapshot.executionInput.metadata, {
    owner: "alice",
    priority: 1,
  });
});

test("verified approval execution snapshots return an isolated clone of the complete input", () => {
  const executionInput = {
    metadata: {
      owner: "alice",
    },
    tags: ["tag-1", "tag-2"],
    title: "Review renewal risk",
  };
  const inputPreview = {
    tags: ["tag-1"],
    title: "Review renewal risk",
  };
  const snapshot = createApprovalExecutionSnapshot({
    accessScope,
    capabilityId: "task.create",
    capabilityVersion: "1.0.0",
    executionInput,
    inputPreview,
  });
  executionInput.metadata.owner = "mallory";
  executionInput.tags.push("mutated-before-verification");
  const firstInput = verifyApprovalExecutionSnapshot({
    accessScope,
    approvalObjectHash: snapshot.approvalObjectHash,
    capabilityId: "task.create",
    capabilityVersion: "1.0.0",
    inputPreview,
    privateSnapshot: snapshot.privateSnapshot,
  });

  firstInput.metadata.owner = "mallory";
  firstInput.tags.push("mutated");

  const secondInput = verifyApprovalExecutionSnapshot({
    accessScope,
    approvalObjectHash: snapshot.approvalObjectHash,
    capabilityId: "task.create",
    capabilityVersion: "1.0.0",
    inputPreview,
    privateSnapshot: snapshot.privateSnapshot,
  });

  assert.deepEqual(secondInput, {
    metadata: {
      owner: "alice",
    },
    tags: ["tag-1", "tag-2"],
    title: "Review renewal risk",
  });
});

test("approval snapshot verification rejects any changed approval subject field", () => {
  const inputPreview = {
    title: "Review renewal risk",
  };
  const snapshot = createApprovalExecutionSnapshot({
    accessScope,
    capabilityId: "task.create",
    capabilityVersion: "1.0.0",
    executionInput: {
      description: "Track the complete approved operation.",
      title: "Review renewal risk",
    },
    inputPreview,
  });
  const baseVerification = {
    accessScope,
    approvalObjectHash: snapshot.approvalObjectHash,
    capabilityId: "task.create",
    capabilityVersion: "1.0.0",
    inputPreview,
    privateSnapshot: snapshot.privateSnapshot,
  };
  const changedSubjects = [
    {
      ...baseVerification,
      approvalObjectHash: `sha256:${"0".repeat(64)}`,
    },
    {
      ...baseVerification,
      accessScope: {
        ...accessScope,
        workspaceId: "workspace-b",
      },
    },
    {
      ...baseVerification,
      capabilityId: "summary.create",
    },
    {
      ...baseVerification,
      capabilityVersion: "2.0.0",
    },
    {
      ...baseVerification,
      inputPreview: {
        title: "A different public preview",
      },
    },
    {
      ...baseVerification,
      privateSnapshot: {
        ...snapshot.privateSnapshot,
        executionInput: {
          ...snapshot.privateSnapshot.executionInput,
          title: "A different private execution input",
        },
      },
    },
  ];

  for (const changedSubject of changedSubjects) {
    assert.throws(
      () => verifyApprovalExecutionSnapshot(changedSubject),
      (error) => {
        assert.equal(error.status, 409);
        assert.equal(
          error.code,
          APPROVAL_EXECUTION_SNAPSHOT_ERROR_CODES.hashMismatch
        );
        return true;
      }
    );
  }
});

test("approval execution snapshots reject values that cannot round-trip as canonical JSON", () => {
  const cyclic = {
    title: "cyclic",
  };
  cyclic.self = cyclic;
  const sparseTags = [];
  sparseTags.length = 1;
  const inputCases = [
    {
      title: "undefined",
      metadata: {
        owner: undefined,
      },
    },
    {
      title: "non-finite",
      score: Number.POSITIVE_INFINITY,
    },
    {
      title: "bigint",
      count: 1n,
    },
    {
      title: "date",
      dueAt: new Date("2026-07-30T00:00:00.000Z"),
    },
    {
      title: "buffer",
      bytes: Buffer.from("secret"),
    },
    {
      title: "function",
      execute: () => {},
    },
    {
      title: "sparse-array",
      tags: sparseTags,
    },
    cyclic,
  ];

  for (const executionInput of inputCases) {
    assert.throws(
      () =>
        createApprovalExecutionSnapshot({
          accessScope,
          capabilityId: "task.create",
          capabilityVersion: "1.0.0",
          executionInput,
          inputPreview: {
            title: executionInput.title,
          },
        }),
      (error) => {
        assert.equal(error.status, 409);
        assert.equal(
          error.code,
          APPROVAL_EXECUTION_SNAPSHOT_ERROR_CODES.invalidJson
        );
        return true;
      }
    );
  }
});

test("approval execution snapshots reject hidden own properties instead of silently omitting execution input", () => {
  const executionInput = {
    title: "Review renewal risk",
  };
  Object.defineProperty(executionInput, "hiddenInstruction", {
    configurable: true,
    enumerable: false,
    value: "must remain bound to approval",
  });

  assert.throws(
    () =>
      createApprovalExecutionSnapshot({
        accessScope,
        capabilityId: "task.create",
        capabilityVersion: "1.0.0",
        executionInput,
        inputPreview: {
          title: executionInput.title,
        },
      }),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(
        error.code,
        APPROVAL_EXECUTION_SNAPSHOT_ERROR_CODES.invalidJson
      );
      return true;
    }
  );
});

test("approval execution snapshots reject custom, accessor, and symbolic array properties", () => {
  const customPropertyArray = ["one"];
  customPropertyArray.extra = "hidden-from-json";
  const accessorArray = ["one"];
  Object.defineProperty(accessorArray, "0", {
    enumerable: true,
    get: () => "computed",
  });
  const symbolicArray = ["one"];
  symbolicArray[Symbol("hidden")] = "hidden-from-json";

  for (const tags of [customPropertyArray, accessorArray, symbolicArray]) {
    assert.throws(
      () =>
        createApprovalExecutionSnapshot({
          accessScope,
          capabilityId: "task.create",
          capabilityVersion: "1.0.0",
          executionInput: {
            tags,
          },
          inputPreview: {},
        }),
      (error) => {
        assert.equal(error.status, 409);
        assert.equal(
          error.code,
          APPROVAL_EXECUTION_SNAPSHOT_ERROR_CODES.invalidJson
        );
        return true;
      }
    );
  }
});

test("approval execution snapshots reject excessively deep JSON without overflowing", () => {
  const executionInput = {};
  let current = executionInput;

  for (let depth = 0; depth < 80; depth += 1) {
    current.nested = {};
    current = current.nested;
  }

  assert.throws(
    () =>
      createApprovalExecutionSnapshot({
        accessScope,
        capabilityId: "task.create",
        capabilityVersion: "1.0.0",
        executionInput,
        inputPreview: {},
      }),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(
        error.code,
        APPROVAL_EXECUTION_SNAPSHOT_ERROR_CODES.invalidJson
      );
      assert.match(error.message, /maximum nesting depth/i);
      return true;
    }
  );
});

test("approval execution snapshot verification fails closed for missing and unsupported records", () => {
  assert.throws(
    () =>
      verifyApprovalExecutionSnapshot({
        accessScope,
        approvalObjectHash: `sha256:${"0".repeat(64)}`,
        capabilityId: "task.create",
        capabilityVersion: "1.0.0",
        inputPreview: {},
        privateSnapshot: null,
      }),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(
        error.code,
        APPROVAL_EXECUTION_SNAPSHOT_ERROR_CODES.missingSnapshot
      );
      return true;
    }
  );

  assert.throws(
    () =>
      verifyApprovalExecutionSnapshot({
        accessScope,
        approvalObjectHash: `sha256:${"0".repeat(64)}`,
        capabilityId: "task.create",
        capabilityVersion: "1.0.0",
        inputPreview: {},
        privateSnapshot: {
          executionInput: {},
          snapshotVersion: 999,
        },
      }),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(
        error.code,
        APPROVAL_EXECUTION_SNAPSHOT_ERROR_CODES.unsupportedVersion
      );
      return true;
    }
  );
});
