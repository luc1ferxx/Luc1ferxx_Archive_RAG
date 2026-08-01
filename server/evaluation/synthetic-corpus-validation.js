import path from "node:path";

import { isSafeUploadFileName } from "../upload-policy.js";
import {
  SYNTHETIC_COMPARE_EXPECTATIONS,
} from "./synthetic-case-verdict.js";

const unsafeWindowsFileNameCharacters = /[<>:"|?*]/u;
const windowsReservedFileName =
  /^(?:aux|com[1-9]|con|lpt[1-9]|nul|prn)(?:\.|$)/iu;

const createCorpusError = (message) =>
  new Error(`Invalid synthetic evaluation corpus: ${message}`);

const requireRecord = (value, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw createCorpusError(`${label} must be an object.`);
  }

  return value;
};

const validateStableIdentityPart = (value, label) => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().toLowerCase() === "unknown"
  ) {
    throw createCorpusError(`${label} must be a stable non-empty string.`);
  }
};

const validateDocumentFileName = (fileName, index) => {
  const label = `documents[${index}].fileName`;

  if (
    typeof fileName !== "string" ||
    !isSafeUploadFileName(fileName) ||
    path.posix.basename(fileName) !== fileName ||
    path.win32.basename(fileName) !== fileName ||
    unsafeWindowsFileNameCharacters.test(fileName) ||
    windowsReservedFileName.test(fileName) ||
    !fileName.toLowerCase().endsWith(".pdf") ||
    fileName.endsWith(".") ||
    fileName.endsWith(" ")
  ) {
    throw createCorpusError(
      `${label} must be a safe PDF basename without path components.`
    );
  }

  return fileName;
};

export const validateSyntheticCorpus = (corpus) => {
  const normalizedCorpus = requireRecord(corpus, "root");

  validateStableIdentityPart(normalizedCorpus.id, "root.id");
  validateStableIdentityPart(normalizedCorpus.version, "root.version");

  if (!Array.isArray(normalizedCorpus.documents)) {
    throw createCorpusError("documents must be an array.");
  }
  if (!Array.isArray(normalizedCorpus.cases)) {
    throw createCorpusError("cases must be an array.");
  }

  const destinationNames = new Set();
  const documentKeys = new Set();

  normalizedCorpus.documents.forEach((value, index) => {
    const document = requireRecord(value, `documents[${index}]`);
    const fileName = validateDocumentFileName(document.fileName, index);
    const destinationName = fileName.normalize("NFC").toLowerCase();
    const documentKey =
      typeof document.key === "string"
        ? document.key.trim().normalize("NFC")
        : "";

    if (!documentKey || document.key !== documentKey || documentKeys.has(documentKey)) {
      throw createCorpusError(
        `documents[${index}].key must be a unique normalized non-empty string.`
      );
    }
    documentKeys.add(documentKey);

    if (destinationNames.has(destinationName)) {
      throw createCorpusError(
        `documents[${index}].fileName duplicates another destination.`
      );
    }
    destinationNames.add(destinationName);

    if (
      !Array.isArray(document.pages) ||
      document.pages.some((page) => typeof page !== "string")
    ) {
      throw createCorpusError(
        `documents[${index}].pages must be an array of strings.`
      );
    }
  });

  const comparisonExpectationRequired =
    normalizedCorpus.id === "synthetic-corpus-compare-hard" ||
    normalizedCorpus.cases.some(
      (value) => value?.compareExpectation !== undefined
    );

  normalizedCorpus.cases.forEach((value, index) => {
    const testCase = requireRecord(value, `cases[${index}]`);

    if (
      testCase.compareExpectation !== undefined &&
      !SYNTHETIC_COMPARE_EXPECTATIONS.includes(testCase.compareExpectation)
    ) {
      throw createCorpusError(
        `cases[${index}].compareExpectation must be one of ${SYNTHETIC_COMPARE_EXPECTATIONS.join(
          ", "
        )}.`
      );
    }

    if (
      comparisonExpectationRequired &&
      testCase.type === "compare" &&
      testCase.compareExpectation === undefined
    ) {
      throw createCorpusError(
        `cases[${index}].compareExpectation is required for every comparison case in this corpus.`
      );
    }

    if (
      testCase.compareExpectation !== undefined &&
      testCase.type !== "compare"
    ) {
      throw createCorpusError(
        `cases[${index}].compareExpectation is only valid when type is compare.`
      );
    }

    if (
      testCase.compareExpectation !== undefined &&
      (testCase.compareExpectation === "abstain") !==
        (testCase.shouldAbstain === true)
    ) {
      throw createCorpusError(
        `cases[${index}].compareExpectation must agree with shouldAbstain.`
      );
    }
  });

  return normalizedCorpus;
};
