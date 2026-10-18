#!/usr/bin/env node
// The tenant-isolation demo against a RUNNING server started with
// deploy/demo/hardened.env (docs/demo-tenant-isolation.md). It speaks HTTP
// with the profile's demo tokens and never touches the database.
//
//   npm run demo:fake-model                 the deterministic demo model on 127.0.0.1:5199
//   npm run demo:seed                       workspaces, members and sample documents
//   npm run demo:walkthrough                the isolation checklist; exit 1 on any FAIL
//
// The logic lives in demo/tenant-demo.js, which
// test/tenant-isolation-hardened.e2e.test.mjs runs against a real server.

import { pathToFileURL } from "node:url";

import { DEMO_FAKE_MODEL_DEFAULT_PORT, startDemoFakeModel } from "./demo/fake-model.js";
import {
  createDemoClient,
  DEMO_CHECKS,
  DEMO_DEFAULT_BASE_URL,
  formatDemoResultTable,
  runDemoWalkthrough,
  seedDemoTenants,
} from "./demo/tenant-demo.js";

export const USAGE = `Usage: node demo-tenants.mjs <command> [options]

Commands
  seed          Register the demo workspaces and members (as tenant-manager)
                and upload the sample documents. Idempotent.
  walkthrough   Run the isolation checklist and print a PASS/FAIL table; exit 1
                when a check fails.
  fake-model    Serve the deterministic demo model (OpenAI-compatible
                /v1/embeddings and /v1/chat/completions) until interrupted.

Options
  --url <base>          The server (default ${DEMO_DEFAULT_BASE_URL}); seed, walkthrough.
  --only <id,...>       Run only these checks; walkthrough.
  --json                Print the walkthrough results as JSON.
  --host <address>      Listen address (default 127.0.0.1); fake-model.
  --port <n>            Listen port (default ${DEMO_FAKE_MODEL_DEFAULT_PORT}); fake-model.
  --chat-delay-ms <n>   Hold each chat completion this long (default 0), so
                        concurrent chats overlap; fake-model.
  --help                Show this message.

DEMO ONLY: the tokens are the public demo values of deploy/demo/hardened.env.

Checks: ${DEMO_CHECKS.map((check) => check.id).join(", ")}
`;

export const parseDemoArgs = (argv = []) => {
  const options = {
    chatDelayMs: 0,
    command: "",
    help: false,
    host: "127.0.0.1",
    json: false,
    only: null,
    port: DEMO_FAKE_MODEL_DEFAULT_PORT,
    url: DEMO_DEFAULT_BASE_URL,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index]);
    const [name, inlineValue] =
      arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const readValue = () => {
      const value = inlineValue ?? argv[++index];

      if (value === undefined || String(value).trim() === "") {
        throw new Error(`${name} needs a value.`);
      }

      return String(value).trim();
    };

    if (name === "--help" || name === "-h") {
      options.help = true;
    } else if (name === "--json") {
      options.json = true;
    } else if (name === "--url") {
      options.url = readValue();
    } else if (name === "--host") {
      options.host = readValue();
    } else if (name === "--port") {
      const port = Number(readValue());

      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error("--port must be an integer from 0 to 65535.");
      }

      options.port = port;
    } else if (name === "--chat-delay-ms") {
      const delay = Number(readValue());

      if (!Number.isInteger(delay) || delay < 0 || delay > 60_000) {
        throw new Error("--chat-delay-ms must be an integer from 0 to 60000.");
      }

      options.chatDelayMs = delay;
    } else if (name === "--only") {
      const ids = readValue().split(",").map((id) => id.trim()).filter(Boolean);
      const unknown = ids.filter((id) => !DEMO_CHECKS.some((check) => check.id === id));

      if (unknown.length > 0) {
        throw new Error(`Unknown check: ${unknown.join(", ")}.`);
      }

      options.only = ids;
    } else if (!name.startsWith("-") && !options.command) {
      options.command = name;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.help && !["seed", "walkthrough", "fake-model"].includes(options.command)) {
    throw new Error(options.command ? `Unknown command: ${options.command}` : "Name a command.");
  }

  return options;
};

export const runDemoCommand = async (argv, { stdout = process.stdout, stderr = process.stderr } = {}) => {
  let options;

  try {
    options = parseDemoArgs(argv);
  } catch (error) {
    stderr.write(`${error.message}\n\n${USAGE}`);
    return 2;
  }

  if (options.help) {
    stdout.write(USAGE);
    return 0;
  }

  if (options.command === "fake-model") {
    const { url } = await startDemoFakeModel({
      chatDelayMs: options.chatDelayMs,
      host: options.host,
      port: options.port,
    });

    stdout.write(`[demo] fake model serving ${url} (OPENAI_BASE_URL); Ctrl-C stops it.\n`);
    // Runs until the process is interrupted.
    return new Promise(() => {});
  }

  const client = createDemoClient({ baseUrl: options.url });

  try {
    if (options.command === "seed") {
      await seedDemoTenants({ client, log: (line) => stdout.write(`[seed] ${line}\n`) });
      stdout.write("[seed] done.\n");
      return 0;
    }

    const results = await runDemoWalkthrough({ client, only: options.only });

    stdout.write(options.json ? `${JSON.stringify(results, null, 2)}\n` : `${formatDemoResultTable(results)}\n`);
    return results.some((result) => result.status === "FAIL") ? 1 : 0;
  } catch (error) {
    stderr.write(`[demo] ${options.command} failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDemoCommand(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
