import { AsyncLocalStorage } from "node:async_hooks";
import {
  AGENT_EVENT_TYPES,
  emitAgentEvent,
  hasAgentEventSink,
} from "./agent-event-stream.js";
import {
  formatSupportedClaim,
  normalizeGroundedClaimSupportForHeadings,
} from "./grounded-answer-finalizer.js";
import { evaluateClaimSupport } from "./self-check/evaluate.js";
import { normalizeGroupedSourceLabels } from "./self-check/text.js";

// Verified answer drafts for a streaming /chat request.
//
// The model's answer is streamed token by token, but tokens never leave the
// server. Each time a sentence completes, the answer so far goes through the
// same claim check the finalizer uses (evaluateClaimSupport plus its heading
// normalization); a sentence that check supports is sent as an answer_draft
// event, and one it does not support is held back. Checking the growing
// prefix, not the sentence alone, gives each sentence the headings and
// sections before it, as the final check will.
//
// A draft is provisional. The finalizer runs on the whole answer and may
// rebuild it, and the document loop may replace the answer with a follow-up
// one; the result event is the only authoritative answer, and clients replace
// the drafts with it. What a draft guarantees is narrower: it was never
// unverified text. The streaming eval measures how often drafts survive.
//
// Drafts are sent only inside a channel the agent opens around the answer the
// user is waiting for, and only when a streaming client is attached, so /chat,
// background tasks, evals, and the model calls Skills make are unchanged.

const channelStorage = new AsyncLocalStorage();

export const runWithAnswerDraftChannel = (action) =>
  hasAgentEventSink()
    ? channelStorage.run({ releasedCount: 0 }, action)
    : action();

// Latin sentence ends need following whitespace, so "12.5" is not split while
// "12." is still streaming; CJK sentence ends and line breaks stand alone.
const SENTENCE_END_PATTERN = /[.!?](?=\s)|[。！？]|\n/g;
const TRAILING_LABELS_PATTERN = /^(?:[ \t]*\[[^\]\n]*\])*/;

/**
 * The longest prefix made of finished sentences. Models put the citation
 * after the full stop ("... 12 months. [Source 1]"), so a sentence is finished
 * only once its trailing labels have arrived and something after them -- a
 * line break or the next sentence -- shows nothing more belongs to it.
 * Checked any earlier, it would be judged without its citation and held back.
 */
export const findCompletePrefix = (text) => {
  let complete = 0;

  for (const match of text.matchAll(SENTENCE_END_PATTERN)) {
    const end = match.index + match[0].length;

    if (match[0] === "\n") {
      complete = end;
      continue;
    }

    const labels = text.slice(end).match(TRAILING_LABELS_PATTERN)[0];
    const next = text.slice(end + labels.length).match(/^[ \t]*([^ \t])/);

    // An opening bracket may be a label still streaming in.
    if (next && next[1] !== "[") {
      complete = end + labels.length;
    }
  }

  return text.slice(0, complete);
};

/**
 * Returns completion options that stream verified drafts for one answer, or
 * null outside a draft channel. `finish(text)` checks the last sentence, which
 * may end without punctuation, against the answer the model returned.
 */
export const createAnswerDraftReleaser = ({ citations = [] } = {}) => {
  const channel = channelStorage.getStore();

  if (!channel || citations.length === 0) {
    return null;
  }

  let buffer = "";
  let checkedPrefixLength = 0;
  let decidedClaimCount = 0;

  const release = (answerText) => {
    try {
      const claimSupport = normalizeGroundedClaimSupportForHeadings(
        evaluateClaimSupport({
          answerText: normalizeGroupedSourceLabels(answerText),
          citations,
        })
      );

      if (!claimSupport.checked) {
        return;
      }

      for (const claim of claimSupport.claims.slice(decidedClaimCount)) {
        const text = claim.supported && !claim.heading
          ? formatSupportedClaim({ claim, citations })
          : "";

        if (text) {
          emitAgentEvent({
            draft: { index: channel.releasedCount, text },
            type: AGENT_EVENT_TYPES.answerDraft,
          });
          channel.releasedCount += 1;
        }
      }

      decidedClaimCount = Math.max(decidedClaimCount, claimSupport.claims.length);
    } catch {
      // A draft is a courtesy; it must never fail the answer it previews.
    }
  };

  return {
    completionOptions: {
      // A retry or failover model starts over, and so does the answer: drop
      // every draft this channel sent, including an earlier answer's.
      onAttemptStart: () => {
        buffer = "";
        checkedPrefixLength = 0;
        decidedClaimCount = 0;

        if (channel.releasedCount > 0) {
          channel.releasedCount = 0;
          emitAgentEvent({ type: AGENT_EVENT_TYPES.answerDraftReset });
        }
      },
      onTextDelta: (delta) => {
        buffer += delta;
        const prefix = findCompletePrefix(buffer);

        if (prefix.length > checkedPrefixLength) {
          checkedPrefixLength = prefix.length;
          release(prefix);
        }
      },
    },
    finish: (text) => release(String(text ?? "")),
  };
};
