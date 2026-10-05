import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import {
  chunkDocument,
  chunkDocumentWithConfig,
  findUnindexedPageText,
} from "../rag/chunker.js";
import {
  splitLongSentence,
  splitSentenceSegments,
  splitSentences,
} from "../rag/sentence-splitter.js";
import { normalizeWhitespace } from "../rag/text-utils.js";

const sentence = (pages, { chunkSize = 900, chunkOverlap = 180 } = {}) =>
  chunkDocumentWithConfig({
    docId: "doc-sentence",
    fileName: "sentence.pdf",
    publicFilePath: "",
    pages,
    chunkStrategy: "sentence",
    chunkSize,
    chunkOverlap,
  });

const collapse = (value) => String(value).replace(/\s+/g, " ").trim();

// Every chunk body (the chunk text, or the text after its repeated section
// heading) must be one contiguous stretch of its page in reading order, and
// the stretches must cover every non-whitespace character of the page.
const assertPagesAlignedAndCovered = (pages, chunks) => {
  for (const page of pages) {
    assert.deepEqual(
      findUnindexedPageText(page, chunks),
      [],
      `page ${page.pageNumber} has text that reached no chunk`
    );

    const text = collapse(normalizeWhitespace(page.text));
    const covered = new Uint8Array(text.length);
    let cursor = 0;

    for (const chunk of chunks.filter((entry) => entry.metadata.pageNumber === page.pageNumber)) {
      const parts = chunk.pageContent.split("\n\n");
      const candidates = [collapse(chunk.pageContent)];

      if (chunk.metadata.sectionHeading && parts[0] === chunk.metadata.sectionHeading) {
        candidates.push(collapse(parts.slice(1).join(" ")));
      }

      let found = -1;
      let body = "";

      for (const candidate of candidates.filter(Boolean)) {
        let at = text.indexOf(candidate, cursor);
        const first = at;

        while (at !== -1 && covered.subarray(at, at + candidate.length).every(Boolean)) {
          at = text.indexOf(candidate, at + 1);
        }

        at = at === -1 ? first : at;

        if (at !== -1) {
          found = at;
          body = candidate;
          break;
        }
      }

      assert.notEqual(
        found,
        -1,
        `chunk ${chunk.metadata.chunkIndex} is not a stretch of page ${page.pageNumber} in reading order`
      );
      covered.fill(1, found, found + body.length);
      cursor = found;
    }

    for (let index = 0; index < text.length; index += 1) {
      if (text[index] !== " " && !covered[index]) {
        assert.fail(
          `page ${page.pageNumber} text near "${text.slice(Math.max(0, index - 20), index + 40)}" is in no chunk`
        );
      }
    }
  }
};

const assertWithinSize = (chunks, chunkSize) => {
  for (const chunk of chunks) {
    assert.ok(
      chunk.pageContent.length <= chunkSize,
      `chunk ${chunk.metadata.chunkIndex} has ${chunk.pageContent.length} characters, over ${chunkSize}`
    );
  }
};

const assertContiguousChunkIds = (chunks) => {
  chunks.forEach((chunk, index) => {
    assert.equal(chunk.metadata.chunkIndex, index);
    assert.equal(chunk.id, `doc-sentence:${index}`);
  });
};

// The text after the repeated section heading.
const chunkBody = (chunk) =>
  chunk.metadata.sectionHeading &&
  chunk.pageContent.startsWith(`${chunk.metadata.sectionHeading}\n\n`)
    ? chunk.pageContent.slice(chunk.metadata.sectionHeading.length + 2)
    : chunk.pageContent;

describe("sentence splitter", () => {
  test("does not cut after abbreviations, initials, acronyms or numbered references", () => {
    assert.deepEqual(
      splitSentences(
        "Smith et al. (2019) proposed it. Results improved, e.g. on SQuAD, i.e. the dev set. " +
          "See Fig. 2 and Eq. (3) for details. Accuracy is 0.95 vs. 0.90 overall. " +
          "J. R. R. Tolkien lived in the U.S. for years. Dr. Who met Mr. Smith at Acme Inc. in 2019. " +
          "It was filed as No. 5 in Proc. Natl. Acad. Sci. last year."
      ),
      [
        "Smith et al. (2019) proposed it.",
        "Results improved, e.g. on SQuAD, i.e. the dev set.",
        "See Fig. 2 and Eq. (3) for details.",
        "Accuracy is 0.95 vs. 0.90 overall.",
        "J. R. R. Tolkien lived in the U.S. for years.",
        "Dr. Who met Mr. Smith at Acme Inc. in 2019.",
        "It was filed as No. 5 in Proc. Natl. Acad. Sci. last year.",
      ]
    );
  });

  test("keeps a list number or caption label with the text it introduces", () => {
    assert.deepEqual(
      splitSentences(
        "1. Introduction of the method. 2. Related work is here. 3.2. Results are shown below. " +
          "Table 1. Results of the experiments. Fig. 2. Accuracy over epochs. " +
          "IV. Conclusion follows. See Section 3. It explains. The answer is 42. Then more."
      ),
      [
        "1. Introduction of the method.",
        "2. Related work is here.",
        "3.2. Results are shown below.",
        "Table 1. Results of the experiments.",
        "Fig. 2. Accuracy over epochs.",
        "IV. Conclusion follows.",
        "See Section 3.",
        "It explains.",
        "The answer is 42.",
        "Then more.",
      ]
    );
    assert.deepEqual(splitSentences("ii. The second item."), ["ii. The second item."]);
  });

  test("keeps decimals and version numbers and cuts after the last dot", () => {
    assert.deepEqual(splitSentences("Version 2.0.1 scored 3.14 on v1.2. 2020 was next."), [
      "Version 2.0.1 scored 3.14 on v1.2.",
      "2020 was next.",
    ]);
  });

  test("treats a word 'no.' as a sentence end unless a number follows", () => {
    assert.deepEqual(splitSentences("The answer is no. Then No. 5 arrived."), [
      "The answer is no.",
      "Then No. 5 arrived.",
    ]);
  });

  test("handles ellipses, repeated terminators and closing quotes or brackets", () => {
    assert.deepEqual(
      splitSentences(
        'It paused... and then left. Really?! Yes. He said "Stop." Then he left. (See Table 2.) Next one… Done.'
      ),
      [
        "It paused... and then left.",
        "Really?!",
        "Yes.",
        'He said "Stop."',
        "Then he left.",
        "(See Table 2.)",
        "Next one…",
        "Done.",
      ]
    );
  });

  test("does not cut before a lowercase word", () => {
    assert.deepEqual(splitSentences("We use the ROUGE-1. metric and etc. so on."), [
      "We use the ROUGE-1. metric and etc. so on.",
    ]);
  });

  test("cuts CJK text after 。！？； without whitespace and keeps closing quotes", () => {
    const text = "这是第一句。这是第二句！第三句？第四句；引用“结束。”然后继续";
    const segments = splitSentenceSegments(text);

    assert.deepEqual(
      segments.map((segment) => segment.text),
      ["这是第一句。", "这是第二句！", "第三句？", "第四句；", "引用“结束。”", "然后继续"]
    );
    assert.ok(segments.every((segment) => segment.separator === ""));
    assert.equal(segments.map((segment) => segment.separator + segment.text).join(""), text);
  });

  test("records the separator each sentence had in the text", () => {
    const text = "First one. Second one.第三句。Fourth one.";
    const segments = splitSentenceSegments(text);

    assert.deepEqual(
      segments.map((segment) => [segment.separator, segment.text]),
      [
        ["", "First one."],
        [" ", "Second one.第三句。"],
        ["", "Fourth one."],
      ]
    );
    assert.equal(segments.map((segment) => segment.separator + segment.text).join(""), text);
  });

  test("cuts a long sentence at a clause, then a word, then a hard boundary", () => {
    const clause = splitLongSentence("alpha beta gamma, delta epsilon zeta eta theta", 24);

    assert.deepEqual(clause, [
      { text: "alpha beta gamma,", separator: "" },
      { text: "delta epsilon zeta eta", separator: " " },
      { text: "theta", separator: " " },
    ]);

    const cjk = splitLongSentence("一二三四五六七八，九十一二三四五六七八九十", 10);

    assert.deepEqual(
      cjk.map((piece) => [piece.separator, piece.text]),
      [
        ["", "一二三四五六七八，"],
        ["", "九十一二三四五六七八"],
        ["", "九十"],
      ]
    );

    const hard = splitLongSentence("abcdefghijklmnopqrstuvwxyz", 10);

    assert.deepEqual(
      hard.map((piece) => piece.text),
      ["abcdefghij", "klmnopqrst", "uvwxyz"]
    );

    // A hard cut never separates the two halves of a surrogate pair.
    const astral = "😀𠀀".repeat(12);
    const astralPieces = splitLongSentence(astral, 7);

    assert.equal(astralPieces.map((piece) => piece.text).join(""), astral);
    assert.ok(
      astralPieces.every(
        (piece) =>
          piece.text.length <= 7 &&
          !/[\uD800-\uDFFF]/u.test(piece.text)
      ),
      JSON.stringify(astralPieces)
    );

    for (const pieces of [clause, cjk, hard]) {
      assert.ok(pieces.every((piece) => piece.text.length > 0));
    }
    assert.ok(clause.every((piece) => piece.text.length <= 24));
    assert.ok(cjk.every((piece) => piece.text.length <= 10));
    assert.ok(hard.every((piece) => piece.text.length <= 10));
  });
});

describe("sentence chunking", () => {
  test("packs whole sentences, overlaps whole trailing sentences, and stays within the size", () => {
    const sentences = [
      "Alpha one is the first sentence here.",
      "Beta two follows the first one.",
      "Gamma three is a third sentence.",
      "Delta four ends this paragraph.",
    ];
    const pages = [{ pageNumber: 1, text: sentences.join(" ") }];
    const chunks = sentence(pages, { chunkSize: 80, chunkOverlap: 40 });

    assert.deepEqual(
      chunks.map((chunk) => chunk.pageContent),
      [
        `${sentences[0]} ${sentences[1]}`,
        `${sentences[1]} ${sentences[2]}`,
        `${sentences[2]} ${sentences[3]}`,
      ]
    );
    assertWithinSize(chunks, 80);
    assertContiguousChunkIds(chunks);
    assertPagesAlignedAndCovered(pages, chunks);
  });

  test("carries no overlap when even the last sentence does not fit it", () => {
    const pages = [
      {
        pageNumber: 1,
        text: "This opening sentence is fairly long. And this second sentence is long too. Third.",
      },
    ];
    const chunks = sentence(pages, { chunkSize: 80, chunkOverlap: 20 });

    assert.deepEqual(
      chunks.map((chunk) => chunk.pageContent),
      [
        "This opening sentence is fairly long. And this second sentence is long too.",
        "Third.",
      ]
    );
  });

  test("keeps the overlap within its bound on every chunk", () => {
    const text = Array.from(
      { length: 40 },
      (_, index) => `Sentence number ${index} has ${"word ".repeat(index % 7)}content.`
    ).join(" ");
    const pages = [{ pageNumber: 1, text }];

    for (const [chunkSize, chunkOverlap] of [
      [120, 50],
      [200, 80],
      [300, 0],
    ]) {
      const chunks = sentence(pages, { chunkSize, chunkOverlap });
      const units = splitSentences(text);

      assertWithinSize(chunks, chunkSize);
      assertPagesAlignedAndCovered(pages, chunks);

      let overlappingPairs = 0;

      for (let index = 1; index < chunks.length; index += 1) {
        const previous = splitSentences(chunks[index - 1].pageContent);
        const current = splitSentences(chunks[index].pageContent);
        let shared = Math.min(previous.length - 1, current.length - 1);

        while (
          shared > 0 &&
          previous.slice(previous.length - shared).join(" ") !== current.slice(0, shared).join(" ")
        ) {
          shared -= 1;
        }

        const overlap = current.slice(0, shared).join(" ");

        assert.ok(overlap.length <= chunkOverlap, `overlap "${overlap}" exceeds ${chunkOverlap}`);
        assert.ok(current.every((entry) => units.includes(entry)), "chunks hold whole sentences");
        overlappingPairs += shared > 0 ? 1 : 0;
      }

      assert.equal(overlappingPairs > 0, chunkOverlap > 0);
    }
  });

  test("cuts only a sentence longer than the size, into pieces under the size", () => {
    const longSentence = `The longest clause ${"keeps going with words ".repeat(12)}until it ends, and then ${"another clause runs on ".repeat(10)}to the end.`;
    const pages = [
      { pageNumber: 1, text: `A short opener. ${longSentence} A short closer.` },
    ];
    const chunks = sentence(pages, { chunkSize: 200, chunkOverlap: 40 });

    assertWithinSize(chunks, 200);
    assertPagesAlignedAndCovered(pages, chunks);
    assert.ok(longSentence.length > 200);
    // The opener is a whole sentence and keeps its own chunk boundary; the long
    // sentence is never used as overlap.
    assert.equal(chunks[0].pageContent.startsWith("A short opener."), true);
    assert.ok(chunks.some((chunk) => chunk.pageContent.endsWith("A short closer.")));
  });

  test("splits a run without whitespace (a long token or CJK text) without losing characters", () => {
    // Not periodic, so the alignment check finds each piece in one place.
    let state = 7;
    const next = () => {
      state = (state * 48271) % 2147483647;
      return state;
    };
    const token = Array.from({ length: 250 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[next() % 36]).join("");
    const cjk = Array.from({ length: 270 }, () => "这是一个很长的句子中文"[next() % 11]).join("");
    const pages = [
      { pageNumber: 1, text: `Before it. ${token} After it.` },
      { pageNumber: 2, text: `${cjk}。短句。` },
    ];
    const chunks = sentence(pages, { chunkSize: 100, chunkOverlap: 20 });

    assertWithinSize(chunks, 100);
    assertPagesAlignedAndCovered(pages, chunks);
    assert.ok(chunks.filter((chunk) => chunk.metadata.pageNumber === 2).every((chunk) => !/ /.test(chunk.pageContent)));
  });

  test("joins the lines of a paragraph so a sentence broken across lines stays whole", () => {
    const pages = [
      {
        pageNumber: 1,
        text: "The concept space includes concepts from KBs such as Wikipedia,\nProbase (Wu et al., 2012), and others. A second sentence\nfollows here.",
      },
    ];
    const chunks = sentence(pages);

    assert.deepEqual(
      chunks.map((chunk) => chunk.pageContent),
      [
        "The concept space includes concepts from KBs such as Wikipedia, Probase (Wu et al., 2012), and others. A second sentence follows here.",
      ]
    );
  });

  test("never merges list items or table rows with prose", () => {
    const pages = [
      {
        pageNumber: 1,
        text: [
          "The system has three parts",
          "- a retriever that reads the index",
          "and wraps onto this line",
          "- a ranker.",
          "The ranker is fast.",
          "Results are below",
          "Model 0.81 0.79 0.80",
          "Large 0.85 0.83 0.84",
          "Both models are compared.",
          "1) first step",
          "2) second step",
        ].join("\n"),
      },
    ];
    const chunks = sentence(pages);

    assert.equal(chunks.length, 1);
    assert.deepEqual(chunks[0].pageContent.split("\n\n"), [
      "The system has three parts",
      "- a retriever that reads the index and wraps onto this line",
      "- a ranker.",
      "The ranker is fast. Results are below",
      "Model 0.81 0.79 0.80",
      "Large 0.85 0.83 0.84",
      "Both models are compared.",
      "1) first step",
      "2) second step",
    ]);
    assertPagesAlignedAndCovered(pages, chunks);
  });

  test("never ends a chunk with the bare number of the next list item", () => {
    const pages = [
      {
        pageNumber: 1,
        text: Array.from(
          { length: 30 },
          (_, index) =>
            `${index + 1}. Author ${index} wrote a paper${" again".repeat(index % 4)}. Venue ${index} proceedings.`
        ).join("\n"),
      },
    ];

    for (const chunkSize of [60, 70, 80, 90, 100]) {
      const chunks = sentence(pages, { chunkSize, chunkOverlap: 0 });

      for (const chunk of chunks) {
        assert.doesNotMatch(chunk.pageContent, /(?:^|\s)\d{1,3}\.$/u, chunk.pageContent);
        assert.doesNotMatch(chunk.pageContent, /^\d{1,3}\.(?:\s|$)(?!Author)/u, chunk.pageContent);
      }
      assertPagesAlignedAndCovered(pages, chunks);
    }
  });

  test("repeats the section heading and keeps it as sectionHeading within the size", () => {
    const body = Array.from({ length: 8 }, (_, index) => `Method sentence ${index} explains a step.`).join(" ");
    const pages = [
      { pageNumber: 1, text: `Intro text without a heading.\n2 Method\n${body}\nResults:\nIt worked.` },
    ];
    const chunks = sentence(pages, { chunkSize: 120, chunkOverlap: 40 });

    assertWithinSize(chunks, 120);
    assertPagesAlignedAndCovered(pages, chunks);
    assertContiguousChunkIds(chunks);
    assert.deepEqual(chunks[0].metadata.sectionHeading, null);
    assert.equal(chunks[0].pageContent, "Intro text without a heading.");

    const methodChunks = chunks.filter((chunk) => chunk.metadata.sectionHeading === "2 Method");

    assert.ok(methodChunks.length > 1);
    assert.ok(methodChunks.every((chunk) => chunk.pageContent.startsWith("2 Method\n\nMethod sentence")));
    assert.deepEqual(
      [chunks.at(-1).metadata.sectionHeading, chunks.at(-1).pageContent],
      ["Results:", "Results:\n\nIt worked."]
    );
  });

  test("keeps heading-like lines without body text, like the structured chunker", () => {
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
      { pageNumber: 2, text: "Body on page two.\nAPPENDIX\nTRAILING NOTES" },
    ];
    const chunks = sentence(pages);

    assertPagesAlignedAndCovered(pages, chunks);
    assert.deepEqual(
      chunks.map((chunk) => [chunk.metadata.pageNumber, chunk.metadata.sectionHeading, chunk.pageContent]),
      [
        [1, null, "Results are summarised below. Table 2: Retrieval quality"],
        [
          1,
          "ROBERTA 0.85 0.83 0.84",
          [
            "Model P R F1",
            "BERT 0.81 0.79 0.80",
            "ROBERTA 0.85 0.83 0.84",
            "The larger model wins on every metric.",
          ].join("\n\n"),
        ],
        // Heading-like lines at the end of a page join the page's last chunk
        // and never carry over to the next page.
        [2, null, "Body on page two.\n\nAPPENDIX\n\nTRAILING NOTES"],
      ]
    );
  });

  test("never lets a chunk or a heading span pages", () => {
    const pages = [
      { pageNumber: 1, text: "1 Introduction\nThe first page ends mid" },
      { pageNumber: 2, text: "sentence on the second page. More text follows." },
      { pageNumber: 3, text: "" },
      { pageNumber: 4, text: "第四页的句子。" },
    ];
    const chunks = sentence(pages);

    assertContiguousChunkIds(chunks);
    assertPagesAlignedAndCovered(pages, chunks);
    assert.deepEqual(
      chunks.map((chunk) => [chunk.metadata.pageNumber, chunk.metadata.sectionHeading, chunk.pageContent]),
      [
        [1, "1 Introduction", "1 Introduction\n\nThe first page ends mid"],
        [2, null, "sentence on the second page. More text follows."],
        [4, null, "第四页的句子。"],
      ]
    );
  });

  test("keeps the chunk metadata shape of the other strategies", () => {
    const pages = [{ pageNumber: 7, text: "1 Scope\nOne sentence." }];
    const [structuredChunk] = chunkDocumentWithConfig({
      docId: "doc-sentence",
      fileName: "sentence.pdf",
      publicFilePath: "",
      pages,
      source: { kind: "upload" },
      chunkStrategy: "structured",
      chunkSize: 900,
      chunkOverlap: 180,
    });
    const [sentenceChunk] = chunkDocumentWithConfig({
      docId: "doc-sentence",
      fileName: "sentence.pdf",
      publicFilePath: "",
      pages,
      source: { kind: "upload" },
      chunkStrategy: "sentence",
      chunkSize: 900,
      chunkOverlap: 180,
    });

    assert.deepEqual(Object.keys(sentenceChunk).sort(), Object.keys(structuredChunk).sort());
    assert.deepEqual(sentenceChunk.metadata, structuredChunk.metadata);
    assert.equal(sentenceChunk.pageContent, structuredChunk.pageContent);
  });

  describe("RAG_CHUNK_STRATEGY", () => {
    const original = process.env.RAG_CHUNK_STRATEGY;

    afterEach(() => {
      if (original === undefined) {
        delete process.env.RAG_CHUNK_STRATEGY;
      } else {
        process.env.RAG_CHUNK_STRATEGY = original;
      }
    });

    test("selects the sentence chunker only when set to sentence", () => {
      const text = `${"Paragraph one has a sentence. ".repeat(20)}\n${"Paragraph two has another one. ".repeat(20)}`;
      const input = { docId: "doc-sentence", fileName: "sentence.pdf", pages: [{ pageNumber: 1, text }] };

      process.env.RAG_CHUNK_STRATEGY = "sentence";
      const withSentences = chunkDocument(input);

      delete process.env.RAG_CHUNK_STRATEGY;
      const withDefault = chunkDocument(input);

      assert.deepEqual(
        withSentences.map((chunk) => chunk.pageContent),
        sentence(input.pages).map((chunk) => chunk.pageContent)
      );
      assert.deepEqual(
        withDefault.map((chunk) => chunk.pageContent),
        chunkDocumentWithConfig({
          ...input,
          publicFilePath: "",
          chunkStrategy: "structured",
          chunkSize: 900,
          chunkOverlap: 180,
        }).map((chunk) => chunk.pageContent)
      );
      assert.notDeepEqual(
        withSentences.map((chunk) => chunk.pageContent),
        withDefault.map((chunk) => chunk.pageContent)
      );
    });
  });
});

// A deterministic mix of everything the chunker has to handle, at several
// sizes: no chunk over the size, every character of every page in reading
// order in some chunk.
describe("sentence chunking invariants on generated pages", () => {
  let seed = 20261004;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const pick = (items) => items[Math.floor(random() * items.length)];
  const draw = (alphabet, length) =>
    Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
  // Every piece carries a running number, so that the alignment check can
  // tell repeated pieces apart.
  let counter = 0;
  const pieces = [
    (n) => `Smith et al. (2019) report gains of 3.5 points in run ${n}, e.g. on v1.1 of the data.`,
    (n) => `See Fig. ${n} and Eq. (4); the U.S. results differ from those in Sec. 3.`,
    (n) => `The model ${n}... works. Does it scale?! It does (mostly).`,
    (n) =>
      `A long clause ${Array.from({ length: Math.floor(random() * 120) }, (_, index) => `w${n}x${index}${index % 9 === 8 ? "," : ""}`).join(" ")} ends here.`,
    (n) => `tok${n}${draw("abcdefghijklmnopqrstuvwxyz0123456789", Math.floor(random() * 400))}`,
    (n) =>
      `第${n}段${Array.from({ length: 1 + Math.floor(random() * 40) }, () => `${draw("中文句子在这里第二个长短", 3 + Math.floor(random() * 30))}${pick(["。", "！", "，", "；"])}`).join("")}`,
    (n) => `- list item ${n} that wraps`,
    (n) => `onto continuation line ${n}`,
    (n) => `1) numbered item ${n}.`,
    (n) => `BERT ${n} 0.81 0.79 0.80`,
    (n) => `Model ${n}.5 13.1 14.0`,
    (n) => `${n} Method`,
    (n) => `RESULTS ${n}`,
    (n) => `Waiting period ${n}:`,
    (n) => `Some Long Heading Number ${n} Like This One Here And There`,
    (n) => `Table ${n}: Scores on the test set.`,
    (n) => `wi${n} =`,
  ];
  const makePage = (pageNumber) => {
    const count = 1 + Math.floor(random() * 30);
    let text = "";

    for (let index = 0; index < count; index += 1) {
      counter += 1;
      text += (index > 0 ? pick(["\n", "\n", "\n\n", " "]) : "") + pick(pieces)(counter);
    }

    return { pageNumber, text };
  };
  const pages = Array.from({ length: 40 }, (_, index) => makePage(index + 1));

  for (const [chunkSize, chunkOverlap] of [
    [60, 15],
    [120, 30],
    [300, 60],
    [900, 180],
    [900, 0],
  ]) {
    test(`size ${chunkSize}, overlap ${chunkOverlap}`, () => {
      const chunks = sentence(pages, { chunkSize, chunkOverlap });

      assertWithinSize(chunks, chunkSize);
      assertContiguousChunkIds(chunks);
      assertPagesAlignedAndCovered(pages, chunks);
      assert.ok(chunks.every((chunk) => chunkBody(chunk).trim().length > 0));
    });
  }
});
