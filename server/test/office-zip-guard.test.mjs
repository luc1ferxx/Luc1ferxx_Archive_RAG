// The Office archive guard (rag/office/zip-guard.js): the caps on declared and
// actually inflated bytes, entry names, encryption, DTDs in XML parts, the
// agreement of local headers, directory and end record that keeps SheetJS
// and JSZip reading the archive the guard read, and the parts it keeps.
import test from "node:test";
import assert from "node:assert/strict";
import { crc32 } from "node:zlib";

import { DOCUMENT_FORMAT_ERROR_CODES, DocumentFormatError } from "../rag/document-format-errors.js";
import {
  COMPRESSION_RATIO_MIN_ENTRY_BYTES,
  CONTENT_TYPES_PART,
  PACKAGE_PART_MAX_BYTES,
  PACKAGE_RELATIONSHIPS_PART,
  assertOfficeXmlWithinLimit,
  assertXmlPartWithinLimit,
  decodeXmlPart,
  describeOfficePackage,
  getXmlPartSize,
  resolvePackageTarget,
  scanOfficeArchive,
  startsWithZipLocalHeader,
} from "../rag/office/zip-guard.js";
import { buildDocx, buildPptx, buildZip, docxEntries, replacePart, withDoctype } from "./office-fixture-builder.mjs";

const CODES = DOCUMENT_FORMAT_ERROR_CODES;
const MiB = 1024 * 1024;

const expectInvalid = (promise) =>
  assert.rejects(promise, (error) => {
    assert.ok(error instanceof DocumentFormatError, String(error?.stack ?? error));
    assert.equal(error.status, 400);
    assert.equal(error.code, CODES.archiveInvalid);
    return true;
  });

const expectTooLarge = (promise) =>
  assert.rejects(promise, (error) => {
    assert.ok(error instanceof DocumentFormatError, String(error?.stack ?? error));
    assert.equal(error.status, 413);
    assert.equal(error.code, CODES.archiveTooLarge);
    return true;
  });

const xml = (name, text) => ({ data: text, name });

// An observer that records what the guard let through.
const createRecorder = () => {
  const seen = new Map();
  const finished = [];

  return {
    finished,
    observe: (name) => ({
      finish: () => finished.push(name),
      push: (chunk) => seen.set(name, (seen.get(name) ?? 0) + chunk.length),
    }),
    seen,
    total: () => [...seen.values()].reduce((sum, bytes) => sum + bytes, 0),
  };
};

test("a well-formed package: entries, file names, kept parts, package description and readPart", async () => {
  const bytes = buildDocx({ blocks: [{ heading: 1, text: "Title" }, { text: "Body" }] });
  const scan = await scanOfficeArchive(bytes, { keep: (name) => name === "word/document.xml" });

  assert.equal(startsWithZipLocalHeader(bytes), true);
  assert.equal(scan.entryCount, scan.fileNames.length);
  assert.ok(scan.fileNames.includes("word/document.xml"));
  assert.deepEqual([...scan.parts.keys()].sort(), ["[Content_Types].xml", "_rels/.rels", "word/document.xml"]);
  assert.match(scan.parts.get("word/document.xml").toString("utf8"), /Body/);
  assert.equal(scan.inflatedBytes > 0, true);
  assert.deepEqual(scan.package, {
    declaresMainContentType: true,
    hasContentTypes: true,
    mainPart: {
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
      exists: true,
      name: "word/document.xml",
    },
  });

  // readPart inflates any file entry again, by name without regard to case.
  assert.deepEqual(await scanOfficeArchive(bytes).then((other) => other.readPart("WORD/STYLES.XML")), await scan.readPart("word/styles.xml"));
  assert.equal(await scan.readPart("word/missing.xml"), null);
});

test("directory entries are counted and inflated but never kept or observed", async () => {
  const recorder = createRecorder();
  const scan = await scanOfficeArchive(buildZip([{ data: "", name: "word/" }, xml("word/a.xml", "<a/>")]), {
    keep: () => true,
    observe: recorder.observe,
  });

  assert.equal(scan.entryCount, 2);
  assert.deepEqual(scan.fileNames, ["word/a.xml"]);
  assert.deepEqual([...scan.parts.keys()], ["word/a.xml"]);
  assert.deepEqual(recorder.finished, ["word/a.xml"]);
});

test("the entry cap comes from the end record, before any entry is read", async () => {
  const entries = Array.from({ length: 6 }, (_, index) => xml(`part${index}.xml`, "<a/>"));

  await expectTooLarge(scanOfficeArchive(buildZip(entries), { limits: { maxEntries: 5 } }));
  await scanOfficeArchive(buildZip(entries.slice(0, 5)), { limits: { maxEntries: 5 } });

  process.env.RAG_OFFICE_MAX_ZIP_ENTRIES = "3";

  try {
    await expectTooLarge(scanOfficeArchive(buildZip(entries.slice(0, 4))));
  } finally {
    delete process.env.RAG_OFFICE_MAX_ZIP_ENTRIES;
  }
});

test("declared sizes over the total cap are refused before anything inflates", async () => {
  const recorder = createRecorder();
  const archive = buildZip([xml("a.xml", "<a>".padEnd(600, "x")), xml("b.xml", "<b>".padEnd(600, "y"))]);

  await expectTooLarge(scanOfficeArchive(archive, { limits: { maxUncompressedBytes: 1000 }, observe: recorder.observe }));
  assert.equal(recorder.total(), 0, "nothing was inflated");
  await scanOfficeArchive(archive, { limits: { maxUncompressedBytes: 1200 } });
});

test("an entry that inflates past its declared size runs into the total cap, and inflation stops there", async () => {
  const recorder = createRecorder();
  // 64 MiB of zeros declared as 10 bytes.
  const archive = buildZip([{ data: Buffer.alloc(64 * MiB), declaredUncompressedSize: 10, name: "bomb.xml" }]);
  const started = Date.now();

  await expectTooLarge(
    scanOfficeArchive(archive, {
      limits: { maxCompressionRatio: 1_000_000, maxUncompressedBytes: 2 * MiB },
      observe: recorder.observe,
    })
  );
  assert.ok(recorder.total() <= 2 * MiB, `the guard let ${recorder.total()} bytes through`);
  assert.ok(Date.now() - started < 5000, "inflation stopped at the cap");
});

test("the ratio cap: declared ratios refuse before inflating, actual ratios as soon as they show", async () => {
  const honestBomb = buildZip([{ data: Buffer.alloc(8 * MiB), name: "bomb.bin" }]);
  const lyingBomb = buildZip([{ data: Buffer.alloc(8 * MiB), declaredUncompressedSize: 100, name: "bomb.bin" }]);
  const recorder = createRecorder();

  await expectTooLarge(scanOfficeArchive(honestBomb, { observe: recorder.observe }));
  assert.equal(recorder.total(), 0, "a declared bomb is refused from the directory alone");

  await expectTooLarge(scanOfficeArchive(lyingBomb, { observe: recorder.observe }));

  // Stopped at the first chunk past max(1 MiB, 200 x its compressed size),
  // far short of the 8 MiB it would inflate to.
  const compressedSize = lyingBomb.readUInt32LE(18);
  const stopAt = Math.max(COMPRESSION_RATIO_MIN_ENTRY_BYTES, 200 * compressedSize);

  assert.ok(recorder.total() <= stopAt, `let ${recorder.total()} bytes through, stop at ${stopAt}`);
  assert.ok(stopAt < 4 * MiB);

  // The cap applies above 1 MiB inflated only: 1 MiB of zeros passes, one byte more does not.
  await scanOfficeArchive(buildZip([{ data: Buffer.alloc(COMPRESSION_RATIO_MIN_ENTRY_BYTES), name: "zeros.bin" }]));
  await expectTooLarge(scanOfficeArchive(buildZip([{ data: Buffer.alloc(COMPRESSION_RATIO_MIN_ENTRY_BYTES + 1), name: "zeros.bin" }])));

  // A higher ratio setting lets the same bytes through; stored entries have a ratio of 1.
  await scanOfficeArchive(honestBomb, { limits: { maxCompressionRatio: 100_000 } });
  await scanOfficeArchive(buildZip([{ data: Buffer.alloc(2 * MiB), method: "store", name: "stored.bin" }]));
});

test("an entry whose bytes disagree with its record under the caps is invalid, not too large", async () => {
  await expectInvalid(scanOfficeArchive(buildZip([{ data: "x".repeat(100), declaredUncompressedSize: 10, name: "a.txt" }])));
  await expectInvalid(scanOfficeArchive(buildZip([{ data: "x".repeat(100), declaredUncompressedSize: 1000, name: "a.txt" }])));
  await expectInvalid(scanOfficeArchive(buildZip([{ crc32: 12345, data: "<a/>", name: "a.xml" }])));
});

test("unsafe, duplicate and rewritten entry names are refused", async () => {
  for (const name of ["../evil.xml", "word/../../evil.xml", "/etc/passwd", "C:/evil.xml", "word\\document.xml"]) {
    await expectInvalid(scanOfficeArchive(buildZip([xml(name, "<a/>")])));
  }

  await expectInvalid(scanOfficeArchive(buildZip([xml("word/a.xml", "<a/>"), xml("WORD/A.XML", "<b/>")])));

  // An Info-ZIP Unicode Path field that renames the entry for yauzl and JSZip
  // but not for SheetJS, which reads the raw bytes.
  const rawName = Buffer.from("image.png");
  const unicodePath = Buffer.concat([Buffer.from([1]), Buffer.alloc(4), Buffer.from("xl/workbook.xml")]);

  unicodePath.writeUInt32LE(crc32(rawName), 1);

  const extra = Buffer.concat([Buffer.from([0x75, 0x70]), Buffer.alloc(2), unicodePath]);

  extra.writeUInt16LE(unicodePath.length, 2);
  await expectInvalid(scanOfficeArchive(buildZip([{ data: "<a/>", extra, name: "image.png" }])));
});

test("encrypted entries and compression methods other than store and deflate are refused", async () => {
  await expectInvalid(scanOfficeArchive(buildZip([{ data: "<a/>", flags: 0x0001, name: "a.xml" }])));
  await expectInvalid(scanOfficeArchive(buildZip([{ data: "<a/>", flags: 0x0040, name: "a.xml" }])));
  await expectInvalid(scanOfficeArchive(buildZip([{ data: "<a/>", local: { flags: 0x0801 }, name: "a.xml" }])));
  await expectInvalid(scanOfficeArchive(buildZip([{ data: "<a/>", methodCode: 12, name: "a.xml" }])));
});

test("a local header must agree with the directory: name, method and sizes", async () => {
  await expectInvalid(scanOfficeArchive(buildZip([{ data: "<a/>", local: { name: "b.xml" }, name: "a.xml" }])));
  await expectInvalid(scanOfficeArchive(buildZip([{ data: "<a/>", local: { method: 0 }, name: "a.xml" }])));
  await expectInvalid(scanOfficeArchive(buildZip([{ data: "<a/>", local: { uncompressedSize: 0xfffffff0 }, name: "a.xml" }])));
  await expectInvalid(scanOfficeArchive(buildZip([{ data: "<a/>", local: { compressedSize: 1 }, name: "a.xml" }])));

  // With a data descriptor the local sizes may be zero (streaming writers).
  await scanOfficeArchive(
    buildZip([{ data: "<a/>", flags: 0x0008, local: { compressedSize: 0, uncompressedSize: 0 }, name: "a.xml" }])
  );
  // ... but not some other number.
  await expectInvalid(
    scanOfficeArchive(buildZip([{ data: "<a/>", flags: 0x0008, local: { compressedSize: 0, uncompressedSize: 99 }, name: "a.xml" }]))
  );
});

test("a ZIP64 extra field must give the sizes the guard checked", async () => {
  const data = Buffer.from("<a>zip64</a>");
  const compressedLength = buildZip([{ data, name: "a.xml" }]).readUInt32LE(18);
  const zip64Extra = (uncompressed, compressed, length = 16) => {
    const body = Buffer.alloc(length);

    if (length >= 16) {
      body.writeBigUInt64LE(BigInt(uncompressed), 0);
      body.writeBigUInt64LE(BigInt(compressed), 8);
    }

    const header = Buffer.alloc(4);

    header.writeUInt16LE(0x0001, 0);
    header.writeUInt16LE(length, 2);
    return Buffer.concat([header, body]);
  };

  await scanOfficeArchive(buildZip([{ data, extra: zip64Extra(data.length, compressedLength), name: "a.xml" }]));
  await scanOfficeArchive(buildZip([{ data, localExtra: zip64Extra(data.length, compressedLength), name: "a.xml" }]));
  await expectInvalid(scanOfficeArchive(buildZip([{ data, extra: zip64Extra(4 * 1024 ** 3, compressedLength), name: "a.xml" }])));
  await expectInvalid(scanOfficeArchive(buildZip([{ data, localExtra: zip64Extra(data.length, 1), name: "a.xml" }])));
  await expectInvalid(scanOfficeArchive(buildZip([{ data, localExtra: zip64Extra(0, 0, 8), name: "a.xml" }])));
});

test("the end record must be the only reading: trailing bytes, a signature in the comment, ZIP64, a hidden record", async () => {
  const entries = [xml("a.xml", "<a/>"), xml("b.xml", "<b/>")];

  await scanOfficeArchive(buildZip(entries, { comment: "an ordinary comment" }));
  await expectInvalid(scanOfficeArchive(buildZip(entries, { trailing: "junk" })));
  await expectInvalid(scanOfficeArchive(buildZip(entries, { comment: "PK\u0005\u0006 inside the comment" })));
  await expectInvalid(scanOfficeArchive(buildZip(entries, { entriesOnDisk: 0xffff, totalEntries: 0xffff })));
  await expectInvalid(scanOfficeArchive(buildZip(entries, { entriesOnDisk: 1 })));
  // The end record counts one entry, the directory holds two: a reader that
  // follows the records would find one the guard never read.
  await expectInvalid(scanOfficeArchive(buildZip(entries, { entriesOnDisk: 1, totalEntries: 1 })));
  await expectInvalid(scanOfficeArchive(Buffer.from("PK\u0003\u0004 and nothing else")));
  await expectInvalid(scanOfficeArchive(Buffer.from("no zip at all")));
});

test("a DTD in any .xml or .rels part is refused, in any case and in UTF-16", async () => {
  const base = docxEntries({ blocks: [{ text: "x" }] });
  const documentXml = String(base.find((entry) => entry.name === "word/document.xml").data);
  const cases = {
    entityOnly: replacePart(base, "word/document.xml", documentXml.replace("<w:document", '<!ENTITY a "b"><w:document')),
    inRels: replacePart(base, "_rels/.rels", withDoctype(String(base.find((entry) => entry.name === "_rels/.rels").data))),
    lowerCase: replacePart(base, "word/document.xml", documentXml.replace("?>", "?><!doctype w:document>")),
    upperExtension: [...base, xml("customXml/ITEM1.XML", withDoctype("<root/>"))],
    utf16be: [
      ...base,
      { data: Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(withDoctype("<root/>"), "utf16le").swap16()]), name: "customXml/item1.xml" },
    ],
    utf16le: [
      ...base,
      { data: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(withDoctype("<root/>"), "utf16le")]), name: "customXml/item1.xml" },
    ],
    withDoctype: replacePart(base, "word/document.xml", withDoctype(documentXml)),
  };

  for (const [label, entries] of Object.entries(cases)) {
    await expectInvalid(scanOfficeArchive(buildZip(entries))).catch((error) => {
      error.message = `${label}: ${error.message}`;
      throw error;
    });
  }

  // Split across the 16 KiB inflate chunks: still seen.
  for (const offset of [16_380, 16_384, 16_377, 32_760]) {
    const text = `${"<a/>".repeat(Math.ceil(offset / 4)).slice(0, offset)}<!DOCTYPE root><root/>`;

    await expectInvalid(scanOfficeArchive(buildZip([xml("big.xml", text)])));
  }

  // Comments and CDATA are not DTDs; the words anywhere in an XML part are
  // refused all the same (the contract: any part *containing* them); outside
  // XML parts they are not looked for.
  await scanOfficeArchive(buildZip([xml("a.xml", "<a><!-- c --><![CDATA[x]]></a>")]));
  await expectInvalid(scanOfficeArchive(buildZip([xml("a.xml", "<a><!-- <!ENTITY in a comment --></a>")])));
  await scanOfficeArchive(buildZip([{ data: "<!DOCTYPE html><html/>", name: "media/page.html" }]));
});

test("describeOfficePackage resolves the main part like the relationship says", () => {
  const contentTypes = Buffer.from(
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      "</Types>"
  );
  const relationships = (target, extra = "") =>
    Buffer.from(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        `<Relationship Id="rId1" Type="http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument" Target="${target}"${extra}/>` +
        "</Relationships>"
    );
  const describe = (rels, fileNames) =>
    describeOfficePackage(new Map([["[Content_Types].xml", contentTypes], ["_rels/.rels", rels]]), fileNames);

  // A Default content type, a strict relationship type, a leading slash and percent-encoding.
  assert.deepEqual(describe(relationships("/xl/work%20book.xml"), ["xl/work book.xml"]).mainPart, {
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
    exists: true,
    name: "xl/work book.xml",
  });
  // An external target is no part of the package.
  assert.equal(describe(relationships("http://example.com/x.xml", ' TargetMode="External"'), []).mainPart, null);
  // A part missing from the archive.
  assert.equal(describe(relationships("xl/workbook.xml"), []).mainPart.exists, false);
  // No content types at all.
  assert.deepEqual(describeOfficePackage(new Map(), ["a.xml"]), {
    declaresMainContentType: false,
    hasContentTypes: false,
    mainPart: null,
  });
});

test("resolvePackageTarget and decodeXmlPart", () => {
  assert.equal(resolvePackageTarget("word/document.xml"), "word/document.xml");
  assert.equal(resolvePackageTarget("/word/document.xml"), "word/document.xml");
  assert.equal(resolvePackageTarget("./word/./document.xml"), "word/document.xml");
  assert.equal(resolvePackageTarget("worksheets/sheet1.xml", "xl"), "xl/worksheets/sheet1.xml");
  assert.equal(resolvePackageTarget("../media/a.png", "ppt/slides"), "ppt/media/a.png");
  assert.equal(resolvePackageTarget("50%.xml"), "50%.xml");
  assert.equal(resolvePackageTarget(""), null);
  assert.equal(resolvePackageTarget(undefined), null);

  const text = '<?xml version="1.0"?><a>é</a>';

  assert.equal(decodeXmlPart(Buffer.from(text)), text);
  assert.equal(decodeXmlPart(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)])), text);
  assert.equal(decodeXmlPart(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")])), text);
  assert.equal(decodeXmlPart(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, "utf16le").swap16()])), text);
  assert.equal(decodeXmlPart(Buffer.from(text, "utf16le")), text);
  assert.equal(decodeXmlPart(Buffer.from(text, "utf16le").swap16()), text);
});

test("the guard is deterministic and keeps PPTX parts byte for byte", async () => {
  const bytes = buildPptx({ slides: [{ notes: "Speaker notes", title: "One" }, { title: "Two" }] });
  const keep = (name) => name.startsWith("ppt/");
  const first = await scanOfficeArchive(bytes, { keep });
  const second = await scanOfficeArchive(bytes, { keep });

  assert.deepEqual([...first.parts], [...second.parts]);
  assert.deepEqual(first.fileNames, second.fileNames);
  assert.match(first.parts.get("ppt/notesSlides/notesSlide1.xml").toString("utf8"), /Speaker notes/);
  assert.deepEqual(await first.readPart("ppt/slides/slide2.xml"), first.parts.get("ppt/slides/slide2.xml"));
});

test("scanOfficeArchive wants a Buffer", async () => {
  await assert.rejects(scanOfficeArchive("not bytes"), TypeError);
});

test("partSizes: every file entry's inflated size by lower-case name", async () => {
  const scan = await scanOfficeArchive(
    buildZip([{ data: "", name: "word/" }, xml("Word/Document.xml", "<doc>12345</doc>"), { data: Buffer.alloc(7), name: "a.bin" }])
  );

  assert.deepEqual([...scan.partSizes], [
    ["word/document.xml", 16],
    ["a.bin", 7],
  ]);
});

test("the package parts the guard parses are capped, declared size before anything inflates", async () => {
  for (const name of [CONTENT_TYPES_PART, PACKAGE_RELATIONSHIPS_PART]) {
    const oversized = `<a>${"x".repeat(PACKAGE_PART_MAX_BYTES)}</a>`;
    const recorder = createRecorder();

    // Declared: refused while the directory is read.
    await expectTooLarge(scanOfficeArchive(buildZip([{ data: oversized, method: "store", name }]), { observe: recorder.observe }));
    assert.equal(recorder.total(), 0, "nothing was inflated");
    // Actual: a directory that understates the size runs into the cap as it inflates.
    await expectTooLarge(
      scanOfficeArchive(
        buildZip([{ data: oversized, declaredUncompressedSize: 100, name }]),
        { limits: { maxCompressionRatio: 1_000_000 } }
      )
    );
  }

  // Any other part may be larger.
  await scanOfficeArchive(buildZip([{ data: `<a>${"x".repeat(PACKAGE_PART_MAX_BYTES)}</a>`, method: "store", name: "word/document.xml" }]));
});

test("assertOfficeXmlWithinLimit: a Word document's XML parts together, a deck's one by one, nothing else counts", async () => {
  const archive = await scanOfficeArchive(
    buildZip([
      xml("word/document.xml", `<w>${"d".repeat(1000)}</w>`),
      xml("word/footnotes.xml", `<w>${"f".repeat(1000)}</w>`),
      xml("word/_rels/document.xml.rels", "<r/>"),
      { data: Buffer.alloc(50_000), method: "store", name: "word/media/image1.png" },
    ])
  );
  const xmlBytes = 1007 + 1007 + 4;
  const refusal = (format, limit) => {
    try {
      assertOfficeXmlWithinLimit(archive, format, { maxXmlBytes: limit });
      return null;
    } catch (error) {
      assert.ok(error instanceof DocumentFormatError);
      assert.equal(error.status, 413);
      assert.equal(error.code, CODES.archiveTooLarge);
      return error.message;
    }
  };

  assert.equal(refusal("docx", xmlBytes), null);
  assert.match(refusal("docx", xmlBytes - 1), /XML parts inflate to more than \d+ bytes together \(RAG_OFFICE_MAX_XML_BYTES\)/);
  assert.equal(refusal("pptx", 1007), null);
  assert.match(refusal("pptx", 1006), /an XML part inflates to more than 1006 bytes \(RAG_OFFICE_MAX_XML_BYTES\)/);
  // A workbook's parts are left to the XLSX loader, which knows its worksheets.
  assert.equal(refusal("xlsx", 1), null);
  assert.equal(getXmlPartSize(archive, "WORD/DOCUMENT.XML"), 1007);
  assert.equal(getXmlPartSize(archive, "word/missing.xml"), 0);
  assert.throws(() => assertXmlPartWithinLimit(archive, "word/footnotes.xml", 1000), (error) => error.status === 413);
  assert.doesNotThrow(() => assertXmlPartWithinLimit(archive, "word/missing.xml", 1));
});
