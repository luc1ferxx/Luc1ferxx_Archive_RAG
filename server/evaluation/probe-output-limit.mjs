// probe-output-limit.mjs
//
// Whether the chat endpoint honours the output limit the document answer
// calls send (RAG_ANSWER_MAX_TOKENS). It makes one request through the app's
// own chat client (createChatClient), so it uses the same OPENAI_BASE_URL,
// OPENAI_CHAT_MODEL and OPENAI_API_KEY, the field RAG_LLM_MAX_TOKENS_FIELD
// names, and the request timeout. The request asks for a reply far longer
// than a limit of 8 tokens. The limit is honoured when the reply stops for
// length (finish_reason "length") within it. Ollama 0.34.4 honours max_tokens
// and ignores max_completion_tokens. So with max_completion_tokens this probe
// fails against Ollama, as it should: the answer calls would run with no limit
// there.
//
// The real-model CI runs it before its answer sample. If an Ollama version
// stops honouring the field, the job then fails in seconds, before a greedy
// reply can run to the request timeout. Run it before trusting the limit on
// another endpoint, model or server version. It calls the endpoint directly,
// as the monolith and the model gateway do; in a split deployment, run it with
// the gateway's settings.
//
// It prints only the finish reason, the token count, the field, the model and
// the endpoint's host, never the reply.
//
// Exit codes:
//   0  honoured.
//   1  not honoured: the reply went past the limit, whether it finished on its
//      own or stopped at a longer limit of the endpoint's own.
//   2  no verdict: a bad argument or setting, a failed request, or a reply
//      that ended on its own within the limit or without a token count.
//
// Usage: node evaluation/probe-output-limit.mjs [--max-tokens 8] [--json]

import { pathToFileURL } from "node:url";
import { getChatModel, getLlmMaxTokensField, LLM_MAX_TOKENS_FIELDS } from "../rag/config.js";
import { createChatClient, resolveBaseUrl } from "../rag/openai-client.js";
import { readOptionValue, toPositiveInteger } from "./eval-cli.js";

// Asks for a few hundred tokens, so a reply that finishes on its own within a
// limit of 8 would be a surprise.
export const PROBE_PROMPT = "Count from 1 to 200, one number per line.";
export const DEFAULT_PROBE_MAX_TOKENS = 8;
export const PROBE_EXIT_CODES = Object.freeze({ honoured: 0, not_honoured: 1, no_verdict: 2 });

const MAX_ERROR_CHARS = 300;
const USAGE = "usage: probe-output-limit.mjs [--max-tokens 8] [--json]";

// The verdict on one reply. A reply past the limit is not honoured, whatever it
// stopped for: "length" there means a longer limit of the endpoint's own.
export const judgeOutputLimitProbe = ({ finishReason, completionTokens, maxTokens }) => {
  const tokens = Number.isFinite(completionTokens) ? completionTokens : null;

  if (tokens !== null && tokens > maxTokens) {
    return {
      verdict: "not_honoured",
      reason: finishReason === "length" ? "stopped_at_another_limit" : "finished_past_limit",
    };
  }

  if (finishReason === "length") {
    return {
      verdict: "honoured",
      reason: tokens === null ? "stopped_for_length_without_token_count" : "stopped_for_length",
    };
  }

  return {
    verdict: "no_verdict",
    reason: tokens === null ? "finished_without_token_count" : "finished_within_limit",
  };
};

const describeEndpointHost = (baseUrl) => {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "(not a URL)";
  }
};

// Reads every setting before any request, so a wrong one refuses the probe
// instead of failing it halfway. The key stays apart from what is printed.
export const readOutputLimitProbeSettings = ({ maxTokens = DEFAULT_PROBE_MAX_TOKENS } = {}) => {
  const field = getLlmMaxTokensField();
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set (Ollama accepts any value).");
  }

  return {
    apiKey,
    probe: {
      maxTokens,
      field,
      model: getChatModel(),
      endpointHost: describeEndpointHost(resolveBaseUrl()),
    },
  };
};

export const runOutputLimitProbe = async ({ apiKey, probe }) => {
  const reply = await createChatClient({ apiKey, model: probe.model }).invoke(PROBE_PROMPT, {
    maxTokens: probe.maxTokens,
  });
  const finishReason = reply.finishReason ?? null;
  const completionTokens = Number.isFinite(reply.usage?.completion_tokens) ? reply.usage.completion_tokens : null;

  return {
    ...judgeOutputLimitProbe({ finishReason, completionTokens, maxTokens: probe.maxTokens }),
    finishReason,
    completionTokens,
    ...probe,
  };
};

const describeTokens = (tokens) =>
  tokens === null ? "an unreported number of tokens" : `${tokens} token${tokens === 1 ? "" : "s"}`;

const describeProbe = ({ maxTokens, field, model, endpointHost }) =>
  `limit ${maxTokens} sent as ${field}, model ${model}, endpoint ${endpointHost}`;

export const formatOutputLimitProbe = (result) => {
  const tokens = describeTokens(result.completionTokens ?? null);
  const finished = JSON.stringify(result.finishReason ?? null);

  switch (result.reason) {
    case "stopped_for_length":
      return `Output limit honoured: the reply stopped for length after ${tokens} (${describeProbe(result)}).`;
    case "stopped_for_length_without_token_count":
      return `Output limit honoured: the reply stopped for length; the endpoint reported no token count (${describeProbe(result)}).`;
    case "finished_past_limit":
      return [
        `Output limit NOT honoured: the reply finished on its own (${finished}) after ${tokens}, past the limit (${describeProbe(result)}).`,
        `Answer calls would run without a limit here; the endpoint may read the other field (RAG_LLM_MAX_TOKENS_FIELD: ${LLM_MAX_TOKENS_FIELDS.join(" or ")}).`,
      ].join(" ");
    case "stopped_at_another_limit":
      return `Output limit NOT honoured: the reply stopped for length after ${tokens}, past the limit, so at a limit of the endpoint's own (${describeProbe(result)}).`;
    case "finished_within_limit":
      return `No verdict: the reply finished on its own (${finished}) after ${tokens}, within the limit, so it says nothing about the limit (${describeProbe(result)}).`;
    case "finished_without_token_count":
      return `No verdict: the reply finished on its own (${finished}) and the endpoint reported no token count (${describeProbe(result)}).`;
    case "request_failed":
      return `No verdict: the request failed${result.status ? ` with HTTP ${result.status}` : ""}: ${result.error} (${describeProbe(result)}).`;
    default:
      return `No verdict: ${result.error}`;
  }
};

const truncateError = (error) => {
  const message = String(error?.message ?? error);

  return message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS)}…` : message;
};

const parseProbeArguments = (argv) => {
  let json = false;
  let maxTokens = DEFAULT_PROBE_MAX_TOKENS;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--json") {
      json = true;
    } else if (arg === "--max-tokens" || arg.startsWith("--max-tokens=")) {
      const option = readOptionValue({ arg, args: argv, index, option: "--max-tokens" });

      maxTokens = toPositiveInteger(option.value, DEFAULT_PROBE_MAX_TOKENS, "--max-tokens");
      index = option.nextIndex;
    } else {
      throw new Error(`Unknown argument ${JSON.stringify(arg)}; ${USAGE}`);
    }
  }

  return { json, maxTokens };
};

// The whole command, without touching process state: returns the exit code
// and the text to print. A bad argument or setting sends no request.
export const runOutputLimitProbeCli = async (argv = []) => {
  let json = argv.includes("--json");
  let settings;
  let result;

  try {
    const options = parseProbeArguments(argv);

    json = options.json;
    settings = readOutputLimitProbeSettings({ maxTokens: options.maxTokens });
  } catch (error) {
    result = { verdict: "no_verdict", reason: "invalid_setting", error: truncateError(error) };
  }

  if (!result) {
    try {
      result = await runOutputLimitProbe(settings);
    } catch (error) {
      result = {
        verdict: "no_verdict",
        reason: "request_failed",
        status: error?.status ?? null,
        error: truncateError(error),
        ...settings.probe,
      };
    }
  }

  return {
    exitCode: PROBE_EXIT_CODES[result.verdict],
    output: json ? `${JSON.stringify(result, null, 2)}\n` : `${formatOutputLimitProbe(result)}\n`,
    result,
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Like the other evaluation commands: server/.env, or DOTENV_CONFIG_PATH.
  await import("dotenv/config");

  const { exitCode, output } = await runOutputLimitProbeCli(process.argv.slice(2));

  process.stdout.write(output);
  process.exitCode = exitCode;
}
