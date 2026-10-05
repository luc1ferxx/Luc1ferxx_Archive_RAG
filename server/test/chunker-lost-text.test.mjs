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
    // The heading counts toward the chunk size: the body chunk fits with 4
    // characters to spare, the trailing heading does not.
    const chunkSize = "1 Overview".length + 2 + body.length + 4;
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
    // The heading counts toward the chunk size: the heading and the paragraph
    // fit, the kept lines in front of them do not.
    const chunkSize = "Section Three".length + 2 + paragraph.length + 10;
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

describe("structured chunking without consecutive headings", () => {
  test("heading and body chunks keep their text and headings; a paragraph longer than the overlap is not carried", () => {
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
    const chunkSize = 64;
    const chunks = structured(pages, { chunkSize, chunkOverlap: 10 });

    assertEveryPageIndexed(pages, chunks);
    assertContiguousChunkIds(chunks);
    // Before the overlap was capped, the third chunk carried the whole first
    // paragraph (48 characters against an overlap of 10) and ran to 109
    // characters.
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
          "1 Background\n\nSecond background paragraph adds the details.",
        ],
        ["2 Results", "2 Results\n\nThe results paragraph reports the numbers."],
      ]
    );
    assert.ok(chunks.every((chunk) => chunk.pageContent.length <= chunkSize));
  });
});

describe("structured chunking stays within the chunk size", () => {
  const assertWithinSize = (chunks, chunkSize) => {
    for (const chunk of chunks) {
      assert.ok(
        chunk.pageContent.length <= chunkSize,
        `chunk ${chunk.metadata.chunkIndex} is ${chunk.pageContent.length} characters`
      );
    }
  };

  test("the overlap of a long paragraph is its trailing whole sentences that fit", () => {
    const paragraph = [
      "Retrieval quality depends on chunking.",
      "Smith et al. report that whole sentences help.",
      "Overlap carries context, e.g. a definition.",
      "The next chunk starts after it.",
      "Version 2.1 kept 3.5 times fewer duplicates.",
      "A final short sentence closes it.",
    ].join(" ");
    const pages = [{ pageNumber: 1, text: ["2 Method", paragraph].join("\n") }];
    const chunkSize = 120;
    const chunks = structured(pages, { chunkSize, chunkOverlap: 60 });

    assertEveryPageIndexed(pages, chunks);
    assertContiguousChunkIds(chunks);
    assertWithinSize(chunks, chunkSize);
    // The overlap is cut with the sentence splitter, so "et al." and "2.1"
    // stay inside their sentences. The packing of the paragraph itself still
    // cuts at every ". " (here after "e.g.").
    assert.deepEqual(
      chunks.map((chunk) => [chunk.metadata.sectionHeading, chunk.pageContent]),
      [
        [
          "2 Method",
          "2 Method\n\nRetrieval quality depends on chunking. Smith et al. report that whole sentences help.",
        ],
        [
          "2 Method",
          "2 Method\n\nSmith et al. report that whole sentences help.\n\nOverlap carries context, e.g.",
        ],
        [
          "2 Method",
          "2 Method\n\na definition. The next chunk starts after it. Version 2.1 kept 3.5 times fewer duplicates.",
        ],
        [
          "2 Method",
          "2 Method\n\nVersion 2.1 kept 3.5 times fewer duplicates.\n\nA final short sentence closes it.",
        ],
      ]
    );
  });

  test("whole previous paragraphs are carried while they fit the overlap", () => {
    const pages = [
      {
        pageNumber: 2,
        text: [
          "Short line one.",
          "Second paragraph is a bit longer than the first one.",
          "Third paragraph needs a new chunk because it does not fit.",
        ].join("\n"),
      },
    ];
    const chunkSize = 120;
    const chunks = structured(pages, { chunkSize, chunkOverlap: 60 });

    assertEveryPageIndexed(pages, chunks);
    assertWithinSize(chunks, chunkSize);
    assert.deepEqual(
      chunks.map((chunk) => chunk.pageContent),
      [
        "Short line one.\n\nSecond paragraph is a bit longer than the first one.",
        "Second paragraph is a bit longer than the first one.\n\nThird paragraph needs a new chunk because it does not fit.",
      ]
    );
  });

  test("a sentence longer than the chunk size is cut at word boundaries and never carried", () => {
    const longSentence = Array.from({ length: 30 }, (_, index) => `term${index}`).join(" ");
    const pages = [
      { pageNumber: 1, text: ["Preface text.", longSentence, "After."].join("\n") },
    ];
    const chunkSize = 60;
    const chunks = structured(pages, { chunkSize, chunkOverlap: 30 });

    assertEveryPageIndexed(pages, chunks);
    assertWithinSize(chunks, chunkSize);
    assert.deepEqual(
      chunks.map((chunk) => chunk.pageContent),
      [
        "Preface text.",
        "term0 term1 term2 term3 term4 term5 term6 term7 term8 term9",
        "term10 term11 term12 term13 term14 term15 term16 term17",
        "term18 term19 term20 term21 term22 term23 term24 term25",
        "term26 term27 term28 term29\n\nAfter.",
      ]
    );
  });

  test("long paragraphs at the default size and overlap stay within the size", () => {
    const sentence = (index) =>
      `Sentence ${index} reports a measured value of ${index}.5 percent on the held-out split.`;
    const paragraphs = [0, 1, 2].map((block) =>
      Array.from({ length: 25 }, (_, index) => sentence(block * 25 + index)).join(" ")
    );
    const pages = [
      { pageNumber: 1, text: ["3 Experiments", ...paragraphs].join("\n") },
    ];
    const chunks = structured(pages);

    assertEveryPageIndexed(pages, chunks);
    assertContiguousChunkIds(chunks);
    assertWithinSize(chunks, 900);

    let chunksWithOverlap = 0;

    for (const [index, chunk] of chunks.entries()) {
      assert.equal(chunk.metadata.sectionHeading, "3 Experiments");

      if (index === 0) {
        continue;
      }

      // Whatever the chunk repeats from the previous one is at most the
      // overlap and ends on a whole sentence.
      const previous = chunks[index - 1].pageContent;
      const body = chunk.pageContent.slice("3 Experiments\n\n".length);
      let repeated = 0;

      for (let length = 1; length <= body.length; length += 1) {
        if (previous.endsWith(body.slice(0, length))) {
          repeated = length;
        }
      }

      assert.ok(repeated <= 180, `chunk ${index} repeats ${repeated} characters`);

      if (repeated > 0) {
        chunksWithOverlap += 1;
        assert.match(body.slice(0, repeated), /split\.$/);
      }
    }

    assert.ok(chunksWithOverlap > 0);
  });
});
