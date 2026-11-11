// build-office-format-corpus.mjs
//
// Builds the corpus of the Office format evaluation (office-format-eval.js)
// with Word, PowerPoint and Excel themselves, through AppleScript. Needs macOS,
// Microsoft 365 for Mac, and permission for the calling app to control Word,
// PowerPoint and Excel:
//
//   sheet  SheetJS writes each workbook's cells. Excel opens it, fits the
//          columns, prints the header row on every page, scales the sheet to
//          one page wide, saves it again and exports the PDF.
//   word   the test fixture writer sets each QASPER paper as a Word document.
//          Word opens it, saves it again and exports the PDF.
//   deck   PowerPoint makes each deck from scratch (title and content layouts,
//          body bullets from the master, speaker notes), saves it and exports
//          the PDF.
//
// The Office sandbox writes only where it may, so the work happens in a folder
// of the Office group container. The finished files are copied to --out, next
// to manifest.json (documents with their file digests, questions with their
// gold answers). The folder in the group container is removed at the end.
// Office writes the account name into each file's properties, so the corpus
// stays in the ignored evaluation/generated/ and is never committed.
//
// Usage:
//   node evaluation/build-office-format-corpus.mjs [--out evaluation/generated/office-formats]
//     [--seed 1] [--sheets 18] [--decks 16] [--papers 30] [--sheet-questions 6]
//     [--qasper evaluation/generated/qasper/qasper-train-v0.3.json] [--corpora word,sheet,deck]

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import * as XLSX from "xlsx";

import { buildDocx } from "../test/office-fixture-builder.mjs";
import {
  CORPUS_FORMATS,
  MANIFEST_VERSION,
  OFFICE_FORMAT_CORPORA,
  SHEET_DOMAINS,
  buildDeckQuestions,
  buildDeckSpec,
  buildSheetQuestions,
  buildSheetSpec,
  buildWordQuestions,
  deckAppleScript,
  qasperPaperToBlocks,
  selectQasperPapers,
  sheetRoundTripAppleScript,
  sheetSpecToCells,
  wordRoundTripAppleScript,
} from "./office-format-eval.js";
import { createSeededRandom } from "./paired-bootstrap.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OFFICE_GROUP_CONTAINER = path.join(os.homedir(), "Library", "Group Containers", "UBF8T346G9.Office");
const pad = (value) => String(value).padStart(2, "0");

const sha256 = async (filePath) => createHash("sha256").update(await readFile(filePath)).digest("hex");

const runAppleScript = async (script, scriptPath) => {
  await writeFile(scriptPath, script);
  await execFileAsync("osascript", [scriptPath], { timeout: 15 * 60 * 1000 });
};

const officeVersion = async (application) => {
  const { stdout } = await execFileAsync("osascript", ["-e", `tell application "${application}" to get version`], {
    timeout: 120000,
  });

  return stdout.trim();
};

/** The workbook as SheetJS writes it: one sheet, numbers with their number formats. */
export const writeSheetWorkbook = (spec) => {
  const cells = sheetSpecToCells(spec);
  const sheet = {};

  cells.forEach((row, rowIndex) => {
    row.forEach((cell, columnIndex) => {
      const address = XLSX.utils.encode_cell({ c: columnIndex, r: rowIndex });

      sheet[address] =
        cell.type === "number" ? { t: "n", v: cell.value, z: cell.format } : { t: "s", v: String(cell.value) };
    });
  });
  sheet["!ref"] = XLSX.utils.encode_range({ e: { c: cells[0].length - 1, r: cells.length - 1 }, s: { c: 0, r: 0 } });

  const workbook = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(workbook, sheet, spec.sheetName);
  return XLSX.write(workbook, { bookType: "xlsx", type: "buffer" });
};

const parseArgs = (args) => {
  const option = (name, fallback) => {
    const index = args.indexOf(name);

    return index >= 0 ? args[index + 1] : fallback;
  };
  const count = (name, fallback) => Math.max(0, Number.parseInt(option(name, String(fallback)), 10) || 0);
  const corpora = String(option("--corpora", OFFICE_FORMAT_CORPORA.join(",")))
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const corpus of corpora) {
    if (!OFFICE_FORMAT_CORPORA.includes(corpus)) {
      throw new Error(`--corpora takes ${OFFICE_FORMAT_CORPORA.join(", ")}; got ${corpus}.`);
    }
  }

  return {
    corpora,
    decks: count("--decks", 16),
    out: path.resolve(process.cwd(), option("--out", path.join(__dirname, "generated", "office-formats"))),
    papers: count("--papers", 30),
    qasper: path.resolve(
      process.cwd(),
      option("--qasper", path.join(__dirname, "generated", "qasper", "qasper-train-v0.3.json"))
    ),
    seed: Number.parseInt(option("--seed", "1"), 10) || 1,
    sheetQuestions: count("--sheet-questions", 6),
    sheets: count("--sheets", 18),
  };
};

/** Every document of the requested corpora: its spec or blocks and its questions. */
export const planOfficeFormatCorpus = ({ corpora, decks, papers, qasper, seed, sheetQuestions, sheets }) => {
  const documents = [];

  if (corpora.includes("sheet")) {
    for (let index = 1; index <= sheets; index += 1) {
      const domain = SHEET_DOMAINS[(index - 1) % SHEET_DOMAINS.length];
      const random = createSeededRandom(seed * 1000 + index);
      const spec = buildSheetSpec({ domain, id: `sheet-${pad(index)}-${domain.id}`, random });

      documents.push({ corpus: "sheet", id: spec.id, questions: buildSheetQuestions({ count: sheetQuestions, random, spec }), spec });
    }
  }

  if (corpora.includes("deck")) {
    for (let index = 1; index <= decks; index += 1) {
      const random = createSeededRandom(seed * 2000 + index);
      const spec = buildDeckSpec({ id: `deck-${pad(index)}`, random });

      documents.push({ corpus: "deck", id: spec.id, questions: buildDeckQuestions({ random, spec }), spec });
    }
  }

  if (corpora.includes("word")) {
    for (const paperId of selectQasperPapers(qasper, { count: papers, seed })) {
      const paper = qasper[paperId];

      documents.push({
        blocks: qasperPaperToBlocks(paper),
        corpus: "word",
        id: paperId,
        questions: buildWordQuestions({ paper, paperId }),
        title: paper.title,
      });
    }
  }

  return documents;
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const qasper = options.corpora.includes("word") ? JSON.parse(await readFile(options.qasper, "utf8")) : {};
  const documents = planOfficeFormatCorpus({ ...options, qasper });
  const workDirectory = path.join(OFFICE_GROUP_CONTAINER, "archive-rag-office-eval", `corpus-seed-${options.seed}`);

  if (!(await stat(OFFICE_GROUP_CONTAINER).catch(() => null))) {
    throw new Error(`No Office group container at ${OFFICE_GROUP_CONTAINER}; Microsoft 365 for Mac is needed.`);
  }

  await rm(workDirectory, { force: true, recursive: true });
  await mkdir(workDirectory, { recursive: true });

  const office = {
    excel: options.corpora.includes("sheet") ? await officeVersion("Microsoft Excel") : null,
    powerpoint: options.corpora.includes("deck") ? await officeVersion("Microsoft PowerPoint") : null,
    word: options.corpora.includes("word") ? await officeVersion("Microsoft Word") : null,
  };
  const manifestDocuments = [];

  try {
    for (const document of documents) {
      const format = CORPUS_FORMATS[document.corpus];
      const nativeName = `${document.id}.${format}`;
      const pdfName = `${document.id}.pdf`;
      const nativeWorkPath = path.join(workDirectory, nativeName);
      const pdfWorkPath = path.join(workDirectory, pdfName);
      const scriptPath = path.join(workDirectory, `${document.id}.applescript`);

      if (document.corpus === "sheet") {
        const sourcePath = path.join(workDirectory, `${document.id}-source.xlsx`);

        await writeFile(sourcePath, writeSheetWorkbook(document.spec));
        await runAppleScript(
          sheetRoundTripAppleScript({ pdfPath: pdfWorkPath, sourcePath, xlsxPath: nativeWorkPath }),
          scriptPath
        );
      } else if (document.corpus === "word") {
        const sourcePath = path.join(workDirectory, `${document.id}-source.docx`);

        await writeFile(sourcePath, buildDocx({ blocks: document.blocks }));
        await runAppleScript(
          wordRoundTripAppleScript({ docxPath: nativeWorkPath, pdfPath: pdfWorkPath, sourcePath }),
          scriptPath
        );
      } else {
        await runAppleScript(deckAppleScript({ pdfPath: pdfWorkPath, pptxPath: nativeWorkPath, spec: document.spec }), scriptPath);
      }

      const corpusDirectory = path.join(options.out, document.corpus);

      await mkdir(corpusDirectory, { recursive: true });
      await copyFile(nativeWorkPath, path.join(corpusDirectory, nativeName));
      await copyFile(pdfWorkPath, path.join(corpusDirectory, pdfName));
      manifestDocuments.push({
        corpus: document.corpus,
        format,
        id: document.id,
        native: `${document.corpus}/${nativeName}`,
        nativeSha256: await sha256(path.join(corpusDirectory, nativeName)),
        pdf: `${document.corpus}/${pdfName}`,
        pdfSha256: await sha256(path.join(corpusDirectory, pdfName)),
        ...(document.title ? { title: document.title } : {}),
      });
      console.log(`${document.corpus} ${document.id}: ${document.questions.length} questions`);
    }
  } finally {
    await rm(workDirectory, { force: true, recursive: true });
  }

  const manifest = {
    corpora: options.corpora,
    counts: {
      decks: options.corpora.includes("deck") ? options.decks : 0,
      papers: options.corpora.includes("word") ? options.papers : 0,
      sheetQuestions: options.sheetQuestions,
      sheets: options.corpora.includes("sheet") ? options.sheets : 0,
    },
    documents: manifestDocuments,
    generatedAt: new Date().toISOString(),
    office,
    qasper: options.corpora.includes("word") ? path.basename(options.qasper) : null,
    questions: documents.flatMap((document) => document.questions),
    seed: options.seed,
    version: MANIFEST_VERSION,
  };

  await writeFile(path.join(options.out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `${manifestDocuments.length} documents, ${manifest.questions.length} questions -> ${path.join(options.out, "manifest.json")}`
  );
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
