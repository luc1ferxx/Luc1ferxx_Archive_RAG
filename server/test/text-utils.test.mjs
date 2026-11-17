import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSearchText, normalizeToken, tokenize } from "../rag/text-utils.js";

test("tokenize keeps ASCII and Chinese tokens as they were", () => {
  assert.deepEqual(tokenize("What's the GPT-4 notice period (30 days)?"), [
    "what", "s", "the", "gpt", "4", "notice", "period", "30", "days",
  ]);
  assert.deepEqual(tokenize("合同解除需提前30天书面通知。"), [
    "合", "同", "解", "除", "需", "提", "前", "30", "天", "书", "面", "通", "知",
  ]);
  assert.deepEqual(tokenize("AI模型v2版本，2024年发布"), ["ai", "模", "型", "v2", "版", "本", "2024", "年", "发", "布"]);
  assert.equal(normalizeSearchText("  Notice: 30 days; 合同（解除）!  "), "notice 30 days 合同 解除");
  assert.equal(normalizeToken("(GPT-4)"), "gpt-4");
});

test("tokenize reads Korean, Cyrillic and accented Latin as whole words", () => {
  assert.deepEqual(tokenize("계약 해지 통지 기간은?"), ["계약", "해지", "통지", "기간은"]);
  assert.deepEqual(tokenize("Срок уведомления — 30 дней"), ["срок", "уведомления", "30", "дней"]);
  assert.deepEqual(tokenize("Kündigungsfrist für Mieter"), ["kündigungsfrist", "für", "mieter"]);
  assert.equal(normalizeSearchText("Préavis de résiliation — Срок!"), "préavis de résiliation срок");
  assert.equal(normalizeToken("«Договор»,"), "договор");
});
