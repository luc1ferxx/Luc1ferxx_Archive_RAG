import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseServiceSigningKey, parseTrustedServiceKeys } from "../rag/service-identity-keys.js";
import { signServiceToken, verifyServiceToken } from "../rag/service-identity.js";
import { COMPOSE_SIGNING_KEY_VARIABLES, runServiceKeysCommand } from "../service-keys.mjs";

// server/service-keys.mjs: key pairs for INTERNAL_SERVICE_AUTH=ed25519, printed
// to standard output and never written anywhere.

const serverDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const toolPath = path.join(serverDirectory, "service-keys.mjs");

const run = (argv, env = {}) => {
  const out = [];
  const err = [];
  const code = runServiceKeysCommand({
    argv,
    env,
    stderr: { write: (text) => err.push(text) },
    stdout: { write: (text) => out.push(text) },
  });

  return { code, stderr: err.join(""), stdout: out.join("").split("\n").filter(Boolean) };
};

test("generate prints one tier's private key and the public entry for the others", () => {
  const { code, stderr, stdout } = run(["generate", "retrieval"]);

  assert.equal(code, 0);
  assert.equal(stdout.length, 2);

  const [privateLine, publicEntry] = stdout;
  const privateKey = privateLine.replace(/^INTERNAL_SERVICE_SIGNING_KEY=/, "");
  const signing = parseServiceSigningKey(privateKey);
  const trusted = parseTrustedServiceKeys(publicEntry);

  assert.match(privateLine, /^INTERNAL_SERVICE_SIGNING_KEY=[A-Za-z0-9+/=]+$/);
  assert.equal(signing.error, null);
  assert.deepEqual(trusted.errors, []);
  assert.deepEqual(trusted.entries.map(({ issuer, keyId }) => [issuer, keyId]), [["retrieval", signing.key.keyId]]);
  assert.equal(trusted.entries[0].publicKeyBase64, signing.key.publicKeyBase64);
  // Notes go to standard error, keys never do.
  assert.match(stderr, /never in a tracked file/);
  assert.ok(!stderr.includes(privateKey));

  // A token signed with the printed key verifies against the printed entry.
  const token = signServiceToken({
    audience: "model-gateway",
    env: { INTERNAL_SERVICE_AUTH: "ed25519", INTERNAL_SERVICE_SIGNING_KEY: privateKey },
    issuer: "retrieval",
    system: true,
  });

  assert.equal(
    verifyServiceToken(token, {
      audience: "model-gateway",
      env: { INTERNAL_SERVICE_AUTH: "ed25519", INTERNAL_SERVICE_TRUSTED_KEYS: publicEntry },
    }).issuer,
    "retrieval"
  );

  // Two runs never print the same key.
  assert.notEqual(run(["generate", "retrieval"]).stdout[0], privateLine);
});

test("an explicit key id is printed and used; public re-derives an entry from the environment", () => {
  const generated = run(["generate", "agent", "--kid", "agent-2026-10"]);

  assert.equal(generated.code, 0);
  assert.equal(generated.stdout[1], "INTERNAL_SERVICE_SIGNING_KEY_ID=agent-2026-10");
  assert.match(generated.stdout[2], /^agent:agent-2026-10:/);

  const privateKey = generated.stdout[0].split("=").slice(1).join("=");
  const derived = run(["public", "agent"], {
    INTERNAL_SERVICE_SIGNING_KEY: privateKey,
    INTERNAL_SERVICE_SIGNING_KEY_ID: "agent-2026-10",
  });

  assert.equal(derived.code, 0);
  assert.deepEqual(derived.stdout, [generated.stdout[2]]);
  assert.equal(run(["public", "agent"], {}).code, 2);
});

test("compose prints the exports compose.services.yml reads", () => {
  const { code, stdout } = run(["compose"]);
  const exports = Object.fromEntries(
    stdout.map((line) => {
      const match = line.match(/^export ([A-Z0-9_]+)=(.+)$/);

      assert.ok(match, line.slice(0, 40));
      return [match[1], match[2]];
    })
  );
  const trusted = parseTrustedServiceKeys(exports.INTERNAL_SERVICE_TRUSTED_KEYS);

  assert.equal(code, 0);
  assert.equal(exports.INTERNAL_SERVICE_AUTH, "ed25519");
  assert.deepEqual(trusted.errors, []);
  assert.deepEqual(trusted.entries.map((entry) => entry.issuer).sort(), Object.keys(COMPOSE_SIGNING_KEY_VARIABLES).sort());

  for (const [issuer, variable] of Object.entries(COMPOSE_SIGNING_KEY_VARIABLES)) {
    const { key } = parseServiceSigningKey(exports[variable]);

    assert.equal(trusted.byKeyId.get(key.keyId).issuers[0], issuer, `${variable} is ${issuer}'s key`);
  }
});

test("bad arguments print the usage and exit 2; the tool writes no files", async () => {
  for (const argv of [["generate"], ["generate", "edge"], ["generate", "api", "--kid"], ["generate", "api", "extra"], ["compose", "x"], ["rotate"]]) {
    const { code, stderr, stdout } = run(argv);

    assert.equal(code, 2, argv.join(" "));
    assert.deepEqual(stdout, []);
    assert.match(stderr, /Usage:/);
  }

  assert.equal(run([]).code, 0);

  // As a script, and with nothing in its source that could write a file.
  const child = spawnSync(process.execPath, [toolPath, "generate", "api"], { encoding: "utf8" });

  assert.equal(child.status, 0);
  assert.match(child.stdout, /^INTERNAL_SERVICE_SIGNING_KEY=/);

  const source = await readFile(toolPath, "utf8");

  assert.doesNotMatch(source, /node:fs|from "fs"|writeFile|createWriteStream/);
});
