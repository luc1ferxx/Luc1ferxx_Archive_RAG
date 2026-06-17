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
    () =>
      registry.execute("shell.exec", {
        input: {
          command: "pwd",
        },
      }),
    /Unknown AgentRAG capability id/
  );
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

test("built-in capabilities execute whitelisted adapters", async () => {
  const arxivCalls = [];
  const compareCalls = [];
  const importCalls = [];
  const webCalls = [];
  const registry = createDefaultCapabilityRegistry({
    arxivEnrichmentService: {
      importForDocument: async ({
        accessScope,
        docId,
        selectedArxivIds,
        selectionToken,
      }) => {
        importCalls.push({
          accessScope,
          docId,
          selectedArxivIds,
          selectionToken,
        });

        return {
          importedCount: 1,
          skippedCount: 0,
          failedCount: 0,
          importedPapers: [
            {
              arxivId: "2401.00001v1",
              docId: "doc-imported",
              fileName: "paper.pdf",
              title: "Imported Paper",
            },
          ],
          skippedPapers: [],
        };
      },
    },
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
      chat: async (docIds, question, options) => {
        compareCalls.push({
          docIds,
          options,
          question,
        });

        return {
          text: "Remote work policies differ on allowed days. [Source 1] [Source 2]",
          citations: [
            {
              docId: docIds[0],
              fileName: "remote-work.pdf",
              pageNumber: 1,
              excerpt: "Policy A allows two remote days.",
            },
            {
              docId: docIds[1],
              fileName: "security.pdf",
              pageNumber: 2,
              excerpt: "Policy B allows three remote days.",
            },
          ],
        };
      },
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
    approval: {
      approved: true,
    },
    input: {
      question: "remote approval",
    },
  });
  const searchResult = await registry.execute(
    CAPABILITY_IDS.workspaceSearchDocuments,
    {
      accessScope,
      approval: {
        approved: true,
      },
      input: {
        limit: 2,
        query: "remote approval",
      },
    }
  );
  const citationResult = await registry.execute(CAPABILITY_IDS.citationVerify, {
    input: {
      answerText: "Remote work requires manager approval.",
      citations: [
        {
          docId: "doc-remote",
          fileName: "remote-work.pdf",
          excerpt: "Remote work requires manager approval.",
        },
      ],
    },
  });
  const reportResult = await registry.execute(CAPABILITY_IDS.reportExport, {
    accessScope,
    approval: {
      approved: true,
    },
    input: {
      title: "Remote Work Report",
      content: "Remote work requires approval.",
      format: "markdown",
      citations: [
        {
          docId: "doc-remote",
          fileName: "remote-work.pdf",
          pageNumber: 1,
        },
      ],
    },
  });
  const importResult = await registry.execute(
    CAPABILITY_IDS.recommendationImportSelected,
    {
      accessScope,
      approval: {
        approved: true,
      },
      input: {
        provider: "arxiv",
        docId: "doc-remote",
        selectedIds: ["2401.00001v1"],
        selectionToken: "selection-token",
      },
    }
  );
  const compareResult = await registry.execute(
    CAPABILITY_IDS.documentCompareBatch,
    {
      accessScope,
      approval: {
        approved: true,
      },
      input: {
        question: "Compare remote work limits.",
        docIds: ["doc-remote", "doc-security"],
      },
    }
  );
  const webResult = await registry.execute(CAPABILITY_IDS.webSearch, {
    approval: {
      approved: true,
    },
    input: {
      question: "latest policy",
    },
  });

  assert.equal(arxivResult.importedCount, 1);
  assert.equal(arxivCalls[0].maxResults, 10);
  assert.deepEqual(arxivCalls[0].accessScope, accessScope);
  assert.equal(discoveryResult.matches[0].document.docId, "doc-remote");
  assert.equal(searchResult.matches[0].document.docId, "doc-remote");
  assert.equal(citationResult.passed, true);
  assert.equal(reportResult.report.fileName, "remote-work-report.md");
  assert.equal(importResult.importedCount, 1);
  assert.deepEqual(importCalls[0].selectedArxivIds, ["2401.00001v1"]);
  assert.equal(compareResult.comparisons.length, 1);
  assert.deepEqual(compareCalls[0].docIds, ["doc-remote", "doc-security"]);
  assert.deepEqual(compareCalls[0].options.accessScope, accessScope);
  assert.equal(webResult.text, "web answer");
  assert.deepEqual(webCalls, ["latest policy"]);
  assert.equal(
    registry.describe(CAPABILITY_IDS.arxivImportTopic).privacyPolicy.externalCall,
    true
  );
});

test("built-in capability policies require approval before agent actions", async () => {
  const registry = createDefaultCapabilityRegistry({
    arxivImportService: {
      importTopic: async () => {
        throw new Error("arXiv import should wait for approval.");
      },
    },
    ragService: {
      listDocuments: () => [],
      chat: async () => {
        throw new Error("Document compare should wait for approval.");
      },
    },
    arxivEnrichmentService: {
      importForDocument: async () => {
        throw new Error("Recommendation import should wait for approval.");
      },
    },
    webChatService: async () => {
      throw new Error("Web search should wait for approval.");
    },
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  const cases = [
    {
      id: CAPABILITY_IDS.arxivImportTopic,
      input: {
        maxResults: 2,
        topic: "retrieval augmented generation",
      },
      preview: {
        maxResults: 2,
        topic: "retrieval augmented generation",
      },
    },
    {
      id: CAPABILITY_IDS.webSearch,
      input: {
        question: "latest launch date",
      },
      preview: {
        question: "latest launch date",
      },
    },
    {
      id: CAPABILITY_IDS.documentDiscovery,
      input: {
        docIds: ["doc-1"],
        question: "remote work policy",
      },
      preview: {
        docIds: ["doc-1"],
        question: "remote work policy",
      },
    },
    {
      id: CAPABILITY_IDS.workspaceSearchDocuments,
      input: {
        docIds: ["doc-1"],
        limit: 3,
        query: "remote work",
      },
      preview: {
        docIds: ["doc-1"],
        limit: 3,
        query: "remote work",
      },
    },
    {
      id: CAPABILITY_IDS.reportExport,
      input: {
        title: "Risk report",
        content: "Sensitive report body.",
        format: "markdown",
      },
      preview: {
        title: "Risk report",
        format: "markdown",
      },
    },
    {
      id: CAPABILITY_IDS.recommendationImportSelected,
      input: {
        provider: "arxiv",
        docId: "doc-1",
        selectedIds: ["2401.00001v1"],
        selectionToken: "selection-token",
      },
      preview: {
        provider: "arxiv",
        docId: "doc-1",
        selectedIds: ["2401.00001v1"],
      },
    },
    {
      id: CAPABILITY_IDS.documentCompareBatch,
      input: {
        question: "Compare policies.",
        docIds: ["doc-1", "doc-2"],
      },
      preview: {
        question: "Compare policies.",
        docIds: ["doc-1", "doc-2"],
      },
    },
  ];

  for (const testCase of cases) {
    const capability = registry.get(testCase.id);
    const description = registry.describe(testCase.id);
    const policyResult = evaluateCapabilityPolicy(capability, {
      accessScope,
      input: testCase.input,
    });

    assert.equal(description.approvalPolicy.userConfirmationRequired, true);
    assert.deepEqual(
      policyResult.decision,
      CAPABILITY_POLICY_DECISIONS.needsApproval
    );
    assert.equal(policyResult.approvalGate.capabilityId, testCase.id);
    assert.deepEqual(policyResult.approvalGate.inputPreview, testCase.preview);
    await assert.rejects(
      () =>
        registry.execute(testCase.id, {
          accessScope,
          input: testCase.input,
        }),
      (error) => {
        assert.equal(isAgentRunInterrupt(error), true);
        assert.equal(error.type, "capability_approval_required");
        return true;
      }
    );
  }

  const citationCapability = registry.get(CAPABILITY_IDS.citationVerify);
  const citationPolicyResult = evaluateCapabilityPolicy(citationCapability, {
    input: {
      answerText: "Remote work requires manager approval.",
      citations: [
        {
          docId: "doc-1",
          excerpt: "Remote work requires manager approval.",
        },
      ],
    },
  });

  assert.equal(
    citationPolicyResult.decision,
    CAPABILITY_POLICY_DECISIONS.allowed
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
