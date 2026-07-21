import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPABILITY_IDS,
  CAPABILITY_POLICY_DECISIONS,
  createCapabilityRegistry,
  createInMemoryActionTaskService,
  createDefaultCapabilityRegistry,
  evaluateCapabilityPolicy,
  validateCapabilityContract,
} from "../rag/capabilities/index.js";
import { isAgentRunInterrupt } from "../rag/agent-interrupts.js";
import {
  ARTIFACT_TYPES,
  createInMemoryWorkspaceArtifactStore,
  createWorkspaceArtifactService,
} from "../rag/workspace-artifacts/index.js";
import {
  TEST_CONNECTOR_CAPABILITY_ID,
  TEST_CONNECTOR_ID,
  createTestConnectorSpec,
} from "../rag/connectors/index.js";

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

test("default capability registry can mount connector capabilities explicitly", async () => {
  const calls = [];
  const registry = createDefaultCapabilityRegistry({
    connectorExecutors: {
      [TEST_CONNECTOR_CAPABILITY_ID]: async ({
        connector,
        connectorCapability,
        executionBoundary,
        input,
      }) => {
        calls.push({
          connector,
          connectorCapability,
          executionBoundary,
          input,
        });

        return {
          connectorId: connector.id,
          text: input.message,
        };
      },
    },
    connectors: [createTestConnectorSpec()],
  });
  const description = registry.describe(TEST_CONNECTOR_CAPABILITY_ID);

  assert.equal(description.id, TEST_CONNECTOR_CAPABILITY_ID);
  assert.equal(description.label, "Connector Echo");

  const result = await registry.execute(TEST_CONNECTOR_CAPABILITY_ID, {
    accessScope: {
      userId: "alice",
      workspaceId: "workspace-a",
    },
    approval: {
      approved: true,
    },
    input: {
      apiKey: "sk-test-secret-value",
      message: "hello connector",
    },
    services: {
      secretResolver: {
        TEST_CONNECTOR_API_TOKEN: "sk-test-secret-value",
      },
    },
  });

  assert.deepEqual(result, {
    connectorId: TEST_CONNECTOR_ID,
    text: "hello connector",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].connector.id, TEST_CONNECTOR_ID);
  assert.deepEqual(calls[0].input, {
    message: "hello connector",
  });
  assert.deepEqual(calls[0].executionBoundary.secrets.availableRefs, [
    "TEST_CONNECTOR_API_TOKEN",
  ]);
  assert.doesNotMatch(JSON.stringify(calls), /sk-test-secret-value/);
});

test("built-in capabilities execute whitelisted adapters", async () => {
  const arxivCalls = [];
  const compareCalls = [];
  const importCalls = [];
  const actionTaskService = createInMemoryActionTaskService();
  const workspaceArtifactService = createWorkspaceArtifactService({
    store: createInMemoryWorkspaceArtifactStore(),
  });
  const webCalls = [];
  const registry = createDefaultCapabilityRegistry({
    actionTaskService,
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
    workspaceArtifactService,
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
      answerText: "Remote work requires manager approval. [Source 1]",
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
  const taskResult = await registry.execute(CAPABILITY_IDS.taskCreate, {
    accessScope,
    approval: {
      approved: true,
    },
    input: {
      description: "Review renewal risks before Friday.",
      priority: "high",
      tags: ["renewal", "risk"],
      title: "Review renewal risks",
    },
  });
  const organizeResult = await registry.execute(CAPABILITY_IDS.documentOrganize, {
    accessScope,
    approval: {
      approved: true,
    },
    input: {
      docIds: ["doc-remote", "doc-security"],
      strategy: "profile_tags",
      taskId: "organization-task",
      title: "Policy folders",
    },
  });
  const summaryResult = await registry.execute(CAPABILITY_IDS.summaryCreate, {
    accessScope,
    approval: {
      approved: true,
    },
    input: {
      citations: [
        {
          docId: "doc-remote",
          pageNumber: 1,
        },
      ],
      docIds: ["doc-remote"],
      summary: "Remote work requires manager approval.",
      taskId: "summary-task",
      title: "Remote Work Summary",
    },
  });
  const externalImportResult = await registry.execute(
    CAPABILITY_IDS.externalImport,
    {
      accessScope,
      approval: {
        approved: true,
      },
      input: {
        provider: "url",
        sourceUrl: "https://example.test/policy.pdf",
        title: "External policy",
      },
    }
  );

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
  assert.equal(taskResult.task.status, "pending");
  assert.equal(taskResult.task.type, "agent_action");
  assert.equal(taskResult.task.action, "task.create");
  assert.equal(organizeResult.task.status, "completed");
  assert.equal(organizeResult.task.id, "organization-task");
  assert.deepEqual(organizeResult.organization.groups[0].docIds, ["doc-remote"]);
  assert.equal(summaryResult.task.status, "completed");
  assert.equal(summaryResult.task.id, "summary-task");
  assert.equal(summaryResult.summary.title, "Remote Work Summary");
  assert.equal(externalImportResult.task.status, "queued");
  assert.equal(externalImportResult.importRequest.sourceUrl, "https://example.test/policy.pdf");
  assert.equal(
    registry.describe(CAPABILITY_IDS.arxivImportTopic).privacyPolicy.externalCall,
    true
  );
});

test("report export persists one replay-safe workspace artifact", async () => {
  let artifactId = 0;
  const workspaceArtifactService = createWorkspaceArtifactService({
    createArtifactId: () => `artifact-${(artifactId += 1)}`,
    now: () => "2026-07-15T00:00:00.000Z",
    store: createInMemoryWorkspaceArtifactStore(),
  });
  const registry = createDefaultCapabilityRegistry({
    workspaceArtifactService,
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  const payload = {
    accessScope,
    approval: {
      approved: true,
    },
    input: {
      citations: [
        {
          docId: "doc-1",
          excerpt: "Evidence excerpt",
          pageNumber: 2,
          title: "Source",
        },
      ],
      content: "Grounded report body.",
      format: "markdown",
      title: "Grounded report",
    },
    services: {
      artifactExecution: {
        idempotencyKey: "goal-deliverable:task-1:report",
        sourceRunId: "run-1",
        sourceTaskId: "task-1",
      },
    },
  };

  const result = await registry.execute(CAPABILITY_IDS.reportExport, payload);
  const replay = await registry.execute(CAPABILITY_IDS.reportExport, payload);

  assert.equal(result.stored, true);
  assert.equal(result.report.fileName, "grounded-report.md");
  assert.deepEqual(result.artifact, {
    artifactId: "artifact-1",
    artifactType: ARTIFACT_TYPES.report,
    fileName: "grounded-report.md",
    format: "markdown",
    mimeType: "text/markdown",
    sourceRunId: "run-1",
    sourceTaskId: "task-1",
    status: "active",
    title: "Grounded report",
  });
  assert.deepEqual(replay.artifact, result.artifact);
  assert.equal(
    (
      await workspaceArtifactService.listArtifacts({
        accessScope,
      })
    ).total,
    1
  );
  assert.equal(
    (
      await workspaceArtifactService.getArtifact({
        accessScope,
        artifactId: result.artifact.artifactId,
      })
    ).citationManifest[0].docId,
    "doc-1"
  );
  assert.equal(result.citations, undefined);
});

test("JSON report artifacts filter sensitive metadata while preserving compatibility output", async () => {
  const workspaceArtifactService = createWorkspaceArtifactService({
    createArtifactId: () => "artifact-json-report",
    now: () => "2026-07-15T00:00:00.000Z",
    store: createInMemoryWorkspaceArtifactStore(),
  });
  const registry = createDefaultCapabilityRegistry({
    reportExportService: {
      exportReport: async () => ({
        marker: "compatibility-marker",
        report: {
          content: JSON.stringify({
            citations: [
              {
                authorizationHeader: "Bearer report-secret",
                docId: "doc-1",
                prompt: "private citation prompt",
                title: "Public source",
              },
            ],
            content: "Safe generated report content.",
            metadata: {
              apiKey: "private-api-key",
              password: "private-password",
              rawTrace: "private-trace",
              safeLabel: "public-label",
              token: "private-token",
            },
            title: "JSON report",
          }),
          fileName: "custom-report.json",
          format: "json",
          mimeType: "application/json",
        },
        text: "Custom export completed.",
      }),
    },
    workspaceArtifactService,
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  const result = await registry.execute(CAPABILITY_IDS.reportExport, {
    accessScope,
    approval: {
      approved: true,
    },
    input: {
      citations: [{ docId: "doc-1", title: "Public source" }],
      content: "Safe generated report content.",
      format: "json",
      metadata: {
        safeLabel: "public-label",
      },
      title: "JSON report",
    },
  });
  const stored = await workspaceArtifactService.getArtifact({
    accessScope,
    artifactId: result.artifact.artifactId,
  });
  const storedReport = JSON.parse(stored.content);

  assert.equal(result.marker, "compatibility-marker");
  assert.equal(result.text, "Custom export completed.");
  assert.equal(result.report.fileName, "custom-report.json");
  assert.equal(storedReport.metadata.safeLabel, "public-label");
  assert.equal(storedReport.citations[0].docId, "doc-1");
  assert.doesNotMatch(
    stored.content,
    /report-secret|private citation prompt|private-api-key|private-password|private-trace|private-token/
  );
});

test("summary create persists a workspace artifact and compatible action task", async () => {
  let artifactId = 0;
  const workspaceArtifactService = createWorkspaceArtifactService({
    createArtifactId: () => `artifact-${(artifactId += 1)}`,
    now: () => "2026-07-15T00:00:00.000Z",
    store: createInMemoryWorkspaceArtifactStore(),
  });
  const registry = createDefaultCapabilityRegistry({
    actionTaskService: createInMemoryActionTaskService(),
    workspaceArtifactService,
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  const payload = {
    accessScope,
    approval: {
      approved: true,
    },
    input: {
      citations: [{ docId: "doc-1", pageNumber: 1 }],
      docIds: ["doc-1"],
      metadata: {
        kind: "goal_summary",
      },
      summary: "Remote work requires manager approval.",
      title: "Remote Work Summary",
    },
    services: {
      artifactExecution: {
        idempotencyKey: "goal-deliverable:task-1:summary",
        sourceRunId: "run-1",
        sourceTaskId: "task-1",
      },
    },
  };

  const result = await registry.execute(CAPABILITY_IDS.summaryCreate, payload);
  const replay = await registry.execute(CAPABILITY_IDS.summaryCreate, payload);
  const stored = await workspaceArtifactService.getArtifact({
    accessScope,
    artifactId: result.artifact.artifactId,
  });

  assert.equal(result.summary.title, "Remote Work Summary");
  assert.equal(result.task.status, "completed");
  assert.equal(replay.task.id, result.task.id);
  assert.equal(result.artifact.artifactType, ARTIFACT_TYPES.summary);
  assert.deepEqual(replay.artifact, result.artifact);
  assert.equal(stored.content, "Remote work requires manager approval.");
  assert.deepEqual(stored.docIds, ["doc-1"]);
  assert.equal(stored.citationManifest[0].docId, "doc-1");
  assert.deepEqual(stored.payload, {
    metadata: {
      kind: "goal_summary",
    },
  });
});

test("document organize persists a collection artifact without mutating documents", async () => {
  let artifactId = 0;
  let mutationCalls = 0;
  const workspaceArtifactService = createWorkspaceArtifactService({
    createArtifactId: () => `artifact-${(artifactId += 1)}`,
    now: () => "2026-07-15T00:00:00.000Z",
    store: createInMemoryWorkspaceArtifactStore(),
  });
  const registry = createDefaultCapabilityRegistry({
    actionTaskService: createInMemoryActionTaskService(),
    ragService: {
      deleteDocument: () => {
        mutationCalls += 1;
      },
      ingestDocument: () => {
        mutationCalls += 1;
      },
      listDocuments: () => [
        {
          docId: "doc-1",
          fileName: "policy.pdf",
          profile: {
            tags: ["policy"],
          },
        },
        {
          docId: "doc-2",
          fileName: "security.pdf",
          profile: {
            tags: ["security"],
          },
        },
      ],
    },
    workspaceArtifactService,
  });
  const accessScope = {
    userId: "alice",
    workspaceId: "workspace-a",
  };
  const payload = {
    accessScope,
    approval: {
      approved: true,
    },
    input: {
      docIds: ["doc-1", "doc-2"],
      strategy: "profile_tags",
      title: "Policy collection",
    },
    services: {
      artifactExecution: {
        idempotencyKey: "goal-deliverable:task-1:collection",
        sourceRunId: "run-1",
        sourceTaskId: "task-1",
      },
    },
  };

  const result = await registry.execute(
    CAPABILITY_IDS.documentOrganize,
    payload
  );
  const replay = await registry.execute(
    CAPABILITY_IDS.documentOrganize,
    payload
  );
  const stored = await workspaceArtifactService.getArtifact({
    accessScope,
    artifactId: result.artifact.artifactId,
  });

  assert.equal(mutationCalls, 0);
  assert.equal(result.organization.documentCount, 2);
  assert.equal(result.task.status, "completed");
  assert.equal(replay.task.id, result.task.id);
  assert.equal(
    result.artifact.artifactType,
    ARTIFACT_TYPES.documentCollection
  );
  assert.deepEqual(replay.artifact, result.artifact);
  assert.deepEqual(stored.docIds, ["doc-1", "doc-2"]);
  assert.deepEqual(stored.payload, {
    documentCount: 2,
    groups: [
      {
        docIds: ["doc-1"],
        label: "policy",
      },
      {
        docIds: ["doc-2"],
        label: "security",
      },
    ],
    strategy: "profile_tags",
  });
});

test("artifact-producing capability fails before recording success when storage fails", async () => {
  let actionTaskCalls = 0;
  const registry = createDefaultCapabilityRegistry({
    actionTaskService: {
      createActionTask: async () => {
        actionTaskCalls += 1;
        return {
          id: "unexpected-task",
        };
      },
    },
    workspaceArtifactService: {
      createArtifact: async () => {
        throw new Error("database unavailable");
      },
    },
  });

  await assert.rejects(
    () =>
      registry.execute(CAPABILITY_IDS.summaryCreate, {
        accessScope: {
          userId: "alice",
          workspaceId: "workspace-a",
        },
        approval: {
          approved: true,
        },
        input: {
          summary: "Summary that must not be marked stored.",
          title: "Unavailable summary",
        },
      }),
    (error) =>
      error.code === "workspace_artifact_write_failed" &&
      error.status === 500 &&
      /database unavailable/.test(error.message)
  );
  assert.equal(actionTaskCalls, 0);
});

test("artifact-producing capability reports missing storage as a typed write failure", async () => {
  const registry = createDefaultCapabilityRegistry();

  await assert.rejects(
    () =>
      registry.execute(CAPABILITY_IDS.reportExport, {
        accessScope: {
          userId: "alice",
          workspaceId: "workspace-a",
        },
        approval: {
          approved: true,
        },
        input: {
          content: "Report body",
          title: "Unconfigured report",
        },
      }),
    (error) =>
      error.code === "workspace_artifact_write_failed" &&
      error.status === 500 &&
      /service is required/.test(error.message)
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
    {
      id: CAPABILITY_IDS.taskCreate,
      input: {
        title: "Follow up on renewal risk",
        description: "Track renewal risk review.",
        priority: "high",
      },
      preview: {
        title: "Follow up on renewal risk",
        description: "Track renewal risk review.",
        priority: "high",
      },
    },
    {
      id: CAPABILITY_IDS.documentOrganize,
      input: {
        title: "Policy folders",
        docIds: ["doc-1"],
        strategy: "profile_tags",
      },
      preview: {
        title: "Policy folders",
        docIds: ["doc-1"],
        strategy: "profile_tags",
      },
    },
    {
      id: CAPABILITY_IDS.summaryCreate,
      input: {
        title: "Policy summary",
        summary: "Remote work requires manager approval.",
        docIds: ["doc-1"],
      },
      preview: {
        title: "Policy summary",
        summary: "Remote work requires manager approval.",
        docIds: ["doc-1"],
      },
    },
    {
      id: CAPABILITY_IDS.externalImport,
      input: {
        provider: "url",
        sourceUrl: "https://example.test/policy.pdf",
        title: "External policy",
      },
      preview: {
        provider: "url",
        sourceUrl: "https://example.test/policy.pdf",
        title: "External policy",
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
