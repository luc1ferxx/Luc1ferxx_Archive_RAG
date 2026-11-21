import { createInMemoryRecommendationSnapshotStore } from "./recommendation-snapshots.js";
import { buildSafeExternalDocumentSummary } from "./external-context-sanitizer.js";
import { normalizeText } from "../lib/normalize-text.js";

const ARXIV_RECOMMENDATION_PROVIDER = "arxiv";
const DEFAULT_ARXIV_SNAPSHOT_MAX_RESULTS = 3;

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

  // The papers of the confirmed offer this import did not take (or failed),
  // as a new offer. The offer is the token the confirmation was checked
  // against (`offerSelectionToken`: the task's or the saved suggestion's), so
  // the papers left are the same on whichever tier runs the import; the saved
  // suggestion follows when this process holds that offer.
  const updateAfterImport = ({
    accessScope = {},
    docId,
    importResult,
    offerSelectionToken,
    selectedPapers,
    topic,
  } = {}) => {
    const offer = selectionTokenService.readSelectionToken(offerSelectionToken);
    const existingSnapshot = recommendationSnapshotStore.get({
      accessScope,
      docId,
      provider: ARXIV_RECOMMENDATION_PROVIDER,
    });
    const savedOffer =
      existingSnapshot?.selectionToken === normalizeText(offerSelectionToken)
        ? existingSnapshot
        : null;
    const selectedPaperIds = buildPaperIdSet(selectedPapers);
    const failedPaperIds = buildPaperIdSet(importResult.failedPapers);
    const remainingPapers = toArray(offer?.papers).filter((paper) => {
      const paperId = getPaperId(paper);

      return !selectedPaperIds.has(paperId) || failedPaperIds.has(paperId);
    });

    if (remainingPapers.length === 0) {
      if (savedOffer) {
        recommendationSnapshotStore.delete({
          accessScope,
          docId,
          provider: ARXIV_RECOMMENDATION_PROVIDER,
        });
      }

      return null;
    }

    const requestedMaxResults = offer.requestedMaxResults || remainingPapers.length;
    const selectionToken = selectionTokenService.createSelectionToken({
      docId,
      papers: remainingPapers,
      requestedMaxResults,
      topic,
    });

    if (savedOffer) {
      recommendationSnapshotStore.upsert({
        accessScope,
        snapshot: buildSavedSuggestionSnapshot({
          existingSnapshot: savedOffer,
          now,
          suggestion: {
            ...savedOffer,
            papers: remainingPapers,
            requestedMaxResults,
            selectionToken,
          },
        }),
      });
    }

    return {
      papers: remainingPapers,
      selectionToken,
    };
  };

  // The token of the saved offer, which a direct import must present.
  const getSelectionToken = ({ accessScope = {}, docId } = {}) =>
    recommendationSnapshotStore.get({
      accessScope,
      docId,
      provider: ARXIV_RECOMMENDATION_PROVIDER,
    })?.selectionToken ?? null;

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
    getSelectionToken,
    list,
    save,
    updateAfterImport,
  };
};
