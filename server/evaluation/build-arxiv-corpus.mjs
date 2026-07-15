#!/usr/bin/env node

import pdfParse from "pdf-parse";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toRepoRelativePath } from "./eval-evidence.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const defaultManifestPath = path.join(__dirname, "arxiv-corpus.manifest.json");
const defaultCasesPath = path.join(__dirname, "arxiv-corpus-cases.json");
const defaultGeneratedDirectory = path.join(__dirname, "generated");
const defaultPdfDirectory = path.join(defaultGeneratedDirectory, "arxiv-pdfs");
const defaultOutputPath = path.join(defaultGeneratedDirectory, "arxiv-corpus.json");

const usage = `Usage: npm run corpus:arxiv -- [options]

Downloads a fixed arXiv paper set and extracts PDF text into the page-based
corpus format used by eval:rerank.

Options:
  --manifest <path>      Manifest JSON. Defaults to evaluation/arxiv-corpus.manifest.json.
  --cases <path>         Labeled cases JSON. Defaults to evaluation/arxiv-corpus-cases.json.
  --output <path>        Output corpus JSON. Defaults to evaluation/generated/arxiv-corpus.json.
  --pdf-dir <path>       PDF cache directory. Defaults to evaluation/generated/arxiv-pdfs.
  --max-pages <number>   Parse at most this many pages per PDF.
  --delay-ms <number>    Delay between uncached arXiv downloads. Defaults to 3000.
  --force-download       Re-download PDFs even when cached.
  --skip-download        Use only cached PDFs.
  --no-cases             Build the corpus without labeled cases.
  --help                 Show this message.
`;

const parseArgs = (argv) => {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const rawArg = argv[index];

    if (!rawArg.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${rawArg}`);
    }

    const [key, inlineValue] = rawArg.slice(2).split("=", 2);
    const nextValue = argv[index + 1];

    if (inlineValue !== undefined) {
      args[key] = inlineValue;
    } else if (nextValue && !nextValue.startsWith("--")) {
      args[key] = nextValue;
      index += 1;
    } else {
      args[key] = true;
    }
  }

  return args;
};

const toPositiveInteger = (value, fallbackValue, name) => {
  if (value === undefined) {
    return fallbackValue;
  }

  const parsedValue = Number(value);

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsedValue;
};

const toNonNegativeInteger = (value, fallbackValue, name) => {
  if (value === undefined) {
    return fallbackValue;
  }

  const parsedValue = Number(value);

  if (!Number.isInteger(parsedValue) || parsedValue < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }

  return parsedValue;
};

const resolvePath = (filePath) =>
  path.resolve(process.cwd(), filePath);

const sleep = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const pathExists = async (filePath) => {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
};

const readCasesFile = async ({ casesPath, disabled }) => {
  if (disabled) {
    return {
      cases: [],
      source: null,
    };
  }

  if (!(await pathExists(casesPath))) {
    return {
      cases: [],
      source: null,
    };
  }

  const payload = JSON.parse(await readFile(casesPath, "utf8"));
  const cases = Array.isArray(payload) ? payload : payload.cases;

  if (!Array.isArray(cases)) {
    throw new Error(`Cases file must be an array or contain a cases array: ${casesPath}`);
  }

  return {
    cases,
    source: casesPath,
  };
};

const normalizeArxivIdForFile = (arxivId) =>
  String(arxivId ?? "").trim().replace(/[^A-Za-z0-9._-]+/g, "_");

const buildPdfPath = ({ pdfDirectory, documentSpec }) =>
  path.join(
    pdfDirectory,
    documentSpec.fileName || `${normalizeArxivIdForFile(documentSpec.arxivId)}.pdf`
  );

const normalizePageText = (text = "") =>
  String(text)
    .replace(/\u0000/g, "")
    .replace(/\r/g, "")
    .replace(/-\n(?=[a-z])/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const renderPdfPageText = async (pageData) => {
  const textContent = await pageData.getTextContent({
    normalizeWhitespace: false,
    disableCombineTextItems: false,
  });
  let text = "";
  let lastY = null;

  for (const item of textContent.items) {
    const y = item.transform?.[5];
    const value = item.str ?? "";

    if (!value) {
      continue;
    }

    if (lastY === null || lastY === y) {
      text += value;
    } else {
      text += `\n${value}`;
    }

    lastY = y;
  }

  return text;
};

const extractPdfPages = async ({ pdfPath, maxPages }) => {
  const dataBuffer = await readFile(pdfPath);
  const pages = [];
  const result = await pdfParse(dataBuffer, {
    max: maxPages ?? 0,
    pagerender: async (pageData) => {
      const text = await renderPdfPageText(pageData);
      pages.push(normalizePageText(text));
      return text;
    },
  });

  return {
    pages,
    pageCount: result.numpages,
    renderedPageCount: result.numrender,
    pdfVersion: result.version,
    info: result.info ?? null,
  };
};

const downloadPdf = async ({ documentSpec, pdfPath }) => {
  const response = await fetch(documentSpec.pdfUrl, {
    headers: {
      "user-agent": "Luc1ferxx-Archive-RAG arXiv corpus builder (local evaluation)",
      "accept": "application/pdf,*/*;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to download ${documentSpec.arxivId}: HTTP ${response.status}`
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw new Error(
      `Downloaded content for ${documentSpec.arxivId} does not look like a PDF.`
    );
  }

  await writeFile(pdfPath, buffer);

  return buffer.byteLength;
};

const buildAnnotationPlan = (documents) =>
  documents.map((documentSpec) => ({
    docKey: documentSpec.key,
    arxivId: documentSpec.arxivId,
    title: documentSpec.title,
    suggestedCaseCount: 5,
    annotationFocus: documentSpec.annotationFocus ?? [],
    suggestedCaseTypes: [
      "qa_exact_evidence",
      "qa_hard_negative",
      "compare_with_related_paper",
      "should_abstain_missing_evidence",
      "ambiguous_or_weak_match_query"
    ],
  }));

const buildCorpus = async ({
  manifest,
  cases,
  casesSource,
  pdfDirectory,
  maxPages,
  forceDownload,
  skipDownload,
  delayMs,
}) => {
  const documents = [];
  const downloadRecords = [];

  await mkdir(pdfDirectory, {
    recursive: true,
  });

  for (const [index, documentSpec] of manifest.documents.entries()) {
    const pdfPath = buildPdfPath({
      pdfDirectory,
      documentSpec,
    });
    const cached = await pathExists(pdfPath);
    let downloadedBytes = null;

    if (!cached || forceDownload) {
      if (skipDownload) {
        throw new Error(
          `Missing cached PDF for ${documentSpec.arxivId}: ${pdfPath}`
        );
      }

      downloadedBytes = await downloadPdf({
        documentSpec,
        pdfPath,
      });

      if (delayMs > 0 && index < manifest.documents.length - 1) {
        await sleep(delayMs);
      }
    }

    const extracted = await extractPdfPages({
      pdfPath,
      maxPages,
    });
    const nonEmptyPageCount = extracted.pages.filter(Boolean).length;

    documents.push({
      key: documentSpec.key,
      arxivId: documentSpec.arxivId,
      title: documentSpec.title,
      fileName: documentSpec.fileName || path.basename(pdfPath),
      absUrl: documentSpec.absUrl,
      pdfUrl: documentSpec.pdfUrl,
      primaryCategory: documentSpec.primaryCategory,
      tags: documentSpec.tags ?? [],
      pages: extracted.pages,
    });
    downloadRecords.push({
      key: documentSpec.key,
      arxivId: documentSpec.arxivId,
      pdfPath: toRepoRelativePath(pdfPath),
      cached: cached && !forceDownload,
      downloadedBytes,
      pageCount: extracted.pageCount,
      renderedPageCount: extracted.renderedPageCount,
      nonEmptyPageCount,
      characterCount: extracted.pages.reduce((sum, page) => sum + page.length, 0),
    });
  }

  return {
    metadata: {
      generatedAt: new Date().toISOString(),
      source: "arxiv",
      manifestName: manifest.name ?? null,
      manifestVersion: manifest.version ?? null,
      casesSource: casesSource ? toRepoRelativePath(casesSource) : null,
      maxPages: maxPages ?? null,
    },
    documents,
    cases,
    annotationPlan: buildAnnotationPlan(manifest.documents),
    buildReport: {
      documents: downloadRecords,
    },
  };
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(usage.trim());
    return;
  }

  const manifestPath = resolvePath(args.manifest ?? defaultManifestPath);
  const casesPath = resolvePath(args.cases ?? defaultCasesPath);
  const outputPath = resolvePath(args.output ?? defaultOutputPath);
  const pdfDirectory = resolvePath(args["pdf-dir"] ?? defaultPdfDirectory);
  const maxPages = args["max-pages"] === undefined
    ? null
    : toPositiveInteger(args["max-pages"], null, "--max-pages");
  const delayMs = toNonNegativeInteger(args["delay-ms"], 3000, "--delay-ms");
  const forceDownload = Boolean(args["force-download"]);
  const skipDownload = Boolean(args["skip-download"]);

  if (forceDownload && skipDownload) {
    throw new Error("--force-download and --skip-download cannot be combined.");
  }

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const { cases, source: casesSource } = await readCasesFile({
    casesPath,
    disabled: Boolean(args["no-cases"]),
  });
  const corpus = await buildCorpus({
    manifest,
    cases,
    casesSource,
    pdfDirectory,
    maxPages,
    forceDownload,
    skipDownload,
    delayMs,
  });

  await mkdir(path.dirname(outputPath), {
    recursive: true,
  });
  await writeFile(outputPath, `${JSON.stringify(corpus, null, 2)}\n`, "utf8");

  const totalPages = corpus.documents.reduce(
    (sum, document) => sum + document.pages.length,
    0
  );
  const totalCharacters = corpus.documents.reduce(
    (sum, document) =>
      sum + document.pages.reduce((pageSum, page) => pageSum + page.length, 0),
    0
  );

  console.log(`Wrote ${outputPath}`);
  console.log(`Documents: ${corpus.documents.length}`);
  console.log(`Cases: ${corpus.cases.length}`);
  console.log(`Pages: ${totalPages}`);
  console.log(`Characters: ${totalCharacters}`);
  console.log(`PDF cache: ${pdfDirectory}`);
};

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
