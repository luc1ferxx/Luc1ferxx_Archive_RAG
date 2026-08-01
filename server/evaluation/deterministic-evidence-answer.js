import { buildTermSet } from "../rag/text-utils.js";

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
const USER_QUESTION_PATTERN =
  /(?:^|\n)User Question:\n([\s\S]*?)(?=\n\n(?:Resolved Retrieval Question:|Long-term memory:|Retrieved Evidence:|Retrieved evidence:|Comparison diagnostics:|Evidence by document:|Source\s+\d+)|$)/i;

const normalizeEvidence = (value = "") =>
  String(value).replace(/\s+/g, " ").trim();

const extractEvidenceSentences = (value = "") => {
  const evidence = normalizeEvidence(value);

  if (!evidence) {
    return [];
  }

  return (
    evidence.match(/.*?(?:[.!?\u3002\uff01\uff1f]|$)(?:\s+|$)/g) ??
    [evidence]
  )
    .map((sentence) => sentence.trim())
    .filter(Boolean);
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
      const sentences = extractEvidenceSentences(evidence);

      return sentences.length > 0
        ? {
            rank,
            sentence: sentences[0],
            sentences,
          }
        : null;
    })
    .filter(Boolean);
};

export const isDeterministicComparisonPrompt = (prompt = "") => {
  const text = String(prompt);

  return COMPARISON_PROMPT_PATTERNS.some((pattern) => pattern.test(text));
};

const extractUserQuestion = (prompt = "") =>
  String(prompt).match(USER_QUESTION_PATTERN)?.[1]?.trim() ?? "";

const countQuestionTermMatches = (questionTerms, sentence) => {
  const sentenceTerms = buildTermSet(sentence);

  return [...questionTerms].reduce(
    (matchCount, term) => matchCount + Number(sentenceTerms.has(term)),
    0
  );
};

const selectQaEvidenceSentences = ({ prompt, sources }) => {
  const questionTerms = buildTermSet(extractUserQuestion(prompt));
  const rankedSources = sources.map(({ rank, sentence, sentences }) => {
    const candidates = (sentences ?? [sentence]).map((evidenceSentence) => ({
      rank,
      score: countQuestionTermMatches(questionTerms, evidenceSentence),
      sentence: evidenceSentence,
    }));

    return {
      candidates,
      score: Math.max(0, ...candidates.map((candidate) => candidate.score)),
    };
  });

  if (rankedSources.length === 0) {
    return null;
  }

  const selectedSource = rankedSources.reduce(
    (selected, source) => source.score > selected.score ? source : selected,
    rankedSources[0]
  );
  const relevantCandidates = selectedSource.candidates.filter(
    (candidate) => candidate.score > 0
  );

  return relevantCandidates.length > 0
    ? relevantCandidates
    : selectedSource.candidates.slice(0, 1);
};

export const buildDeterministicEvidenceAnswer = (prompt = "") => {
  const sources = extractDeterministicEvidenceSources(prompt);

  if (sources.length === 0) {
    return ABSTAIN_ANSWER;
  }

  if (!isDeterministicComparisonPrompt(prompt)) {
    const selected = selectQaEvidenceSentences({ prompt, sources });

    return selected
      ? selected
          .map(({ rank, sentence }) => `${sentence} [Source ${rank}]`)
          .join("\n")
      : ABSTAIN_ANSWER;
  }

  return sources
    .flatMap(({ rank, sentence, sentences }) =>
      (sentences ?? [sentence]).map(
        (evidenceSentence) => `${evidenceSentence} [Source ${rank}]`
      )
    )
    .join("\n");
};
