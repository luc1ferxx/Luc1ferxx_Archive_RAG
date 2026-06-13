import assert from "node:assert/strict";
import test from "node:test";

import {
  createInMemoryRecommendationSnapshotStore,
  normalizeRecommendationSnapshot,
} from "../rag/recommendation-snapshots.js";

test("recommendation snapshots are scoped by provider, document, user, and workspace", () => {
  const store = createInMemoryRecommendationSnapshotStore();

  store.upsert({
    accessScope: {
      userId: "alice",
      workspaceId: "workspace-a",
    },
    snapshot: {
      document: {
        docId: "doc-1",
        fileName: "private notes.pdf",
      },
      papers: [
        {
          id: "paper-1",
          title: "Paper One",
        },
      ],
      provider: "arxiv",
      selectionToken: "token-1",
      topic: "retrieval augmented generation",
    },
  });
  store.upsert({
    accessScope: {
      userId: "alice",
      workspaceId: "workspace-a",
    },
    snapshot: {
      docId: "doc-1",
      papers: [
        {
          id: "paper-2",
          title: "Paper Two",
        },
      ],
      provider: "semantic-scholar",
      selectionToken: "token-2",
      topic: "retrieval augmented generation",
    },
  });

  assert.equal(
    store.list({
      accessScope: {
        userId: "alice",
        workspaceId: "workspace-a",
      },
      provider: "arxiv",
    }).length,
    1
  );
  assert.equal(
    store.list({
      accessScope: {
        userId: "bob",
        workspaceId: "workspace-a",
      },
      provider: "arxiv",
    }).length,
    0
  );
  assert.equal(
    store.get({
      accessScope: {
        userId: "alice",
        workspaceId: "workspace-a",
      },
      docId: "doc-1",
      provider: "semantic-scholar",
    }).papers[0].id,
    "paper-2"
  );

  store.delete({
    accessScope: {
      userId: "alice",
      workspaceId: "workspace-a",
    },
    docId: "doc-1",
    provider: "arxiv",
  });

  assert.equal(
    store.get({
      accessScope: {
        userId: "alice",
        workspaceId: "workspace-a",
      },
      docId: "doc-1",
      provider: "arxiv",
    }),
    null
  );
  assert.equal(
    store.get({
      accessScope: {
        userId: "alice",
        workspaceId: "workspace-a",
      },
      docId: "doc-1",
      provider: "semantic-scholar",
    }).papers[0].id,
    "paper-2"
  );
});

test("recommendation snapshot normalization rejects incomplete snapshots", () => {
  assert.equal(
    normalizeRecommendationSnapshot({
      document: {
        docId: "doc-1",
      },
    }),
    null
  );
  assert.equal(
    normalizeRecommendationSnapshot({
      provider: "arxiv",
    }),
    null
  );
  assert.deepEqual(
    normalizeRecommendationSnapshot({
      document: {
        docId: " doc-1 ",
        fileName: " notes.pdf ",
      },
      provider: " arxiv ",
      requestedMaxResults: "3",
    }),
    {
      id: "arxiv:doc-1",
      provider: "arxiv",
      document: {
        docId: "doc-1",
        fileName: "notes.pdf",
      },
      topic: "",
      requestedMaxResults: 3,
      papers: [],
      selectionToken: "",
      reason: null,
      createdAt: "",
      updatedAt: "",
    }
  );
});
