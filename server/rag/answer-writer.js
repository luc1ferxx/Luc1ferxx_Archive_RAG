import { ChatPromptTemplate, PromptTemplate } from "@langchain/core/prompts";
import { getMaxComparisonSources, getPromptVersion } from "./config.js";
import {
  buildCitation,
  buildContextSection,
  dedupeCitations,
  getResultKey,
} from "./citations.js";
import { completeText } from "./openai.js";

const qaPromptV1 = PromptTemplate.fromTemplate(
  `You answer questions using only retrieved document evidence.
If the evidence is insufficient, say so directly.
Do not substitute adjacent topics for the asked topic.
Keep the answer concise, within five sentences.
When you rely on evidence, cite source labels such as Source 1.

{questionBlock}

Retrieved Evidence:
{context}

Grounded Answer:`
);

const comparisonPromptV1 = PromptTemplate.fromTemplate(
  `You compare uploaded documents using only the provided evidence.
Separate agreement, difference, and uncertainty.
If a document lacks evidence, say so explicitly.
Do not treat a related but different policy as evidence for the asked policy.
Keep the answer concise and cite source labels such as Source 1 when making evidence-based claims.

{questionBlock}

Comparison diagnostics:
{diagnostics}

Evidence by document:
{context}

Write the answer using these sections:
Summary:
Per document:
Agreements:
Differences:
Gaps or uncertainty:`
);

const qaPromptV2 = ChatPromptTemplate.fromMessages([
  [
    "system",
    `You are a document-grounded assistant for uploaded PDFs.
Follow these rules strictly:
- Answer only from the provided evidence.
- Use the same language as the user's latest question.
- Answer the original user question, not the retrieval paraphrase.
- Use the resolved retrieval question only to clarify references or scope.
- Do not substitute related topics, adjacent policies, or likely assumptions for the asked topic.
- If the evidence is insufficient, say exactly what is missing and do not guess.
- Every evidence-based sentence must end with citations like [Source 1].
- Do not cite a source unless it directly supports the sentence.
- Keep the answer concise, usually within five sentences.`,
  ],
  [
    "human",
    `{questionBlock}

Retrieved evidence:
{context}

Grounded Answer:`,
  ],
]);

const comparisonPromptV2 = ChatPromptTemplate.fromMessages([
  [
    "system",
    `You are a document-grounded comparison assistant for uploaded PDFs.
Follow these rules strictly:
- Compare only from the provided evidence.
- Use the same language as the user's latest question.
- Separate agreement, difference, and uncertainty clearly.
- If any document lacks strong evidence, say so explicitly.
- Do not treat a related but different policy as evidence for the asked policy.
- Do not fill evidence gaps with assumptions.
- Every evidence-based sentence must end with citations like [Source 1].
- Do not cite a source unless it directly supports the sentence.
- Keep the answer concise and structured.`,
  ],
  [
    "human",
    `{questionBlock}

Comparison diagnostics:
{diagnostics}

Evidence by document:
{context}

Write the answer using these sections:
Summary:
Per document:
Agreements:
Differences:
Gaps or uncertainty:

Use short bullets inside sections when helpful.`,
  ],
]);

const buildQuestionBlock = ({ query, resolvedQuery }) =>
  resolvedQuery && resolvedQuery !== query
    ? [
        `User Question:\n${query}`,
        `Resolved Retrieval Question:\n${resolvedQuery}`,
        "Answer the user question. Use the resolved retrieval question only for reference disambiguation.",
      ].join("\n\n")
    : `User Question:\n${query}`;

const formatSelectedPrompt = async ({ v1Template, v2Template, values }) =>
  getPromptVersion() === "v1" ? v1Template.format(values) : v2Template.invoke(values);

export const prepareQASourceBundle = ({ results }) => {
  const rankedResults = results.map((result, index) => ({
    ...result,
    rank: index + 1,
  }));

  return {
    rankedResults,
    citations: dedupeCitations(
      rankedResults.map((result) =>
        buildCitation(result.document, result.score, result.rank)
      )
    ),
    context: rankedResults
      .map((result) => buildContextSection(result.document, result.score, result.rank))
      .join("\n\n"),
  };
};

export const prepareComparisonSourceBundle = ({ alignment }) => {
  const flattenedResults = [];
  const seenResultKeys = new Set();
  const appendResult = (result) => {
    const resultKey = getResultKey(result);

    if (seenResultKeys.has(resultKey)) {
      return;
    }

    seenResultKeys.add(resultKey);
    flattenedResults.push(result);
  };

  for (const entry of alignment.perDocument) {
    if (entry.results[0]) {
      appendResult(entry.results[0]);
    }

    if (flattenedResults.length >= getMaxComparisonSources()) {
      break;
    }
  }

  for (
    let offset = 1;
    flattenedResults.length < getMaxComparisonSources();
    offset += 1
  ) {
    let appendedInPass = false;

    for (const entry of alignment.perDocument) {
      if (!entry.results[offset]) {
        continue;
      }

      appendResult(entry.results[offset]);
      appendedInPass = true;

      if (flattenedResults.length >= getMaxComparisonSources()) {
        break;
      }
    }

    if (!appendedInPass) {
      break;
    }
  }

  const rankedResults = flattenedResults.map((result, index) => ({
    ...result,
    rank: index + 1,
  }));
  const rankByResultKey = new Map(
    rankedResults.map((result) => [getResultKey(result), result.rank])
  );
  const selectedResultKeys = new Set(rankByResultKey.keys());

  return {
    rankedResults,
    citations: dedupeCitations(
      rankedResults.map((result) =>
        buildCitation(result.document, result.score, result.rank)
      )
    ),
    context: alignment.perDocument
      .map((entry) => {
        const selectedResults = entry.results.filter((result) =>
          selectedResultKeys.has(getResultKey(result))
        );

        if (selectedResults.length === 0) {
          return [
            `Document: ${entry.fileName}`,
            "No strong evidence was retrieved for this document.",
          ].join("\n");
        }

        return [
          `Document: ${entry.fileName}`,
          entry.focusTerms.length > 0
            ? `Focus terms: ${entry.focusTerms.join(", ")}`
            : null,
          ...selectedResults.map((result) =>
            buildContextSection(
              result.document,
              result.score,
              rankByResultKey.get(getResultKey(result))
            )
          ),
        ]
          .filter(Boolean)
          .join("\n\n");
      })
      .join("\n\n---\n\n"),
  };
};

export const writeQaAnswer = async ({ query, resolvedQuery, bundle }) => {
  const prompt = await formatSelectedPrompt({
    v1Template: qaPromptV1,
    v2Template: qaPromptV2,
    values: {
      questionBlock: buildQuestionBlock({
        query,
        resolvedQuery,
      }),
      context: bundle.context,
    },
  });
  const text = await completeText(prompt);

  return {
    text: text || "I couldn't synthesize an answer from the retrieved document evidence.",
    citations: bundle.citations,
  };
};

export const writeComparisonAnswer = async ({
  query,
  resolvedQuery,
  bundle,
  analysis,
}) => {
  const diagnostics = [
    analysis.sharedTerms.length > 0
      ? `Shared focus terms: ${analysis.sharedTerms.join(", ")}`
      : "Shared focus terms: none detected confidently",
    `Evidence balance: ${analysis.evidenceBalance}`,
    analysis.missingDocuments.length > 0
      ? `Documents without strong evidence: ${analysis.missingDocuments
          .map((document) => document.fileName)
          .join(", ")}`
      : "Documents without strong evidence: none",
  ].join("\n");

  const selectedPrompt = await formatSelectedPrompt({
    v1Template: comparisonPromptV1,
    v2Template: comparisonPromptV2,
    values: {
      questionBlock: buildQuestionBlock({
        query,
        resolvedQuery,
      }),
      diagnostics,
      context: bundle.context,
    },
  });
  const text = await completeText(selectedPrompt);

  return {
    text:
      text ||
      "I couldn't produce a reliable comparison from the retrieved document evidence.",
    citations: bundle.citations,
  };
};
