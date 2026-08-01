import { hasCompatibleEvidenceIdentity } from "./citations.js";

const SOURCE_LABEL_PATTERN = /\[(source|来源)\s*(\d+)\]/gi;
const CLAIM_SOURCE_RANK_FIELDS = Object.freeze([
  "sourceRanks",
  "verifiedSourceRanks",
  "supportedSourceRanks",
  "missingSourceRanks",
  "ambiguousSourceRanks",
]);

const getPositiveRank = (entry, index) => {
  const explicitRank = Number(entry?.rank);

  return Number.isInteger(explicitRank) && explicitRank > 0
    ? explicitRank
    : index + 1;
};

const getSupportedSourceRanks = (claimSupport = {}) =>
  new Set(
    (Array.isArray(claimSupport?.claims) ? claimSupport.claims : [])
      .filter((claim) => claim?.supported === true)
      .flatMap((claim) => claim.supportedSourceRanks ?? [])
      .map(Number)
      .filter((rank) => Number.isInteger(rank) && rank > 0)
  );

const rebaseProjectedSourceLabels = ({ text = "", rankMap = new Map() }) =>
  String(text ?? "").replace(
    SOURCE_LABEL_PATTERN,
    (_match, label, rawRank) => {
      const rebasedRank = rankMap.get(Number(rawRank));

      if (!rebasedRank) {
        return "";
      }

      return label.toLowerCase() === "source"
        ? `[Source ${rebasedRank}]`
        : `[来源 ${rebasedRank}]`;
    }
  );

const cloneEntries = (entries = []) =>
  (Array.isArray(entries) ? entries : []).map((entry) => ({ ...entry }));

const cloneProjectionValue = (value) => {
  if (Array.isArray(value)) {
    return value.map(cloneProjectionValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        cloneProjectionValue(nestedValue),
      ])
    );
  }

  return value;
};

const rebaseSourceRanks = (sourceRanks, rankMap) =>
  Array.isArray(sourceRanks)
    ? [
        ...new Set(
          sourceRanks
            .map((rank) => rankMap.get(Number(rank)))
            .filter(Boolean)
        ),
      ]
    : sourceRanks;

const rebaseClaimSupport = ({ claimSupport, rankMap }) => {
  if (!claimSupport || typeof claimSupport !== "object") {
    return claimSupport ?? null;
  }

  const projectedClaimSupport = cloneProjectionValue(claimSupport);
  const rebaseRecord = (record) => {
    for (const field of CLAIM_SOURCE_RANK_FIELDS) {
      if (Array.isArray(record?.[field])) {
        record[field] = rebaseSourceRanks(record[field], rankMap);
      }
    }
  };

  rebaseRecord(projectedClaimSupport);
  projectedClaimSupport.claims?.forEach(rebaseRecord);

  return projectedClaimSupport;
};

const buildIdentityRankMap = (citations = []) =>
  new Map(
    (Array.isArray(citations) ? citations : []).map((citation, index) => {
      const rank = getPositiveRank(citation, index);

      return [rank, rank];
    })
  );

export const projectGroundedRankedContent = ({
  text = "",
  citations = [],
  sourceRankMap = new Map(),
} = {}) => {
  const projectedCitations = [];
  const projectedRanks = new Set();

  for (const [index, citation] of (Array.isArray(citations) ? citations : []).entries()) {
    const sourceRank = getPositiveRank(citation, index);
    const projectedRank = sourceRankMap.get(sourceRank);

    if (!projectedRank || projectedRanks.has(projectedRank)) {
      continue;
    }

    projectedRanks.add(projectedRank);
    projectedCitations.push({
      ...citation,
      rank: projectedRank,
    });
  }

  return {
    text: rebaseProjectedSourceLabels({ text, rankMap: sourceRankMap }),
    citations: projectedCitations,
  };
};

export const projectGroundedAnswer = ({
  text = "",
  citations = [],
  retrievedContexts = [],
  claimSupport = null,
} = {}) => {
  if (claimSupport?.checked !== true) {
    const sourceRankMap = buildIdentityRankMap(citations);

    return {
      text: String(text ?? ""),
      citations: cloneEntries(citations),
      retrievedContexts: cloneEntries(retrievedContexts),
      claimSupport: rebaseClaimSupport({ claimSupport, rankMap: sourceRankMap }),
      sourceRankMap,
    };
  }

  const supportedSourceRanks = getSupportedSourceRanks(claimSupport);
  const rankMap = new Map();
  const citationBySourceRank = new Map();

  for (const [index, citation] of (citations ?? []).entries()) {
    const sourceRank = getPositiveRank(citation, index);

    if (!supportedSourceRanks.has(sourceRank) || rankMap.has(sourceRank)) {
      continue;
    }

    const projectedRank = rankMap.size + 1;
    rankMap.set(sourceRank, projectedRank);
    citationBySourceRank.set(sourceRank, citation);
  }
  const projectedContent = projectGroundedRankedContent({
    text,
    citations,
    sourceRankMap: rankMap,
  });

  const projectedContextRanks = new Set();
  const projectedRetrievedContexts = [];

  for (const [index, context] of (retrievedContexts ?? []).entries()) {
    const sourceRank = getPositiveRank(context, index);
    const projectedRank = rankMap.get(sourceRank);
    const sourceCitation = citationBySourceRank.get(sourceRank);

    if (
      !projectedRank ||
      !sourceCitation ||
      !hasCompatibleEvidenceIdentity(sourceCitation, context) ||
      projectedContextRanks.has(projectedRank)
    ) {
      continue;
    }

    projectedContextRanks.add(projectedRank);
    projectedRetrievedContexts.push({
      ...context,
      rank: projectedRank,
    });
  }

  return {
    text: projectedContent.text,
    citations: projectedContent.citations,
    retrievedContexts: projectedRetrievedContexts,
    claimSupport: rebaseClaimSupport({ claimSupport, rankMap }),
    sourceRankMap: new Map(rankMap),
  };
};
