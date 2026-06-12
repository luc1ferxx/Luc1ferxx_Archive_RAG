import test from "node:test";
import assert from "node:assert/strict";
import {
  buildArxivTopicFromDocumentProfile,
  createArxivEnrichmentService,
} from "../rag/arxiv-enrichment.js";

test("arxiv enrichment derives a public topic from profile tags only", () => {
  const topic = buildArxivTopicFromDocumentProfile({
    fileName: "confidential-project-redwood.pdf",
    profile: {
      summary: "Customer Alpha private roadmap for Redwood.",
      tags: ["retrieval", "augmented", "generation", "internal", "redwood"],
      entities: ["Customer Alpha", "REDWOOD-917"],
    },
  });

  assert.equal(topic, "retrieval augmented generation");
  assert.equal(topic.includes("Customer"), false);
  assert.equal(topic.includes("REDWOOD-917"), false);
});

test("arxiv enrichment returns suggestions for a scoped document", async () => {
  const searchCalls = [];
  const service = createArxivEnrichmentService({
    arxivImportService: {
      importTopic: async () => {
        throw new Error("import should not run for suggestions");
      },
    },
    arxivService: {
      search: async ({ maxResults, topic }) => {
        searchCalls.push({
          maxResults,
          topic,
        });

        return [
          {
            arxivId: "2401.00001v1",
            pdfUrl: "https://arxiv.org/pdf/2401.00001v1",
            title: "Retrieval Augmented Generation for Archives",
          },
        ];
      },
    },
    ragService: {
      getDocument: (docId, accessScope) => {
        assert.equal(docId, "doc-1");
        assert.deepEqual(accessScope, {
          userId: "alice",
          workspaceId: "workspace-a",
        });

        return {
          docId,
          fileName: "private-notes.pdf",
          profile: {
            tags: ["retrieval", "augmented", "generation"],
          },
        };
      },
    },
  });

  const result = await service.suggestForDocument({
    accessScope: {
      userId: "alice",
      workspaceId: "workspace-a",
    },
    docId: "doc-1",
    maxResults: 3,
  });

  assert.equal(result.topic, "retrieval augmented generation");
  assert.equal(result.papers.length, 1);
  assert.match(result.selectionToken, /^v1\./);
  assert.deepEqual(searchCalls, [
    {
      maxResults: 3,
      topic: "retrieval augmented generation",
    },
  ]);
});

test("arxiv enrichment imports papers only after confirmation", async () => {
  const imports = [];
  const searches = [];
  const service = createArxivEnrichmentService({
    arxivImportService: {
      importPapers: async ({ maxResults, papers, topic }) => {
        imports.push({
          maxResults,
          paperIds: papers.map((paper) => paper.arxivId),
          topic,
        });

        return {
          topic,
          requestedMaxResults: maxResults,
          foundCount: papers.length,
          importedCount: papers.length,
          skippedCount: 0,
          failedCount: 0,
          importedPapers: [],
          skippedPapers: [],
          failedPapers: [],
        };
      },
    },
    arxivService: {
      search: async ({ maxResults, topic }) => {
        searches.push({
          maxResults,
          topic,
        });

        return [
          {
            arxivId: "2401.00001v1",
            pdfUrl: "https://arxiv.org/pdf/2401.00001v1",
            title: "Retrieval Augmented Generation for Archives",
          },
          {
            arxivId: "2401.00002v1",
            pdfUrl: "https://arxiv.org/pdf/2401.00002v1",
            title: "Grounded Question Answering with Documents",
          },
          {
            arxivId: "2401.00003v1",
            pdfUrl: "https://arxiv.org/pdf/2401.00003v1",
            title: "Hybrid Retrieval for Private Workspaces",
          },
        ];
      },
    },
    ragService: {
      getDocument: () => ({
        docId: "doc-1",
        fileName: "private-notes.pdf",
        profile: {
          tags: ["retrieval", "augmented", "generation"],
        },
      }),
    },
  });

  const suggestion = await service.suggestForDocument({
    docId: "doc-1",
    maxResults: 3,
  });

  assert.equal(imports.length, 0);

  const result = await service.importForDocument({
    docId: "doc-1",
    selectionToken: suggestion.selectionToken,
  });

  assert.equal(result.document.docId, "doc-1");
  assert.equal(result.importedCount, 3);
  assert.deepEqual(searches, [
    {
      maxResults: 3,
      topic: "retrieval augmented generation",
    },
  ]);
  assert.deepEqual(imports, [
    {
      maxResults: 3,
      paperIds: ["2401.00001v1", "2401.00002v1", "2401.00003v1"],
      topic: "retrieval augmented generation",
    },
  ]);
});

test("arxiv enrichment requires a confirmed selection token before import", async () => {
  const service = createArxivEnrichmentService({
    arxivImportService: {
      importPapers: async () => {
        throw new Error("import should not run without a selection token");
      },
    },
    arxivService: {
      search: async () => [],
    },
    ragService: {
      getDocument: () => ({
        docId: "doc-1",
        fileName: "private-notes.pdf",
        profile: {
          tags: ["retrieval", "augmented", "generation"],
        },
      }),
    },
  });

  await assert.rejects(
    () =>
      service.importForDocument({
        docId: "doc-1",
      }),
    /selectionToken is required/
  );
});
