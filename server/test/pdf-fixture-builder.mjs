// Hand-written PDF bytes for the pdf.js extraction and worker pool suites
// (pdf-page-extraction.test.mjs, pdf-parse-pool.test.mjs). A helper, not a
// suite: test/run.test.mjs only runs *.test.mjs files.
//
// The layout follows test/pdf-loader.test.mjs's builder (byte-offset
// cross-reference table, uncompressed streams), extended with raw content
// streams, image and form XObjects shared by every page, and an Info
// dictionary. Every stream is ASCII (images use /ASCIIHexDecode), so the
// byte offsets are the string offsets.

export const PAGE_WIDTH = 612;
export const PAGE_HEIGHT = 792;

export const escapePdfText = (text) =>
  String(text).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

/** One text item: `text` drawn at (x, y) in font F1 (Helvetica) or F2 (Courier). */
export const textItem = (x, y, text, { font = "F1", size = 12 } = {}) =>
  `BT /${font} ${size} Tf ${x} ${y} Td (${escapePdfText(text)}) Tj ET`;

/** Lines of text from the top margin down, `leading` apart, one item each. */
export const textLines = (lines, { font = "F1", leading = 14, size = 11, top = 720, x = 72 } = {}) =>
  lines
    .map((line, index) =>
      typeof line === "string"
        ? textItem(x, top - index * leading, line, { font, size })
        : line.map(([cellX, cellText]) => textItem(cellX, top - index * leading, cellText, { font, size })).join("\n")
    )
    .join("\n");

/** A 2x2 grey image XObject, painted into the unit square of the matrix in force. */
export const GREY_IMAGE = Object.freeze({
  dict: "<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode",
  stream: "00FFFF00>",
});

/**
 * A form XObject drawing `content`, with `{{Name}}` in its resources replaced
 * by the reference of the shared XObject of that name.
 */
export const formXObject = (content, { bbox = [0, 0, PAGE_WIDTH, PAGE_HEIGHT], group = false, matrix = [1, 0, 0, 1, 0, 0], xobjects = [] } = {}) => ({
  dict:
    `<< /Type /XObject /Subtype /Form /BBox [${bbox.join(" ")}] /Matrix [${matrix.join(" ")}]` +
    (group ? " /Group << /S /Transparency >>" : "") +
    ` /Resources << /XObject << ${xobjects.map((name) => `/${name} {{${name}}}`).join(" ")} >> >>`,
  stream: content,
});

/**
 * PDF 1.4 bytes. `pages`: content streams (strings). `xobjects`: { Name:
 * { dict, stream } } shared by every page's resources (a dict without its
 * closing ">>" and /Length, which are added here). `fonts`: { Name: dict }
 * added to F1 (Helvetica) and F2 (Courier). `title` adds an Info dictionary.
 */
export const buildPdf = ({ fonts = {}, pages, xobjects = {}, title = null }) => {
  const objects = new Map([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"],
    [4, "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>"],
  ]);
  let nextId = 5;
  const fontIds = new Map([
    ["F1", 3],
    ["F2", 4],
  ]);
  const xobjectIds = new Map();

  for (const [name, dict] of Object.entries(fonts)) {
    fontIds.set(name, nextId);
    objects.set(nextId, dict);
    nextId += 1;
  }

  for (const name of Object.keys(xobjects)) {
    xobjectIds.set(name, nextId);
    nextId += 1;
  }

  const resolveRefs = (text) => text.replace(/\{\{(\w+)\}\}/g, (_match, name) => `${xobjectIds.get(name)} 0 R`);
  const streamObject = (dict, stream) =>
    `${resolveRefs(dict)} /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;

  for (const [name, { dict, stream }] of Object.entries(xobjects)) {
    objects.set(xobjectIds.get(name), streamObject(dict, stream));
  }

  const xobjectResources = xobjectIds.size
    ? ` /XObject << ${[...xobjectIds].map(([name, id]) => `/${name} ${id} 0 R`).join(" ")} >>`
    : "";
  const pageIds = [];

  for (const content of pages) {
    const pageId = nextId;
    const contentId = nextId + 1;

    nextId += 2;
    pageIds.push(pageId);
    objects.set(
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Contents ${contentId} 0 R ` +
        `/Resources << /Font << ${[...fontIds].map(([name, id]) => `/${name} ${id} 0 R`).join(" ")} >>` +
        `${xobjectResources} >> >>`
    );
    objects.set(contentId, streamObject("<<", content));
  }

  objects.set(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`);

  let infoId = null;

  if (title) {
    infoId = nextId;
    objects.set(infoId, `<< /Title (${escapePdfText(title)}) /Producer (pdf-fixture-builder) >>`);
  }

  const ids = [...objects.keys()].sort((left, right) => left - right);
  const offsets = new Map();
  let pdf = "%PDF-1.4\n";

  for (const id of ids) {
    offsets.set(id, Buffer.byteLength(pdf, "latin1"));
    pdf += `${id} 0 obj\n${objects.get(id)}\nendobj\n`;
  }

  const size = ids.at(-1) + 1;
  const xrefOffset = Buffer.byteLength(pdf, "latin1");

  pdf += `xref\n0 ${size}\n0000000000 65535 f \n`;

  for (let id = 1; id < size; id += 1) {
    pdf += offsets.has(id) ? `${String(offsets.get(id)).padStart(10, "0")} 00000 n \n` : "0000000000 65535 f \n";
  }

  pdf += `trailer\n<< /Root 1 0 R /Size ${size}${infoId ? ` /Info ${infoId} 0 R` : ""} >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, "latin1");
};

// A font whose codes A-E pdf.js reads as private-use code points and the
// replacement character: the kind of text layer a font without a usable
// ToUnicode map leaves behind.
export const GARBLED_FONT =
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding " +
  "/Differences [65 /uniE001 /uniE002 /uniE003 /uniFFFD /uniF8FF] >> >>";

// Seven pages of prose that exercise paragraph detection across page ranges:
// soft-wrapped lines, a line-end hyphen whose word another page spells joined
// ("informa-"/"tion" vs "information") and one whose hyphenated form another
// page uses ("follow-"/"up" vs "follow-up"), a list, a heading, and a table.
export const buildProsePdf = ({ title = "Range parity sample" } = {}) =>
  buildPdf({
    pages: [
      textLines([
        "Remote Work Policy",
        "Employees may work remotely on two days per week when",
        "their manager approves the schedule in writing. The informa-",
        "tion they handle stays on managed devices.",
        "A follow-",
        "up review happens every quarter.",
      ]),
      textLines(["Second page opens a new paragraph that wraps onto", "the next line without punctuation at the break."]),
      textLines([
        "Table 1: Leave entitlements",
        [[72, "Category"], [250, "Days"], [400, "Notice"]],
        [[72, "Annual"], [250, "25"], [400, "30"]],
        [[72, "Parental"], [250, "90"], [400, "60"]],
        [[72, "Sick"], [250, "10"], [400, "0"]],
      ]),
      textLines(["- First item of a list", "- Second item that continues", "  in lowercase on the next line"]),
      textLines(["Every follow-up meeting is minuted. Minutes record the", "information shared and who shared it."]),
      textLines(["Sixth page, a single line."]),
      textLines(["Seventh page ends the document with a last line", "that wraps once more before the end."]),
    ],
    title,
  });

// Five pages a router tells apart: prose with a line-end hyphen, a captioned
// table with two numbered equations under it, a full-page image without
// text, a small figure with a caption, and a garbled text layer.
export const buildMixedPdf = () =>
  buildPdf({
    fonts: { F3: GARBLED_FONT },
    pages: [
      textLines([
        "Quarterly report",
        "Revenue grew in every region except the north, where a new",
        "competitor opened two stores. The board approved the re-",
        "structuring plan in March.",
      ]),
      textLines([
        "Table 2: Results by region",
        [[72, "Region"], [250, "Revenue"], [400, "Growth"]],
        [[72, "North"], [250, "12.1"], [400, "-3%"]],
        [[72, "South"], [250, "18.4"], [400, "7%"]],
        [[72, "E = mc2"], [400, "(3)"]],
        [[72, "x + y = z"], [400, "(4a)"]],
      ]),
      "q 612 0 0 792 0 0 cm /Im1 Do Q",
      `q 61.2 0 0 79.2 0 0 cm /Im1 Do Q\n${textLines(["A caption under a small figure."], { top: 60 })}`,
      "BT /F3 12 Tf 72 720 Td (ABCDEABCDE) Tj ET BT /F1 12 Tf 72 700 Td (plain) Tj ET",
    ],
    title: "Mixed sample",
    xobjects: { Im1: GREY_IMAGE },
  });
