export const markHistoricalQualityEvidence = (payload = {}) => ({
  ...payload,
  authoritativeForCurrentCommit: false,
  evidenceScope: "historical",
  verification: {
    currentCommitVerified: false,
    scope: "historical",
  },
});
