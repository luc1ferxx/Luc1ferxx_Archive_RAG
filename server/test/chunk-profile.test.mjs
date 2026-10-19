import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CHUNK_PROFILE_FIELDS,
  CHUNKER_VERSION,
  computeChunkProfileId,
  describeChunkProfile,
  describeChunkProfileChange,
  readStoredChunkProfile,
  stampChunkProfile,
} from "../rag/chunk-profile.js";
import { chunkDocumentWithConfig } from "../rag/chunker.js";
import { CHUNK_STRATEGIES } from "../rag/config.js";
import { chunkDocumentPages } from "../rag/index.js";

const PROFILE_VARIABLES = [
  "RAG_CHUNK_STRATEGY",
  "RAG_CHUNK_SIZE",
  "RAG_CHUNK_OVERLAP",
  "PDF_PARSER",
  "PDF_PARAGRAPH_DETECTION",
];
// Every case starts from the defaults (a file runs in a process of its own).
const clearProfileVariables = () => {
  for (const name of PROFILE_VARIABLES) {
    delete process.env[name];
  }
};

clearProfileVariables();
afterEach(clearProfileVariables);

const pagesOf = (texts) => texts.map((text, index) => ({ pageNumber: index + 1, text }));

describe("chunk profile", () => {
  test("names the chunker version and the settings that decide the chunks", () => {
    const profile = describeChunkProfile();

    assert.equal(CHUNKER_VERSION, 2);
    assert.deepEqual(Object.keys(profile), ["id", ...CHUNK_PROFILE_FIELDS]);
    assert.deepEqual(
      { ...profile, id: undefined },
      {
        chunkerVersion: 2,
        id: undefined,
        overlap: 180,
        paragraphDetection: true,
        pdfParser: "pdfjs",
        size: 900,
        strategy: "structured",
      }
    );
    assert.match(profile.id, /^[0-9a-f]{12}$/);
    // The default profile's id, pinned: a changed default, field or
    // serialization changes every stored chunk's id, so it must not happen
    // by accident.
    assert.equal(profile.id, "06c55d11be63");
    assert.ok(Object.isFrozen(profile));
  });

  test("the id is a hash of the fields alone, whatever order they come in", () => {
    const profile = describeChunkProfile();
    const reversed = Object.fromEntries(CHUNK_PROFILE_FIELDS.toReversed().map((field) => [field, profile[field]]));

    assert.equal(computeChunkProfileId(reversed), profile.id);
    assert.equal(describeChunkProfile().id, profile.id);

    const variants = [
      { strategy: "sentence" },
      { size: 901 },
      { overlap: 181 },
      { pdfParser: "docling" },
      { paragraphDetection: false },
    ];
    const ids = new Set([profile.id, ...variants.map((variant) => describeChunkProfile(variant).id)]);

    assert.equal(ids.size, variants.length + 1, "every field changes the id");
    assert.notEqual(computeChunkProfileId({ ...profile, chunkerVersion: 1 }), profile.id);
  });

  test("follows the environment, and an invalid setting throws", () => {
    process.env.RAG_CHUNK_STRATEGY = "sentence";
    process.env.RAG_CHUNK_SIZE = "600";
    process.env.RAG_CHUNK_OVERLAP = "";
    process.env.PDF_PARSER = "auto";
    process.env.PDF_PARAGRAPH_DETECTION = "false";

    assert.deepEqual(
      { ...describeChunkProfile() },
      { ...describeChunkProfile({ overlap: 180, paragraphDetection: false, pdfParser: "auto", size: 600, strategy: "sentence" }) }
    );

    process.env.PDF_PARSER = "pdf.js";
    assert.throws(() => describeChunkProfile(), /PDF_PARSER/);
    process.env.PDF_PARSER = "";
    process.env.RAG_CHUNK_STRATEGY = "fixed";
    assert.throws(() => describeChunkProfile(), /RAG_CHUNK_STRATEGY/);
    // So an ingest refuses before it cuts anything.
    assert.throws(
      () => chunkDocumentPages({ docId: "doc-invalid", fileName: "invalid.pdf", pages: pagesOf(["Some text."]) }),
      /RAG_CHUNK_STRATEGY must be one of/
    );
  });

  test("a stored profile is read back, and anything without a well-formed id is unknown", () => {
    const profile = describeChunkProfile();

    assert.deepEqual(readStoredChunkProfile(JSON.parse(JSON.stringify(profile))), profile);

    for (const value of [null, undefined, "06c55d11be63", [], {}, { id: "short" }, { id: "06C55D11BE63" }, { ...profile, id: 12 }]) {
      assert.equal(readStoredChunkProfile(value), null, JSON.stringify(value));
    }
  });

  test("a change names the fields and the settings that would restore the recorded profile", () => {
    const recorded = describeChunkProfile({ paragraphDetection: false, size: 600 });
    const current = describeChunkProfile();

    assert.deepEqual(describeChunkProfileChange(recorded, current), {
      fields: ["size", "paragraphDetection"],
      settings: { PDF_PARAGRAPH_DETECTION: "false", RAG_CHUNK_SIZE: "600" },
    });
    assert.deepEqual(describeChunkProfileChange({ ...current, chunkerVersion: 1 }, current), {
      fields: ["chunkerVersion"],
      settings: {},
    });
    assert.deepEqual(describeChunkProfileChange(current, current), { fields: [], settings: {} });
  });

  test("stamping adds the id and changes nothing else", () => {
    const profile = describeChunkProfile();
    const metadata = { chunkIndex: 0, docId: "d", sectionHeading: null };

    assert.deepEqual(stampChunkProfile(metadata, profile), { ...metadata, chunkProfileId: profile.id });
    assert.deepEqual(metadata, { chunkIndex: 0, docId: "d", sectionHeading: null });
  });

  test("an ingest's chunks carry the profile they were cut with; text and boundaries are the chunker's", () => {
    process.env.RAG_CHUNK_SIZE = "300";
    process.env.RAG_CHUNK_OVERLAP = "60";

    const pages = pagesOf([
      `1 Overview\n${"The archive keeps every signed contract for seven years. ".repeat(12)}`,
      "2 Retention\nShort paragraph.",
    ]);
    const chunked = chunkDocumentPages({ docId: "doc-ingest", fileName: "ingest.pdf", pages });
    const profile = describeChunkProfile();
    const expected = chunkDocumentWithConfig({
      chunkOverlap: 60,
      chunkSize: 300,
      chunkStrategy: "structured",
      docId: "doc-ingest",
      fileName: "ingest.pdf",
      pages,
    });

    assert.deepEqual(chunked.chunkProfile, profile);
    assert.equal(profile.size, 300);
    assert.ok(chunked.documents.length > 2);
    assert.deepEqual(
      chunked.documents,
      expected.map((chunk) => ({
        id: chunk.id,
        metadata: { ...chunk.metadata, chunkProfileId: profile.id },
        pageContent: chunk.pageContent,
      }))
    );
  });
});

// ---------------------------------------------------------------------------
// The chunker's output, pinned per CHUNKER_VERSION
//
// 1dcc8467 changed the default structured chunker's output while its message
// said byte-identical, and nothing noticed. Every strategy's chunks over a
// fixed set of pages are hashed here; when the hash moves, chunk text or
// boundaries changed for the same pages and settings. Checked against the
// chunker of 1dcc8467^ (its rag/chunker.js, config.js, document-utils.js and
// text-utils.js): structured hashed 3f40dd212d044620 there (50 of the 120
// document x settings inputs cut differently, 32 of them corpus pages),
// simple the same as today.
// ---------------------------------------------------------------------------

// What a changed digest asks for, in its failure message.
const DIGEST_CHANGED =
  "The chunker's output changed for the same pages and settings. That changes the chunk profile: bump CHUNKER_VERSION in rag/chunk-profile.js (stored chunks and index versions then say they were cut by the older chunker, and the staged ingest re-chunks jobs chunked before), say so in the commit, and pin the new digests under the new version here, keeping the older entries.";

const CHUNKER_OUTPUT_DIGESTS = Object.freeze({
  2: Object.freeze({
    sentence: "4eec88427e25cea2",
    simple: "661208b6225b4994",
    structured: "01a420237b4c1961",
  }),
});

const evaluationDirectory = fileURLToPath(new URL("../evaluation/", import.meta.url));

// The tracked synthetic corpora: their pages are what the deterministic evals chunk.
const readCorpusDocuments = () =>
  readdirSync(evaluationDirectory)
    .filter((name) => /^synthetic-corpus.*\.json$/.test(name))
    .sort()
    .flatMap((name) =>
      JSON.parse(readFileSync(`${evaluationDirectory}${name}`, "utf8")).documents.map((document) => ({
        key: `${name}:${document.key}`,
        pages: pagesOf(document.pages),
      }))
    );

// Pages for the paths the corpora rarely reach: paragraphs longer than a
// chunk (split), overlap across paragraphs, heading runs, list items, table
// rows, soft-wrapped lines, CJK. Deterministic.
const buildGeneratedDocuments = () => {
  let seed = 20261018;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const pick = (items) => items[Math.floor(random() * items.length)];
  const words = ["archive", "contract", "notice", "period", "vendor", "liability", "renewal", "employee", "policy", "review"];
  const sentence = () =>
    `${Array.from({ length: 4 + Math.floor(random() * 14) }, () => pick(words)).join(" ")}${pick([".", ".", "?", ";"])}`;
  const paragraph = (sentences) => Array.from({ length: sentences }, sentence).join(" ").replace(/^./, (first) => first.toUpperCase());
  const blocks = [
    () => `${1 + Math.floor(random() * 9)}.${Math.floor(random() * 9)} ${pick(["Scope", "Notice Period", "Liability Cap"])}`,
    () => `${pick(["Effective Date", "Governing Law", "Payment Terms"])}:`,
    () => "Termination And Renewal",
    () => paragraph(2),
    () => paragraph(6),
    () => paragraph(30),
    () => `- ${sentence()}\n- ${sentence()}\n- ${sentence()}`,
    () => `Notice Period    30 Days\nLiability Cap    12 Months\nRenewal    Automatic`,
    () => `${paragraph(1)}\nwrapped onto the next line ${sentence()}`,
    () => "第一章 总则\n本合同自签署之日起生效。双方应当遵守本合同的全部条款。",
  ];

  return Array.from({ length: 6 }, (_, documentIndex) => ({
    key: `generated:${documentIndex}`,
    pages: pagesOf(
      Array.from({ length: 3 }, () => Array.from({ length: 4 + Math.floor(random() * 8) }, () => pick(blocks)()).join("\n"))
    ),
  }));
};

const CHUNK_SETTINGS = Object.freeze([
  { chunkOverlap: 180, chunkSize: 900 },
  { chunkOverlap: 60, chunkSize: 300 },
  { chunkOverlap: 0, chunkSize: 120 },
]);

const digestChunkerOutput = (chunkStrategy, documents, chunkWithConfig = chunkDocumentWithConfig) => {
  const hash = createHash("sha256");

  for (const settings of CHUNK_SETTINGS) {
    for (const document of documents) {
      const chunks = chunkWithConfig({
        ...settings,
        chunkStrategy,
        docId: document.key,
        fileName: `${document.key}.pdf`,
        pages: document.pages,
        publicFilePath: "",
      });

      hash.update(
        JSON.stringify([
          settings,
          document.key,
          chunks.map((chunk) => [chunk.id, chunk.pageContent, chunk.metadata.pageNumber, chunk.metadata.sectionHeading]),
        ])
      );
    }
  }

  return hash.digest("hex").slice(0, 16);
};

test("the chunker's output for fixed pages is pinned to CHUNKER_VERSION", () => {
  const documents = [...readCorpusDocuments(), ...buildGeneratedDocuments()];
  const pinned = CHUNKER_OUTPUT_DIGESTS[CHUNKER_VERSION];

  assert.ok(documents.length > 30, `only ${documents.length} documents`);
  assert.ok(pinned, `No chunker output digests are pinned for CHUNKER_VERSION ${CHUNKER_VERSION}. ${DIGEST_CHANGED}`);
  assert.deepEqual(
    Object.fromEntries(CHUNK_STRATEGIES.map((strategy) => [strategy, digestChunkerOutput(strategy, documents)])),
    { ...pinned },
    DIGEST_CHANGED
  );
});
