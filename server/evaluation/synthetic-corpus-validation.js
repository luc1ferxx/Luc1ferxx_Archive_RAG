import path from "node:path";

import { isSafeUploadFileName } from "../upload-policy.js";

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

  if (!Array.isArray(normalizedCorpus.documents)) {
    throw createCorpusError("documents must be an array.");
  }
  if (!Array.isArray(normalizedCorpus.cases)) {
    throw createCorpusError("cases must be an array.");
  }

  const destinationNames = new Set();

  normalizedCorpus.documents.forEach((value, index) => {
    const document = requireRecord(value, `documents[${index}]`);
    const fileName = validateDocumentFileName(document.fileName, index);
    const destinationName = fileName.normalize("NFC").toLowerCase();

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

  return normalizedCorpus;
};
