// Files written by Microsoft Word, PowerPoint and Excel themselves (16.115 for
// Mac), not by office-fixture-builder.mjs. The builder writes the minimal
// package each loader needs (PowerPoint repairs its decks before it opens
// them); these hold what the real writers add: themes, slide layouts and
// masters, extension lists, mc:AlternateContent, styles, calcChain, Excel's
// saved-folder path, Office's own zip layout. fixtures/office-real/README.md
// says how each file was made. Their author fields and Excel's saved-folder
// path were rewritten by fixtures/office-real/scrub-office-package.mjs; every
// other entry is byte for byte what Office wrote.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DOCUMENT_MIME_TYPES, detectDocumentFormatAtPath } from "../rag/document-formats.js";
import { loadDocumentPages } from "../rag/document-loader.js";
import { scanOfficeArchive } from "../rag/office/zip-guard.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "office-real");
const fixturePath = (name) => path.join(FIXTURES, name);
const AUTHOR_PLACEHOLDER = "Archive RAG test";

const slide = (pageNumber, locationLabel, lines) => ({
  locationLabel,
  locationUnit: "slide",
  pageNumber,
  text: lines.join("\n"),
});
const section = (pageNumber, locationLabel, lines) => ({
  locationLabel,
  locationUnit: "section",
  pageNumber,
  text: lines.join("\n"),
});
const sheet = (pageNumber, locationLabel, lines) => ({
  locationLabel,
  locationUnit: "sheet",
  pageNumber,
  text: lines.join("\n"),
});

const EXPECTED = {
  // Made in Excel: a merged title row, number formats, formulas (the cached
  // values are Excel's), DATE() dates, and the hidden sheet "Scratch" second.
  "budget.xlsx": {
    application: "Microsoft Macintosh Excel",
    format: "xlsx",
    pages: [
      sheet(1, "Budget", [
        "Sheet: Budget",
        "Q3 budget review",
        "Department; Budget; Spent; Remaining; Review date",
        "Department: Engineering; Budget: 120,000.00; Spent: 98,500.50; Remaining: 21,499.50; Review date: 2026-09-29",
        "Department: Marketing; Budget: 45,000.00; Spent: 47,250.00; Remaining: -2,250.00; Review date: 2026-09-14",
        "Department: Support; Budget: 30,000.00; Spent: 12,000.00; Remaining: 18,000.00; Review date: 2026-09-30",
      ]),
      sheet(3, "Notes", ["Sheet: Notes", "Owner; Note", "Owner: Finance; Note: Marketing overspend approved by CFO"]),
    ],
    parse: { extractor: "sheetjs", extractorVersion: "0.20.3", format: "xlsx" },
  },
  // The builder's document (numbered list, table, footnote, endnote, comment)
  // opened in Word and saved again, so the package and its table are Word's.
  "equipment-rules.docx": {
    application: "Microsoft Office Word",
    format: "docx",
    pages: [
      section(1, "Equipment Rules", [
        "Equipment Rules",
        "These rules cover hardware bought for employees.[1]",
        "- Request the item in the service portal",
        "- Wait for the approver",
        "- Collect the item from IT",
        "Item; Limit; Approver",
        "Item: Laptop; Limit: 1,800 USD; Approver: IT manager",
        "Item: Monitor; Limit: 400 USD; Approver: Team lead",
        "Item: Phone; Limit: 900 USD; Approver: Department head",
      ]),
      section(2, "Returns", [
        "Returns",
        "Return equipment within ten working days of leaving.[2]",
        "Damaged items go to the repair desk first.",
        "[1] Rules reviewed every January.",
        "[2] Late returns are billed at cost.",
      ]),
    ],
    parse: { extractor: "mammoth", extractorVersion: "1.13.0", format: "docx" },
  },
  // The builder's table deck opened in PowerPoint (which repaired the minimal
  // package) and saved again: the table and the notes page are PowerPoint's.
  "incident-targets.pptx": {
    application: "Microsoft Macintosh PowerPoint",
    format: "pptx",
    pages: [
      slide(1, "Incident Response Targets", [
        "Incident Response Targets",
        "Severity; Response time; Owner",
        "Severity: Critical; Response time: 15 minutes; Owner: On-call lead",
        "Severity: High; Response time: 4 hours; Owner: Service owner",
        "Severity: Low; Response time: 3 days; Owner: Help desk",
        "Notes:",
        "Escalate critical incidents to the on-call lead.",
      ]),
    ],
    parse: { extractor: "ooxml-pptx", extractorVersion: 2, format: "pptx" },
  },
  // Made in PowerPoint: a title slide, a title-and-content slide whose body
  // bullets come from the slide master (none written on the paragraphs), its
  // speaker notes, a hidden third slide, and a section header.
  "security-review.pptx": {
    application: "Microsoft Macintosh PowerPoint",
    format: "pptx",
    pages: [
      slide(1, "Quarterly Security Review", ["Quarterly Security Review", "Information security team, third quarter"]),
      slide(2, "Key Findings", [
        "Key Findings",
        "- Phishing reports rose 18 percent this quarter",
        "- All laptops now use full-disk encryption",
        "- Two vendors failed the access review",
        "Notes:",
        "Mention that the encryption rollout finished in week 9.",
      ]),
      slide(4, "Next Steps", ["Next Steps", "Vendor remediation plan due in October"]),
    ],
    parse: { extractor: "ooxml-pptx", extractorVersion: 2, format: "pptx" },
  },
  // Made in Word: Heading 1 and Heading 2, List Bullet paragraphs and a
  // footnote. The footnote was added through AppleScript, which made Word
  // write "No Reference" in front of the footnote's own text: the loader reads
  // the text as Word stored it.
  "travel-policy.docx": {
    application: "Microsoft Office Word",
    format: "docx",
    pages: [
      section(1, "Travel Policy", [
        "Travel Policy",
        "This policy applies to all employees who travel for work.",
        "Flights",
        "Employees book economy class for flights under six hours.",
        "Business class needs written approval from a vice president.[1]",
        "Expense Limits",
        "- Hotels up to 180 USD per night",
        "- Meals up to 60 USD per day",
        "- Taxis up to 40 USD per trip",
      ]),
      section(2, "Equipment Policy", [
        "Equipment Policy",
        "Purchases above 5,000 USD need three quotes.",
        "[1] No ReferenceApproval requests go through the travel portal.",
      ]),
    ],
    parse: { extractor: "mammoth", extractorVersion: "1.13.0", format: "docx" },
  },
};

for (const [name, expected] of Object.entries(EXPECTED)) {
  test(`${name}: detected and loaded as Office wrote it`, async () => {
    const filePath = fixturePath(name);
    const detected = await detectDocumentFormatAtPath(filePath);
    const loaded = await loadDocumentPages(filePath);

    assert.deepEqual(detected, { format: expected.format, mimeType: DOCUMENT_MIME_TYPES[expected.format] });
    assert.equal(loaded.format, expected.format);
    assert.equal(loaded.mimeType, DOCUMENT_MIME_TYPES[expected.format]);
    assert.deepEqual(loaded.parse, expected.parse);
    assert.deepEqual(loaded.pages, expected.pages);
  });

  test(`${name}: written by ${expected.application}, with no personal details left`, async () => {
    const archive = await scanOfficeArchive(await readFile(fixturePath(name)));
    const appProperties = (await archive.readPart("docProps/app.xml")).toString("utf8");
    const coreProperties = (await archive.readPart("docProps/core.xml")).toString("utf8");

    // The fixture is the real application's output, not builder output.
    assert.match(appProperties, new RegExp(`<Application>${expected.application}</Application>`));

    // Author fields hold only the placeholder the scrub script wrote.
    for (const field of ["dc:creator", "cp:lastModifiedBy"]) {
      const value = coreProperties.match(new RegExp(`<${field}>([^<]*)</${field}>`))?.[1];

      if (value !== undefined) {
        assert.equal(value, AUTHOR_PLACEHOLDER, `${field} of ${name}`);
      }
    }

    // No part names a local user's folder.
    for (const partName of archive.fileNames) {
      const text = (await archive.readPart(partName)).toString("latin1");

      for (const match of text.matchAll(/\/Users\/([^/"<]*)/g)) {
        assert.equal(match[1], "test", `${partName} of ${name} names /Users/${match[1]}`);
      }
    }
  });
}
