// probe-output-limit.mjs
//
// Whether the chat endpoint honours the output limit the document answer
// calls send (RAG_ANSWER_MAX_TOKENS).
//
// What it sends: one request through the app's own chat client
// (createChatClient), with the answer calls' model, key, field
// (RAG_LLM_MAX_TOKENS_FIELD) and request timeout, to one endpoint:
// OPENAI_BASE_URL, else OPENAI_API_BASE, else https://api.openai.com/v1. The
// request is PROBE_PROMPT with a limit of 8 tokens and no temperature (the
// endpoint's default), so an honoured limit stops it for length within 8
// tokens. Ollama 0.34.4 honours max_tokens and ignores max_completion_tokens,
// so with the second field this fails against it, as it should: the answer
// calls would run with no limit there. For a model gateway, run it with the
// gateway's settings; when MODEL_GATEWAY_CHAT_UPSTREAMS lists replicas, run it
// once per replica with OPENAI_BASE_URL set to that replica (the probe does
// not read the list).
//
// Where it runs: the real-model CI runs it before its answer sample. If the
// pinned Ollama ignores the field, the job fails there once the probe's own
// reply, which nothing limits then, has ended: 723 tokens on 0.34.4 here, so
// on the CPU runner probably a minute or two plus a model load (not
// measured), and one request timeout at most. Without it, each attempt of a
// runaway answer would run to the request timeout before the answer step
// failed. Run it before trusting the limit on another endpoint, model or
// server version.
//
// Exit codes:
//   0  honoured: the reply stopped for length, and the endpoint reported at
//      most the limit's tokens.
//   1  not honoured: the endpoint reported more tokens than the limit, whether
//      the reply finished on its own or was cut at a longer limit of the
//      endpoint's own.
//   2  no verdict: a bad argument or setting (nothing is sent), a request the
//      model-call guard refused or that failed, a reply that finished on its
//      own within the limit, or a reply without a token count.
//
// Output: the verdict, the finish reason, the token count, the limit, the
// field, the model and the endpoint's host. A failed request adds the
// endpoint's HTTP status and its error message (with the key and the base
// URL's credentials removed, cut at 300 characters). An error raised before
// any answer prints only its name and code, because fetch quotes the
// Authorization value or the whole URL in some of its messages, and the
// guard's messages hold the URL. Never the reply, never the key.
//
// Usage: node evaluation/probe-output-limit.mjs [--max-tokens 8] [--json]
//        npm run probe:output-limit [-- [--max-tokens 8] [--json]]

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getChatModel, getLlmMaxTokensField, LLM_MAX_TOKENS_FIELDS } from "../rag/config.js";
import { CIRCUIT_OPEN_CODE, MODEL_CALL_QUEUE_FULL_CODE } from "../rag/model-call-guard.js";
import { createChatClient, resolveBaseUrl } from "../rag/openai-client.js";
import { readOptionValue, toPositiveInteger } from "./eval-cli.js";

// Asks for a few hundred tokens, so a reply that finishes on its own within a
// limit of 8 would be a surprise.
export const PROBE_PROMPT = "Count from 1 to 200, one number per line.";
export const DEFAULT_PROBE_MAX_TOKENS = 8;
export const PROBE_EXIT_CODES = Object.freeze({ honoured: 0, not_honoured: 1, no_verdict: 2 });

const MAX_ERROR_CHARS = 300;
// Shorter "secrets" (an empty key, a one-letter user name) are not worth
// garbling an error message for.
const MIN_REDACTED_CHARS = 4;
const GUARD_REFUSAL_CODES = new Set([CIRCUIT_OPEN_CODE, MODEL_CALL_QUEUE_FULL_CODE]);
const USAGE = "usage: probe-output-limit.mjs [--max-tokens 8] [--json]";

// The verdict on one reply. Only the endpoint's own token count shows that
// this limit applied: "length" past the limit means a longer limit of the
// endpoint's own, and "length" without a count could be either.
export const judgeOutputLimitProbe = ({ finishReason, completionTokens, maxTokens }) => {
  const tokens = Number.isFinite(completionTokens) ? completionTokens : null;

  if (tokens === null) {
    return {
      verdict: "no_verdict",
      reason: finishReason === "length" ? "stopped_for_length_without_token_count" : "finished_without_token_count",
    };
  }

  if (tokens > maxTokens) {
    return {
      verdict: "not_honoured",
      reason: finishReason === "length" ? "stopped_at_another_limit" : "finished_past_limit",
    };
  }

  return finishReason === "length"
    ? { verdict: "honoured", reason: "stopped_for_length" }
    : { verdict: "no_verdict", reason: "finished_within_limit" };
};

const decodeComponent = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

// The host is what gets printed; the user name and password are only kept to
// be removed from error messages.
const describeEndpoint = (baseUrl) => {
  try {
    const url = new URL(baseUrl);

    return {
      host: url.host,
      credentials: [url.username, url.password].filter(Boolean).flatMap((part) => [part, decodeComponent(part)]),
    };
  } catch {
    return { host: "(not a URL)", credentials: [] };
  }
};

// Reads every setting before any request, so a wrong one refuses the probe
// instead of failing it halfway. The key and the credentials stay apart from
// what is printed.
export const readOutputLimitProbeSettings = ({ maxTokens = DEFAULT_PROBE_MAX_TOKENS } = {}) => {
  // The client sends a limit only when it is a safe positive integer and drops
  // any other value without a word, so a larger one would probe nothing.
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw new Error(`--max-tokens must be a positive whole number no larger than ${Number.MAX_SAFE_INTEGER}.`);
  }

  const field = getLlmMaxTokensField();
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set (Ollama accepts any value).");
  }

  const endpoint = describeEndpoint(resolveBaseUrl());

  return {
    apiKey,
    secrets: [apiKey, ...endpoint.credentials],
    probe: {
      maxTokens,
      field,
      model: getChatModel(),
      endpointHost: endpoint.host,
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

const truncate = (text) => (text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text);

const redact = (text, secrets) =>
  secrets
    .filter((secret) => typeof secret === "string" && secret.length >= MIN_REDACTED_CHARS)
    .reduce((current, secret) => current.split(secret).join("[redacted]"), text);

// A failed request. An answer from the endpoint (error.upstreamStatus, set by
// the client on an HTTP error) keeps its status and message, secrets removed
// first and then cut. Anything raised before an answer gives only its name and
// code: fetch building or sending the request, the timeout, or the model-call
// guard. Some of those messages quote the Authorization value or the whole
// URL, and the guard's hold its key (the URL and the model).
export const describeProbeRequestError = (error, secrets = []) => {
  if (Number.isInteger(error?.upstreamStatus)) {
    return {
      reason: "request_failed",
      status: error.upstreamStatus,
      code: null,
      error: truncate(redact(String(error?.message ?? ""), secrets)),
    };
  }

  const code = error?.code ?? error?.cause?.code ?? null;

  return {
    reason: GUARD_REFUSAL_CODES.has(code) ? "refused_by_guard" : "request_failed",
    status: null,
    code: code === null ? null : String(code),
    error: [error?.name ?? "Error", code].filter(Boolean).join(" "),
  };
};

const describeTokens = (tokens) =>
  tokens === null ? "an unreported number of tokens" : `${tokens} token${tokens === 1 ? "" : "s"}`;

const describeProbe = ({ maxTokens, field, model, endpointHost }) =>
  `limit ${maxTokens} in ${field}, model ${model}, endpoint ${endpointHost}`;

export const formatOutputLimitProbe = (result) => {
  const tokens = describeTokens(result.completionTokens ?? null);
  const finished = JSON.stringify(result.finishReason ?? null);

  switch (result.reason) {
    case "stopped_for_length":
      return `Output limit honoured: the reply stopped for length after ${tokens} (${describeProbe(result)}).`;
    case "finished_past_limit":
      return [
        `Output limit NOT honoured: the reply finished on its own (${finished}) after ${tokens}, past the limit (${describeProbe(result)}).`,
        `Answer calls would run without a limit here; the endpoint may read the other field (RAG_LLM_MAX_TOKENS_FIELD: ${LLM_MAX_TOKENS_FIELDS.join(" or ")}).`,
      ].join(" ");
    case "stopped_at_another_limit":
      return `Output limit NOT honoured: the reply stopped for length after ${tokens}, past the limit, so at a limit of the endpoint's own (${describeProbe(result)}).`;
    case "finished_within_limit":
      return `No verdict: the reply finished on its own (${finished}) after ${tokens}, within the limit, so it says nothing about the limit (${describeProbe(result)}).`;
    case "stopped_for_length_without_token_count":
      return `No verdict: the reply stopped for length, but the endpoint reported no token count, so the stop may have been a limit of its own (${describeProbe(result)}).`;
    case "finished_without_token_count":
      return `No verdict: the reply finished on its own (${finished}) and the endpoint reported no token count (${describeProbe(result)}).`;
    case "refused_by_guard":
      return `No verdict: the model-call guard refused the request (${result.code}); nothing was sent (${describeProbe(result)}).`;
    case "request_failed":
      return result.status === null
        ? `No verdict: the request failed before the endpoint answered (${result.error}); check that the endpoint is reachable and that OPENAI_BASE_URL and OPENAI_API_KEY are well formed (${describeProbe(result)}).`
        : `No verdict: the endpoint answered HTTP ${result.status}: ${result.error} (${describeProbe(result)}).`;
    default:
      return `No verdict: ${result.error}`;
  }
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
    result = { verdict: "no_verdict", reason: "invalid_setting", error: truncate(String(error?.message ?? error)) };
  }

  if (!result) {
    try {
      result = await runOutputLimitProbe(settings);
    } catch (error) {
      result = { verdict: "no_verdict", ...describeProbeRequestError(error, settings.secrets), ...settings.probe };
    }
  }

  return {
    exitCode: PROBE_EXIT_CODES[result.verdict],
    output: json ? `${JSON.stringify(result, null, 2)}\n` : `${formatOutputLimitProbe(result)}\n`,
    result,
  };
};

// Real paths on both sides, so a run through a symlink is still a run: Node
// resolves the main module's URL but not process.argv[1], and a silent non-run
// would exit 0, which here means "honoured".
const isRunAsCommand = () => {
  if (!process.argv[1]) {
    return false;
  }

  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isRunAsCommand()) {
  // Like the other evaluation commands: server/.env, or DOTENV_CONFIG_PATH.
  await import("dotenv/config");

  const { exitCode, output } = await runOutputLimitProbeCli(process.argv.slice(2));

  // Exit once the output is written. Under RAG_SHARED_STATE=redis the
  // model-call guard's Redis client would otherwise keep the process alive
  // after the verdict.
  process.stdout.write(output, () => process.exit(exitCode));
}
