const normalizeText = (value) => String(value ?? "").trim();

const normalizeAccessScope = (accessScope = {}) => ({
  userId: normalizeText(accessScope.userId),
  workspaceId: normalizeText(accessScope.workspaceId),
});

const buildScopeKey = (accessScope = {}) => {
  const scope = normalizeAccessScope(accessScope);

  return `${scope.userId}\u0000${scope.workspaceId}`;
};

const buildSnapshotKey = ({ accessScope = {}, docId = "", provider = "" } = {}) =>
  `${buildScopeKey(accessScope)}\u0000${normalizeText(provider)}\u0000${normalizeText(docId)}`;

const toArray = (value) => (Array.isArray(value) ? value : []);

export const normalizeRecommendationSnapshot = (snapshot = {}) => {
  const provider = normalizeText(snapshot.provider);
  const docId = normalizeText(snapshot.document?.docId ?? snapshot.docId);

  if (!provider || !docId) {
    return null;
  }

  return {
    id: normalizeText(snapshot.id) || `${provider}:${docId}`,
    provider,
    document: {
      docId,
      fileName: normalizeText(snapshot.document?.fileName),
    },
    topic: normalizeText(snapshot.topic),
    requestedMaxResults: Number.parseInt(snapshot.requestedMaxResults ?? 0, 10) || 0,
    papers: toArray(snapshot.papers),
    selectionToken: normalizeText(snapshot.selectionToken),
    reason: snapshot.reason ?? null,
    createdAt: normalizeText(snapshot.createdAt),
    updatedAt: normalizeText(snapshot.updatedAt),
  };
};

export const createInMemoryRecommendationSnapshotStore = () => {
  const snapshots = new Map();

  return {
    delete({ accessScope = {}, docId, provider } = {}) {
      return snapshots.delete(
        buildSnapshotKey({
          accessScope,
          docId,
          provider,
        })
      );
    },

    get({ accessScope = {}, docId, provider } = {}) {
      return (
        snapshots.get(
          buildSnapshotKey({
            accessScope,
            docId,
            provider,
          })
        ) ?? null
      );
    },

    list({ accessScope = {}, provider = "" } = {}) {
      const scopeKey = buildScopeKey(accessScope);
      const normalizedProvider = normalizeText(provider);

      return [...snapshots.values()].filter(
        (snapshot) =>
          snapshot.scopeKey === scopeKey &&
          (!normalizedProvider || snapshot.provider === normalizedProvider)
      );
    },

    upsert({ accessScope = {}, snapshot } = {}) {
      const normalizedSnapshot = normalizeRecommendationSnapshot(snapshot);

      if (!normalizedSnapshot) {
        throw new Error("Recommendation snapshot requires provider and docId.");
      }

      const scopeKey = buildScopeKey(accessScope);
      const storedSnapshot = {
        ...normalizedSnapshot,
        scopeKey,
      };

      snapshots.set(
        buildSnapshotKey({
          accessScope,
          docId: storedSnapshot.document.docId,
          provider: storedSnapshot.provider,
        }),
        storedSnapshot
      );

      return storedSnapshot;
    },
  };
};
