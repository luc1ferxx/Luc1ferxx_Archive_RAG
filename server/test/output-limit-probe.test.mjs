import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resetModelCallGuards } from "../rag/model-call-guard.js";
import {
  judgeOutputLimitProbe,
  PROBE_EXIT_CODES,
  PROBE_PROMPT,
  runOutputLimitProbeCli,
} from "../evaluation/probe-output-limit.mjs";

// evaluation/probe-output-limit.mjs (npm run probe:output-limit) is what the
// real-model CI runs before its answer sample: the answer step's output limit
// holds only if the endpoint honours the field it travels in, and Ollama
// ignores max_completion_tokens. These tests pin the verdicts, the request it
// sends (the app's own chat client, so the answer calls' field and endpoint),
// that nothing is sent on a bad argument or setting, how failures are told
// apart, and that neither the reply nor a secret is ever printed.

const serverDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const probeScript = path.join(serverDirectory, "evaluation", "probe-output-limit.mjs");

const ENVIRONMENT_KEYS = [
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",
  "OPENAI_API_KEY",
  "OPENAI_CHAT_MODEL",
  "RAG_LLM_MAX_TOKENS_FIELD",
  "RAG_LLM_REQUEST_TIMEOUT_MS",
  "RAG_LLM_CIRCUIT_FAILURE_THRESHOLD",
];
const REPLY_SENTINEL = "SENTINEL-REPLY-TEXT";
const API_KEY = "probe-test-key";

let originalFetch = null;
let originalEnvironment = null;
let requests = [];
let endpointCounter = 0;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalEnvironment = Object.fromEntries(ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]));

  for (const key of ENVIRONMENT_KEYS) {
    delete process.env[key];
  }

  requests = [];
  resetModelCallGuards();
});

afterEach(() => {
  globalThis.fetch = originalFetch;

  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  resetModelCallGuards();
});

// A fresh host per call, so no model-call guard state carries over, and only
// the given settings. The trailing slash is the client's to trim.
const useEndpoint = (environment = {}) => {
  for (const key of ENVIRONMENT_KEYS) {
    delete process.env[key];
  }

  endpointCounter += 1;
  const host = `probe-${endpointCounter}.test`;

  process.env.OPENAI_BASE_URL = `http://${host}/v1/`;
  process.env.OPENAI_API_KEY = API_KEY;
  process.env.OPENAI_CHAT_MODEL = "probe-model";
  Object.assign(process.env, environment);

  return host;
};

const completion = ({ finishReason, completionTokens }) => ({
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: `${REPLY_SENTINEL} 1 2 3 4 5` },
      finish_reason: finishReason,
    },
  ],
  ...(completionTokens === undefined
    ? {}
    : { usage: { prompt_tokens: 20, completion_tokens: completionTokens, total_tokens: 20 + completionTokens } }),
});

// `buildRequest` builds a Request first, as Node's fetch does, so a header
// value or URL that fetch would refuse throws the error fetch would throw.
const stubEndpoint = (reply, { buildRequest = false } = {}) => {
  globalThis.fetch = async (url, options) => {
    const request = {
      url: String(url),
      headers: options?.headers ?? {},
      body: options?.body ? JSON.parse(options.body) : null,
    };

    requests.push(request);

    if (buildRequest) {
      new Request(url, options);
    }

    if (reply instanceof Error) {
      throw reply;
    }

    const { status = 200, payload } = typeof reply === "function" ? reply(request) : reply;

    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(),
      text: async () => JSON.stringify(payload),
    };
  };
};

// Every run, whatever its verdict, prints neither the reply nor the key.
const runProbe = async (argv = []) => {
  const run = await runOutputLimitProbeCli(argv);

  assert.equal(run.output.includes(REPLY_SENTINEL), false, "the reply is never printed");
  assert.equal(run.output.includes(API_KEY), false, "the key is never printed");
  assert.equal(run.exitCode, PROBE_EXIT_CODES[run.result.verdict]);

  return run;
};

test("a reply is judged by its finish reason and the endpoint's token count against the limit", () => {
  const cases = [
    [{ finishReason: "length", completionTokens: 8 }, { verdict: "honoured", reason: "stopped_for_length" }],
    [{ finishReason: "length", completionTokens: 5 }, { verdict: "honoured", reason: "stopped_for_length" }],
    // Without a count, a stop for length may have been the endpoint's own limit.
    [
      { finishReason: "length", completionTokens: null },
      { verdict: "no_verdict", reason: "stopped_for_length_without_token_count" },
    ],
    [{ finishReason: "length", completionTokens: 2048 }, { verdict: "not_honoured", reason: "stopped_at_another_limit" }],
    [{ finishReason: "stop", completionTokens: 185 }, { verdict: "not_honoured", reason: "finished_past_limit" }],
    [{ finishReason: null, completionTokens: 9 }, { verdict: "not_honoured", reason: "finished_past_limit" }],
    [{ finishReason: "stop", completionTokens: 3 }, { verdict: "no_verdict", reason: "finished_within_limit" }],
    [{ finishReason: "stop", completionTokens: 8 }, { verdict: "no_verdict", reason: "finished_within_limit" }],
    [{ finishReason: "stop", completionTokens: undefined }, { verdict: "no_verdict", reason: "finished_without_token_count" }],
  ];

  for (const [reply, expected] of cases) {
    assert.deepEqual(judgeOutputLimitProbe({ ...reply, maxTokens: 8 }), expected, JSON.stringify(reply));
  }

  assert.deepEqual(PROBE_EXIT_CODES, { honoured: 0, not_honoured: 1, no_verdict: 2 });
});

test("a reply that stops for length within the limit passes, sent as the answer calls send theirs", async () => {
  const host = useEndpoint();

  stubEndpoint({ payload: completion({ finishReason: "length", completionTokens: 8 }) });

  const run = await runProbe();

  assert.equal(run.exitCode, 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `http://${host}/v1/chat/completions`);
  assert.equal(requests[0].headers.Authorization, `Bearer ${API_KEY}`);
  // The whole body: the limit in the default field, no temperature, nothing else.
  assert.deepEqual(requests[0].body, {
    model: "probe-model",
    messages: [{ role: "user", content: PROBE_PROMPT }],
    max_tokens: 8,
  });
  assert.deepEqual(run.result, {
    verdict: "honoured",
    reason: "stopped_for_length",
    finishReason: "length",
    completionTokens: 8,
    maxTokens: 8,
    field: "max_tokens",
    model: "probe-model",
    endpointHost: host,
  });
  assert.equal(
    run.output,
    `Output limit honoured: the reply stopped for length after 8 tokens (limit 8 in max_tokens, model probe-model, endpoint ${host}).\n`
  );
});

test("max_completion_tokens against an endpoint that ignores it fails, as with Ollama", async () => {
  const host = useEndpoint({ RAG_LLM_MAX_TOKENS_FIELD: " MAX_COMPLETION_TOKENS " });

  // Ollama 0.34.4: max_completion_tokens is not read, the reply runs to its end.
  stubEndpoint((request) =>
    request.body.max_tokens === undefined
      ? { payload: completion({ finishReason: "stop", completionTokens: 185 }) }
      : { payload: completion({ finishReason: "length", completionTokens: request.body.max_tokens }) }
  );

  const run = await runProbe();

  assert.equal(run.exitCode, 1);
  assert.equal(requests[0].body.max_completion_tokens, 8);
  assert.equal("max_tokens" in requests[0].body, false);
  assert.equal(run.result.reason, "finished_past_limit");
  assert.equal(
    run.output,
    [
      `Output limit NOT honoured: the reply finished on its own ("stop") after 185 tokens, past the limit (limit 8 in max_completion_tokens, model probe-model, endpoint ${host}).`,
      "Answer calls would run without a limit here; the endpoint may read the other field (RAG_LLM_MAX_TOKENS_FIELD: max_tokens or max_completion_tokens).\n",
    ].join(" ")
  );
});

test("a reply cut at a longer limit of the endpoint's own fails", async () => {
  useEndpoint();
  stubEndpoint({ payload: completion({ finishReason: "length", completionTokens: 2048 }) });

  const run = await runProbe();

  assert.equal(run.exitCode, 1);
  assert.equal(run.result.reason, "stopped_at_another_limit");
  assert.match(run.output, /^Output limit NOT honoured: the reply stopped for length after 2048 tokens, past the limit, so at a limit of the endpoint's own \(/);
});

test("a reply that ends on its own within the limit, or comes without a token count, gives no verdict", async () => {
  useEndpoint();
  stubEndpoint({ payload: completion({ finishReason: "stop", completionTokens: 3 }) });

  const within = await runProbe();

  assert.equal(within.exitCode, 2);
  assert.equal(within.result.reason, "finished_within_limit");
  assert.match(within.output, /^No verdict: the reply finished on its own \("stop"\) after 3 tokens, within the limit, so it says nothing about the limit \(/);

  stubEndpoint({ payload: completion({ finishReason: "stop" }) });

  const uncounted = await runProbe();

  assert.equal(uncounted.exitCode, 2);
  assert.equal(uncounted.result.reason, "finished_without_token_count");
  assert.equal(uncounted.result.completionTokens, null);

  // An endpoint that ignores the field and stops at a cap of its own without
  // reporting usage would look the same, so a stop for length alone passes nothing.
  stubEndpoint({ payload: completion({ finishReason: "length" }) });

  const lengthOnly = await runProbe();

  assert.equal(lengthOnly.exitCode, 2);
  assert.equal(lengthOnly.result.reason, "stopped_for_length_without_token_count");
  assert.match(lengthOnly.output, /^No verdict: the reply stopped for length, but the endpoint reported no token count, so the stop may have been a limit of its own \(/);
});

test("--max-tokens sets the limit and --json prints the result as it was judged", async () => {
  useEndpoint();
  stubEndpoint((request) => ({
    payload: completion({ finishReason: "length", completionTokens: request.body.max_tokens }),
  }));

  const spaced = await runProbe(["--max-tokens", "16", "--json"]);

  assert.equal(spaced.exitCode, 0);
  assert.equal(requests[0].body.max_tokens, 16);
  assert.deepEqual(JSON.parse(spaced.output), spaced.result);
  assert.equal(spaced.result.maxTokens, 16);

  const inline = await runProbe(["--max-tokens=12"]);

  assert.equal(inline.exitCode, 0);
  assert.equal(requests[1].body.max_tokens, 12);
  assert.match(inline.output, /after 12 tokens \(limit 12 in max_tokens,/);
});

test("a failed request gives no verdict, once: the endpoint's status and message, or only the name and code of an error before any answer", async () => {
  const host = useEndpoint();

  stubEndpoint({ status: 404, payload: { error: { message: 'model "probe-model" not found' } } });

  const missing = await runProbe();

  assert.equal(missing.exitCode, 2);
  assert.equal(requests.length, 1, "the probe never retries");
  assert.equal(missing.result.reason, "request_failed");
  assert.equal(missing.result.status, 404);
  assert.equal(
    missing.output,
    `No verdict: the endpoint answered HTTP 404: model "probe-model" not found (limit 8 in max_tokens, model probe-model, endpoint ${host}).\n`
  );

  const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), { code: "ECONNREFUSED" });

  stubEndpoint(Object.assign(new TypeError("fetch failed"), { cause: refused }));

  const unreachable = await runProbe();

  assert.equal(unreachable.exitCode, 2);
  assert.equal(unreachable.result.status, null);
  assert.equal(unreachable.result.code, "ECONNREFUSED");
  assert.equal(
    unreachable.output,
    `No verdict: the request failed before the endpoint answered (TypeError ECONNREFUSED); check that the endpoint is reachable and that OPENAI_BASE_URL and OPENAI_API_KEY are well formed (limit 8 in max_tokens, model probe-model, endpoint ${host}).\n`
  );

  // A long message from the endpoint is cut, so it cannot flood the log.
  stubEndpoint({ status: 500, payload: { error: { message: "x".repeat(1000) } } });

  const long = await runProbe();

  assert.equal(long.result.error.length, 301);
  assert.ok(long.result.error.endsWith("…"));
});

test("a refusal by the model-call guard says that nothing was sent, not an HTTP status", async () => {
  const host = useEndpoint({ RAG_LLM_CIRCUIT_FAILURE_THRESHOLD: "1" });

  stubEndpoint({ status: 503, payload: { error: { message: "busy" } } });

  const unavailable = await runProbe();

  assert.equal(unavailable.result.status, 503);

  // The failure opened the endpoint's circuit: the next call never leaves the process.
  const refusal = await runProbe();

  assert.equal(requests.length, 1);
  assert.equal(refusal.exitCode, 2);
  assert.deepEqual(
    { reason: refusal.result.reason, status: refusal.result.status, code: refusal.result.code },
    { reason: "refused_by_guard", status: null, code: "CIRCUIT_OPEN" }
  );
  assert.equal(
    refusal.output,
    `No verdict: the model-call guard refused the request (CIRCUIT_OPEN); nothing was sent (limit 8 in max_tokens, model probe-model, endpoint ${host}).\n`
  );
});

test("an error message never carries the key or the base URL's credentials", async () => {
  // fetch quotes a header value it refuses (here a key with a line break in it) ...
  useEndpoint({ OPENAI_API_KEY: "sk-DUMMY-KEY-PART-ONE\nsk-DUMMY-KEY-PART-TWO" });
  stubEndpoint({ payload: completion({ finishReason: "length", completionTokens: 8 }) }, { buildRequest: true });

  const badHeader = await runProbe(["--json"]);

  assert.equal(badHeader.exitCode, 2);
  assert.equal(badHeader.result.error, "TypeError");
  assert.doesNotMatch(badHeader.output, /DUMMY-KEY/);

  // ... and the whole URL, user name and password included, for a URL with credentials.
  useEndpoint({ OPENAI_BASE_URL: "https://proxyuser:S3CRET%40PASSWORD@llm-proxy.invalid/v1" });
  stubEndpoint({ payload: completion({ finishReason: "length", completionTokens: 8 }) }, { buildRequest: true });

  const credentialUrl = await runProbe(["--json"]);

  assert.equal(credentialUrl.exitCode, 2);
  assert.equal(credentialUrl.result.endpointHost, "llm-proxy.invalid");
  assert.doesNotMatch(credentialUrl.output, /proxyuser|S3CRET/);

  // An endpoint's own message keeps its text, with the secrets removed.
  useEndpoint({ OPENAI_BASE_URL: "https://proxyuser:S3CRET%40PASSWORD@llm-proxy.invalid/v1" });
  stubEndpoint({
    status: 401,
    payload: { error: { message: `Incorrect API key provided: ${API_KEY} (proxy login proxyuser / S3CRET@PASSWORD)` } },
  });

  const echoed = await runProbe();

  assert.equal(echoed.exitCode, 2);
  assert.equal(
    echoed.output,
    "No verdict: the endpoint answered HTTP 401: Incorrect API key provided: [redacted] (proxy login [redacted] / [redacted]) (limit 8 in max_tokens, model probe-model, endpoint llm-proxy.invalid).\n"
  );
});

test("a bad argument or setting refuses the probe before any request", async () => {
  const refusals = [
    { argv: ["--max-tokens", "0"], message: /--max-tokens must be a positive integer/ },
    { argv: ["--max-tokens", "eight"], message: /--max-tokens must be a positive integer/ },
    // Values the client would drop without a word, so the request would carry no limit.
    { argv: ["--max-tokens", "1e21"], message: /no larger than 9007199254740991/ },
    { argv: ["--max-tokens", "9007199254740993"], message: /no larger than 9007199254740991/ },
    { argv: ["--max-tokens"], message: /--max-tokens requires a value/ },
    { argv: ["--max-tokens", "--verbose"], message: /--max-tokens requires a value/ },
    { argv: ["--verbose"], message: /Unknown argument "--verbose"; usage: probe-output-limit\.mjs/ },
    { environment: { RAG_LLM_MAX_TOKENS_FIELD: "max_output_tokens" }, message: /RAG_LLM_MAX_TOKENS_FIELD must be one of max_tokens, max_completion_tokens/ },
    { environment: { OPENAI_API_KEY: "" }, message: /OPENAI_API_KEY is not set/ },
  ];

  for (const { argv = [], environment = {}, message } of refusals) {
    useEndpoint(environment);
    stubEndpoint({ payload: completion({ finishReason: "length", completionTokens: 8 }) });

    const run = await runProbe(argv);

    assert.equal(run.exitCode, 2, JSON.stringify({ argv, environment }));
    assert.equal(run.result.reason, "invalid_setting");
    assert.match(run.result.error, message);
    assert.equal(run.output, `No verdict: ${run.result.error}\n`);
    assert.equal(requests.length, 0, "nothing is sent");
  }

  // With --json even a refusal prints JSON.
  useEndpoint();

  const json = await runProbe(["--json", "--max-tokens", "-1"]);

  assert.deepEqual(JSON.parse(json.output), {
    verdict: "no_verdict",
    reason: "invalid_setting",
    error: "--max-tokens must be a positive integer.",
  });
  assert.equal(requests.length, 0);
});

test("as a command it reads only the given environment, exits with the verdict's code, also through a symlink and with shared state on", { timeout: 60_000 }, async () => {
  // A stand-in that, like Ollama, honours max_tokens and ignores max_completion_tokens.
  const server = createServer((request, response) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const limit = JSON.parse(body).max_tokens;
      const payload = limit
        ? completion({ finishReason: "length", completionTokens: limit })
        : completion({ finishReason: "stop", completionTokens: 185 });

      response.writeHead(200, { "content-type": "application/json", connection: "close" });
      response.end(JSON.stringify(payload));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const scratch = await mkdtemp(path.join(os.tmpdir(), "output-limit-probe-"));
  const { port } = server.address();
  const runCommand = (environment, script = probeScript) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script], {
        cwd: serverDirectory,
        // DOTENV_CONFIG_PATH keeps a developer's server/.env out of the run.
        env: {
          PATH: process.env.PATH,
          DOTENV_CONFIG_PATH: "/dev/null",
          OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
          OPENAI_API_KEY: API_KEY,
          OPENAI_CHAT_MODEL: "probe-model",
          ...environment,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  const honouredLine = `Output limit honoured: the reply stopped for length after 8 tokens (limit 8 in max_tokens, model probe-model, endpoint 127.0.0.1:${port}).\n`;

  try {
    const honoured = await runCommand({});

    assert.equal(honoured.code, 0, honoured.stderr);
    assert.equal(honoured.stdout, honouredLine);
    assert.equal(honoured.stderr, "");

    const ignored = await runCommand({ RAG_LLM_MAX_TOKENS_FIELD: "max_completion_tokens" });

    assert.equal(ignored.code, 1, ignored.stderr);
    assert.match(ignored.stdout, /^Output limit NOT honoured: the reply finished on its own \("stop"\) after 185 tokens/);
    assert.equal(ignored.stderr, "");

    // Through a symlink the command still runs: a silent exit 0 would read as "honoured".
    const linked = path.join(scratch, "probe-link.mjs");

    await symlink(probeScript, linked);

    const throughLink = await runCommand({}, linked);

    assert.equal(throughLink.code, 0, throughLink.stderr);
    assert.equal(throughLink.stdout, honouredLine);

    // With shared state on and no Redis to reach, the guard falls back to
    // per-process state, and the command still exits once it has printed.
    const shared = await runCommand({ RAG_SHARED_STATE: "redis", REDIS_URL: path.join(scratch, "no-redis.sock") });

    assert.equal(shared.code, 0, shared.stderr);
    assert.equal(shared.stdout, honouredLine);

    for (const run of [honoured, ignored, throughLink, shared]) {
      assert.equal(run.stdout.includes(REPLY_SENTINEL), false);
      assert.equal(run.stdout.includes(API_KEY), false);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(scratch, { recursive: true, force: true });
  }
});
