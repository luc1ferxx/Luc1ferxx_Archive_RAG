import { normalizeWhitespace } from "./text-utils.js";

const MAX_QUESTIONS = 3;

const trimQuestion = (value = "") =>
  normalizeWhitespace(value).replace(/[?？。.\s]+$/u, "");

const getCitationKey = (citation = {}) =>
  [
    citation.docId ?? "",
    citation.fileName ?? "",
    citation.pageNumber ?? "",
    citation.chunkIndex ?? "",
    citation.rank ?? "",
  ].join(":");

export const dedupeResearchCitations = (results = []) => {
  const citations = [];
  const seenKeys = new Set();

  for (const result of results) {
    for (const citation of result.citations ?? []) {
      const key = getCitationKey(citation);

      if (seenKeys.has(key)) {
        continue;
      }

      seenKeys.add(key);
      citations.push({
        ...citation,
        rank: citations.length + 1,
      });
    }
  }

  return citations;
};

export const buildResearchPlan = ({ question, documents = [] }) => {
  const topic = trimQuestion(question);
  const documentHints = documents
    .map((document) => document.fileName)
    .filter(Boolean)
    .slice(0, 4)
    .join(", ");
  const scopeSuffix = documentHints
    ? ` Focus on these documents: ${documentHints}.`
    : "";
  const questions = [
    `What are the most important facts, terms, and obligations related to ${topic}?${scopeSuffix}`,
    `Which document evidence supports or qualifies the main findings about ${topic}?${scopeSuffix}`,
    `What conflicts, gaps, risks, or uncertainties should be called out about ${topic}?${scopeSuffix}`,
  ].slice(0, MAX_QUESTIONS);

  return {
    topic: question,
    questions: questions.map((subquestion, index) => ({
      id: `rq-${index + 1}`,
      question: subquestion,
      status: "pending",
    })),
  };
};

const getDocumentEvidenceSummary = ({ documents = [], citations = [] }) => {
  if (citations.length === 0) {
    return "No document citations were returned by the research lookups.";
  }

  const citationsByDocId = new Map();

  for (const citation of citations) {
    const key = citation.docId ?? citation.fileName ?? "unknown";
    const entries = citationsByDocId.get(key) ?? [];
    entries.push(citation);
    citationsByDocId.set(key, entries);
  }

  return [...citationsByDocId.entries()]
    .map(([docKey, docCitations]) => {
      const document = documents.find(
        (candidate) =>
          candidate.docId === docKey || candidate.fileName === docCitations[0]?.fileName
      );
      const fileName = document?.fileName ?? docCitations[0]?.fileName ?? docKey;
      const pages = [
        ...new Set(docCitations.map((citation) => citation.pageNumber).filter(Boolean)),
      ];

      return `- ${fileName}: ${docCitations.length} citation${
        docCitations.length === 1 ? "" : "s"
      }${pages.length > 0 ? ` on page${pages.length === 1 ? "" : "s"} ${pages.join(", ")}` : ""}.`;
    })
    .join("\n");
};

const formatFinding = (result, index) => {
  const answer = normalizeWhitespace(result.text || result.error || "No answer returned.");
  const citationLabels = (result.citations ?? [])
    .map((citation) => `[Source ${citation.rank}]`)
    .join(" ");

  return `${index + 1}. ${answer}${citationLabels ? ` ${citationLabels}` : ""}`;
};

export const formatResearchBrief = ({ question, documents = [], plan, results }) => {
  const citations = dedupeResearchCitations(results);
  const completedResults = results.filter((result) => result.status === "completed");
  const failedResults = results.filter((result) => result.status === "failed");
  const abstainedResults = results.filter((result) => result.abstained);
  const text = [
    "Executive Summary",
    completedResults.length > 0
      ? `The research brief ran ${completedResults.length} document-grounded lookup${
          completedResults.length === 1 ? "" : "s"
        } for: ${question}`
      : `The research brief could not complete document-grounded lookups for: ${question}`,
    "",
    "Key Findings",
    ...(completedResults.length > 0
      ? completedResults.map(formatFinding)
      : ["1. No completed findings were returned."]),
    "",
    "Evidence By Document",
    getDocumentEvidenceSummary({
      documents,
      citations,
    }),
    "",
    "Conflicts Or Gaps",
    failedResults.length > 0 || abstainedResults.length > 0
      ? [
          ...failedResults.map((result) => `- ${result.question}: ${result.error}`),
          ...abstainedResults.map((result) => `- ${result.question}: evidence was insufficient.`),
        ].join("\n")
      : "- No explicit tool failures or abstentions were reported. Review citations for source-level nuance.",
    "",
    "Recommended Next Questions",
    ...plan.questions.map((entry) => `- ${entry.question}`),
  ].join("\n");

  return {
    topic: question,
    questions: plan.questions.map((entry) => ({
      id: entry.id,
      question: entry.question,
      status:
        results.find((result) => result.id === entry.id)?.status ?? entry.status,
    })),
    findings: results,
    citations,
    text,
  };
};
