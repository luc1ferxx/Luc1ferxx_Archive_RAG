// load-bench-pdf.mjs
//
// Small, valid text PDFs for the API load test's ingest scenario
// (run-api-load-bench.mjs --scenario ingest), written by hand so the benchmark
// needs no PDF library. Each page is one uncompressed content stream that
// draws one line per sentence in the standard Helvetica font; pdf.js
// (rag/pdf-loader.js) extracts every line as its own text item, so the pages
// the upload route ingests are exactly the sentences given here.
//
// Only printable ASCII survives: the strings are PDF literal strings in
// WinAnsiEncoding, and anything else is replaced with "?" rather than encoded.

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 72;
const FONT_SIZE = 11;
const LEADING = 14;

const toPdfLiteral = (text) =>
  `(${String(text)
    .replace(/[^\x20-\x7e]/g, "?")
    .replace(/[\\()]/g, (character) => `\\${character}`)})`;

const buildContentStream = (lines) => {
  const operators = [`BT`, `/F1 ${FONT_SIZE} Tf`, `${LEADING} TL`, `${MARGIN} ${PAGE_HEIGHT - MARGIN} Td`];

  lines.forEach((line, index) => {
    if (index > 0) operators.push("T*");
    operators.push(`${toPdfLiteral(line)} Tj`);
  });
  operators.push("ET");

  return operators.join("\n");
};

/**
 * PDF 1.4 bytes for `pages`, an array of arrays of lines (one sentence per
 * line works best). Object layout: 1 catalog, 2 page tree, 3 font, then one
 * page object and one content stream per page; the cross-reference table
 * carries the real byte offsets, so strict parsers need no repair pass.
 */
export const buildTextPdf = ({ pages = [], title = "" } = {}) => {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new TypeError("buildTextPdf needs at least one page.");
  }

  const objects = [];
  const pageObjectIds = pages.map((_, index) => 4 + index * 2);
  const infoObjectId = title ? 4 + pages.length * 2 : null;

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

  pages.forEach((lines, index) => {
    const pageId = pageObjectIds[index];
    const stream = buildContentStream(Array.isArray(lines) ? lines : [String(lines)]);

    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId + 1] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
  });

  if (infoObjectId) {
    objects[infoObjectId] = `<< /Title ${toPdfLiteral(title)} /Producer (archive-rag load test) >>`;
  }

  // The binary comment line tells transfer tools the file is not plain text.
  let body = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets = [];

  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.byteLength(body, "latin1");
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(body, "latin1");
  // Every xref entry is exactly 20 bytes including its two-byte line end.
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) {
    body += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  body +=
    `trailer\n<< /Size ${objects.length} /Root 1 0 R${infoObjectId ? ` /Info ${infoObjectId} 0 R` : ""} >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(body, "latin1");
};

const PROGRAMS = Object.freeze([
  "Albatross", "Bluebell", "Cobalt", "Driftwood", "Ember", "Foxglove", "Glacier", "Heron",
  "Indigo", "Jasper", "Kelp", "Lantern", "Marigold", "Nimbus", "Orchid", "Pebble",
]);
const DEPARTMENTS = Object.freeze(["finance", "legal", "platform", "research", "support", "security"]);
const CITIES = Object.freeze(["Lisbon", "Osaka", "Denver", "Nairobi", "Oslo", "Perth", "Quito"]);
const INGEST_FILLER = Object.freeze([
  "Quarterly reviews confirm that every control owner signed the attestation.",
  "Budget variances above five percent are escalated to the program sponsor.",
  "Supplier contracts are stored in the procurement archive for seven years.",
  "Training completion is tracked per team in the learning management system.",
  "Disaster recovery drills are run twice a year with a written summary.",
  "Change freezes apply during the final two weeks of each fiscal year.",
]);

// One distinct, answerable fact per page, so no two uploaded documents share a
// chunk and retrieval can tell them apart.
const INGEST_FACTS = Object.freeze([
  (name, seed) => `The approval threshold for Program ${name} is ${1000 + (seed % 97) * 25} dollars.`,
  (name, seed) => `Program ${name} is run by the ${DEPARTMENTS[seed % DEPARTMENTS.length]} department.`,
  (name, seed) => `The field office for Program ${name} is located in ${CITIES[seed % CITIES.length]}.`,
  (name, seed) => `Program ${name} publishes its audit report in month ${1 + (seed % 12)} of every year.`,
]);

/**
 * Deterministic upload documents for one ingest level: `documents` PDFs of
 * `pages` pages, each page a heading, one fact naming the document's program
 * and a few filler sentences. `tag` makes names unique per level and run so a
 * later level never re-uploads an earlier document's text.
 */
export const buildIngestDocuments = ({ documents = 8, pages = 4, sentencesPerPage = 6, tag = "l1" } = {}) =>
  Array.from({ length: documents }, (_, docIndex) => {
    const name = `${PROGRAMS[docIndex % PROGRAMS.length]}-${tag}-${docIndex + 1}`;
    const pageLines = Array.from({ length: pages }, (_, pageIndex) => {
      const seed = docIndex * 7 + pageIndex * 3;
      const filler = Array.from(
        { length: Math.max(0, sentencesPerPage - 2) },
        (_, sentence) => INGEST_FILLER[(docIndex + pageIndex + sentence) % INGEST_FILLER.length]
      );

      return [
        `Program ${name} operating manual, part ${pageIndex + 1}.`,
        INGEST_FACTS[pageIndex % INGEST_FACTS.length](name, seed),
        ...filler,
      ];
    });
    const fileName = `program-${name.toLowerCase()}-manual.pdf`;

    return {
      fileName,
      name,
      pageLines,
      pdf: buildTextPdf({ pages: pageLines, title: `Program ${name} operating manual` }),
    };
  });
