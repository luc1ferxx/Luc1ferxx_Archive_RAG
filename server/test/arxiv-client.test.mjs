import test from "node:test";
import assert from "node:assert/strict";
import {
  buildArxivSearchUrl,
  createArxivService,
  normalizeArxivMaxResults,
  parseArxivFeed,
} from "../rag/arxiv-client.js";

const sampleFeed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/2401.00001v2</id>
    <updated>2024-01-03T00:00:00Z</updated>
    <published>2024-01-01T00:00:00Z</published>
    <title>Retrieval Augmented Generation for Archives</title>
    <summary>
      A paper about retrieval augmented generation.
    </summary>
    <author><name>Alice Author</name></author>
    <author><name>Bob Author</name></author>
    <link href="http://arxiv.org/abs/2401.00001v2" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/2401.00001v2" rel="related" type="application/pdf"/>
    <arxiv:primary_category term="cs.IR" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.IR" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
</feed>`;

test("arxiv client parses Atom feed entries", () => {
  const papers = parseArxivFeed(sampleFeed);

  assert.equal(papers.length, 1);
  assert.equal(papers[0].arxivId, "2401.00001v2");
  assert.equal(papers[0].title, "Retrieval Augmented Generation for Archives");
  assert.deepEqual(papers[0].authors, ["Alice Author", "Bob Author"]);
  assert.equal(papers[0].primaryCategory, "cs.IR");
  assert.deepEqual(papers[0].categories, ["cs.IR", "cs.CL"]);
  assert.equal(papers[0].pdfUrl, "http://arxiv.org/pdf/2401.00001v2");
});

test("arxiv client builds bounded search URLs", () => {
  const url = buildArxivSearchUrl({
    apiUrl: "https://example.test/query",
    maxResults: 50,
    topic: "retrieval augmented generation",
  });

  assert.equal(url.origin, "https://example.test");
  assert.equal(url.searchParams.get("max_results"), "10");
  assert.equal(
    url.searchParams.get("search_query"),
    "all:retrieval AND all:augmented AND all:generation"
  );
  assert.equal(normalizeArxivMaxResults("0"), 3);
});

test("arxiv service searches and validates PDF downloads", async () => {
  const requests = [];
  const service = createArxivService({
    apiUrl: "https://example.test/query",
    fetchImpl: async (url) => {
      requests.push(String(url));

      if (String(url).includes("/pdf/")) {
        const pdfBuffer = Buffer.from("%PDF-1.7 fake");

        return {
          ok: true,
          arrayBuffer: async () =>
            pdfBuffer.buffer.slice(
              pdfBuffer.byteOffset,
              pdfBuffer.byteOffset + pdfBuffer.byteLength
            ),
        };
      }

      return {
        ok: true,
        text: async () => sampleFeed,
      };
    },
  });

  const papers = await service.search({
    topic: "RAG",
    maxResults: 1,
  });
  const buffer = await service.downloadPdf(papers[0]);

  assert.equal(papers[0].title, "Retrieval Augmented Generation for Archives");
  assert.equal(Buffer.from(buffer).subarray(0, 5).toString("utf8"), "%PDF-");
  assert.equal(requests.length, 2);
});

test("arxiv service passes AbortSignal.timeout to fetchImpl for search", async () => {
  const capturedOptions = [];
  const service = createArxivService({
    apiUrl: "https://example.test/query",
    requestTimeoutMs: 5_000,
    fetchImpl: async (_url, options) => {
      capturedOptions.push(options);

      return {
        ok: true,
        text: async () => sampleFeed,
      };
    },
  });

  await service.search({ topic: "RAG" });

  assert.equal(capturedOptions.length, 1);
  assert.ok(capturedOptions[0].signal, "signal must be passed to fetch");
  assert.ok(
    capturedOptions[0].signal instanceof AbortSignal,
    "signal must be an AbortSignal"
  );
});

test("arxiv service passes AbortSignal.timeout to fetchImpl for downloadPdf", async () => {
  const capturedOptions = [];
  const service = createArxivService({
    requestTimeoutMs: 10_000,
    fetchImpl: async (_url, options) => {
      capturedOptions.push(options);
      const pdfBuffer = Buffer.from("%PDF-1.7 fake");

      return {
        ok: true,
        arrayBuffer: async () =>
          pdfBuffer.buffer.slice(
            pdfBuffer.byteOffset,
            pdfBuffer.byteOffset + pdfBuffer.byteLength
          ),
      };
    },
  });

  await service.downloadPdf({ pdfUrl: "https://arxiv.org/pdf/2401.00001v2", arxivId: "2401.00001v2" });

  assert.equal(capturedOptions.length, 1);
  assert.ok(capturedOptions[0].signal, "signal must be passed to fetch");
  assert.ok(
    capturedOptions[0].signal instanceof AbortSignal,
    "signal must be an AbortSignal"
  );
});

test("arxiv service wraps TimeoutError as 504 for search", async () => {
  const service = createArxivService({
    apiUrl: "https://example.test/query",
    requestTimeoutMs: 2_000,
    fetchImpl: async () => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    },
  });

  await assert.rejects(
    service.search({ topic: "RAG" }),
    (error) => {
      assert.equal(error.status, 504);
      assert.match(error.message, /arXiv search timed out after 2000ms/);
      return true;
    }
  );
});

test("arxiv service wraps AbortError as 504 for downloadPdf", async () => {
  const service = createArxivService({
    requestTimeoutMs: 7_000,
    fetchImpl: async () => {
      const err = new DOMException("signal is aborted", "AbortError");
      throw err;
    },
  });

  await assert.rejects(
    service.downloadPdf({ pdfUrl: "https://arxiv.org/pdf/2401.00001v2", arxivId: "2401.00001v2" }),
    (error) => {
      assert.equal(error.status, 504);
      assert.match(error.message, /arXiv downloadPdf timed out after 7000ms/);
      return true;
    }
  );
});
