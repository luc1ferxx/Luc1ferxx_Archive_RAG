const ABSTAIN_ANSWER =
  "I could not find enough grounded evidence in the selected documents.";
const SOURCE_HEADING_PATTERN = /(?:^|\n)Source\s+(\d+)\s*(?=\n)/g;
const EVIDENCE_MARKER = "\nEvidence:\n";
const EVIDENCE_SUFFIX_PATTERNS = [
  /\n\n---(?:\n|$)/,
  /\n\nGrounded Answer:/,
  /\n\nInstructions:/,
  /\n\nQuestion:/,
  /\n\nWrite the answer\b/,
];
const COMPARISON_PROMPT_PATTERNS = [
  /You compare uploaded documents/i,
  /document-grounded comparison assistant/i,
];

const normalizeEvidence = (value = "") =>
  String(value).replace(/\s+/g, " ").trim();

const extractFirstSentence = (value = "") => {
  const evidence = normalizeEvidence(value);

  if (!evidence) {
    return "";
  }

  return (
    evidence.match(/.*?(?:[.!?\u3002\uff01\uff1f]|$)/)?.[0]?.trim() ??
    evidence
  );
};

const trimEvidenceSuffix = (value = "") => {
  let end = value.length;

  for (const pattern of EVIDENCE_SUFFIX_PATTERNS) {
    const match = pattern.exec(value);

    if (match && match.index < end) {
      end = match.index;
    }
  }

  return value.slice(0, end);
};

export const extractDeterministicEvidenceSources = (prompt = "") => {
  const text = String(prompt);
  const headings = [...text.matchAll(SOURCE_HEADING_PATTERN)];

  return headings
    .map((heading, index) => {
      const rank = Number(heading[1]);
      const blockStart = heading.index + heading[0].length;
      const blockEnd = headings[index + 1]?.index ?? text.length;
      const block = text.slice(blockStart, blockEnd);
      const evidenceStart = block.indexOf(EVIDENCE_MARKER);

      if (!Number.isInteger(rank) || rank <= 0 || evidenceStart === -1) {
        return null;
      }

      const evidence = trimEvidenceSuffix(
        block.slice(evidenceStart + EVIDENCE_MARKER.length)
      );
      const sentence = extractFirstSentence(evidence);

      return sentence
        ? {
            rank,
            sentence,
          }
        : null;
    })
    .filter(Boolean);
};

export const isDeterministicComparisonPrompt = (prompt = "") => {
  const text = String(prompt);

  return COMPARISON_PROMPT_PATTERNS.some((pattern) => pattern.test(text));
};

export const buildDeterministicEvidenceAnswer = (prompt = "") => {
  const sources = extractDeterministicEvidenceSources(prompt);

  if (sources.length === 0) {
    return ABSTAIN_ANSWER;
  }

  const selectedSources = isDeterministicComparisonPrompt(prompt)
    ? sources
    : sources.slice(0, 1);

  return selectedSources
    .map(({ rank, sentence }) => `${sentence} [Source ${rank}]`)
    .join("\n");
};
