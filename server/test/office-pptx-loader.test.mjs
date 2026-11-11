import test from "node:test";
import assert from "node:assert/strict";
import { isDocumentFormatError } from "../rag/document-format-errors.js";
import { extractPptxPages, PPTX_EXTRACTOR_VERSION } from "../rag/office/pptx-loader.js";

// The parts Map is built directly from XML strings, the way the archive guard
// hands it over (ZIP entry name without a leading slash -> Buffer); no ZIP is
// involved.

const NAMESPACES = [
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"',
].join(" ");

const RELATIONSHIP_TYPES = {
  officeDocument: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
  slide: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide",
  slideMaster: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster",
  slideLayout: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout",
  notesSlide: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide",
  hyperlink: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
};

const xmlPart = (body) => Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}`, "utf8");

const relationshipsXml = (relationships) =>
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships
    .map(
      ({ id, type, target, external = false }) =>
        `<Relationship Id="${id}" Type="${RELATIONSHIP_TYPES[type] ?? type}" Target="${target}"${
          external ? ' TargetMode="External"' : ""
        }/>`
    )
    .join("")}</Relationships>`;

const presentationXml = (relationshipIds, namespaces = NAMESPACES) =>
  `<p:presentation ${namespaces}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdMaster"/></p:sldMasterIdLst>` +
  `<p:sldIdLst>${relationshipIds.map((id, index) => `<p:sldId id="${256 + index}" r:id="${id}"/>`).join("")}</p:sldIdLst>` +
  `<p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;

const SHAPE_TREE_HEADER =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

const slideXml = (shapes, { show } = {}) =>
  `<p:sld ${NAMESPACES}${show === undefined ? "" : ` show="${show}"`}><p:cSld><p:spTree>${SHAPE_TREE_HEADER}${shapes}</p:spTree></p:cSld>` +
  "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>";

const notesXml = (shapes) =>
  `<p:notes ${NAMESPACES}><p:cSld><p:spTree>${SHAPE_TREE_HEADER}${shapes}</p:spTree></p:cSld>` +
  "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>";

const placeholderXml = (placeholder) => {
  if (!placeholder) {
    return "";
  }

  const type = placeholder.type ? ` type="${placeholder.type}"` : "";
  const idx = placeholder.idx === undefined ? "" : ` idx="${placeholder.idx}"`;
  return `<p:ph${type}${idx}/>`;
};

const offsetXml = (offset) =>
  offset ? `<a:xfrm><a:off x="${offset.x}" y="${offset.y}"/><a:ext cx="1000" cy="1000"/></a:xfrm>` : "";

const run = (text) => `<a:r><a:rPr lang="en-US" dirty="0"/><a:t>${text}</a:t></a:r>`;
const paragraph = (text, properties = "") => `<a:p>${properties}${run(text)}</a:p>`;
const paragraphs = (...texts) => texts.map((text) => paragraph(text)).join("");

const shape = ({ id = 2, name = "TextBox", placeholder = null, offset = null, body = "" } = {}) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr>${placeholderXml(placeholder)}</p:nvPr></p:nvSpPr>` +
  `<p:spPr>${offsetXml(offset)}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${body}</p:txBody></p:sp>`;

const textBox = (text, offset = null) => shape({ offset, body: paragraph(text) });
const title = (text, type = "title") => shape({ name: "Title 1", placeholder: { type }, body: paragraph(text) });

const group = (offset, inner) =>
  `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="20" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
  `<p:grpSpPr><a:xfrm><a:off x="${offset.x}" y="${offset.y}"/><a:ext cx="10" cy="10"/>` +
  `<a:chOff x="${offset.x}" y="${offset.y}"/><a:chExt cx="10" cy="10"/></a:xfrm></p:grpSpPr>${inner}</p:grpSp>`;

const tableCell = (cell) => {
  const { text = "", paragraphs: cellParagraphs = null, attributes = "" } =
    typeof cell === "string" ? { text: cell } : cell;
  const body = (cellParagraphs ?? [text])
    .map((value) => (value ? paragraph(value) : '<a:p><a:endParaRPr lang="en-US"/></a:p>'))
    .join("");

  return `<a:tc${attributes}><a:txBody><a:bodyPr/><a:lstStyle/>${body}</a:txBody><a:tcPr/></a:tc>`;
};

const table = (rows, offset = null) =>
  `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="Table"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>` +
  `${offset ? `<p:xfrm><a:off x="${offset.x}" y="${offset.y}"/><a:ext cx="1000" cy="1000"/></p:xfrm>` : "<p:xfrm/>"}` +
  `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"/>` +
  `<a:tblGrid>${rows[0].map(() => '<a:gridCol w="1000"/>').join("")}</a:tblGrid>` +
  `${rows.map((row) => `<a:tr h="370840">${row.map(tableCell).join("")}</a:tr>`).join("")}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;

// One deck: slides[i] is stored as ppt/slides/slide{i+1}.xml behind
// relationship rId{i+1}; `order` lists the slide indexes in p:sldIdLst order.
// A slide may bring notes (stored as ppt/notesSlides/notesSlide{i+1}.xml) and
// extra slide relationships.
const buildDeck = (slides, { order = slides.map((_, index) => index) } = {}) => {
  const parts = new Map();
  const presentationRelationships = [
    { id: "rIdMaster", type: "slideMaster", target: "slideMasters/slideMaster1.xml" },
  ];

  slides.forEach((slide, index) => {
    const number = index + 1;
    const definition = typeof slide === "string" ? { xml: slide } : slide;
    const slideRelationships = [{ id: "rId1", type: "slideLayout", target: "../slideLayouts/slideLayout1.xml" }];

    presentationRelationships.push({ id: `rId${number}`, type: "slide", target: `slides/slide${number}.xml` });
    parts.set(`ppt/slides/slide${number}.xml`, xmlPart(definition.xml));

    if (definition.notes !== undefined) {
      parts.set(`ppt/notesSlides/notesSlide${number}.xml`, xmlPart(definition.notes));
      slideRelationships.push({ id: "rId2", type: "notesSlide", target: `../notesSlides/notesSlide${number}.xml` });
    }

    slideRelationships.push(...(definition.relationships ?? []));
    parts.set(`ppt/slides/_rels/slide${number}.xml.rels`, xmlPart(relationshipsXml(slideRelationships)));
  });

  parts.set("ppt/presentation.xml", xmlPart(presentationXml(order.map((index) => `rId${index + 1}`))));
  parts.set("ppt/_rels/presentation.xml.rels", xmlPart(relationshipsXml(presentationRelationships)));

  return parts;
};

const withPart = (parts, name, value) => new Map(parts).set(name, value);

const withoutPart = (parts, name) => {
  const copy = new Map(parts);
  copy.delete(name);
  return copy;
};

const CONTENT_MARKER = "Confidential-7731";

const assertArchiveInvalid = (parts, messagePattern) => {
  assert.throws(
    () => extractPptxPages(parts),
    (error) => {
      assert.ok(isDocumentFormatError(error), "the shared coded refusal");
      assert.equal(error.status, 400);
      assert.equal(error.code, "DOCUMENT_ARCHIVE_INVALID");
      assert.equal(error.expose, true);
      assert.match(error.message, /^The document cannot be read: /);
      assert.match(error.message, messagePattern);
      assert.ok(!error.message.includes(CONTENT_MARKER), "the message carries no file content");
      assert.ok(!error.message.includes("slide1"), "the message carries no part names");
      return true;
    }
  );
};

// Version 2: bullets follow PowerPoint's inheritance (the test below), which
// changed the text of the same bytes.
test("PPTX_EXTRACTOR_VERSION is 2", () => {
  assert.equal(PPTX_EXTRACTOR_VERSION, 2);
});

// A layout and a master the way PowerPoint writes them: the master's body
// text style bullets its first two levels, its title style does not; the
// layout's content placeholder (idx 1) leaves bullets to the master, its
// caption placeholder (idx 13) turns them off.
const listStyleXml = (tag, levels) =>
  `<${tag}>${levels.map((setting, index) => `<a:lvl${index + 1}pPr>${setting}</a:lvl${index + 1}pPr>`).join("")}</${tag}>`;
const BULLET = '<a:buFont typeface="Arial"/><a:buChar char="•"/>';
const NO_BULLET = "<a:buNone/>";
const styledPlaceholder = ({ id, type, idx, listStyle = "<a:lstStyle/>" }) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Placeholder ${id}"/><p:cNvSpPr/><p:nvPr>${placeholderXml({ idx, type })}</p:nvPr></p:nvSpPr>` +
  `<p:spPr/><p:txBody><a:bodyPr/>${listStyle}${paragraph("Click to edit Master text styles")}</p:txBody></p:sp>`;
const MASTER_XML =
  `<p:sldMaster ${NAMESPACES}><p:cSld><p:spTree>${SHAPE_TREE_HEADER}` +
  styledPlaceholder({ id: 2, type: "title" }) +
  styledPlaceholder({ id: 3, idx: 1, type: "body" }) +
  "</p:spTree></p:cSld><p:txStyles>" +
  listStyleXml("p:titleStyle", [NO_BULLET]) +
  listStyleXml("p:bodyStyle", [BULLET, BULLET]) +
  listStyleXml("p:otherStyle", ['<a:defRPr lang="en-US"/>']) +
  "</p:txStyles></p:sldMaster>";
const LAYOUT_XML =
  `<p:sldLayout ${NAMESPACES} type="obj"><p:cSld><p:spTree>${SHAPE_TREE_HEADER}` +
  styledPlaceholder({ id: 2, type: "title" }) +
  styledPlaceholder({ id: 3, idx: 1 }) +
  styledPlaceholder({ id: 4, idx: 13, listStyle: listStyleXml("a:lstStyle", [NO_BULLET]), type: "body" }) +
  "</p:spTree></p:cSld></p:sldLayout>";

const withLayoutAndMaster = (parts, { layout = LAYOUT_XML, master = MASTER_XML } = {}) => {
  const copy = new Map(parts);

  copy.set("ppt/slideLayouts/slideLayout1.xml", xmlPart(layout));
  copy.set(
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
    xmlPart(relationshipsXml([{ id: "rId1", type: "slideMaster", target: "../slideMasters/slideMaster1.xml" }]))
  );
  copy.set("ppt/slideMasters/slideMaster1.xml", xmlPart(master));
  return copy;
};

test("a paragraph's bullet is inherited from the layout and the master, as PowerPoint draws it", () => {
  const ownListStyle =
    '<p:sp><p:nvSpPr><p:cNvPr id="8" name="Numbered box"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>' +
    `${listStyleXml("a:lstStyle", ['<a:buAutoNum type="arabicPeriod"/>'])}${paragraph("Numbered by its own list style")}</p:txBody></p:sp>`;
  const slide = slideXml(
    title("Plan") +
      shape({
        body:
          paragraph("Launch in Q3") +
          paragraph("Beta with ten customers", '<a:pPr lvl="1"/>') +
          paragraph("Not a list item", "<a:pPr><a:buNone/></a:pPr>"),
        id: 3,
        offset: { x: 0, y: 100 },
        placeholder: { idx: 1 },
      }) +
      shape({ body: paragraph("A caption"), id: 4, offset: { x: 0, y: 200 }, placeholder: { idx: 13, type: "body" } }) +
      shape({ body: paragraph("A loose text box"), id: 5, offset: { x: 0, y: 300 } }) +
      ownListStyle
  );
  const expected = {
    pageNumber: 1,
    text: [
      "Plan",
      "- Launch in Q3",
      "- Beta with ten customers",
      "Not a list item",
      "A caption",
      "A loose text box",
      "- Numbered by its own list style",
    ].join("\n"),
    locationUnit: "slide",
    locationLabel: "Plan",
  };

  assert.deepEqual(extractPptxPages(withLayoutAndMaster(buildDeck([slide]))), [expected]);

  // Without the layout and master nothing is inherited: only the indented
  // paragraph and the shape's own list style mark list items.
  assert.deepEqual(extractPptxPages(buildDeck([slide]))[0].text.split("\n"), [
    "Plan",
    "Launch in Q3",
    "- Beta with ten customers",
    "Not a list item",
    "A caption",
    "A loose text box",
    "- Numbered by its own list style",
  ]);

  // A layout or master that cannot be read only loses the inherited bullets.
  const broken = withLayoutAndMaster(buildDeck([slide]), { master: "<p:sldMaster" });

  assert.equal(extractPptxPages(broken)[0].text.split("\n")[1], "Launch in Q3");
});

test("the presentation part may be passed in, as the archive guard resolved it", () => {
  const parts = buildDeck([slideXml(textBox("From the named part"))]);
  const renamed = new Map(
    [...parts].map(([name, value]) => [name.replace("ppt/presentation.xml", "ppt/deck.xml").replace("presentation.xml.rels", "deck.xml.rels"), value])
  );

  assert.deepEqual(extractPptxPages(renamed, { presentationPart: "ppt/deck.xml" }), [
    { pageNumber: 1, text: "From the named part", locationUnit: "slide" },
  ]);
  // Through _rels/.rels the reader finds it on its own.
  assert.deepEqual(
    extractPptxPages(
      withPart(renamed, "_rels/.rels", xmlPart(relationshipsXml([{ id: "rId1", type: "officeDocument", target: "ppt/deck.xml" }])))
    ),
    [{ pageNumber: 1, text: "From the named part", locationUnit: "slide" }]
  );
});

test("the text budget: table lines as they are written, then each page; 413 past it", () => {
  const rows = [["Label", "Value"], ...Array.from({ length: 50 }, (_, index) => [`k${index}`, `v${index}`])];
  const parts = buildDeck([slideXml(table(rows)), slideXml(textBox("x".repeat(400)))]);
  const pages = extractPptxPages(parts);
  const total = pages.reduce((sum, page) => sum + page.text.length, 0);
  const expectTooLarge = (maxTextChars) =>
    assert.throws(
      () => extractPptxPages(parts, { maxTextChars }),
      (error) =>
        isDocumentFormatError(error) &&
        error.status === 413 &&
        error.code === "DOCUMENT_ARCHIVE_TOO_LARGE" &&
        /RAG_OFFICE_MAX_TEXT_CHARS/.test(error.message)
    );

  assert.deepEqual(extractPptxPages(parts, { maxTextChars: total }), pages);
  expectTooLarge(total - 1);
  // The table alone is past a small budget before its slide is assembled.
  expectTooLarge(100);
});

test("a header cell too long to be a label is written once; the column letter labels the rows", () => {
  const longHeader = `Notes ${"z".repeat(300)}`;
  const parts = buildDeck([slideXml(table([["Name", longHeader], ["Ada", "first"], ["Bo", "second"]]))]);

  assert.deepEqual(extractPptxPages(parts)[0].text.split("\n"), [
    `Name; ${longHeader}`,
    "Name: Ada; B: first",
    "Name: Bo; B: second",
  ]);
});

test("a notes page with more paragraphs than a call can take as arguments still reads", () => {
  const count = 130_000;
  const notesBody = shape({ body: "<a:p><a:r><a:t>n</a:t></a:r></a:p>".repeat(count), placeholder: { idx: 1, type: "body" } });
  const pages = extractPptxPages(buildDeck([{ notes: notesXml(notesBody), xml: slideXml(textBox("Slide")) }]));

  assert.equal(pages[0].text.split("\n").length, count + 2);
});

test("slides follow p:sldIdLst, numbered by their position in the deck", () => {
  const parts = buildDeck([slideXml(textBox("First part")), slideXml(textBox("Second part")), slideXml(textBox("Third part"))], {
    order: [2, 0, 1],
  });

  assert.deepEqual(extractPptxPages(parts), [
    { pageNumber: 1, text: "Third part", locationUnit: "slide" },
    { pageNumber: 2, text: "First part", locationUnit: "slide" },
    { pageNumber: 3, text: "Second part", locationUnit: "slide" },
  ]);
});

test("hidden slides yield no page but keep their numbers", () => {
  const parts = buildDeck([
    slideXml(textBox("Visible one")),
    { xml: slideXml(textBox("Hidden zero"), { show: "0" }), notes: notesXml(textBox("Hidden notes")) },
    slideXml(textBox("Hidden false"), { show: "false" }),
    slideXml(textBox("Shown explicitly"), { show: "1" }),
    slideXml(textBox("Shown true"), { show: "true" }),
  ]);

  assert.deepEqual(
    extractPptxPages(parts).map(({ pageNumber, text }) => ({ pageNumber, text })),
    [
      { pageNumber: 1, text: "Visible one" },
      { pageNumber: 4, text: "Shown explicitly" },
      { pageNumber: 5, text: "Shown true" },
    ]
  );
});

test("the title comes first and labels the page; other slides carry no label key", () => {
  const titledSlide = slideXml(
    textBox("Caption at the top", { x: 0, y: 0 }) +
      shape({
        name: "Title 1",
        placeholder: { type: "title" },
        body: paragraphs("Quarterly", "Results 2026"),
      }) +
      textBox("Body text", { x: 0, y: 500 })
  );
  const centeredTitleSlide = slideXml(
    shape({ placeholder: { type: "subTitle", idx: 1 }, body: paragraph("Subtitle") }) + title("Opening", "ctrTitle")
  );
  const untitledSlide = slideXml(textBox("No title here"));
  const emptyTitleSlide = slideXml(
    shape({ placeholder: { type: "title" }, body: '<a:p><a:endParaRPr lang="en-US"/></a:p>' }) + textBox("Only body")
  );
  const pages = extractPptxPages(buildDeck([titledSlide, centeredTitleSlide, untitledSlide, emptyTitleSlide]));

  assert.deepEqual(pages[0], {
    pageNumber: 1,
    text: "Quarterly\nResults 2026\nCaption at the top\nBody text",
    locationUnit: "slide",
    locationLabel: "Quarterly Results 2026",
  });
  assert.deepEqual(pages[1], {
    pageNumber: 2,
    text: "Opening\nSubtitle",
    locationUnit: "slide",
    locationLabel: "Opening",
  });
  assert.deepEqual(Object.keys(pages[2]), ["pageNumber", "text", "locationUnit"]);
  assert.deepEqual(pages[3], { pageNumber: 4, text: "Only body", locationUnit: "slide" });
});

test("bulleted, numbered and indented paragraphs become list lines; empty paragraphs are dropped", () => {
  const body = [
    paragraph("Plain paragraph"),
    paragraph("Bulleted", '<a:pPr marL="342900" indent="-342900"><a:buFont typeface="Arial"/><a:buChar char="&#8226;"/></a:pPr>'),
    paragraph("Numbered", '<a:pPr><a:buAutoNum type="arabicPeriod"/></a:pPr>'),
    paragraph("Picture bullet", '<a:pPr><a:buBlip><a:blip r:embed="rId9"/></a:buBlip></a:pPr>'),
    paragraph("Indented", '<a:pPr lvl="1"><a:buNone/></a:pPr>'),
    paragraph("Top level without bullet", '<a:pPr lvl="0"><a:buNone/></a:pPr>'),
    '<a:p><a:pPr><a:buChar char="-"/></a:pPr><a:endParaRPr lang="en-US"/></a:p>',
    paragraph("   "),
    paragraph("Odd level value", '<a:pPr lvl="x"/>'),
  ].join("");
  const [page] = extractPptxPages(buildDeck([slideXml(shape({ body }))]));

  assert.equal(
    page.text,
    [
      "Plain paragraph",
      "- Bulleted",
      "- Numbered",
      "- Picture bullet",
      "- Indented",
      "Top level without bullet",
      "Odd level value",
    ].join("\n")
  );
});

test("runs, fields and line breaks of a paragraph join on one line", () => {
  const body =
    `<a:p>${run("Hello ")}${run("big")}<a:br><a:rPr lang="en-US"/></a:br>${run("world on ")}` +
    '<a:fld id="{11111111-2222-3333-4444-555555555555}" type="datetime1"><a:rPr lang="en-US"/><a:t>11/11/2026</a:t></a:fld>' +
    '<a:endParaRPr lang="en-US"/></a:p>' +
    `<a:p>${run("  spaced\tout   ")}${run("  text  ")}</a:p>`;
  const [page] = extractPptxPages(buildDeck([slideXml(shape({ body }))]));

  assert.equal(page.text, "Hello big world on 11/11/2026\nspaced out text");
});

test("tables become one line per row, labelled by the first row", () => {
  const longHeader = "H".repeat(201);
  const slide = slideXml(
    table(
      [
        ["Region", "Q1", "Q2"],
        ["North", "10", "12"],
        ["South", "", "9"],
        [{ paragraphs: ["Two", "paragraphs"] }, "7", ""],
        ["", "", ""],
      ],
      { x: 0, y: 100 }
    ) +
      table([["Item", ""], ["Pen", "Blue"]], { x: 0, y: 200 }) +
      table(
        [
          ["Name", { text: "2026", attributes: ' gridSpan="2"' }, { attributes: ' hMerge="1"' }],
          [{ text: "B", attributes: ' rowSpan="2"' }, "3", "4"],
          [{ attributes: ' vMerge="1"' }, "5", "6"],
        ],
        { x: 0, y: 300 }
      ) +
      table([["Lonely", "header row"]], { x: 0, y: 400 }) +
      table([[longHeader, "Short"], ["value", "kept"]], { x: 0, y: 500 }) +
      // A merge PowerPoint draws from its hMerge cells, without gridSpan.
      table([["Year", "Total", { attributes: ' hMerge="1"' }], ["2025", "1", "2"]], { x: 0, y: 600 })
  );
  const [page] = extractPptxPages(buildDeck([slide]));

  assert.equal(
    page.text,
    [
      "Region; Q1; Q2",
      "Region: North; Q1: 10; Q2: 12",
      "Region: South; Q2: 9",
      "Region: Two paragraphs; Q1: 7",
      // Under an empty header, the column letter (as in Word and Excel tables).
      "Item",
      "Item: Pen; B: Blue",
      "Name; 2026",
      "Name: B; 2026: 3; 2026: 4",
      "2026: 5; 2026: 6",
      "Lonely; header row",
      // A header over 200 characters is written once and is not a label.
      `${longHeader}; Short`,
      "A: value; Short: kept",
      "Year; Total",
      "Year: 2025; Total: 1; Total: 2",
    ].join("\n")
  );
});

test("group shapes are flattened and shapes are ordered by their own offsets", () => {
  // EMU offsets; the groups' own offsets are deliberately far from their
  // children's, which place the children. "1mm" is 36000 EMU.
  const slide = slideXml(
    shape({ name: "Body", placeholder: { idx: 1 }, body: paragraph("Unpositioned body") }) +
      textBox("Bottom", { x: 0, y: 500000 }) +
      group(
        { x: 0, y: 900000 },
        textBox("Middle", { x: 0, y: 300000 }) +
          group({ x: 700000, y: 950000 }, textBox("Top right", { x: 500000, y: 100000 }))
      ) +
      textBox("Top left", { x: 0, y: 100000 }) +
      textBox("Tie first", { x: 10000, y: 400000 }) +
      textBox("Tie second", { x: 10000, y: 400000 }) +
      textBox("Second unpositioned") +
      table([["Cell"]], { x: 0, y: 200000 }) +
      textBox("One millimetre down", { x: 0, y: "1mm" })
  );
  const [page] = extractPptxPages(buildDeck([slide]));

  assert.equal(
    page.text,
    [
      "One millimetre down",
      "Top left",
      "Top right",
      "Cell",
      "Middle",
      "Tie first",
      "Tie second",
      "Bottom",
      "Unpositioned body",
      "Second unpositioned",
    ].join("\n")
  );
});

test("speaker notes follow the slide text; slide number, date, footer and slide image placeholders are skipped", () => {
  const boilerplate = (type, text) => shape({ name: type, placeholder: { type }, body: paragraph(text) });
  const slideWithNotes = {
    xml: slideXml(
      title("Agenda") +
        textBox("Point one", { x: 0, y: 100 }) +
        boilerplate("sldNum", "7") +
        boilerplate("dt", "11/11/2026") +
        boilerplate("ftr", "Company footer")
    ),
    notes: notesXml(
      boilerplate("sldImg", "Picture of the slide") +
        shape({
          name: "Notes Placeholder 2",
          placeholder: { type: "body", idx: 1 },
          body: paragraphs("Remember to smile.", "Then pause.") + paragraph("Sub point", '<a:pPr lvl="1"/>'),
        }) +
        boilerplate("sldNum", "7") +
        boilerplate("dt", "11/11/2026") +
        boilerplate("ftr", "Notes footer")
    ),
  };
  const notesOnlySlide = {
    xml: slideXml(shape({ placeholder: { type: "body", idx: 1 }, body: '<a:p><a:endParaRPr lang="en-US"/></a:p>' })),
    notes: notesXml(shape({ placeholder: { type: "body", idx: 1 }, body: paragraph("Only notes here") })),
  };
  const emptyNotesSlide = {
    xml: slideXml(textBox("Slide text")),
    notes: notesXml(boilerplate("sldImg", "Picture") + boilerplate("sldNum", "9")),
  };
  const emptySlide = slideXml(boilerplate("sldNum", "10") + boilerplate("ftr", "Footer only"));
  const pages = extractPptxPages(
    buildDeck([slideWithNotes, notesOnlySlide, emptyNotesSlide, emptySlide, slideXml(textBox("After the gap"))])
  );

  assert.deepEqual(pages, [
    {
      pageNumber: 1,
      text: "Agenda\nPoint one\nNotes:\nRemember to smile.\nThen pause.\n- Sub point",
      locationUnit: "slide",
      locationLabel: "Agenda",
    },
    { pageNumber: 2, text: "Notes:\nOnly notes here", locationUnit: "slide" },
    { pageNumber: 3, text: "Slide text", locationUnit: "slide" },
    { pageNumber: 5, text: "After the gap", locationUnit: "slide" },
  ]);
});

test("external relationship targets are ignored and never read as parts", () => {
  const parts = buildDeck([
    {
      xml: slideXml(textBox("Linked slide")),
      relationships: [
        { id: "rId7", type: "hyperlink", target: "https://example.com/x", external: true },
        { id: "rId8", type: "notesSlide", target: "../notesSlides/notesSlide1.xml", external: true },
      ],
    },
  ]);
  // A part of that name exists, so reading the external target would show.
  parts.set("ppt/notesSlides/notesSlide1.xml", xmlPart(notesXml(textBox("Must not be read"))));

  assert.deepEqual(extractPptxPages(parts), [{ pageNumber: 1, text: "Linked slide", locationUnit: "slide" }]);

  const externalSlide = withPart(
    parts,
    "ppt/_rels/presentation.xml.rels",
    xmlPart(relationshipsXml([{ id: "rId1", type: "slide", target: "slides/slide1.xml", external: true }]))
  );

  assertArchiveInvalid(externalSlide, /cannot be resolved/);
});

test("relationship targets resolve relative to their part, from the root, by case and percent-encoding", () => {
  const parts = new Map([
    ["_rels/.rels", xmlPart(relationshipsXml([{ id: "rId1", type: "officeDocument", target: "deck/main.xml" }]))],
    ["deck/main.xml", xmlPart(presentationXml(["rIdA", "rIdB", "rIdC", "rIdD"]))],
    [
      "deck/_rels/main.xml.rels",
      xmlPart(
        relationshipsXml([
          { id: "rIdA", type: "slide", target: "/deck/slides/one.xml" },
          { id: "rIdB", type: "slide", target: "./slides/../slides/TWO.XML" },
          { id: "rIdC", type: "slide", target: "slides/slide%203.xml" },
          { id: "rIdD", type: "slide", target: "slides/q&amp;a.xml" },
        ])
      ),
    ],
    ["deck/slides/one.xml", xmlPart(slideXml(textBox("Absolute target")))],
    [
      "deck/slides/_rels/one.xml.rels",
      xmlPart(relationshipsXml([{ id: "rId1", type: "notesSlide", target: "../../notes/n1.xml" }])),
    ],
    ["notes/n1.xml", xmlPart(notesXml(textBox("Notes two folders up")))],
    ["deck/slides/two.xml", xmlPart(slideXml(textBox("Dot segments and case")))],
    ["deck/slides/slide 3.xml", xmlPart(slideXml(textBox("Percent-encoded name")))],
    ["deck/slides/q&a.xml", xmlPart(slideXml(textBox("Entity in the target")))],
  ]);

  assert.deepEqual(
    extractPptxPages(parts).map(({ text }) => text),
    ["Absolute target\nNotes:\nNotes two folders up", "Dot segments and case", "Percent-encoded name", "Entity in the target"]
  );
});

test("the five XML entities and character references are decoded once, nothing else is expanded", () => {
  const text =
    "Tom &amp;amp; Jerry: &amp;lt;b&amp;gt; vs &lt;b&gt; &quot;q&quot; &apos;s&apos; " +
    "&#65;&#x42;&#x4E2D; &amp;#65; &nbsp; a&#0;b c&#xD800;d";
  const body = paragraph(text) + `<a:p><a:r><a:t><![CDATA[x &amp; y <z>]]></a:t></a:r></a:p>` + paragraph("raw\u0001control");
  const [page] = extractPptxPages(buildDeck([slideXml(title("R&amp;D &lt;2026&gt;") + shape({ body }))]));

  assert.equal(page.locationLabel, "R&D <2026>");
  assert.equal(
    page.text,
    [
      "R&D <2026>",
      "Tom &amp; Jerry: &lt;b&gt; vs <b> \"q\" 's' AB中 &#65; &nbsp; a b c d",
      "x &amp; y <z>",
      "raw control",
    ].join("\n")
  );
});

test("alternate content reads the first mc:Choice, else the mc:Fallback", () => {
  const alternate = (inner) =>
    '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">' + inner + "</mc:AlternateContent>";
  const slide = slideXml(
    alternate(
      `<mc:Choice xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" Requires="p14">${textBox("Choice text", { x: 0, y: 0 })}</mc:Choice>` +
        `<mc:Choice Requires="p15">${textBox("Second choice", { x: 0, y: 0 })}</mc:Choice>` +
        `<mc:Fallback>${textBox("Fallback text", { x: 0, y: 0 })}</mc:Fallback>`
    ) +
      alternate(`<mc:Fallback>${textBox("Only a fallback", { x: 0, y: 100 })}</mc:Fallback>`) +
      shape({
        offset: { x: 0, y: 200 },
        body: `<a:p>${run("Inline ")}${alternate(`<mc:Choice Requires="a14">${run("choice")}</mc:Choice><mc:Fallback>${run("fallback")}</mc:Fallback>`)}</a:p>`,
      })
  );
  const [page] = extractPptxPages(buildDeck([slide]));

  assert.equal(page.text, "Choice text\nOnly a fallback\nInline choice");
});

test("Strict namespaces and other prefixes are matched by namespace URI", () => {
  const strict =
    'xmlns:dml="http://purl.oclc.org/ooxml/drawingml/main" ' +
    'xmlns:rel="http://purl.oclc.org/ooxml/officeDocument/relationships" ' +
    'xmlns:pml="http://purl.oclc.org/ooxml/presentationml/main"';
  const parts = new Map([
    [
      "ppt/presentation.xml",
      xmlPart(`<pml:presentation ${strict}><pml:sldIdLst><pml:sldId id="256" rel:id="rId1"/></pml:sldIdLst></pml:presentation>`),
    ],
    [
      "ppt/_rels/presentation.xml.rels",
      xmlPart(
        relationshipsXml([
          { id: "rId1", type: "http://purl.oclc.org/ooxml/officeDocument/relationships/slide", target: "slides/slide1.xml" },
        ])
      ),
    ],
    [
      "ppt/slides/slide1.xml",
      xmlPart(
        `<pml:sld ${strict}><pml:cSld><pml:spTree><pml:sp><pml:nvSpPr><pml:cNvPr id="2" name="T"/><pml:cNvSpPr/>` +
          '<pml:nvPr><pml:ph type="title"/></pml:nvPr></pml:nvSpPr><pml:spPr/><pml:txBody><dml:bodyPr/>' +
          "<dml:p><dml:r><dml:t>Strict title</dml:t></dml:r></dml:p></pml:txBody></pml:sp>" +
          // An element named like a shape but outside PresentationML adds nothing.
          '<x:sp xmlns:x="urn:example"><dml:p><dml:r><dml:t>Not a shape</dml:t></dml:r></dml:p></x:sp>' +
          "</pml:spTree></pml:cSld></pml:sld>"
      ),
    ],
  ]);

  assert.deepEqual(extractPptxPages(parts), [
    { pageNumber: 1, text: "Strict title", locationUnit: "slide", locationLabel: "Strict title" },
  ]);
});

test("UTF-16 parts and byte order marks are decoded", () => {
  const parts = buildDeck([slideXml(textBox("Café 中文"))]);
  const slideText = parts.get("ppt/slides/slide1.xml").toString("utf8").replace('encoding="UTF-8"', 'encoding="UTF-16"');
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(slideText, "utf16le")]);
  const presentationWithBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), parts.get("ppt/presentation.xml")]);
  const decoded = withPart(withPart(parts, "ppt/slides/slide1.xml", utf16), "ppt/presentation.xml", presentationWithBom);

  assert.deepEqual(extractPptxPages(decoded), [{ pageNumber: 1, text: "Café 中文", locationUnit: "slide" }]);

  // UTF-16 without a byte order mark, recognised by its "<?" start, as the
  // archive guard reads it.
  const withoutMark = withPart(parts, "ppt/slides/slide1.xml", Buffer.from(slideText, "utf16le"));
  assert.deepEqual(extractPptxPages(withoutMark), [{ pageNumber: 1, text: "Café 中文", locationUnit: "slide" }]);
});

test("a package shaped the way PowerPoint writes it reads cleanly", () => {
  const officeRelationship = (kind) => `http://schemas.openxmlformats.org/officeDocument/2006/relationships/${kind}`;
  const creationId = (id) =>
    `<a:extLst><a:ext uri="{FF2B5EF4-FFF2-40B4-BE49-F238E27FC236}"><a16:creationId xmlns:a16="http://schemas.microsoft.com/office/drawing/2014/main" id="${id}"/></a:ext></a:extLst>`;
  const header =
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/>' +
    '<a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
  const cell = (text) =>
    `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>${text}</a:t></a:r>` +
    '<a:endParaRPr lang="en-US" dirty="0"/></a:p></a:txBody><a:tcPr/></a:tc>';
  const rowId = (value) =>
    `<a:extLst><a:ext uri="{0D108BD9-81ED-4DB2-BD59-A6C34878D82A}"><a16:rowId xmlns:a16="http://schemas.microsoft.com/office/drawing/2014/main" val="${value}"/></a:ext></a:extLst>`;
  const slide =
    `<p:sld ${NAMESPACES}><p:cSld><p:spTree>${header}` +
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1">${creationId("{6B3A0B2C-5F7B-4C4D-9E3A-1F2E3D4C5B6A}")}</p:cNvPr>` +
    '<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/>' +
    '<p:txBody><a:bodyPr><a:normAutofit/></a:bodyPr><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>Project </a:t></a:r>' +
    '<a:r><a:rPr lang="en-US" b="1" dirty="0"/><a:t>Phoenix</a:t></a:r><a:endParaRPr lang="en-US" dirty="0"/></a:p></p:txBody></p:sp>' +
    `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Content Placeholder 2">${creationId("{1D2C3B4A-0000-4000-8000-000000000001}")}</p:cNvPr>` +
    '<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr/>' +
    '<p:txBody><a:bodyPr><a:normAutofit/></a:bodyPr><a:lstStyle/>' +
    '<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>Launch in Q3</a:t></a:r></a:p>' +
    '<a:p><a:pPr lvl="1"/><a:r><a:rPr lang="en-US" dirty="0"/><a:t>Beta with ten customers</a:t></a:r></a:p>' +
    '<a:p><a:r><a:rPr lang="en-US" dirty="0" err="1"/><a:t>Budgt</a:t></a:r><a:r><a:rPr lang="en-US" dirty="0"/><a:t> approved</a:t></a:r></a:p>' +
    "</p:txBody></p:sp>" +
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Table 3">${creationId("{2E3F4A5B-0000-4000-8000-000000000002}")}</p:cNvPr>` +
    '<p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr><p:extLst>' +
    '<p:ext uri="{D42A27DB-BD31-4B8C-83A1-F6EECF244321}"><p14:modId xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" val="1234567"/></p:ext>' +
    '</p:extLst></p:nvPr></p:nvGraphicFramePr><p:xfrm><a:off x="838200" y="4351338"/><a:ext cx="10515600" cy="741680"/></p:xfrm>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>' +
    '<a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}</a:tableStyleId></a:tblPr>' +
    '<a:tblGrid><a:gridCol w="5257800"><a:extLst><a:ext uri="{9D8B030D-6E8A-4147-A177-3AD203B41FA5}">' +
    '<a16:colId xmlns:a16="http://schemas.microsoft.com/office/drawing/2014/main" val="20000"/></a:ext></a:extLst></a:gridCol>' +
    '<a:gridCol w="5257800"/></a:tblGrid>' +
    `<a:tr h="370840">${cell("Milestone")}${cell("Date")}${rowId("10000")}</a:tr>` +
    `<a:tr h="370840">${cell("Beta")}${cell("July")}${rowId("10001")}</a:tr>` +
    "</a:tbl></a:graphicData></a:graphic></p:graphicFrame>" +
    '<p:sp><p:nvSpPr><p:cNvPr id="5" name="Slide Number Placeholder 4"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>' +
    '<p:nvPr><p:ph type="sldNum" sz="quarter" idx="12"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>' +
    '<a:p><a:fld id="{A1B2C3D4-0000-4000-8000-000000000003}" type="slidenum"><a:rPr lang="en-US"/><a:t>1</a:t></a:fld>' +
    '<a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>' +
    '</p:spTree><p:extLst><p:ext uri="{BB962C8B-B14F-4D97-AF65-F5344CB8AC3E}">' +
    '<p14:creationId xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" val="3141592653"/></p:ext></p:extLst>' +
    "</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>";
  const notes =
    `<p:notes ${NAMESPACES}><p:cSld><p:spTree>${header}` +
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr>' +
    '<p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>' +
    '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>' +
    '<p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>' +
    '<a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t>Mention the pilot results.</a:t></a:r></a:p></p:txBody></p:sp>' +
    '<p:sp><p:nvSpPr><p:cNvPr id="4" name="Slide Number Placeholder 3"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>' +
    '<p:nvPr><p:ph type="sldNum" sz="quarter" idx="5"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>' +
    '<a:p><a:fld id="{A1B2C3D4-0000-4000-8000-000000000004}" type="slidenum"><a:rPr lang="en-US"/><a:t>1</a:t></a:fld></a:p></p:txBody></p:sp>' +
    "</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>";
  const presentation =
    `<p:presentation ${NAMESPACES} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
    '<p:notesMasterIdLst><p:notesMasterId r:id="rId3"/></p:notesMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>' +
    '<p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr></p:defaultTextStyle>' +
    '<p:extLst><p:ext uri="{EFAFB233-063F-42B5-8137-9DF3F51BA10A}"><p15:sldGuideLst xmlns:p15="http://schemas.microsoft.com/office/powerpoint/2012/main"/></p:ext></p:extLst>' +
    "</p:presentation>";
  const parts = new Map([
    [
      "[Content_Types].xml",
      xmlPart(
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>'
      ),
    ],
    [
      "_rels/.rels",
      xmlPart(
        relationshipsXml([
          { id: "rId3", type: officeRelationship("extended-properties"), target: "docProps/app.xml" },
          { id: "rId2", type: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties", target: "docProps/core.xml" },
          { id: "rId1", type: officeRelationship("officeDocument"), target: "ppt/presentation.xml" },
          { id: "rId4", type: officeRelationship("thumbnail"), target: "docProps/thumbnail.jpeg" },
        ])
      ),
    ],
    ["docProps/thumbnail.jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0])],
    ["ppt/presentation.xml", xmlPart(presentation)],
    [
      "ppt/_rels/presentation.xml.rels",
      xmlPart(
        relationshipsXml([
          { id: "rId3", type: officeRelationship("notesMaster"), target: "notesMasters/notesMaster1.xml" },
          { id: "rId7", type: officeRelationship("theme"), target: "theme/theme1.xml" },
          { id: "rId2", type: officeRelationship("slide"), target: "slides/slide1.xml" },
          { id: "rId1", type: officeRelationship("slideMaster"), target: "slideMasters/slideMaster1.xml" },
        ])
      ),
    ],
    ["ppt/theme/theme1.xml", Buffer.from("not read")],
    ["ppt/slides/slide1.xml", xmlPart(slide)],
    [
      "ppt/slides/_rels/slide1.xml.rels",
      xmlPart(
        relationshipsXml([
          { id: "rId2", type: officeRelationship("notesSlide"), target: "../notesSlides/notesSlide1.xml" },
          { id: "rId1", type: officeRelationship("slideLayout"), target: "../slideLayouts/slideLayout2.xml" },
        ])
      ),
    ],
    ["ppt/notesSlides/notesSlide1.xml", xmlPart(notes)],
    // The content placeholder's paragraphs carry no bullet of their own:
    // PowerPoint draws the master's (body text style, level 1).
    ["ppt/slideLayouts/slideLayout2.xml", xmlPart(LAYOUT_XML)],
    [
      "ppt/slideLayouts/_rels/slideLayout2.xml.rels",
      xmlPart(relationshipsXml([{ id: "rId1", type: officeRelationship("slideMaster"), target: "../slideMasters/slideMaster1.xml" }])),
    ],
    ["ppt/slideMasters/slideMaster1.xml", xmlPart(MASTER_XML)],
  ]);

  assert.deepEqual(extractPptxPages(parts), [
    {
      pageNumber: 1,
      text: [
        "Project Phoenix",
        "Milestone; Date",
        "Milestone: Beta; Date: July",
        "- Launch in Q3",
        "- Beta with ten customers",
        "- Budgt approved",
        "Notes:",
        "Mention the pilot results.",
      ].join("\n"),
      locationUnit: "slide",
      locationLabel: "Project Phoenix",
    },
  ]);
});

test("a deck without slides yields no pages", () => {
  const parts = new Map([
    ["ppt/presentation.xml", xmlPart(`<p:presentation ${NAMESPACES}><p:sldSz cx="1" cy="1"/></p:presentation>`)],
    ["ppt/_rels/presentation.xml.rels", xmlPart(relationshipsXml([]))],
  ]);

  assert.deepEqual(extractPptxPages(parts), []);
});

test("missing parts and relationships are refused with DOCUMENT_ARCHIVE_INVALID", () => {
  const parts = buildDeck([{ xml: slideXml(textBox(CONTENT_MARKER)), notes: notesXml(textBox(CONTENT_MARKER)) }]);

  assertArchiveInvalid(new Map(), /no presentation part/);
  assertArchiveInvalid(withoutPart(parts, "ppt/presentation.xml"), /no presentation part/);
  assertArchiveInvalid(withoutPart(parts, "ppt/_rels/presentation.xml.rels"), /no relationships/);
  assertArchiveInvalid(withoutPart(parts, "ppt/slides/slide1.xml"), /is missing/);
  assertArchiveInvalid(withoutPart(parts, "ppt/notesSlides/notesSlide1.xml"), /is missing/);
  assertArchiveInvalid(
    withPart(parts, "_rels/.rels", xmlPart(relationshipsXml([{ id: "rId1", type: "officeDocument", target: "ppt/other.xml" }]))),
    /no presentation part/
  );
  assertArchiveInvalid(
    withPart(parts, "ppt/presentation.xml", xmlPart(presentationXml(["rId9"]))),
    /cannot be resolved/
  );
  assertArchiveInvalid(
    withPart(parts, "ppt/presentation.xml", xmlPart(presentationXml(["rIdMaster"]))),
    /cannot be resolved/
  );
  assertArchiveInvalid(
    withPart(
      parts,
      "ppt/_rels/presentation.xml.rels",
      xmlPart(relationshipsXml([{ id: "rId1", type: "slide", target: "../../slide1.xml" }]))
    ),
    /cannot be resolved/
  );
});

test("parts of the wrong kind, repeated references and ambiguous names are refused", () => {
  const parts = buildDeck([{ xml: slideXml(textBox(CONTENT_MARKER)), notes: notesXml(textBox(CONTENT_MARKER)) }]);

  assertArchiveInvalid(
    withPart(parts, "ppt/presentation.xml", xmlPart(slideXml(textBox(CONTENT_MARKER)))),
    /not a PowerPoint presentation/
  );
  assertArchiveInvalid(
    withPart(
      parts,
      "ppt/_rels/presentation.xml.rels",
      xmlPart(relationshipsXml([{ id: "rId1", type: "slide", target: "notesSlides/notesSlide1.xml" }]))
    ),
    /is something else/
  );
  assertArchiveInvalid(
    withPart(parts, "ppt/notesSlides/notesSlide1.xml", xmlPart(slideXml(textBox(CONTENT_MARKER)))),
    /is something else/
  );
  assertArchiveInvalid(
    withPart(parts, "ppt/presentation.xml", xmlPart(presentationXml(["rId1", "rId1"]))),
    /more than once/
  );
  assertArchiveInvalid(
    withPart(parts, "ppt/_rels/presentation.xml.rels", xmlPart(`<Relationships>${CONTENT_MARKER}</Relationships>`)),
    /relationship part is not valid/
  );

  const ambiguous = withPart(
    withPart(
      withoutPart(parts, "ppt/slides/slide1.xml"),
      "ppt/slides/Slide1.xml",
      xmlPart(slideXml(textBox(CONTENT_MARKER)))
    ),
    "ppt/slides/SLIDE1.xml",
    xmlPart(slideXml(textBox(CONTENT_MARKER)))
  );
  assertArchiveInvalid(ambiguous, /differ only in case/);
});

test("XML that is not well-formed or declares a DTD is refused", () => {
  const parts = buildDeck([slideXml(textBox(CONTENT_MARKER))]);
  const slideName = "ppt/slides/slide1.xml";

  for (const broken of [
    `<p:sld ${NAMESPACES}><p:cSld><p:spTree>${CONTENT_MARKER}</p:cSld></p:sld>`,
    `<p:sld ${NAMESPACES}><p:cSld><p:spTree>`,
    CONTENT_MARKER,
    "",
    `<p:sld><p:cSld/></p:sld>`,
    `<p:sld ${NAMESPACES}><p:cSld><q:x/></p:cSld></p:sld>`,
    `<p:sld ${NAMESPACES} q:show="0"><p:cSld/></p:sld>`,
    `<p:sld ${NAMESPACES}><p:cSld/></p:sld><p:sld ${NAMESPACES}/>trailing ${CONTENT_MARKER}`,
    // A second, self-closing root passes the parser's own validator.
    `<p:sld ${NAMESPACES}><p:cSld/></p:sld><p:sld ${NAMESPACES}/>`,
    `<p:sld ${NAMESPACES}><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>a &amp b</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
  ]) {
    assertArchiveInvalid(withPart(parts, slideName, Buffer.from(broken, "utf8")), /not well-formed/);
  }

  assertArchiveInvalid(
    withPart(
      parts,
      slideName,
      xmlPart(`<!DOCTYPE p:sld [<!ENTITY boom "${CONTENT_MARKER}">]><p:sld ${NAMESPACES}><p:cSld/></p:sld>`)
    ),
    /declares a DTD/
  );
  assertArchiveInvalid(
    withPart(parts, slideName, xmlPart(`<!doctype p:sld><p:sld ${NAMESPACES}><p:cSld/></p:sld>`)),
    /declares a DTD/
  );

  const utf16Doctype = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(`<!DOCTYPE p:sld><p:sld ${NAMESPACES}><p:cSld/></p:sld>`, "utf16le"),
  ]);
  assertArchiveInvalid(withPart(parts, slideName, utf16Doctype), /declares a DTD/);
});

test("the parts argument must be a Map of Buffers", () => {
  assert.throws(() => extractPptxPages({}), TypeError);
  assert.throws(() => extractPptxPages(null), TypeError);

  const parts = buildDeck([slideXml(textBox("Text"))]);
  assert.throws(
    () => extractPptxPages(withPart(parts, "ppt/slides/slide1.xml", parts.get("ppt/slides/slide1.xml").toString("utf8"))),
    TypeError
  );
});

test("the same bytes always give the same pages, whatever the order of the entries", () => {
  const parts = buildDeck(
    [
      {
        xml: slideXml(
          title("Deterministic") +
            group({ x: 0, y: 0 }, textBox("Grouped", { x: 10, y: 10 }) + textBox("Same spot", { x: 10, y: 10 })) +
            table([["Key", "Value"], ["a", "1"]], { x: 0, y: 20 })
        ),
        notes: notesXml(shape({ placeholder: { type: "body", idx: 1 }, body: paragraphs("Note one", "Note two") })),
      },
      slideXml(textBox("Hidden"), { show: "0" }),
      slideXml(textBox("Last")),
    ],
    { order: [1, 2, 0] }
  );
  const first = extractPptxPages(parts);
  const second = extractPptxPages(parts);
  const reversed = extractPptxPages(new Map([...parts.entries()].reverse()));

  assert.deepEqual(second, first);
  assert.deepEqual(reversed, first);
  assert.equal(JSON.stringify(reversed), JSON.stringify(first));
  assert.deepEqual(first, [
    { pageNumber: 2, text: "Last", locationUnit: "slide" },
    {
      pageNumber: 3,
      text: "Deterministic\nGrouped\nSame spot\nKey; Value\nKey: a; Value: 1\nNotes:\nNote one\nNote two",
      locationUnit: "slide",
      locationLabel: "Deterministic",
    },
  ]);
});
