import { createInMemoryRecommendationSnapshotStore } from "./recommendation-snapshots.js";
import { buildSafeExternalDocumentSummary } from "./external-context-sanitizer.js";

const ARXIV_RECOMMENDATION_PROVIDER = "arxiv";
const DEFAULT_ARXIV_SNAPSHOT_MAX_RESULTS = 3;

const normalizeText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const toArray = (value) => (Array.isArray(value) ? value : []);

const stripInternalSnapshotFields = (snapshot = {}) => {
  const { scopeKey, ...publicSnapshot } = snapshot;

  return publicSnapshot;
};

const buildDocumentSummary = (document = {}) =>
  buildSafeExternalDocumentSummary({
    document,
  });

const buildSavedSuggestionSnapshot = ({
  existingSnapshot = null,
  now,
  suggestion,
} = {}) => {
  const timestamp = now();

  return {
    ...suggestion,
    id:
      existingSnapshot?.id ??
      `${ARXIV_RECOMMENDATION_PROVIDER}:${suggestion.document.docId}`,
    provider: ARXIV_RECOMMENDATION_PROVIDER,
    createdAt: existingSnapshot?.createdAt || timestamp,
    updatedAt: timestamp,
  };
};

const getPaperId = (paper = {}) => normalizeText(paper.arxivId);

const buildPaperIdSet = (papers = []) =>
  new Set(toArray(papers).map(getPaperId).filter(Boolean));

export const createArxivRecommendationSnapshotService = ({
  now = () => new Date().toISOString(),
  recommendationSnapshotStore = createInMemoryRecommendationSnapshotStore(),
  resolveDocumentTopic,
  selectionTokenService,
} = {}) => {
  const serializeSavedSuggestion = ({
    accessScope = {},
    snapshot,
  } = {}) => {
    if (!snapshot) {
      return null;
    }

    let document;
    let queryPolicy;
    let topic;

    try {
      ({ document, queryPolicy, topic } = resolveDocumentTopic({
        accessScope,
        docId: snapshot.document?.docId,
      }));
    } catch (error) {
      if (error?.status === 404) {
        recommendationSnapshotStore.delete({
          accessScope,
          docId: snapshot.document?.docId,
          provider: ARXIV_RECOMMENDATION_PROVIDER,
        });
        return null;
      }

      throw error;
    }

    if (!topic || snapshot.topic !== topic) {
      recommendationSnapshotStore.delete({
        accessScope,
        docId: snapshot.document?.docId,
        provider: ARXIV_RECOMMENDATION_PROVIDER,
      });
      return null;
    }

    return {
      ...stripInternalSnapshotFields(snapshot),
      document: buildDocumentSummary(document),
      queryPolicy: snapshot.queryPolicy ?? queryPolicy,
      trace: snapshot.trace ?? {
        externalQueryPolicy: snapshot.queryPolicy ?? queryPolicy,
      },
    };
  };

  const save = ({ accessScope = {}, suggestion } = {}) => {
    const docId = suggestion?.document?.docId;

    if (!docId) {
      return suggestion;
    }

    if ((suggestion.papers ?? []).length === 0 || !suggestion.selectionToken) {
      recommendationSnapshotStore.delete({
        accessScope,
        docId,
        provider: ARXIV_RECOMMENDATION_PROVIDER,
      });
      return suggestion;
    }

    const existingSnapshot = recommendationSnapshotStore.get({
      accessScope,
      docId,
      provider: ARXIV_RECOMMENDATION_PROVIDER,
    });
    const snapshot = recommendationSnapshotStore.upsert({
      accessScope,
      snapshot: buildSavedSuggestionSnapshot({
        existingSnapshot,
        now,
        suggestion,
      }),
    });

    return {
      ...suggestion,
      snapshotId: snapshot.id,
      savedAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
    };
  };

  const updateAfterImport = ({
    accessScope = {},
    docId,
    importResult,
    selectedPapers,
    topic,
  } = {}) => {
    const existingSnapshot = recommendationSnapshotStore.get({
      accessScope,
      docId,
      provider: ARXIV_RECOMMENDATION_PROVIDER,
    });

    if (!existingSnapshot) {
      return null;
    }

    const selectedPaperIds = buildPaperIdSet(selectedPapers);
    const failedPaperIds = buildPaperIdSet(importResult.failedPapers);
    const remainingPapers = toArray(existingSnapshot.papers).filter((paper) => {
      const paperId = getPaperId(paper);

      return !selectedPaperIds.has(paperId) || failedPaperIds.has(paperId);
    });

    if (remainingPapers.length === 0) {
      recommendationSnapshotStore.delete({
        accessScope,
        docId,
        provider: ARXIV_RECOMMENDATION_PROVIDER,
      });
      return null;
    }

    const requestedMaxResults =
      existingSnapshot.requestedMaxResults || remainingPapers.length;
    const updatedSnapshot = recommendationSnapshotStore.upsert({
      accessScope,
      snapshot: buildSavedSuggestionSnapshot({
        existingSnapshot,
        now,
        suggestion: {
          ...existingSnapshot,
          papers: remainingPapers,
          requestedMaxResults,
          selectionToken: selectionTokenService.createSelectionToken({
            docId,
            papers: remainingPapers,
            requestedMaxResults,
            topic,
          }),
        },
      }),
    });

    return stripInternalSnapshotFields(updatedSnapshot);
  };

  const list = ({ accessScope = {} } = {}) => ({
    suggestions: recommendationSnapshotStore
      .list({
        accessScope,
        provider: ARXIV_RECOMMENDATION_PROVIDER,
      })
      .map((snapshot) =>
        serializeSavedSuggestion({
          accessScope,
          snapshot,
        })
      )
      .filter(Boolean),
  });

  const getForDocument = ({ accessScope = {}, docId } = {}) => {
    const { document, queryPolicy, topic } = resolveDocumentTopic({
      accessScope,
      docId,
    });
    const snapshot = recommendationSnapshotStore.get({
      accessScope,
      docId,
      provider: ARXIV_RECOMMENDATION_PROVIDER,
    });
    const savedSuggestion = serializeSavedSuggestion({
      accessScope,
      snapshot,
    });

    return (
      savedSuggestion ?? {
        document: buildDocumentSummary(document),
        topic,
        queryPolicy,
        requestedMaxResults: DEFAULT_ARXIV_SNAPSHOT_MAX_RESULTS,
        papers: [],
        selectionToken: null,
        reason: "no_saved_arxiv_suggestions",
        trace: {
          externalQueryPolicy: queryPolicy,
        },
      }
    );
  };

  return {
    getForDocument,
    list,
    save,
    updateAfterImport,
  };
};
