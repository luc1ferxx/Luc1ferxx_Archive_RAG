#!/usr/bin/env node

import http from "node:http";
import {
  buildTermSet,
  extractAnchorGroups,
  extractMeaningfulTokens,
  normalizeSearchText,
} from "../rag/text-utils.js";

const host = process.env.RAG_CROSS_ENCODER_HOST || "127.0.0.1";
const port = Number(process.env.RAG_CROSS_ENCODER_PORT || 8080);
const modelName = process.env.RAG_CROSS_ENCODER_MODEL || "local-protocol-scorer";

const clamp01 = (value) => Math.max(0, Math.min(1, value));

const uniqueValues = (values) => [
  ...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean)),
];

const countTermOverlap = (queryTerms, termSet) => {
  if (queryTerms.length === 0) {
    return 0;
  }

  return queryTerms.filter((term) => termSet.has(term)).length / queryTerms.length;
};

const buildSignals = (query) => {
  const queryTerms = uniqueValues(extractMeaningfulTokens(query));
  const anchors = extractAnchorGroups(query);
  const normalizedQuery = normalizeSearchText(query);
  const meaningfulPhrase = queryTerms.join(" ");

  return {
    queryTerms,
    anchors,
    phrases: uniqueValues([
      ...anchors.map((anchor) => anchor.normalizedValue),
      meaningfulPhrase.split(" ").length >= 2 ? meaningfulPhrase : "",
      normalizedQuery.split(" ").length >= 2 ? normalizedQuery : "",
    ]),
  };
};

const scoreText = ({ text, signals }) => {
  const normalizedText = normalizeSearchText(text);
  const termSet = buildTermSet(text);
  const overlapScore = countTermOverlap(signals.queryTerms, termSet);
  const phraseScore = signals.phrases.some((phrase) => normalizedText.includes(phrase))
    ? 1
    : 0;
  const anchorScore = signals.anchors.length === 0
    ? 0
    : signals.anchors.filter((anchor) =>
        normalizedText.includes(anchor.normalizedValue) ||
          anchor.terms.every((term) => termSet.has(term))
      ).length / signals.anchors.length;
  const rareTermBonus = signals.queryTerms
    .filter((term) => term.length >= 6 && termSet.has(term))
    .length / Math.max(1, signals.queryTerms.length);

  return clamp01(
    overlapScore * 0.45 +
      phraseScore * 0.25 +
      anchorScore * 0.2 +
      rareTermBonus * 0.1
  );
};

const readJsonBody = (request) =>
  new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk.toString();

      if (body.length > 20_000_000) {
        request.destroy();
        reject(new Error("Request body is too large."));
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });

const sendJson = (response, statusCode, payload) => {
  response.writeHead(statusCode, {
    "content-type": "application/json",
  });
  response.end(`${JSON.stringify(payload)}\n`);
};

const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    sendJson(response, 200, {
      ok: true,
      model: modelName,
      provider: "local-protocol-scorer",
    });
    return;
  }

  if (request.method !== "POST" || request.url !== "/rerank") {
    sendJson(response, 404, {
      error: "not_found",
    });
    return;
  }

  try {
    const payload = await readJsonBody(request);
    const query = String(payload.query ?? "");
    const texts = Array.isArray(payload.texts) ? payload.texts.map(String) : [];

    if (!query.trim()) {
      sendJson(response, 400, {
        error: "query is required",
      });
      return;
    }

    const signals = buildSignals(query);
    sendJson(response, 200, {
      model: payload.model ?? modelName,
      scores: texts.map((text) =>
        scoreText({
          text,
          signals,
        })
      ),
    });
  } catch (error) {
    sendJson(response, 400, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(port, host, () => {
  console.log(`Local cross-encoder-compatible scorer listening at http://${host}:${port}/rerank`);
});
