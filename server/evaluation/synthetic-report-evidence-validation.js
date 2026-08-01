import { chunkDocumentWithConfig } from "../rag/chunker.js";

export const SYNTHETIC_EVIDENCE_REASON_CODES = Object.freeze({
  ok: "ok",
  invalid: "synthetic_evidence_contract_invalid",
  documentContractsInvalid: "synthetic_document_contracts_invalid",
  chunkConfigInvalid: "synthetic_chunk_config_invalid",
  contextCorpusMismatch: "synthetic_context_corpus_mismatch",
  citationContextMismatch: "synthetic_citation_context_mismatch",
  docIdentityConflict: "synthetic_doc_identity_conflict",
  deterministicDocIdMismatch: "synthetic_evidence_doc_id_mismatch",
  evidenceDocKeyOutOfScope: "synthetic_evidence_doc_key_out_of_scope",
  finalEvidenceNotSubset: "synthetic_final_evidence_not_raw_subset",
});

const IDENTITY_FIELDS = Object.freeze([
  "rank",
  "docId",
  "docKey",
  "fileName",
  "pageNumber",
  "chunkIndex",
  "sectionHeading",
]);

const buildIssue = ({ actual, caseId, expected, field, reasonCode }) => ({
  reasonCode,
  caseId: caseId ?? null,
  field,
  expected: expected ?? null,
  actual: actual ?? null,
});

const hasExactIdentity = (citation = {}, context = {}) =>
  IDENTITY_FIELDS.every((field) => citation[field] === context[field]);

const normalizeCorpusText = (value) =>
  String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();

const normalizeSectionHeading = (value) => value ?? null;

const resolveChunkConfig = (executionConfig) => {
  const chunkStrategy = executionConfig?.chunkStrategy;
  const chunkSize = executionConfig?.chunkSize;
  const chunkOverlap = executionConfig?.chunkOverlap;

  if (
    !["simple", "structured"].includes(chunkStrategy) ||
    !Number.isInteger(chunkSize) ||
    chunkSize <= 0 ||
    !Number.isInteger(chunkOverlap) ||
    chunkOverlap < 0 ||
    chunkOverlap >= chunkSize
  ) {
    return null;
  }

  return { chunkStrategy, chunkSize, chunkOverlap };
};

const buildExpectedChunksByDocumentKey = ({
  chunkConfig,
  documentContracts,
  expectedDocIdByKey,
}) =>
  new Map(
    documentContracts.map((documentContract) => {
      const docKey = String(documentContract?.key ?? "").trim();
      const pages = Array.isArray(documentContract?.pages)
        ? documentContract.pages.map((text, pageIndex) => ({
            pageNumber: pageIndex + 1,
            text: String(text ?? ""),
          }))
        : [];
      const chunks = chunkDocumentWithConfig({
        docId:
          expectedDocIdByKey?.get(docKey) ??
          `synthetic-corpus-document:${docKey}`,
        fileName: documentContract?.fileName,
        publicFilePath: "",
        pages,
        ...chunkConfig,
      });

      return [
        docKey,
        new Map(
          chunks.map((chunk) => [chunk.metadata.chunkIndex, chunk])
        ),
      ];
    })
  );

const validateContextsAgainstCorpus = ({
  caseId,
  contexts,
  documentByKey,
  expectedChunksByDocumentKey,
  fieldPrefix,
  issues,
}) => {
  contexts.forEach((context, index) => {
    const documentContract = documentByKey.get(context?.docKey);
    const expectedChunk = expectedChunksByDocumentKey
      .get(context?.docKey)
      ?.get(context?.chunkIndex);
    const expectedValues = {
      docKey: documentContract?.key,
      fileName: expectedChunk?.metadata?.fileName ?? documentContract?.fileName,
      pageNumber: expectedChunk?.metadata?.pageNumber ?? "existing reconstructed chunk page",
      chunkIndex:
        expectedChunk?.metadata?.chunkIndex ?? "existing reconstructed chunk index",
      sectionHeading: normalizeSectionHeading(
        expectedChunk?.metadata?.sectionHeading
      ),
      text: expectedChunk?.pageContent,
    };

    for (const field of [
      "docKey",
      "fileName",
      "pageNumber",
      "chunkIndex",
      "sectionHeading",
      "text",
    ]) {
      const matches =
        field === "text"
          ? expectedChunk !== undefined &&
            normalizeCorpusText(context?.text) ===
              normalizeCorpusText(expectedChunk.pageContent)
          : field === "sectionHeading"
            ? normalizeSectionHeading(context?.sectionHeading) ===
              expectedValues.sectionHeading
          : context?.[field] === expectedValues[field];

      if (!matches) {
        issues.push(
          buildIssue({
            actual: context?.[field],
            caseId,
            expected:
              expectedValues[field] ??
              (field === "docKey" ? "checked-in corpus document key" : "checked-in corpus value"),
            field: `${fieldPrefix}[${index}].${field}`,
            reasonCode: SYNTHETIC_EVIDENCE_REASON_CODES.contextCorpusMismatch,
          })
        );
      }
    }
  });
};

const pairEvidence = ({
  caseId,
  citationField,
  citations,
  contextField,
  contexts,
  issues,
}) => {
  const pairs = [];

  citations.forEach((citation, citationIndex) => {
    const matchingContexts = contexts.filter((context) =>
      hasExactIdentity(citation, context)
    );

    if (matchingContexts.length !== 1) {
      issues.push(
        buildIssue({
          actual: matchingContexts.length,
          caseId,
          expected: 1,
          field: `${citationField}[${citationIndex}]`,
          reasonCode: SYNTHETIC_EVIDENCE_REASON_CODES.citationContextMismatch,
        })
      );
      return;
    }

    pairs.push({ citation, context: matchingContexts[0] });
  });

  contexts.forEach((context, contextIndex) => {
    const matchingCitations = citations.filter((citation) =>
      hasExactIdentity(citation, context)
    );

    if (matchingCitations.length !== 1) {
      issues.push(
        buildIssue({
          actual: matchingCitations.length,
          caseId,
          expected: 1,
          field: `${contextField}[${contextIndex}]`,
          reasonCode: SYNTHETIC_EVIDENCE_REASON_CODES.citationContextMismatch,
        })
      );
    }
  });

  return pairs;
};

const validateDocIdentityMapping = ({ caseId, evidence, issues }) => {
  const docIdByKey = new Map();
  const docKeyById = new Map();

  evidence.forEach((item, index) => {
    const docId = String(item?.docId ?? "").trim();
    const docKey = String(item?.docKey ?? "").trim();
    const conflict =
      !docId ||
      !docKey ||
      (docIdByKey.has(docKey) && docIdByKey.get(docKey) !== docId) ||
      (docKeyById.has(docId) && docKeyById.get(docId) !== docKey);

    if (conflict) {
      issues.push(
        buildIssue({
          actual: { docId: item?.docId, docKey: item?.docKey },
          caseId,
          expected: "one stable docId per corpus docKey and one docKey per docId",
          field: `evidence[${index}]`,
          reasonCode: SYNTHETIC_EVIDENCE_REASON_CODES.docIdentityConflict,
        })
      );
      return;
    }

    docIdByKey.set(docKey, docId);
    docKeyById.set(docId, docKey);
  });
};

const validateEvidenceScope = ({
  allowedDocKeys,
  caseId,
  evidence,
  expectedDocIdByKey,
  fieldPrefix,
  issues,
}) => {
  if (!Array.isArray(allowedDocKeys)) {
    return;
  }

  const allowed = new Set(allowedDocKeys);

  evidence.forEach((item, index) => {
    if (!allowed.has(item?.docKey)) {
      issues.push(
        buildIssue({
          actual: item?.docKey,
          caseId,
          expected: [...allowed],
          field: `${fieldPrefix}[${index}].docKey`,
          reasonCode:
            SYNTHETIC_EVIDENCE_REASON_CODES.evidenceDocKeyOutOfScope,
        })
      );
    }

    const expectedDocId = expectedDocIdByKey?.get(item?.docKey);

    if (expectedDocId && item?.docId !== expectedDocId) {
      issues.push(
        buildIssue({
          actual: item?.docId,
          caseId,
          expected: expectedDocId,
          field: `${fieldPrefix}[${index}].docId`,
          reasonCode:
            SYNTHETIC_EVIDENCE_REASON_CODES.deterministicDocIdMismatch,
        })
      );
    }
  });
};

const toEvidenceKey = ({ citation, context }) =>
  JSON.stringify([
    citation.docId,
    citation.docKey,
    citation.fileName,
    citation.pageNumber,
    citation.chunkIndex,
    context.text,
  ]);

const validateFinalSubset = ({ caseId, finalPairs, rawPairs, issues }) => {
  const rawCounts = new Map();

  rawPairs.forEach((pair) => {
    const key = toEvidenceKey(pair);
    rawCounts.set(key, (rawCounts.get(key) ?? 0) + 1);
  });

  finalPairs.forEach((pair, index) => {
    const key = toEvidenceKey(pair);
    const remaining = rawCounts.get(key) ?? 0;

    if (remaining === 0) {
      issues.push(
        buildIssue({
          actual: {
            docId: pair.citation.docId,
            docKey: pair.citation.docKey,
            pageNumber: pair.citation.pageNumber,
            chunkIndex: pair.citation.chunkIndex,
          },
          caseId,
          expected: "evidence identity present in raw response evidence",
          field: `finalEvidence[${index}]`,
          reasonCode: SYNTHETIC_EVIDENCE_REASON_CODES.finalEvidenceNotSubset,
        })
      );
      return;
    }

    rawCounts.set(key, remaining - 1);
  });
};

export const validateSyntheticEvidenceContract = ({
  allowedDocKeys = null,
  caseId = null,
  caseResult = {},
  documentContracts = [],
  executionConfig = null,
  expectedDocIdByKey = null,
} = {}) => {
  const issues = [];
  const chunkConfig = resolveChunkConfig(executionConfig);
  const safeDocumentContracts = Array.isArray(documentContracts)
    ? documentContracts
    : [];

  if (!Array.isArray(documentContracts) || documentContracts.length === 0) {
    issues.push(
      buildIssue({
        actual: documentContracts,
        caseId,
        expected: "non-empty checked-in corpus document contracts",
        field: "documentContracts",
        reasonCode: SYNTHETIC_EVIDENCE_REASON_CODES.documentContractsInvalid,
      })
    );
  }

  if (!chunkConfig) {
    issues.push(
      buildIssue({
        actual: executionConfig,
        caseId,
        expected: {
          chunkStrategy: "simple or structured",
          chunkSize: "positive integer",
          chunkOverlap: "integer from 0 through chunkSize - 1",
        },
        field: "executionConfig",
        reasonCode: SYNTHETIC_EVIDENCE_REASON_CODES.chunkConfigInvalid,
      })
    );
  }

  const documentByKey = new Map(
    safeDocumentContracts.map((document) => [document?.key, document])
  );
  const expectedChunksByDocumentKey = chunkConfig
    ? buildExpectedChunksByDocumentKey({
        chunkConfig,
        documentContracts: safeDocumentContracts,
        expectedDocIdByKey,
      })
    : new Map();
  const rawCitations = Array.isArray(caseResult.rawCitations)
    ? caseResult.rawCitations
    : [];
  const rawContexts = Array.isArray(caseResult.rawRetrievedContexts)
    ? caseResult.rawRetrievedContexts
    : [];
  const finalCitations = Array.isArray(caseResult.citations)
    ? caseResult.citations
    : [];
  const finalContexts = Array.isArray(caseResult.retrievedContexts)
    ? caseResult.retrievedContexts
    : [];

  for (const [fieldPrefix, evidence] of [
    ["rawCitations", rawCitations],
    ["rawRetrievedContexts", rawContexts],
    ["citations", finalCitations],
    ["retrievedContexts", finalContexts],
  ]) {
    validateEvidenceScope({
      allowedDocKeys,
      caseId,
      evidence,
      expectedDocIdByKey,
      fieldPrefix,
      issues,
    });
  }

  if (chunkConfig) {
    validateContextsAgainstCorpus({
      caseId,
      contexts: rawContexts,
      documentByKey,
      expectedChunksByDocumentKey,
      fieldPrefix: "rawRetrievedContexts",
      issues,
    });
    validateContextsAgainstCorpus({
      caseId,
      contexts: finalContexts,
      documentByKey,
      expectedChunksByDocumentKey,
      fieldPrefix: "retrievedContexts",
      issues,
    });
  }
  const rawPairs = pairEvidence({
    caseId,
    citationField: "rawCitations",
    citations: rawCitations,
    contextField: "rawRetrievedContexts",
    contexts: rawContexts,
    issues,
  });
  const finalPairs = pairEvidence({
    caseId,
    citationField: "citations",
    citations: finalCitations,
    contextField: "retrievedContexts",
    contexts: finalContexts,
    issues,
  });

  validateDocIdentityMapping({
    caseId,
    evidence: [...rawCitations, ...rawContexts, ...finalCitations, ...finalContexts],
    issues,
  });
  validateFinalSubset({ caseId, finalPairs, rawPairs, issues });

  return {
    status: issues.length === 0 ? "pass" : "fail",
    reasonCode:
      issues.length === 0
        ? SYNTHETIC_EVIDENCE_REASON_CODES.ok
        : SYNTHETIC_EVIDENCE_REASON_CODES.invalid,
    issues,
  };
};
