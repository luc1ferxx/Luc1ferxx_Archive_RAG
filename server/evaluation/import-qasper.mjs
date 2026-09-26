// import-qasper.mjs
//
// Converts a QASPER release file (question answering over NLP papers, with
// annotator-selected evidence paragraphs) into this repo's evaluation corpus
// format, so the retrieval comparison, synthetic eval, and LLM judge can run on
// hundreds of externally annotated questions instead of 48 hand-written ones.
//
// Nothing is downloaded here. Get the release from https://allenai.org/data/qasper
// (CC BY 4.0), extract it, and pass the dev JSON, whose shape is:
//   { "<paperId>": { title, abstract,
//       full_text: [{ section_name, paragraphs: [string] }],
//       qas: [{ question, question_id,
//         answers: [{ answer: { unanswerable, extractive_spans, yes_no,
//                               free_form_answer, evidence, highlighted_evidence } }] }] } }
//
// Mapping:
//   - Each paper becomes a document and the abstract is page 1. With the
//     default --granularity paragraph every paragraph is one more "page",
//     prefixed with its section name as a PDF page would show the heading, so
//     expectedEvidence names the annotated paragraphs themselves. With
//     --granularity section a whole section is one page; any chunk of a long
//     section then counts as a hit, which inflates recall.
//   - An answerable question's evidence comes from the first annotator. Its
//     evidence paragraphs map to the pages that contain them; figure and table
//     evidence ("FLOAT SELECTED") is not in the text and is dropped, and a
//     question left with no locatable evidence is skipped, because retrieval
//     cannot be graded.
//   - referenceAnswers keeps every annotator's answer ("Unanswerable" for an
//     unanswerable one), because the official QASPER answer F1 takes the best
//     match over annotators; referenceAnswer and answerType are the first
//     annotator's.
//   - An unanswerable question (first annotator) becomes shouldAbstain: true.
//
// Usage:
//   node evaluation/import-qasper.mjs --input <qasper-dev-v0.3.json>
//     [--papers 20|all] [--seed 1] [--granularity paragraph|section]
//     [--output evaluation/generated/qasper-dev-sample.json]

import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FLOAT_EVIDENCE_PREFIX = "FLOAT SELECTED";

const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

const slug = (value) =>
  normalize(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);

// mulberry32, so the same seed samples the same papers on every run.
const createSeededRandom = (seed) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const samplePaperIds = (paperIds, count, seed) => {
  const random = createSeededRandom(seed);
  const shuffled = [...paperIds].sort();

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
  }

  return shuffled.slice(0, count);
};

export const QASPER_GRANULARITIES = Object.freeze(["paragraph", "section"]);

const buildPages = (paper, granularity) =>
  [
    normalize(paper.abstract),
    ...(paper.full_text ?? []).flatMap((section) => {
      const heading = normalize(section.section_name);
      const paragraphs = (section.paragraphs ?? []).map(normalize).filter(Boolean);

      return granularity === "section"
        ? [[heading, ...paragraphs].filter(Boolean).join("\n\n")]
        : paragraphs.map((paragraph) => [heading, paragraph].filter(Boolean).join("\n\n"));
    }),
  ].filter(Boolean);

// The answer text and type the official QASPER evaluator derives: extractive
// spans (joined with ", ") win over a free-form answer, then yes/no.
export const describeQasperAnswer = (answer = {}) => {
  if (answer.unanswerable) return { text: "Unanswerable", type: "none" };
  if ((answer.extractive_spans ?? []).map(normalize).filter(Boolean).length > 0) {
    return { text: answer.extractive_spans.map(normalize).filter(Boolean).join(", "), type: "extractive" };
  }
  if (normalize(answer.free_form_answer)) return { text: normalize(answer.free_form_answer), type: "abstractive" };
  if (typeof answer.yes_no === "boolean") return { text: answer.yes_no ? "Yes" : "No", type: "boolean" };
  return null;
};

const referenceAnswerOf = (answer) => {
  if (normalize(answer.free_form_answer)) return normalize(answer.free_form_answer);
  if ((answer.extractive_spans ?? []).length > 0) {
    return answer.extractive_spans.map(normalize).join("; ");
  }
  if (typeof answer.yes_no === "boolean") return answer.yes_no ? "Yes" : "No";
  return null;
};

export const convertQasperPaper = ({ granularity = "paragraph", paper, paperId }) => {
  const docKey = `qasper_${slug(paperId)}`;
  const pages = buildPages(paper, granularity);
  const cases = [];
  let skipped = 0;

  for (const qa of paper.qas ?? []) {
    const answer = qa.answers?.[0]?.answer;

    if (!answer || !normalize(qa.question)) {
      skipped += 1;
      continue;
    }

    const references = (qa.answers ?? [])
      .map((entry) => describeQasperAnswer(entry?.answer))
      .filter(Boolean);
    const base = {
      answerType: describeQasperAnswer(answer)?.type ?? null,
      docKeys: [docKey],
      id: `qasper_${slug(qa.question_id || qa.question)}`,
      question: normalize(qa.question),
      referenceAnswers: [...new Set(references.map((reference) => reference.text))],
      type: "qa",
    };

    if (answer.unanswerable) {
      cases.push({ ...base, expectedEvidence: [], shouldAbstain: true });
      continue;
    }

    const evidencePages = [
      ...new Set(
        (answer.evidence ?? [])
          .map(normalize)
          .filter((paragraph) => paragraph && !paragraph.startsWith(FLOAT_EVIDENCE_PREFIX))
          .flatMap((paragraph) =>
            pages.flatMap((page, index) => (page.includes(paragraph) ? [index + 1] : []))
          )
      ),
    ].sort((left, right) => left - right);

    if (evidencePages.length === 0) {
      skipped += 1;
      continue;
    }

    cases.push({
      ...base,
      expectedEvidence: [{ docKey, pages: evidencePages, score: 3 }],
      referenceAnswer: referenceAnswerOf(answer),
      shouldAbstain: false,
    });
  }

  return {
    cases,
    document: {
      fileName: `${docKey}.pdf`,
      key: docKey,
      pages,
      qasperPaperId: paperId,
      title: normalize(paper.title),
    },
    skipped,
  };
};

const parseArgs = (argv) => {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith("--")) {
      args[argv[index].slice(2)] = argv[index + 1];
      index += 1;
    }
  }
  return args;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));

  if (!args.input) {
    throw new Error(
      "--input <qasper-dev-v0.3.json> is required; download the release from https://allenai.org/data/qasper."
    );
  }

  const release = JSON.parse(await readFile(path.resolve(process.cwd(), args.input), "utf8"));
  const paperIds = Object.keys(release ?? {});

  if (paperIds.length === 0 || !Array.isArray(release[paperIds[0]]?.full_text)) {
    throw new Error(
      "Input is not a QASPER release file: expected { paperId: { full_text: [...], qas: [...] } }. The Hugging Face parquet/columnar export has a different shape."
    );
  }

  const paperCount =
    args.papers === "all" ? paperIds.length : Number(args.papers) > 0 ? Number(args.papers) : 20;
  const seed = Number(args.seed) > 0 ? Number(args.seed) : 1;
  const granularity = args.granularity ?? "paragraph";

  if (!QASPER_GRANULARITIES.includes(granularity)) {
    throw new Error(`--granularity must be one of: ${QASPER_GRANULARITIES.join(", ")}.`);
  }

  const converted = samplePaperIds(paperIds, paperCount, seed).map((paperId) =>
    convertQasperPaper({ granularity, paper: release[paperId], paperId })
  );
  const corpus = {
    metadata: {
      granularity,
      license: "CC BY 4.0",
      papers: converted.length,
      seed,
      source: "QASPER (allenai.org/data/qasper)",
      sourceFile: path.basename(args.input),
    },
    documents: converted.map((entry) => entry.document),
    cases: converted.flatMap((entry) => entry.cases),
  };
  const outputPath = path.resolve(
    process.cwd(),
    args.output ?? path.join(__dirname, "generated", "qasper-dev-sample.json")
  );

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(corpus, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        abstainCases: corpus.cases.filter((testCase) => testCase.shouldAbstain).length,
        cases: corpus.cases.length,
        documents: corpus.documents.length,
        outputPath,
        skippedQuestions: converted.reduce((sum, entry) => sum + entry.skipped, 0),
      },
      null,
      2
    )
  );
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
