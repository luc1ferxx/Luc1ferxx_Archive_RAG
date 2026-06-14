import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPABILITY_IDS,
  CAPABILITY_POLICY_DECISIONS,
  createCapabilityRegistry,
  createDefaultCapabilityRegistry,
  evaluateCapabilityPolicy,
  validateCapabilityContract,
} from "../rag/capabilities/index.js";
import { isAgentRunInterrupt } from "../rag/agent-interrupts.js";

test("capability registry validates and describes tool adapters", async () => {
  const capability = {
    id: "test.echo",
    version: "1.0.0",
    label: "Echo",
    inputSchema: {
      type: "object",
    },
    accessScope: {
      required: false,
    },
    approvalPolicy: {
      mode: "direct",
    },
    privacyPolicy: {
      externalCall: false,
    },
    execute: async ({ input }) => input,
  };
  const registry = createCapabilityRegistry([capability]);

  assert.equal(validateCapabilityContract(capability), capability);
  assert.equal(registry.describe("test.echo").label, "Echo");
  assert.equal(registry.list().length, 1);
  await assert.rejects(
    async () =>
      createCapabilityRegistry([
        capability,
        {
          ...capability,
        },
      ]),
    /Duplicate AgentRAG capability id/
  );
});

test("built-in capabilities execute arxiv, web, and document discovery adapters", async () => {
  const arxivCalls = [];
  const webCalls = [];
  const registry = createDefaultCapabilityRegistry({
    arxivImportService: {
      importTopic: async ({ accessScope, maxResults, topic }) => {
        arxivCalls.push({
          accessScope,
          maxResults,
          topic,
        });

        return {
          importedCount: 1,
          topic,
        };
      },
    },
    ragService: {
      listDocuments: () => [
        {
          docId: "doc-remote",
          fileName: "remote-work.pdf",
          profile: {
            summary: "Remote work approvals and manager review.",
            tags: ["remote", "approval"],
          },
        },
        {
          docId: "doc-security",
          fileName: "security.pdf",
          profile: {
            summary: "MFA and device security.",
            tags: ["security"],
          },
        },
      ],
    },
    webChatService: async (question) => {
      webCalls.push(question);

      return {
        text: "web answer",
      };
    },
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };

  const arxivResult = await registry.execute(CAPABILITY_IDS.arxivImportTopic, {
    accessScope,
    approval: {
      approved: true,
    },
    input: {
      maxResults: 99,
      topic: "retrieval augmented generation",
    },
  });
  const discoveryResult = await registry.execute(CAPABILITY_IDS.documentDiscovery, {
    accessScope,
    input: {
      question: "remote approval",
    },
  });
  const webResult = await registry.execute(CAPABILITY_IDS.webSearch, {
    input: {
      question: "latest policy",
    },
  });

  assert.equal(arxivResult.importedCount, 1);
  assert.equal(arxivCalls[0].maxResults, 10);
  assert.deepEqual(arxivCalls[0].accessScope, accessScope);
  assert.equal(discoveryResult.matches[0].document.docId, "doc-remote");
  assert.equal(webResult.text, "web answer");
  assert.deepEqual(webCalls, ["latest policy"]);
  assert.equal(
    registry.describe(CAPABILITY_IDS.arxivImportTopic).privacyPolicy.externalCall,
    true
  );
});

test("capability policy blocks execution until required approval is granted", async () => {
  const calls = [];
  const capability = {
    id: "paper.import",
    version: "1.0.0",
    label: "Paper Import",
    inputSchema: {
      type: "object",
      required: ["topic"],
      properties: {
        topic: {
          type: "string",
        },
      },
    },
    accessScope: {
      required: true,
    },
    approvalPolicy: {
      mode: "user_confirmation",
      writesWorkspace: true,
      userConfirmationRequired: true,
    },
    privacyPolicy: {
      externalCall: true,
      sanitizedInputFields: ["topic"],
      storesResult: true,
    },
    execute: async ({ input, policy }) => {
      calls.push({
        input,
        policy,
      });

      return {
        topic: input.topic,
      };
    },
  };
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  const registry = createCapabilityRegistry([capability]);
  const policyResult = evaluateCapabilityPolicy(capability, {
    accessScope,
    input: {
      topic: "  retrieval augmented generation  ",
    },
  });

  assert.equal(policyResult.decision, CAPABILITY_POLICY_DECISIONS.needsApproval);
  assert.equal(policyResult.approvalGate.inputPreview.topic, "retrieval augmented generation");
  assert.deepEqual(policyResult.riskFlags, [
    "external_call",
    "writes_workspace",
    "stores_result",
  ]);

  await assert.rejects(
    async () =>
      registry.execute("paper.import", {
        accessScope,
        input: {
          topic: "  retrieval augmented generation  ",
        },
      }),
    (error) => {
      assert.equal(isAgentRunInterrupt(error), true);
      assert.equal(error.type, "capability_approval_required");
      assert.equal(
        error.detail.approvalGate.inputPreview.topic,
        "retrieval augmented generation"
      );
      return true;
    }
  );
  assert.equal(calls.length, 0);

  const result = await registry.execute("paper.import", {
    accessScope,
    approval: {
      decision: "approved",
    },
    input: {
      topic: "  retrieval augmented generation  ",
    },
  });

  assert.equal(result.topic, "retrieval augmented generation");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].policy.decision, CAPABILITY_POLICY_DECISIONS.allowed);
});
