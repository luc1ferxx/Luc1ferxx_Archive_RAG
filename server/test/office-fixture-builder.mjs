// Office files built in memory for the format detection, archive guard and
// Office loader suites (office-*.test.mjs, document-loader.test.mjs). A
// helper, not a suite: test/run.test.mjs only runs *.test.mjs files.
//
// Every builder returns the bytes of a real .docx/.pptx/.xlsx: a ZIP written
// here over node:zlib (deflateRawSync, crc32), with fixed timestamps, so the
// same options give the same bytes. The parts are the minimal set Word,
// PowerPoint and Excel write, with the relationships and content types a
// reader resolves through.
//
// API
//
//   buildZip(entries, options) -> Buffer
//     entries: [{ name, data (Buffer | string), method: "deflate" (default) | "store",
//                 methodCode (another method number in both headers, e.g. 12),
//                 flags (extra general-purpose bits, e.g. 1 = encrypted),
//                 declaredUncompressedSize, declaredCompressedSize, crc32
//                   (lies told in both the local header and the directory),
//                 local: { name, uncompressedSize, compressedSize, method, flags }
//                   (the local header alone disagrees),
//                 extra, localExtra (raw extra-field bytes) }]
//     options: { comment, prefix (bytes before the first entry), trailing
//                (bytes after the end record), totalEntries, entriesOnDisk,
//                centralDirectorySize (end record overrides) }
//   zipEntriesFromParts({ name: data }) -> entries (deflated, in key order)
//
//   buildDocx(options) / docxEntries(options)
//     blocks: [
//       { heading: 1..6, text }                       Heading1..6 paragraph
//       { text } | { runs: ["a", { break: true }, { tab: true }, "b"] }
//       { text, footnote: "..." } / { text, endnote: "..." }   note reference after the text
//       { text, comment: "..." }                      a reviewer comment (not extracted)
//       { list: ["a", { text: "b", level: 1 }], ordered }
//       { table: [["Name", "Amount"], ["Alpha", { text: "10", colSpan: 2 }]] }
//         (cells: string or { text, colSpan, vMerge: "restart" | "continue" })
//       { image: true, alt }                          a picture (dropped by the loader)
//     ]
//     header / footer: text of the page header / footer (not extracted)
//
//   buildPptx(options) / pptxEntries(options)
//     slides: [{
//       title, centeredTitle (ctrTitle placeholder instead of title),
//       titlePosition: { x, y } (inches; null: no position), hidden (show="0"),
//       partNumber (the slideN.xml name; presentation order is the array's),
//       shapes: [
//         { paragraphs, x, y, name }                   a text box (no position without x/y)
//         { placeholder: "body" | "sldNum" | "dt" | "ftr" | "subTitle", paragraphs, x, y }
//         { table: [["H1", "H2"], ["a", "b"]], x, y }  a graphicFrame table
//         { group: [shapes], x, y }                     a group shape
//         { picture: true, alt, x, y }
//       ],
//       notes: "text" | ["paragraph", ...]            a notes slide with slide image,
//                                                      body and slide number placeholders
//     }]
//     paragraphs: "text" | { text, bullet, level, noBullet } |
//                 { runs: ["a", { break: true }, { field: "7" }, "b"], bullet, level }
//     The presentation also carries a slide master and layout whose
//     placeholders hold "Click to edit Master title style" (never slide text).
//
//   buildXlsx(options) / xlsxEntries(options)
//     sheets: [{
//       name, state: "visible" (default) | "hidden" | "veryHidden",
//       rows: [[cell, ...], null (an empty row), ...]   row i is Excel row i + 1
//       merges: ["A1:C1"], chart: true (a chart sheet: no cells)
//     }]
//     cell: null/undefined (none), string, number, boolean,
//           { formula, value } (cached value, never evaluated),
//           { date: "2024-01-15", format: "default" (m/d/yy) | "iso" (yyyy-mm-dd) },
//           { value: 1234.5, format: "money" (#,##0.00) | "percent" (0.00%) },
//           { error: "#DIV/0!" }, { styledEmpty: true } (formatting, no value)
//     sharedStrings: true (default) or false (inline strings)
//
//   Every package builder also takes
//     mainContentType  replaces the main part's content type (macro-enabled,
//                      template, slide show variants: VARIANT_CONTENT_TYPES)
//     transform(entries) -> entries   edit the entry list before zipping
//     zip               options for buildZip
//
//   Hostile parts, to add through `transform` (or buildZip directly):
//     bombEntry({ name, bytes, declaredUncompressedSize })  zeros: ~1000:1 deflated
//     fillerEntries(count, { prefix })                       tiny XML entries
//     unsafeNameEntry(name = "../evil.xml")                  a name that climbs out
//     addDoctype(entries, name)                              a DOCTYPE in that part
//   withDoctype(xml)        the XML with a DOCTYPE and an internal ENTITY added
//   replacePart(entries, name, data) / removePart(entries, name)
//   buildOle2Bytes({ pdfMarker }) -> Buffer   an OLE2 compound file header
//   PDF_HEADER_BYTES                           a minimal "%PDF-1.4" file head
import { crc32, deflateRawSync } from "node:zlib";

export const MAIN_CONTENT_TYPES = Object.freeze({
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
});

export const VARIANT_CONTENT_TYPES = Object.freeze({
  docm: "application/vnd.ms-word.document.macroEnabled.main+xml",
  dotx: "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml",
  potx: "application/vnd.openxmlformats-officedocument.presentationml.template.main+xml",
  ppsx: "application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml",
  pptm: "application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml",
  vsdx: "application/vnd.ms-visio.drawing.main+xml",
  xlsb: "application/vnd.ms-excel.sheet.binary.macroEnabled.main",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.main+xml",
  xltx: "application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml",
});

export const OLE2_HEADER = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
export const PDF_HEADER_BYTES = Buffer.from("%PDF-1.4\n%âãÏÓ\n1 0 obj\n<< >>\nendobj\n", "latin1");

// 1x1 transparent PNG.
export const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

export const escapeXml = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const toBuffer = (data) => (Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ""), "utf8"));

// 1980-01-01 00:00 in DOS form, so builds are byte-for-byte reproducible.
const DOS_TIME = 0;
const DOS_DATE = 0x21;
const UTF8_NAME_FLAG = 0x0800;

const writeLocalHeader = ({ name, flags, method, crc, compressedSize, uncompressedSize, extra }) => {
  const header = Buffer.alloc(30);

  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(flags, 6);
  header.writeUInt16LE(method, 8);
  header.writeUInt16LE(DOS_TIME, 10);
  header.writeUInt16LE(DOS_DATE, 12);
  header.writeUInt32LE(crc >>> 0, 14);
  header.writeUInt32LE(compressedSize >>> 0, 18);
  header.writeUInt32LE(uncompressedSize >>> 0, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(extra.length, 28);
  return Buffer.concat([header, name, extra]);
};

const writeCentralHeader = ({ name, flags, method, crc, compressedSize, uncompressedSize, extra, offset }) => {
  const header = Buffer.alloc(46);

  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(flags, 8);
  header.writeUInt16LE(method, 10);
  header.writeUInt16LE(DOS_TIME, 12);
  header.writeUInt16LE(DOS_DATE, 14);
  header.writeUInt32LE(crc >>> 0, 16);
  header.writeUInt32LE(compressedSize >>> 0, 20);
  header.writeUInt32LE(uncompressedSize >>> 0, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt16LE(extra.length, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(offset >>> 0, 42);
  return Buffer.concat([header, name, extra]);
};

export const buildZip = (entries, options = {}) => {
  const prefix = options.prefix ? toBuffer(options.prefix) : Buffer.alloc(0);
  const pieces = [prefix];
  const central = [];
  let offset = prefix.length;

  for (const entry of entries) {
    const data = toBuffer(entry.data);
    const compressed = entry.method === "store" ? data : deflateRawSync(data, { level: 9 });
    // methodCode: another method number in both headers (the data stays as `method` wrote it).
    const method = entry.methodCode ?? (entry.method === "store" ? 0 : 8);
    const name = Buffer.from(entry.name, "utf8");
    const record = {
      compressedSize: entry.declaredCompressedSize ?? compressed.length,
      crc: entry.crc32 ?? crc32(data),
      extra: entry.extra ? toBuffer(entry.extra) : Buffer.alloc(0),
      flags: UTF8_NAME_FLAG | (entry.flags ?? 0),
      method,
      name,
      offset,
      uncompressedSize: entry.declaredUncompressedSize ?? data.length,
    };
    const local = entry.local ?? {};
    const localHeader = writeLocalHeader({
      ...record,
      compressedSize: local.compressedSize ?? record.compressedSize,
      extra: entry.localExtra ? toBuffer(entry.localExtra) : Buffer.alloc(0),
      flags: local.flags ?? record.flags,
      method: local.method ?? record.method,
      name: local.name ? Buffer.from(local.name, "utf8") : record.name,
      uncompressedSize: local.uncompressedSize ?? record.uncompressedSize,
    });

    pieces.push(localHeader, compressed);
    offset += localHeader.length + compressed.length;
    central.push(writeCentralHeader(record));
  }

  const directory = Buffer.concat(central);
  const comment = toBuffer(options.comment ?? "");
  const end = Buffer.alloc(22);

  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(options.entriesOnDisk ?? entries.length, 8);
  end.writeUInt16LE(options.totalEntries ?? entries.length, 10);
  end.writeUInt32LE(options.centralDirectorySize ?? directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);

  return Buffer.concat([...pieces, directory, end, comment, options.trailing ? toBuffer(options.trailing) : Buffer.alloc(0)]);
};

export const zipEntriesFromParts = (parts) => Object.entries(parts).map(([name, data]) => ({ data, name }));

export const replacePart = (entries, name, data) =>
  entries.map((entry) => (entry.name === name ? { ...entry, data } : entry));

export const removePart = (entries, name) => entries.filter((entry) => entry.name !== name);

/** `xml` with a DOCTYPE carrying an internal ENTITY after its declaration. */
export const withDoctype = (xml, { keyword = "DOCTYPE" } = {}) => {
  const doctype = `<!${keyword} root [<!ENTITY name "value">]>`;

  return xml.startsWith("<?xml") ? xml.replace(/\?>\s*/, `?>\n${doctype}\n`) : `${doctype}\n${xml}`;
};

/** `entries` with a DOCTYPE (and an internal ENTITY) added to the part `name`. */
export const addDoctype = (entries, name) =>
  entries.map((entry) => (entry.name === name ? { ...entry, data: withDoctype(String(entry.data)) } : entry));

/**
 * An entry of `bytes` zeros, which deflate about 1000:1: a zip bomb in
 * miniature. `declaredUncompressedSize` makes its headers lie about it.
 */
export const bombEntry = ({ name = "word/media/bomb.bin", bytes = 8 * 1024 * 1024, declaredUncompressedSize } = {}) => ({
  data: Buffer.alloc(bytes),
  name,
  ...(declaredUncompressedSize === undefined ? {} : { declaredUncompressedSize }),
});

/** `count` tiny XML entries, for RAG_OFFICE_MAX_ZIP_ENTRIES. */
export const fillerEntries = (count, { prefix = "customXml/filler" } = {}) =>
  Array.from({ length: count }, (_, index) => ({ data: "<a/>", name: `${prefix}${index}.xml` }));

/** An entry whose name climbs out of the archive ('..' or an absolute path). */
export const unsafeNameEntry = (name = "../evil.xml") => ({ data: "<a/>", name });

const contentTypesXml = ({ defaults = {}, overrides = {} }) =>
  `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  Object.entries(defaults)
    .map(([extension, type]) => `<Default Extension="${escapeXml(extension)}" ContentType="${escapeXml(type)}"/>`)
    .join("") +
  Object.entries(overrides)
    .map(([part, type]) => `<Override PartName="${escapeXml(part)}" ContentType="${escapeXml(type)}"/>`)
    .join("") +
  `</Types>`;

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const relationshipsXml = (relationships) =>
  `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  relationships
    .map(
      ({ id, type, target, external }) =>
        `<Relationship Id="${escapeXml(id)}" Type="${REL}/${type}" Target="${escapeXml(target)}"${
          external ? ' TargetMode="External"' : ""
        }/>`
    )
    .join("") +
  `</Relationships>`;

const packageRelationships = (mainPart) => relationshipsXml([{ id: "rId1", target: mainPart, type: "officeDocument" }]);

const finishPackage = (entries, { transform } = {}) => (transform ? transform(entries) : entries);

// ---------------------------------------------------------------------------
// Word
// ---------------------------------------------------------------------------

const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

const wordRun = (run) => {
  if (run && typeof run === "object") {
    if (run.break) {
      return "<w:r><w:br/></w:r>";
    }

    if (run.tab) {
      return "<w:r><w:tab/></w:r>";
    }

    return `<w:r><w:t xml:space="preserve">${escapeXml(run.text ?? "")}</w:t></w:r>`;
  }

  return `<w:r><w:t xml:space="preserve">${escapeXml(run)}</w:t></w:r>`;
};

const wordRuns = (block) => (block.runs ?? (block.text === undefined ? [] : [block.text])).map(wordRun).join("");

const wordImage = (alt = "") =>
  `<w:r><w:drawing><wp:inline><wp:extent cx="9525" cy="9525"/><wp:docPr id="1" name="Picture 1" descr="${escapeXml(alt)}"/>` +
  `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>` +
  `<pic:nvPicPr><pic:cNvPr id="0" name="image1.png" descr="${escapeXml(alt)}"/><pic:cNvPicPr/></pic:nvPicPr>` +
  `<pic:blipFill><a:blip r:embed="rIdImage1"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic>` +
  `</wp:inline></w:drawing></w:r>`;

const wordTableCell = (cell) => {
  const spec = cell && typeof cell === "object" ? cell : { text: cell ?? "" };
  const properties = [
    spec.colSpan > 1 ? `<w:gridSpan w:val="${spec.colSpan}"/>` : "",
    spec.vMerge === "restart" ? '<w:vMerge w:val="restart"/>' : spec.vMerge === "continue" ? "<w:vMerge/>" : "",
  ].join("");

  return `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/>${properties}</w:tcPr><w:p>${wordRun(spec.text ?? "")}</w:p></w:tc>`;
};

const wordTable = (rows) => {
  const columns = Math.max(
    1,
    ...rows.map((row) => row.reduce((sum, cell) => sum + (cell && typeof cell === "object" ? cell.colSpan ?? 1 : 1), 0))
  );

  return (
    `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid>${'<w:gridCol w:w="2000"/>'.repeat(columns)}</w:tblGrid>` +
    rows.map((row) => `<w:tr>${row.map(wordTableCell).join("")}</w:tr>`).join("") +
    `</w:tbl>`
  );
};

const WORD_STYLES =
  `${XML_DECLARATION}<w:styles ${W_NS}>` +
  `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` +
  [1, 2, 3, 4, 5, 6]
    .map(
      (level) =>
        `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/></w:style>`
    )
    .join("") +
  `<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/></w:style>` +
  `<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/></w:style>` +
  `<w:style w:type="character" w:styleId="EndnoteReference"><w:name w:val="endnote reference"/></w:style>` +
  `</w:styles>`;

const WORD_NUMBERING =
  `${XML_DECLARATION}<w:numbering ${W_NS}>` +
  `<w:abstractNum w:abstractNumId="0">` +
  `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl>` +
  `<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="o"/></w:lvl>` +
  `</w:abstractNum>` +
  `<w:abstractNum w:abstractNumId="1">` +
  `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>` +
  `<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2)"/></w:lvl>` +
  `</w:abstractNum>` +
  `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>` +
  `<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>` +
  `</w:numbering>`;

const wordNotesXml = (kind, notes) =>
  `${XML_DECLARATION}<w:${kind}s ${W_NS}>` +
  `<w:${kind} w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:${kind}>` +
  `<w:${kind} w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:${kind}>` +
  notes.map((text, index) => `<w:${kind} w:id="${index + 1}"><w:p>${wordRun(text)}</w:p></w:${kind}>`).join("") +
  `</w:${kind}s>`;

export const docxEntries = ({ blocks = [], header = null, footer = null, mainContentType = MAIN_CONTENT_TYPES.docx } = {}) => {
  const footnotes = [];
  const endnotes = [];
  const comments = [];
  let hasImage = false;
  const body = blocks
    .map((block) => {
      if (block.heading) {
        return `<w:p><w:pPr><w:pStyle w:val="Heading${block.heading}"/></w:pPr>${wordRuns(block)}</w:p>`;
      }

      if (block.list) {
        return block.list
          .map((item) => {
            const spec = typeof item === "string" ? { text: item } : item;

            return (
              `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${spec.level ?? 0}"/>` +
              `<w:numId w:val="${block.ordered ? 2 : 1}"/></w:numPr></w:pPr>${wordRuns(spec)}</w:p>`
            );
          })
          .join("");
      }

      if (block.table) {
        return wordTable(block.table);
      }

      if (block.image) {
        hasImage = true;
        return `<w:p>${wordImage(block.alt ?? "")}${wordRuns(block)}</w:p>`;
      }

      let notes = "";

      if (block.footnote !== undefined) {
        footnotes.push(block.footnote);
        notes += `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="${footnotes.length}"/></w:r>`;
      }

      if (block.endnote !== undefined) {
        endnotes.push(block.endnote);
        notes += `<w:r><w:rPr><w:rStyle w:val="EndnoteReference"/></w:rPr><w:endnoteReference w:id="${endnotes.length}"/></w:r>`;
      }

      if (block.comment !== undefined) {
        const id = comments.length;

        comments.push(block.comment);
        return (
          `<w:p><w:commentRangeStart w:id="${id}"/>${wordRuns(block)}<w:commentRangeEnd w:id="${id}"/>` +
          `<w:r><w:commentReference w:id="${id}"/></w:r>${notes}</w:p>`
        );
      }

      return `<w:p>${wordRuns(block)}${notes}</w:p>`;
    })
    .join("");
  const documentRelationships = [
    { id: "rIdStyles", target: "styles.xml", type: "styles" },
    { id: "rIdNumbering", target: "numbering.xml", type: "numbering" },
  ];
  const overrides = {
    "/word/document.xml": mainContentType,
    "/word/numbering.xml": "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml",
    "/word/styles.xml": "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml",
  };
  const parts = {};
  let sectionReferences = "";

  if (footnotes.length > 0) {
    documentRelationships.push({ id: "rIdFootnotes", target: "footnotes.xml", type: "footnotes" });
    overrides["/word/footnotes.xml"] = "application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml";
    parts["word/footnotes.xml"] = wordNotesXml("footnote", footnotes);
  }

  if (endnotes.length > 0) {
    documentRelationships.push({ id: "rIdEndnotes", target: "endnotes.xml", type: "endnotes" });
    overrides["/word/endnotes.xml"] = "application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml";
    parts["word/endnotes.xml"] = wordNotesXml("endnote", endnotes);
  }

  if (comments.length > 0) {
    documentRelationships.push({ id: "rIdComments", target: "comments.xml", type: "comments" });
    overrides["/word/comments.xml"] = "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml";
    parts["word/comments.xml"] =
      `${XML_DECLARATION}<w:comments ${W_NS}>` +
      comments
        .map((text, id) => `<w:comment w:id="${id}" w:author="Reviewer" w:initials="R"><w:p>${wordRun(text)}</w:p></w:comment>`)
        .join("") +
      `</w:comments>`;
  }

  for (const [kind, text] of [
    ["header", header],
    ["footer", footer],
  ]) {
    if (text !== null && text !== undefined) {
      documentRelationships.push({ id: `rId${kind}`, target: `${kind}1.xml`, type: kind });
      overrides[`/word/${kind}1.xml`] = `application/vnd.openxmlformats-officedocument.wordprocessingml.${kind}+xml`;
      parts[`word/${kind}1.xml`] =
        `${XML_DECLARATION}<w:${kind === "header" ? "hdr" : "ftr"} ${W_NS}><w:p>${wordRun(text)}</w:p></w:${kind === "header" ? "hdr" : "ftr"}>`;
      sectionReferences += `<w:${kind}Reference w:type="default" r:id="rId${kind}"/>`;
    }
  }

  if (hasImage) {
    documentRelationships.push({ id: "rIdImage1", target: "media/image1.png", type: "image" });
    parts["word/media/image1.png"] = TINY_PNG;
  }

  return zipEntriesFromParts({
    "[Content_Types].xml": contentTypesXml({ defaults: hasImage ? { png: "image/png" } : {}, overrides }),
    "_rels/.rels": packageRelationships("word/document.xml"),
    "word/document.xml": `${XML_DECLARATION}<w:document ${W_NS}><w:body>${body}<w:sectPr>${sectionReferences}</w:sectPr></w:body></w:document>`,
    "word/_rels/document.xml.rels": relationshipsXml(documentRelationships),
    "word/numbering.xml": WORD_NUMBERING,
    "word/styles.xml": WORD_STYLES,
    ...parts,
  });
};

export const buildDocx = (options = {}) => buildZip(finishPackage(docxEntries(options), options), options.zip);

// ---------------------------------------------------------------------------
// PowerPoint
// ---------------------------------------------------------------------------

const P_NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

const EMU = 914400;

const drawingRun = (run) => {
  if (run && typeof run === "object") {
    if (run.break) {
      return '<a:br><a:rPr lang="en-US"/></a:br>';
    }

    if (run.field !== undefined) {
      return `<a:fld id="{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}" type="slidenum"><a:rPr lang="en-US"/><a:t>${escapeXml(run.field)}</a:t></a:fld>`;
    }

    return `<a:r><a:rPr lang="en-US" dirty="0"/><a:t>${escapeXml(run.text ?? "")}</a:t></a:r>`;
  }

  return `<a:r><a:rPr lang="en-US" dirty="0"/><a:t>${escapeXml(run)}</a:t></a:r>`;
};

const drawingParagraph = (paragraph) => {
  const spec = typeof paragraph === "string" ? { text: paragraph } : paragraph;
  const runs = (spec.runs ?? (spec.text === undefined ? [] : [spec.text])).map(drawingRun).join("");
  let properties = "";

  if (spec.bullet) {
    properties = `<a:pPr marL="342900" indent="-342900" lvl="${spec.level ?? 0}"><a:buFont typeface="Arial"/><a:buChar char="•"/></a:pPr>`;
  } else if (spec.noBullet) {
    properties = "<a:pPr><a:buNone/></a:pPr>";
  } else if (spec.level) {
    properties = `<a:pPr lvl="${spec.level}"/>`;
  }

  return `<a:p>${properties}${runs}<a:endParaRPr lang="en-US"/></a:p>`;
};

const transform2d = (shape, child = false) =>
  shape.x === undefined || shape.y === undefined
    ? ""
    : `<a:xfrm><a:off x="${Math.round(shape.x * EMU)}" y="${Math.round(shape.y * EMU)}"/>` +
      `<a:ext cx="${Math.round((shape.width ?? 4) * EMU)}" cy="${Math.round((shape.height ?? 1) * EMU)}"/>` +
      (child ? `<a:chOff x="0" y="0"/><a:chExt cx="${Math.round((shape.width ?? 4) * EMU)}" cy="${Math.round((shape.height ?? 1) * EMU)}"/>` : "") +
      `</a:xfrm>`;

const PLACEHOLDER_ATTRIBUTES = Object.freeze({
  body: 'type="body" idx="1"',
  ctrTitle: 'type="ctrTitle"',
  dt: 'type="dt" sz="half" idx="10"',
  ftr: 'type="ftr" sz="quarter" idx="11"',
  sldImg: 'type="sldImg"',
  sldNum: 'type="sldNum" sz="quarter" idx="12"',
  subTitle: 'type="subTitle" idx="1"',
  title: 'type="title"',
});

const createShapeIds = () => {
  let next = 2;

  return () => next++;
};

const drawingShape = (shape, nextId, slideState) => {
  const id = nextId();

  if (shape.group) {
    return (
      `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${id}" name="Group ${id}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
      `<p:grpSpPr>${transform2d(shape, true)}</p:grpSpPr>` +
      shape.group.map((child) => drawingShape(child, nextId, slideState)).join("") +
      `</p:grpSp>`
    );
  }

  if (shape.table) {
    const columns = Math.max(1, ...shape.table.map((row) => row.length));

    return (
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id}"/>` +
      `<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>` +
      `<p:xfrm><a:off x="${Math.round((shape.x ?? 0) * EMU)}" y="${Math.round((shape.y ?? 0) * EMU)}"/><a:ext cx="${4 * EMU}" cy="${EMU}"/></p:xfrm>` +
      `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>` +
      `<a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>${'<a:gridCol w="1828800"/>'.repeat(columns)}</a:tblGrid>` +
      shape.table
        .map(
          (row) =>
            `<a:tr h="370840">` +
            row
              .map(
                (cell) =>
                  `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${drawingParagraph(String(cell ?? ""))}</a:txBody><a:tcPr/></a:tc>`
              )
              .join("") +
            `</a:tr>`
        )
        .join("") +
      `</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
    );
  }

  if (shape.picture) {
    slideState.hasPicture = true;
    return (
      `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}" descr="${escapeXml(shape.alt ?? "")}"/>` +
      `<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>` +
      `<p:blipFill><a:blip r:embed="rIdImage1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
      `<p:spPr>${transform2d(shape)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
    );
  }

  const placeholder = shape.placeholder ? `<p:ph ${PLACEHOLDER_ATTRIBUTES[shape.placeholder]}/>` : "";
  const paragraphs = (Array.isArray(shape.paragraphs) ? shape.paragraphs : [shape.paragraphs ?? ""])
    .map(drawingParagraph)
    .join("");

  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(shape.name ?? `TextBox ${id}`)}"/>` +
    `<p:cNvSpPr${shape.placeholder ? '><a:spLocks noGrp="1"/></p:cNvSpPr>' : ' txBox="1"/>'}<p:nvPr>${placeholder}</p:nvPr></p:nvSpPr>` +
    `<p:spPr>${transform2d(shape)}</p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`
  );
};

const shapeTree = (shapes) =>
  `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
  `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
  shapes +
  `</p:spTree></p:cSld>`;

const masterShapeIds = createShapeIds();

const SLIDE_MASTER_XML =
  `${XML_DECLARATION}<p:sldMaster ${P_NS}>` +
  shapeTree(
    drawingShape({ paragraphs: ["Click to edit Master title style"], placeholder: "title", x: 0.5, y: 0.3 }, masterShapeIds, {}) +
      drawingShape({ paragraphs: ["Click to edit Master text styles"], placeholder: "body", x: 0.5, y: 1.5 }, masterShapeIds, {})
  ) +
  `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
  `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`;

const SLIDE_LAYOUT_XML =
  `${XML_DECLARATION}<p:sldLayout ${P_NS} type="titleAndBody" preserve="1">` +
  shapeTree(drawingShape({ paragraphs: ["Click to edit Master title style"], placeholder: "title" }, createShapeIds(), {})) +
  `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

const notesSlideXml = (notes, slideNumber) => {
  const nextId = createShapeIds();

  return (
    `${XML_DECLARATION}<p:notes ${P_NS}>` +
    shapeTree(
      `<p:sp><p:nvSpPr><p:cNvPr id="${nextId()}" name="Slide Image Placeholder"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr>` +
        `<p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>` +
        drawingShape({ name: "Notes Placeholder", paragraphs: Array.isArray(notes) ? notes : [notes], placeholder: "body" }, nextId, {}) +
        drawingShape({ name: "Slide Number Placeholder", paragraphs: [{ runs: [{ field: String(slideNumber) }] }], placeholder: "sldNum" }, nextId, {})
    ) +
    `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`
  );
};

export const pptxEntries = ({ slides = [], mainContentType = MAIN_CONTENT_TYPES.pptx } = {}) => {
  const overrides = {
    "/ppt/presentation.xml": mainContentType,
    "/ppt/slideLayouts/slideLayout1.xml": "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml",
    "/ppt/slideMasters/slideMaster1.xml": "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml",
  };
  const parts = {};
  const presentationRelationships = [{ id: "rId1", target: "slideMasters/slideMaster1.xml", type: "slideMaster" }];
  const slideIds = [];
  let hasPicture = false;

  slides.forEach((slide, index) => {
    const partNumber = slide.partNumber ?? index + 1;
    const relationshipId = `rId${100 + partNumber}`;
    const nextId = createShapeIds();
    const slideState = { hasPicture: false };
    let shapes = "";

    if (slide.title !== undefined) {
      shapes += drawingShape(
        {
          name: "Title 1",
          paragraphs: Array.isArray(slide.title) ? slide.title : [slide.title],
          placeholder: slide.centeredTitle ? "ctrTitle" : "title",
          // null: a title without a position.
          ...(slide.titlePosition === null ? {} : slide.titlePosition ?? { x: 0.5, y: 0.3 }),
        },
        nextId,
        slideState
      );
    }

    shapes += (slide.shapes ?? []).map((shape) => drawingShape(shape, nextId, slideState)).join("");
    hasPicture ||= slideState.hasPicture;

    const slideRelationships = [{ id: "rId1", target: "../slideLayouts/slideLayout1.xml", type: "slideLayout" }];

    if (slide.notes !== undefined) {
      slideRelationships.push({ id: "rId2", target: `../notesSlides/notesSlide${partNumber}.xml`, type: "notesSlide" });
      overrides[`/ppt/notesSlides/notesSlide${partNumber}.xml`] =
        "application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml";
      parts[`ppt/notesSlides/notesSlide${partNumber}.xml`] = notesSlideXml(slide.notes, index + 1);
      parts[`ppt/notesSlides/_rels/notesSlide${partNumber}.xml.rels`] = relationshipsXml([
        { id: "rId1", target: `../slides/slide${partNumber}.xml`, type: "slide" },
      ]);
    }

    if (slideState.hasPicture) {
      slideRelationships.push({ id: "rIdImage1", target: "../media/image1.png", type: "image" });
    }

    overrides[`/ppt/slides/slide${partNumber}.xml`] = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";
    parts[`ppt/slides/slide${partNumber}.xml`] =
      `${XML_DECLARATION}<p:sld ${P_NS}${slide.hidden ? ' show="0"' : ""}>${shapeTree(shapes)}` +
      `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
    parts[`ppt/slides/_rels/slide${partNumber}.xml.rels`] = relationshipsXml(slideRelationships);
    presentationRelationships.push({ id: relationshipId, target: `slides/slide${partNumber}.xml`, type: "slide", partNumber });
    slideIds.push(`<p:sldId id="${256 + index}" r:id="${relationshipId}"/>`);
  });

  if (hasPicture) {
    parts["ppt/media/image1.png"] = TINY_PNG;
  }

  // The relationships in part-number order, which need not be the
  // presentation order the slide id list gives.
  const orderedRelationships = [
    presentationRelationships[0],
    ...presentationRelationships.slice(1).sort((left, right) => left.partNumber - right.partNumber),
  ];

  return zipEntriesFromParts({
    "[Content_Types].xml": contentTypesXml({ defaults: hasPicture ? { png: "image/png" } : {}, overrides }),
    "_rels/.rels": packageRelationships("ppt/presentation.xml"),
    "ppt/presentation.xml":
      `${XML_DECLARATION}<p:presentation ${P_NS} saveSubsetFonts="1">` +
      `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
      `<p:sldIdLst>${slideIds.join("")}</p:sldIdLst>` +
      `<p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": relationshipsXml(orderedRelationships),
    "ppt/slideMasters/slideMaster1.xml": SLIDE_MASTER_XML,
    "ppt/slideMasters/_rels/slideMaster1.xml.rels": relationshipsXml([
      { id: "rId1", target: "../slideLayouts/slideLayout1.xml", type: "slideLayout" },
    ]),
    "ppt/slideLayouts/slideLayout1.xml": SLIDE_LAYOUT_XML,
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels": relationshipsXml([
      { id: "rId1", target: "../slideMasters/slideMaster1.xml", type: "slideMaster" },
    ]),
    ...parts,
  });
};

export const buildPptx = (options = {}) => buildZip(finishPackage(pptxEntries(options), options), options.zip);

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

const S_NS =
  'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

// cellXfs: 0 General, 1 m/d/yy (built-in 14), 2 #,##0.00 (4), 3 0.00% (10),
// 4 yyyy-mm-dd (custom 164).
const STYLE_INDEX = Object.freeze({ default: 1, iso: 4, money: 2, percent: 3 });

const SPREADSHEET_STYLES =
  `${XML_DECLARATION}<styleSheet ${S_NS}>` +
  `<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts>` +
  `<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>` +
  `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
  `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="5">` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

export const columnName = (index) => {
  let remaining = index + 1;
  let name = "";

  while (remaining > 0) {
    name = String.fromCharCode(65 + ((remaining - 1) % 26)) + name;
    remaining = Math.floor((remaining - 1) / 26);
  }

  return name;
};

/** Excel's 1900-system serial number of an ISO date (yyyy-mm-dd). */
export const excelDateSerial = (isoDate) => {
  const [year, month, day] = isoDate.split("-").map(Number);

  return (Date.UTC(year, month - 1, day) - Date.UTC(1899, 11, 30)) / 86_400_000;
};

const spreadsheetCell = (reference, cell, strings) => {
  if (cell === null || cell === undefined) {
    return "";
  }

  if (typeof cell === "string") {
    if (strings) {
      let index = strings.indexOf(cell);

      if (index === -1) {
        index = strings.push(cell) - 1;
      }

      return `<c r="${reference}" t="s"><v>${index}</v></c>`;
    }

    return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell)}</t></is></c>`;
  }

  if (typeof cell === "number") {
    return `<c r="${reference}"><v>${cell}</v></c>`;
  }

  if (typeof cell === "boolean") {
    return `<c r="${reference}" t="b"><v>${cell ? 1 : 0}</v></c>`;
  }

  if (cell.styledEmpty) {
    return `<c r="${reference}" s="2"/>`;
  }

  if (cell.error) {
    return `<c r="${reference}" t="e"><v>${escapeXml(cell.error)}</v></c>`;
  }

  if (cell.date) {
    return `<c r="${reference}" s="${STYLE_INDEX[cell.format ?? "default"]}"><v>${excelDateSerial(cell.date)}</v></c>`;
  }

  if (cell.formula !== undefined) {
    const value = cell.value;
    const type = typeof value === "string" ? ' t="str"' : typeof value === "boolean" ? ' t="b"' : "";
    const cached = typeof value === "boolean" ? (value ? 1 : 0) : escapeXml(value);

    return `<c r="${reference}"${type}><f>${escapeXml(cell.formula)}</f><v>${cached}</v></c>`;
  }

  return `<c r="${reference}"${cell.format ? ` s="${STYLE_INDEX[cell.format]}"` : ""}><v>${cell.value}</v></c>`;
};

const worksheetXml = (sheet, strings) => {
  const rows = sheet.rows ?? [];
  let lastColumn = 0;
  const rowXml = rows
    .map((row, rowIndex) => {
      if (!row) {
        return "";
      }

      lastColumn = Math.max(lastColumn, row.length - 1);
      return (
        `<row r="${rowIndex + 1}">` +
        row.map((cell, columnIndex) => spreadsheetCell(`${columnName(columnIndex)}${rowIndex + 1}`, cell, strings)).join("") +
        `</row>`
      );
    })
    .join("");
  const merges = sheet.merges ?? [];

  return (
    `${XML_DECLARATION}<worksheet ${S_NS}>` +
    `<dimension ref="A1:${columnName(lastColumn)}${Math.max(1, rows.length)}"/>` +
    `<sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/>` +
    `<sheetData>${rowXml}</sheetData>` +
    (merges.length > 0
      ? `<mergeCells count="${merges.length}">${merges.map((ref) => `<mergeCell ref="${ref}"/>`).join("")}</mergeCells>`
      : "") +
    `<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`
  );
};

export const xlsxEntries = ({ sheets = [], sharedStrings = true, mainContentType = MAIN_CONTENT_TYPES.xlsx } = {}) => {
  const strings = sharedStrings ? [] : null;
  const overrides = {
    "/xl/styles.xml": "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml",
    "/xl/workbook.xml": mainContentType,
  };
  const parts = {};
  const workbookRelationships = [];
  const sheetElements = [];

  sheets.forEach((sheet, index) => {
    const number = index + 1;
    const relationshipId = `rId${number}`;
    const state = sheet.state && sheet.state !== "visible" ? ` state="${sheet.state}"` : "";

    sheetElements.push(`<sheet name="${escapeXml(sheet.name)}" sheetId="${number}"${state} r:id="${relationshipId}"/>`);

    if (sheet.chart) {
      workbookRelationships.push({ id: relationshipId, target: `chartsheets/sheet${number}.xml`, type: "chartsheet" });
      overrides[`/xl/chartsheets/sheet${number}.xml`] =
        "application/vnd.openxmlformats-officedocument.spreadsheetml.chartsheet+xml";
      parts[`xl/chartsheets/sheet${number}.xml`] =
        `${XML_DECLARATION}<chartsheet ${S_NS}><sheetPr/><sheetViews><sheetView workbookViewId="0"/></sheetViews>` +
        `<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></chartsheet>`;
      return;
    }

    workbookRelationships.push({ id: relationshipId, target: `worksheets/sheet${number}.xml`, type: "worksheet" });
    overrides[`/xl/worksheets/sheet${number}.xml`] =
      "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml";
    parts[`xl/worksheets/sheet${number}.xml`] = worksheetXml(sheet, strings);
  });

  workbookRelationships.push({ id: "rIdStyles", target: "styles.xml", type: "styles" });

  if (strings && strings.length > 0) {
    workbookRelationships.push({ id: "rIdStrings", target: "sharedStrings.xml", type: "sharedStrings" });
    overrides["/xl/sharedStrings.xml"] = "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml";
    parts["xl/sharedStrings.xml"] =
      `${XML_DECLARATION}<sst ${S_NS.split(" ")[0]} count="${strings.length}" uniqueCount="${strings.length}">` +
      strings.map((text) => `<si><t xml:space="preserve">${escapeXml(text)}</t></si>`).join("") +
      `</sst>`;
  }

  return zipEntriesFromParts({
    "[Content_Types].xml": contentTypesXml({ overrides }),
    "_rels/.rels": packageRelationships("xl/workbook.xml"),
    "xl/workbook.xml":
      `${XML_DECLARATION}<workbook ${S_NS}><bookViews><workbookView/></bookViews>` +
      `<sheets>${sheetElements.join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": relationshipsXml(workbookRelationships),
    "xl/styles.xml": SPREADSHEET_STYLES,
    ...parts,
  });
};

export const buildXlsx = (options = {}) => buildZip(finishPackage(xlsxEntries(options), options), options.zip);

// ---------------------------------------------------------------------------
// Other bytes
// ---------------------------------------------------------------------------

/** An OLE2 compound file's first sector (legacy .doc/.xls/.ppt, encrypted Office files). */
export const buildOle2Bytes = ({ pdfMarker = false } = {}) => {
  const bytes = Buffer.alloc(1536);

  OLE2_HEADER.copy(bytes, 0);

  if (pdfMarker) {
    Buffer.from("%PDF-1.4", "latin1").copy(bytes, 600);
  }

  return bytes;
};
