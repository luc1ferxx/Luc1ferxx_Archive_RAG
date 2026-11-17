import { CAPABILITY_IDS } from "../capabilities/index.js";
import { normalizeTrimmedText } from "../../lib/normalize-text.js";
import { toArray } from "./shared.js";

// The answers of the gated Capabilities that return data instead of text. A
// built-in Skill stops at its Capability's approval gate (skills/built-ins.js),
// and once the gate is approved the capability_call step runs the Capability
// and answers from its result here, in the words the Skill used when it ran
// the Capability itself. Each answer is { text, citations, abstained }; a
// Capability without an entry answers with its own text (capability-steps.js).

const CJK_PATTERN = /[\u3400-\u9fff]/;

const formatPaperLine = (paper, index, language) => {
  const id = paper.arxivId ? `arXiv:${paper.arxivId}` : "arXiv";
  const doc = paper.docId ? `docId: ${paper.docId}` : "not indexed";

  if (language === "zh") {
    return `${index + 1}. ${paper.title || id}（${id}，${doc}）`;
  }

  return `${index + 1}. ${paper.title || id} (${id}, ${doc})`;
};

const formatArxivImportAnswer = ({ question, result }) => {
  const language = CJK_PATTERN.test(question) ? "zh" : "en";
  const completedPapers = [
    ...(result.importedPapers ?? []),
    ...(result.skippedPapers ?? []),
  ];
  const lines = completedPapers.map((paper, index) =>
    formatPaperLine(paper, index, language)
  );

  if (language === "zh") {
    return [
      `已从 arXiv 搜索主题 "${result.topic}"，找到 ${result.foundCount} 篇；新导入 ${result.importedCount} 篇，已存在 ${result.skippedCount} 篇，失败 ${result.failedCount} 篇。`,
      ...lines,
      ...(result.failedPapers?.length
        ? [
            "失败项：",
            ...result.failedPapers.map(
              (paper, index) =>
                `${index + 1}. ${paper.title || paper.arxivId}: ${paper.error}`
            ),
          ]
        : []),
    ].join("\n");
  }

  return [
    `Searched arXiv for "${result.topic}". Found ${result.foundCount}; imported ${result.importedCount}, already indexed ${result.skippedCount}, failed ${result.failedCount}.`,
    ...lines,
    ...(result.failedPapers?.length
      ? [
          "Failures:",
          ...result.failedPapers.map(
            (paper, index) =>
              `${index + 1}. ${paper.title || paper.arxivId}: ${paper.error}`
          ),
        ]
      : []),
  ].join("\n");
};

const getProfile = (document = {}) =>
  document.profile && typeof document.profile === "object"
    ? document.profile
    : {
        summary: document.summary ?? "",
        tags: document.tags ?? [],
        entities: document.entities ?? [],
      };

const buildDiscoveryAnswer = (matches) => {
  if (matches.length === 0) {
    return "I could not find a strong matching document from the current workspace metadata.";
  }

  return [
    `I found ${matches.length} likely matching document${
      matches.length === 1 ? "" : "s"
    }:`,
    ...matches.map(({ document }) => {
      const profile = getProfile(document);
      const tags = (profile.tags ?? []).slice(0, 4);
      const tagText = tags.length > 0 ? ` Tags: ${tags.join(", ")}.` : "";
      const summaryText = profile.summary ? ` ${profile.summary}` : "";

      return `- ${document.fileName}.${tagText}${summaryText}`;
    }),
  ].join("\n");
};

const CAPABILITY_ANSWERS = new Map([
  // The importer's counts and paper lists (arxiv-importer.js), in the language
  // of the user's question. The imported and already indexed papers are the
  // sources; an import that found nothing abstains.
  [
    CAPABILITY_IDS.arxivImportTopic,
    ({ question, result }) => ({
      abstained: result.foundCount === 0,
      citations: [
        ...(result.importedPapers ?? []),
        ...(result.skippedPapers ?? []),
      ].map((paper) => ({
        arxivId: paper.arxivId,
        title: paper.title,
        url: paper.absUrl,
        docId: paper.docId,
        fileName: paper.fileName,
      })),
      text: formatArxivImportAnswer({ question, result }),
    }),
  ],
  // The metadata matches (capabilities/documents.js), kept to the approved
  // docIds; no docIds keeps every match.
  [
    CAPABILITY_IDS.documentDiscovery,
    ({ input, result }) => {
      const selectedDocIds = new Set(toArray(input.docIds));
      const matches = (result.matches ?? []).filter(
        ({ document }) =>
          selectedDocIds.size === 0 || selectedDocIds.has(document?.docId)
      );

      return {
        abstained: false,
        citations: [],
        text: buildDiscoveryAnswer(matches),
      };
    },
  ],
]);

/**
 * The answer of an approved Capability whose result is data, or null for a
 * Capability that answers with its own text. `question` is the run's goal
 * (the user's question) and `input` the approved execution input. The text is
 * trimmed as a Skill result's text is (skills/registry.js).
 */
export const formatCapabilityAnswer = ({
  capabilityId,
  input = {},
  question = "",
  result = {},
} = {}) => {
  const format = CAPABILITY_ANSWERS.get(capabilityId);

  if (!format) {
    return null;
  }

  const answer = format({
    input: input ?? {},
    question: question ?? "",
    result: result ?? {},
  });

  return {
    ...answer,
    text: normalizeTrimmedText(answer.text),
  };
};
