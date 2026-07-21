const SOURCE_LABEL_PATTERN = /\[(source|来源)\s*(\d+)\]/gi;

const getLocalCitationRank = (citation = {}, index = 0) => {
  const explicitRank = Number(citation?.rank);

  return Number.isInteger(explicitRank) && explicitRank > 0
    ? explicitRank
    : index + 1;
};

export const filterCitationsToSourceRanks = ({
  sourceRanks = [],
  citations = [],
} = {}) => {
  const referencedRanks = new Set(
    (Array.isArray(sourceRanks) ? sourceRanks : [])
      .map(Number)
      .filter((rank) => Number.isInteger(rank) && rank > 0)
  );

  return (Array.isArray(citations) ? citations : []).filter((citation, index) =>
    referencedRanks.has(getLocalCitationRank(citation, index))
  );
};

const rebaseSourceLabels = ({
  text = "",
  rankMap = new Map(),
  getMissingRank,
} = {}) =>
  String(text ?? "").replace(
    SOURCE_LABEL_PATTERN,
    (match, label, rawRank) => {
      const localRank = Number(rawRank);
      const rank = rankMap.get(localRank) ?? getMissingRank?.(localRank);

      if (!rank) {
        return match;
      }

      return label.toLowerCase() === "source"
        ? `[Source ${rank}]`
        : `[来源 ${rank}]`;
    }
  );

export const rebaseEvidenceResults = (results = []) => {
  let nextRank = 1;
  const citations = [];
  const rebasedResults = (Array.isArray(results) ? results : []).map(
    (result) => {
      const localRankToGlobalRank = new Map();
      const resultCitations = Array.isArray(result?.citations)
        ? result.citations
        : [];
      const missingLocalRankToGlobalRank = new Map();
      const rebasedCitations = resultCitations.map((citation, index) => {
        const localRank = getLocalCitationRank(citation, index);

        if (!localRankToGlobalRank.has(localRank)) {
          localRankToGlobalRank.set(localRank, nextRank);
          nextRank += 1;
        }

        return {
          ...citation,
          rank: localRankToGlobalRank.get(localRank),
        };
      });

      citations.push(...rebasedCitations);

      return {
        ...result,
        text: rebaseSourceLabels({
          text: result?.text,
          rankMap: localRankToGlobalRank,
          getMissingRank: (localRank) => {
            if (!missingLocalRankToGlobalRank.has(localRank)) {
              missingLocalRankToGlobalRank.set(localRank, nextRank);
              nextRank += 1;
            }

            return missingLocalRankToGlobalRank.get(localRank);
          },
        }),
        citations: rebasedCitations,
      };
    }
  );

  return {
    results: rebasedResults,
    citations,
  };
};
