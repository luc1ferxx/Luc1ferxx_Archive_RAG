import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repositoryRoot = path.resolve(__dirname, "..", "..");
const workflowPath = path.join(
  repositoryRoot,
  ".github",
  "workflows",
  "quality-gate.yml"
);
const plannerRealGateWorkflowPath = path.join(
  repositoryRoot,
  ".github",
  "workflows",
  "planner-real-gate.yml"
);

test("quality gate workflow runs server tests, saved gate, and conditional feedback eval", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /name:\s*Quality Gate/);
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /push:/);
  assert.match(workflow, /branches:\s*\n\s*-\s*main/);
  assert.match(workflow, /working-directory:\s*server/);
  assert.match(workflow, /node-version:\s*"20"/);
  assert.match(workflow, /cache-dependency-path:\s*server\/package-lock\.json/);
  assert.match(workflow, /run:\s*npm ci/);
  assert.match(workflow, /run:\s*npm test/);
  assert.match(workflow, /run:\s*npm run eval:trajectory/);
  assert.match(workflow, /OPENAI_API_KEY:\s*\$\{\{\s*secrets\.OPENAI_API_KEY\s*\}\}/);
  assert.match(workflow, /name:\s*Run planner eval \(mock\)/);
  assert.match(workflow, /run:\s*npm run eval:planner -- --provider mock/);
  assert.match(workflow, /name:\s*Run planner eval \(real\)/);
  assert.match(workflow, /if:\s*env\.OPENAI_API_KEY != ''/);
  assert.match(workflow, /run:\s*npm run eval:planner -- --provider real/);
  assert.match(workflow, /run:\s*npm run quality:gate -- --fail-on-warn/);
  assert.match(workflow, /id:\s*feedback/);
  assert.match(workflow, /server\/data\/feedback\/feedback\.jsonl/);
  assert.match(workflow, /run:\s*npm run eval:feedback/);
  assert.match(workflow, /if:\s*steps\.feedback\.outputs\.has_feedback == 'true'/);
});

test("planner real provider workflow runs a required scheduled gate", async () => {
  const workflow = await readFile(plannerRealGateWorkflowPath, "utf8");

  assert.match(workflow, /name:\s*Planner Real Provider Gate/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /schedule:\s*\n\s*-\s*cron:\s*"0 9 \* \* \*"/);
  assert.match(workflow, /OPENAI_API_KEY:\s*\$\{\{\s*secrets\.OPENAI_API_KEY\s*\}\}/);
  assert.match(workflow, /working-directory:\s*server/);
  assert.match(workflow, /node-version:\s*"20"/);
  assert.match(workflow, /run:\s*npm ci/);
  assert.match(workflow, /run:\s*npm run eval:planner -- --provider mock/);
  assert.match(workflow, /run:\s*npm run eval:planner -- --provider real/);
  assert.doesNotMatch(
    workflow,
    /Run planner eval \(real\)[\s\S]*if:\s*env\.OPENAI_API_KEY != ''/
  );
  assert.match(
    workflow,
    /run:\s*npm run planner:gate -- --provider real --compare-provider mock --max-unexpected-fallback-rate=0 --max-divergence-count=0/
  );
  assert.match(workflow, /actions\/upload-artifact@v4/);
});
