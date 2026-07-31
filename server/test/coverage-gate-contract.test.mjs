import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { normalizeChildProcessClose } from "./coverage-process-result.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const coverageGatePath = path.join(testDirectory, "coverage-gate.mjs");

test("API routes coverage includes every server route module", async () => {
  const coverageGateSource = await readFile(coverageGatePath, "utf8");
  const apiRoutesStart = coverageGateSource.indexOf('id: "api_routes"');
  const nextGroupStart = coverageGateSource.indexOf(
    'id: "infra_external_cli"',
    apiRoutesStart
  );

  assert.notEqual(apiRoutesStart, -1, "API routes coverage group must exist");
  assert.notEqual(nextGroupStart, -1, "API routes coverage group must be bounded");

  const apiRoutesGroup = coverageGateSource.slice(
    apiRoutesStart,
    nextGroupStart
  );

  assert.match(
    apiRoutesGroup,
    /\/\^server\\\/routes\\\//,
    "API routes coverage group must include server/routes/**"
  );
});

test("coverage child termination by signal is always a failing result", () => {
  assert.deepEqual(
    normalizeChildProcessClose({
      exitCode: null,
      signal: "SIGKILL",
    }),
    {
      exitCode: 1,
      signal: "SIGKILL",
    }
  );
  assert.deepEqual(
    normalizeChildProcessClose({
      exitCode: 7,
      signal: null,
    }),
    {
      exitCode: 7,
      signal: null,
    }
  );
});
