const EXPLICIT_ABSTAIN_PATTERNS = Object.freeze([
  /^I (?:could not|couldn't) find enough grounded evidence in (?:the )?(?:uploaded|selected) documents(?: to answer reliably| to compare them)?[.!]?$/i,
  /^I (?:could not|couldn't) find enough grounded evidence that specifically addresses [^.!?]+(?: in \d+ of the \d+ selected documents, so the comparison would be unreliable)?[.!]?$/i,
  /^I do not have enough citation-backed evidence to answer reliably[.!]?$/i,
  /^I have not found reliable evidence that directly answers [^.!?]+[.!]?$/i,
  /^I only found strong evidence in \d+ of the \d+ selected documents, so the comparison would be unreliable[.!]?$/i,
]);

const normalizeAnswerText = (answer) =>
  String(answer ?? "").replace(/\s+/g, " ").trim();

export const isExplicitAbstainAnswer = (answer) => {
  const text = normalizeAnswerText(answer);

  return (
    text.length > 0 &&
    EXPLICIT_ABSTAIN_PATTERNS.some((pattern) => pattern.test(text))
  );
};
