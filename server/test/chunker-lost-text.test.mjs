import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  chunkDocumentWithConfig,
  findUnindexedPageText,
} from "../rag/chunker.js";

const structured = (pages, { chunkSize = 900, chunkOverlap = 180 } = {}) =>
  chunkDocumentWithConfig({
    docId: "doc-lost-text",
    fileName: "lost-text.pdf",
    publicFilePath: "",
    pages,
    chunkStrategy: "structured",
    chunkSize,
    chunkOverlap,
  });

const assertEveryPageIndexed = (pages, chunks) => {
  for (const page of pages) {
    assert.deepEqual(
      findUnindexedPageText(page, chunks),
      [],
      `page ${page.pageNumber} has text that reached no chunk`
    );
  }
};

const assertContiguousChunkIds = (chunks) => {
  chunks.forEach((chunk, index) => {
    assert.equal(chunk.metadata.chunkIndex, index);
    assert.equal(chunk.id, `doc-lost-text:${index}`);
  });
};

describe("findUnindexedPageText", () => {
  test("reports page text that no chunk of that page contains", () => {
    const page = { pageNumber: 3, text: "Alpha beta\nGamma delta" };
    const chunks = [
      { pageContent: "Alpha beta", metadata: { pageNumber: 3 } },
      // The right words on the wrong page do not count.
      { pageContent: "Gamma delta", metadata: { pageNumber: 4 } },
    ];

    assert.deepEqual(findUnindexedPageText(page, chunks), ["Gamma", "delta"]);
    assert.deepEqual(findUnindexedPageText(page, []), [
      "Alpha",
      "beta",
      "Gamma",
      "delta",
    ]);
  });

  test("accepts a long token that was sliced across chunks", () => {
    const page = { pageNumber: 1, text: "abcdefghij tail" };
    const chunks = [
      { pageContent: "abcde", metadata: { pageNumber: 1 } },
      { pageContent: "fghij tail", metadata: { pageNumber: 1 } },
    ];

    assert.deepEqual(findUnindexedPageText(page, chunks), []);
  });

  test("covers fixed-window chunking with tight overlap", () => {
    const pages = [{ pageNumber: 1, text: "abcdefghij klmnopqrst" }];
    const chunks = chunkDocumentWithConfig({
      docId: "doc-simple",
      fileName: "simple.pdf",
      publicFilePath: "",
      pages,
      chunkStrategy: "simple",
      chunkSize: 5,
      chunkOverlap: 2,
    });

    assertEveryPageIndexed(pages, chunks);
  });
});

describe("structured chunking keeps heading-like lines", () => {
  test("indexes every row of a table whose rows look like headings", () => {
    const pages = [
      {
        pageNumber: 1,
        text: [
          "Results are summarised below.",
          "Table 2: Retrieval quality",
          "Model P R F1",
          "BERT 0.81 0.79 0.80",
          "ROBERTA 0.85 0.83 0.84",
          "The larger model wins on every metric.",
        ].join("\n"),
      },
    ];
    const chunks = structured(pages);

    assertEveryPageIndexed(pages, chunks);
    assertContiguousChunkIds(chunks);
    // The caption is body text; the header row and every data row look like
    // headings. The replaced rows stay in reading order ahead of the heading
    // in force, which stays the chunk's sectionHeading as before.
    assert.deepEqual(
      chunks.map((chunk) => [chunk.metadata.sectionHeading, chunk.pageContent]),
      [
        [null, "Results are summarised below.\n\nTable 2: Retrieval quality"],
        [
          "ROBERTA 0.85 0.83 0.84",
          [
            "Model P R F1",
            "BERT 0.81 0.79 0.80",
            "ROBERTA 0.85 0.83 0.84",
            "The larger model wins on every metric.",
          ].join("\n\n"),
        ],
      ]
    );
  });

  test("indexes consecutive Label: lead-ins", () => {
    const pages = [
      {
        pageNumber: 1,
        text: [
          "The following conditions apply:",
          "Eligibility:",
          "Waiting period:",
          "Employees qualify after ninety days of continuous service.",
        ].join("\n"),
      },
    ];
    const chunks = structured(pages);

    assertEveryPageIndexed(pages, chunks);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].metadata.sectionHeading, "Waiting period:");
    assert.equal(
      chunks[0].pageContent,
      [
        "The following conditions apply:",
        "Eligibility:",
        "Waiting period:",
        "Employees qualify after ninety days of continuous service.",
      ].join("\n\n")
    );
  });

  test("a heading at the end of a page stays on that page", () => {
    const pages = [
      {
        pageNumber: 1,
        text: [
          "3 Method",
          "We fine-tune the retriever on the training split.",
          "4 Experiments",
        ].join("\n"),
      },
      {
        pageNumber: 2,
        text: "The experiments use the development split.",
      },
    ];
    const chunks = structured(pages);

    assertEveryPageIndexed(pages, chunks);
    assertContiguousChunkIds(chunks);
    assert.deepEqual(
      chunks.map((chunk) => ({
        pageNumber: chunk.metadata.pageNumber,
        sectionHeading: chunk.metadata.sectionHeading,
        pageContent: chunk.pageContent,
      })),
      [
        {
          pageNumber: 1,
          sectionHeading: "3 Method",
          pageContent: [
            "3 Method",
            "We fine-tune the retriever on the training split.",
            "4 Experiments",
          ].join("\n\n"),
        },
        {
          pageNumber: 2,
          sectionHeading: null,
          pageContent: "The experiments use the development split.",
        },
      ]
    );
  });

  test("a page of heading-like lines alone becomes its own chunk", () => {
    const pages = [
      { pageNumber: 1, text: "ANNUAL REPORT\nACME CORP\nFISCAL YEAR 2023" },
      { pageNumber: 2, text: "Revenue grew in every region." },
    ];
    const chunks = structured(pages);

    assertEveryPageIndexed(pages, chunks);
    assertContiguousChunkIds(chunks);
    assert.deepEqual(
      chunks.map((chunk) => [chunk.metadata.pageNumber, chunk.metadata.sectionHeading]),
      [
        [1, "FISCAL YEAR 2023"],
        [2, null],
      ]
    );
    assert.equal(
      chunks[0].pageContent,
      "ANNUAL REPORT\n\nACME CORP\n\nFISCAL YEAR 2023"
    );
  });

  test("a trailing heading that does not fit the last chunk gets its own", () => {
    const body = "Body sentence about retrieval quality and recall.";
    const pages = [
      {
        pageNumber: 1,
        text: ["1 Overview", body, "Appendix A"].join("\n"),
      },
    ];
    const chunkSize = body.length + 4;
    const chunks = structured(pages, { chunkSize, chunkOverlap: 0 });

    assertEveryPageIndexed(pages, chunks);
    assert.deepEqual(
      chunks.map((chunk) => [chunk.metadata.sectionHeading, chunk.pageContent]),
      [
        ["1 Overview", `1 Overview\n\n${body}`],
        ["Appendix A", "Appendix A"],
      ]
    );
  });

  test("a long run of heading-like lines splits by chunk size and loses nothing", () => {
    const rows = Array.from(
      { length: 40 },
      (_, index) => `ROW ${index + 1} ALPHA ${index * 3} BETA ${index * 7}`
    );
    const pages = [
      {
        pageNumber: 1,
        text: ["Table 9: Long table", ...rows, "Closing paragraph after the table."].join(
          "\n"
        ),
      },
    ];
    const chunkSize = 200;
    const chunks = structured(pages, { chunkSize, chunkOverlap: 40 });

    assertEveryPageIndexed(pages, chunks);
    assertContiguousChunkIds(chunks);
    assert.ok(chunks.length > 1);

    for (const chunk of chunks) {
      const bodyLength =
        chunk.pageContent.length -
        (chunk.metadata.sectionHeading ? chunk.metadata.sectionHeading.length + 2 : 0);

      assert.ok(
        bodyLength <= chunkSize,
        `chunk ${chunk.metadata.chunkIndex} is ${bodyLength} characters past its heading`
      );
    }

    // The paragraph after the table keeps the last row as its heading, as it
    // did before the table rows were kept.
    const closing = chunks.find((chunk) =>
      chunk.pageContent.includes("Closing paragraph after the table.")
    );
    assert.equal(closing.metadata.sectionHeading, rows.at(-1));
  });

  test("leading lines that do not fit with the first paragraph leave the body chunk as before", () => {
    const paragraph =
      "This paragraph is long enough that it cannot share a chunk with the lines before it.";
    const pages = [
      {
        pageNumber: 1,
        text: ["Part One", "Chapter Two", "Section Three", paragraph].join("\n"),
      },
    ];
    const chunkSize = paragraph.length + 10;
    const chunks = structured(pages, { chunkSize, chunkOverlap: 0 });

    assertEveryPageIndexed(pages, chunks);
    assert.deepEqual(
      chunks.map((chunk) => [chunk.metadata.sectionHeading, chunk.pageContent]),
      [
        ["Section Three", "Part One\n\nChapter Two\n\nSection Three"],
        ["Section Three", `Section Three\n\n${paragraph}`],
      ]
    );
  });
});

describe("structured chunking without consecutive headings is unchanged", () => {
  test("heading and body chunks keep their text, headings and overlap", () => {
    const pages = [
      {
        pageNumber: 4,
        text: [
          "Intro paragraph before any heading.",
          "1 Background",
          "First background paragraph explains the setting.",
          "Second background paragraph adds the details.",
          "2 Results",
          "The results paragraph reports the numbers.",
        ].join("\n"),
      },
    ];
    const chunks = structured(pages, { chunkSize: 60, chunkOverlap: 10 });

    assertEveryPageIndexed(pages, chunks);
    assertContiguousChunkIds(chunks);
    assert.deepEqual(
      chunks.map((chunk) => [chunk.metadata.sectionHeading, chunk.pageContent]),
      [
        [null, "Intro paragraph before any heading."],
        [
          "1 Background",
          "1 Background\n\nFirst background paragraph explains the setting.",
        ],
        [
          "1 Background",
          [
            "1 Background",
            "First background paragraph explains the setting.",
            "Second background paragraph adds the details.",
          ].join("\n\n"),
        ],
        ["2 Results", "2 Results\n\nThe results paragraph reports the numbers."],
      ]
    );
  });
});
