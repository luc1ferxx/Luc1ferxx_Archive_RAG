// Ed25519 keys for the internal service identity of a split deployment
// (INTERNAL_SERVICE_AUTH=ed25519 or mixed; rag/service-identity-keys.js).
//
//   node service-keys.mjs generate <issuer> [--kid <id>]
//       one key pair: the private key's environment lines for that tier only,
//       and the public entry every tier appends to INTERNAL_SERVICE_TRUSTED_KEYS.
//   node service-keys.mjs compose
//       one key pair per signing tier of compose.services.yml (api, agent,
//       retrieval; the model gateway calls nobody) as `export` lines for the
//       shell that runs docker compose.
//   node service-keys.mjs public <issuer>
//       the public entry of the private key in INTERNAL_SERVICE_SIGNING_KEY
//       (and INTERNAL_SERVICE_SIGNING_KEY_ID), for checking or re-deriving
//       an entry during a rotation; the key is read from the environment,
//       never from the command line.
//
// Keys go to standard output only; this tool never writes a file. Put the
// private keys in a secret store or the deploying shell, never in a tracked
// file. Notes go to standard error, so `eval "$(node service-keys.mjs
// compose)"` takes the exports alone.

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  generateServiceKeyPair,
  parseServiceSigningKey,
  SERVICE_ISSUERS,
} from "./rag/service-identity-keys.js";

// The tiers of compose.services.yml that call another tier, and the shell
// variable each one's INTERNAL_SERVICE_SIGNING_KEY comes from.
export const COMPOSE_SIGNING_KEY_VARIABLES = Object.freeze({
  agent: "INTERNAL_SERVICE_SIGNING_KEY_AGENT",
  api: "INTERNAL_SERVICE_SIGNING_KEY_API",
  retrieval: "INTERNAL_SERVICE_SIGNING_KEY_RETRIEVAL",
});

const USAGE = [
  "Usage:",
  "  node service-keys.mjs generate <issuer> [--kid <id>]",
  "  node service-keys.mjs compose",
  "  node service-keys.mjs public <issuer>   (reads INTERNAL_SERVICE_SIGNING_KEY)",
  `Issuers: ${SERVICE_ISSUERS.join(", ")}.`,
].join("\n");

const readOption = (args, name) => {
  const index = args.indexOf(name);

  if (index === -1) {
    return { args, value: undefined };
  }

  const value = args[index + 1];

  if (value === undefined || value.startsWith("--")) {
    throw new TypeError(`${name} needs a value.`);
  }

  return { args: [...args.slice(0, index), ...args.slice(index + 2)], value };
};

const requireIssuer = (value) => {
  const issuer = String(value ?? "").trim().toLowerCase();

  if (!SERVICE_ISSUERS.includes(issuer)) {
    throw new TypeError(`Name the issuer, one of ${SERVICE_ISSUERS.join(", ")}.`);
  }

  return issuer;
};

const generate = (args, { stderr, stdout }) => {
  const { args: rest, value: keyId } = readOption(args, "--kid");
  const [issuerArgument, ...extra] = rest;

  if (extra.length > 0) {
    throw new TypeError(`Unexpected argument "${extra[0]}".`);
  }

  const pair = generateServiceKeyPair({ issuer: requireIssuer(issuerArgument), keyId });

  stderr.write(
    `Private key for the ${pair.issuer} process only: keep it in a secret store or the deploying shell, never in a tracked file.\n`
  );
  stdout.write(`INTERNAL_SERVICE_SIGNING_KEY=${pair.privateKeyBase64}\n`);

  if (keyId !== undefined) {
    stdout.write(`INTERNAL_SERVICE_SIGNING_KEY_ID=${pair.keyId}\n`);
  }

  stderr.write("Public entry: append it to INTERNAL_SERVICE_TRUSTED_KEYS on every tier.\n");
  stdout.write(`${pair.trustedEntry}\n`);
};

const compose = (args, { stderr, stdout }) => {
  if (args.length > 0) {
    throw new TypeError(`Unexpected argument "${args[0]}".`);
  }

  const pairs = Object.keys(COMPOSE_SIGNING_KEY_VARIABLES).map((issuer) => generateServiceKeyPair({ issuer }));

  stderr.write(
    "Exports for docker compose -f docker-compose.yml -f compose.services.yml; they hold private keys, so keep them out of tracked files and shell history.\n"
  );
  stdout.write("export INTERNAL_SERVICE_AUTH=ed25519\n");

  for (const pair of pairs) {
    stdout.write(`export ${COMPOSE_SIGNING_KEY_VARIABLES[pair.issuer]}=${pair.privateKeyBase64}\n`);
  }

  stdout.write(`export INTERNAL_SERVICE_TRUSTED_KEYS=${pairs.map((pair) => pair.trustedEntry).join(",")}\n`);
};

const printPublicEntry = (args, { env, stdout }) => {
  const [issuerArgument, ...extra] = args;

  if (extra.length > 0) {
    throw new TypeError(`Unexpected argument "${extra[0]}".`);
  }

  const issuer = requireIssuer(issuerArgument);
  const { error, key } = parseServiceSigningKey(env.INTERNAL_SERVICE_SIGNING_KEY, env.INTERNAL_SERVICE_SIGNING_KEY_ID);

  if (error || !key) {
    throw new TypeError(error ?? "Set INTERNAL_SERVICE_SIGNING_KEY to the private key whose public entry you want.");
  }

  stdout.write(`${issuer}:${key.keyId}:${key.publicKeyBase64}\n`);
};

const COMMANDS = Object.freeze({ compose, generate, public: printPublicEntry });

/**
 * Runs one command; returns the exit code. `stdout`/`stderr` are writable
 * streams (or anything with write()); `env` supplies the key for `public`.
 */
export const runServiceKeysCommand = ({
  argv = process.argv.slice(2),
  env = process.env,
  stderr = process.stderr,
  stdout = process.stdout,
} = {}) => {
  const [commandName, ...args] = argv;
  const command = COMMANDS[commandName];

  if (!command) {
    stderr.write(`${USAGE}\n`);
    return commandName === undefined || commandName === "--help" ? 0 : 2;
  }

  try {
    command(args, { env, stderr, stdout });
    return 0;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
    return 2;
  }
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runServiceKeysCommand();
}
