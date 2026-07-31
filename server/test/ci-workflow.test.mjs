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
const robustEvalSuiteWorkflowPath = path.join(
  repositoryRoot,
  ".github",
  "workflows",
  "robust-eval-suite.yml"
);
const releaseEvidenceWorkflowPath = path.join(
  repositoryRoot,
  ".github",
  "workflows",
  "release-evidence.yml"
);
const rootPackagePath = path.join(repositoryRoot, "package.json");

test("root current quality alias forwards command-line arguments", async () => {
  const packageJson = JSON.parse(await readFile(rootPackagePath, "utf8"));

  assert.equal(
    packageJson.scripts?.["quality:current"],
    "cd server && npm run quality:current --"
  );
});

test("root historical quality alias forwards command-line arguments", async () => {
  const packageJson = JSON.parse(await readFile(rootPackagePath, "utf8"));

  assert.equal(
    packageJson.scripts?.["quality:gate"],
    "cd server && npm run quality:gate --"
  );
});

test("root release evidence alias forwards command-line arguments", async () => {
  const packageJson = JSON.parse(await readFile(rootPackagePath, "utf8"));

  assert.equal(
    packageJson.scripts?.["release:gate"],
    "cd server && npm run release:gate --"
  );
});

test("quality gate workflow runs frontend checks in an independent root job", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const frontendJobMatch = workflow.match(
    /\n  frontend-checks:\n([\s\S]*?)(?=\n  [a-zA-Z0-9_-]+:\n|$)/
  );

  assert.ok(frontendJobMatch, "frontend-checks must be a top-level job");

  const frontendJob = frontendJobMatch[0];

  assert.match(frontendJob, /runs-on:\s*ubuntu-latest/);
  assert.match(frontendJob, /node-version:\s*"20"/);
  assert.match(frontendJob, /cache-dependency-path:\s*package-lock\.json/);
  assert.doesNotMatch(frontendJob, /working-directory:\s*server/);

  const commands = ["npm ci", "npm test", "npm run build"];
  let previousCommandIndex = -1;

  for (const command of commands) {
    const commandIndex = frontendJob.indexOf(`run: ${command}`);

    assert.ok(
      commandIndex > previousCommandIndex,
      `${command} must run in order`
    );
    previousCommandIndex = commandIndex;
  }
});

test("quality gate workflow enforces backend route coverage", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const serverJobMatch = workflow.match(
    /\n  server-tests:\n([\s\S]*?)(?=\n  [a-zA-Z0-9_-]+:\n|$)/
  );

  assert.ok(serverJobMatch, "server-tests must be a top-level job");

  const serverJob = serverJobMatch[0];
  const testIndex = serverJob.indexOf("run: npm test");
  const coverageIndex = serverJob.indexOf("run: npm run coverage:gate");

  assert.ok(testIndex >= 0, "server-tests must run the backend tests");
  assert.ok(
    coverageIndex > testIndex,
    "server-tests must enforce coverage after the backend tests"
  );
});

test("quality gate workflow regenerates and validates current-commit evidence", async () => {
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
  assert.match(workflow, /\n  server-tests:\n/);
  assert.match(
    workflow,
    /server-tests:[\s\S]*run:\s*npm test[\s\S]*quality-gate:/,
    "server tests must run as a parallel job, not a quality-gate step"
  );
  assert.doesNotMatch(
    workflow,
    /quality-gate:[\s\S]*run:\s*npm test/,
    "the quality-gate job must not repeat the server test suite"
  );
  assert.match(
    workflow,
    /EVAL_TARGET_COMMIT_SHA:\s*\$\{\{\s*github\.sha\s*\}\}/
  );
  assert.match(workflow, /EVAL_EVIDENCE_PROFILE:\s*quality-current/);
  assert.match(workflow, /name:\s*Run current synthetic eval/);
  assert.match(
    workflow,
    /run:\s*npm run eval:synthetic -- evaluation\/synthetic-corpus-near-duplicate\.json --latest-name latest-quality --openai-provider deterministic/
  );
  assert.match(workflow, /run:\s*npm run eval:trajectory/);
  assert.match(workflow, /OPENAI_API_KEY:\s*\$\{\{\s*secrets\.OPENAI_API_KEY\s*\}\}/);
  assert.match(workflow, /name:\s*Run planner eval \(mock\)/);
  assert.match(workflow, /run:\s*npm run eval:planner -- --provider mock/);
  assert.match(workflow, /name:\s*Run planner eval \(real\)/);
  assert.match(
    workflow,
    /if:\s*\$\{\{\s*!cancelled\(\) && env\.OPENAI_API_KEY != ''\s*\}\}/
  );
  assert.match(workflow, /run:\s*npm run eval:planner -- --provider real/);
  assert.match(workflow, /name:\s*Run recovery observability eval/);
  assert.match(workflow, /run:\s*npm run eval:recovery-observability/);
  assert.match(workflow, /name:\s*Run feedback regression eval/);
  assert.match(workflow, /run:\s*npm run eval:feedback/);
  assert.match(workflow, /name:\s*Check current quality gate/);
  assert.match(
    workflow,
    /run:\s*npm run quality:current -- --target-commit "\$EVAL_TARGET_COMMIT_SHA"/
  );
  assert.match(
    workflow,
    /run:\s*npm run quality:current -- --target-commit "\$EVAL_TARGET_COMMIT_SHA" --require-planner-real/
  );
  assert.doesNotMatch(workflow, /run:\s*npm run quality:gate/);
  assert.ok(
    workflow.indexOf("run: npm run eval:synthetic") <
      workflow.indexOf("run: npm run quality:current"),
    "the current synthetic producer must run before the current gate"
  );
  assert.doesNotMatch(workflow, /id:\s*feedback/);
  assert.doesNotMatch(workflow, /server\/data\/feedback\/feedback\.jsonl/);
  assert.doesNotMatch(workflow, /if:\s*steps\.feedback\.outputs\.has_feedback == 'true'/);
});

test("quality gate workflow preserves diagnostics after an eval failure", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const producerNames = [
    "Run current synthetic eval",
    "Run trajectory eval",
    "Run planner eval (mock)",
    "Run recovery observability eval",
    "Run feedback regression eval",
  ];

  for (const name of producerNames) {
    assert.match(
      workflow,
      new RegExp(
        `name:\\s*${name.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&"
        )}\\s+if:\\s*\\$\\{\\{\\s*!cancelled\\(\\)\\s*\\}\\}`
      ),
      `${name} must still run after a prior producer failure`
    );
  }

  assert.match(workflow, /name:\s*Upload current quality evidence/);
  assert.match(workflow, /if:\s*always\(\)/);
  assert.match(workflow, /uses:\s*actions\/upload-artifact@v4/);
  assert.match(
    workflow,
    /server\/evaluation\/results\/latest-current-quality-gate\.\*/
  );
  assert.match(workflow, /if-no-files-found:\s*error/);
});

test("planner real provider workflow runs a required scheduled gate", async () => {
  const workflow = await readFile(plannerRealGateWorkflowPath, "utf8");

  assert.match(workflow, /name:\s*Planner Real Provider Gate/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /schedule:\s*\n\s*-\s*cron:\s*"0 9 \* \* \*"/);
  assert.match(workflow, /OPENAI_API_KEY:\s*\$\{\{\s*secrets\.OPENAI_API_KEY\s*\}\}/);
  assert.match(workflow, /services:\s*\n\s*postgres:/);
  assert.match(workflow, /image:\s*postgres:16/);
  assert.match(workflow, /POSTGRES_DB:\s*agentai_smoke/);
  assert.match(workflow, /--health-cmd "pg_isready -U postgres -d agentai_smoke"/);
  assert.match(
    workflow,
    /POSTGRES_DATABASE_URL:\s*postgresql:\/\/postgres:postgres@127\.0\.0\.1:5432\/agentai_smoke/
  );
  assert.match(
    workflow,
    /LONG_MEMORY_DATABASE_URL:\s*postgresql:\/\/postgres:postgres@127\.0\.0\.1:5432\/agentai_smoke/
  );
  assert.match(workflow, /AGENT_PLANNER_ROLLOUT:\s*llm/);
  assert.match(workflow, /AGENT_INTENT_PLANNER:\s*llm/);
  assert.match(workflow, /AGENT_EXECUTION_PLANNER:\s*llm/);
  assert.match(workflow, /working-directory:\s*server/);
  assert.match(workflow, /node-version:\s*"20"/);
  assert.match(workflow, /run:\s*npm ci/);
  assert.match(workflow, /run:\s*npm run eval:planner -- --provider mock/);
  assert.match(workflow, /run:\s*npm run eval:planner -- --provider real/);
  assert.match(workflow, /run:\s*npm run eval:trajectory/);
  assert.match(workflow, /run:\s*npm run eval:recovery-observability/);
  assert.doesNotMatch(
    workflow,
    /Run planner eval \(real\)[\s\S]*if:\s*env\.OPENAI_API_KEY != ''/
  );
  assert.match(
    workflow,
    /run:\s*npm run planner:gate -- --provider real --compare-provider mock --max-unexpected-fallback-rate=0 --max-divergence-count=0/
  );
  assert.match(
    workflow,
    /name:\s*Run pure LLM runtime smoke[\s\S]*run:\s*npm run runtime:smoke[\s\S]*name:\s*Check rollout readiness[\s\S]*run:\s*npm run rollout:readiness/
  );
  assert.match(workflow, /server\/evaluation\/results\/latest-rollout-readiness\.\*/);
  assert.match(workflow, /server\/evaluation\/results\/latest-runtime-smoke\.\*/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
});

test("robust eval suite is manual-only because the scheduled release gate owns the same suite", async () => {
  const workflow = await readFile(robustEvalSuiteWorkflowPath, "utf8");

  assert.match(workflow, /name:\s*Robust Eval Suite/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /schedule:/);
  assert.doesNotMatch(workflow, /cron:/);
  assert.match(workflow, /OPENAI_API_KEY:\s*\$\{\{\s*secrets\.OPENAI_API_KEY\s*\}\}/);
  assert.match(workflow, /working-directory:\s*server/);
  assert.match(workflow, /node-version:\s*"20"/);
  assert.match(workflow, /cache-dependency-path:\s*server\/package-lock\.json/);
  assert.match(workflow, /run:\s*npm ci/);
  assert.match(workflow, /name:\s*Require OpenAI key/);
  assert.match(workflow, /run:\s*test -n "\$OPENAI_API_KEY"/);
  assert.match(workflow, /run:\s*npm run eval:robust-suite/);
  assert.match(
    workflow,
    /run:\s*npm run quality:gate -- --fail-on-warn --require-robust-suite/
  );
  assert.match(workflow, /server\/evaluation\/results\/latest\.\*/);
  assert.match(workflow, /server\/evaluation\/results\/latest-rerank-hard-cs\.\*/);
  assert.match(workflow, /server\/evaluation\/results\/latest-arxiv-rerank\.\*/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
});

test("release evidence workflow pins manual and scheduled runs to one target SHA", async () => {
  const workflow = await readFile(releaseEvidenceWorkflowPath, "utf8");

  assert.match(workflow, /name:\s*Release Evidence Gate/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /schedule:\s*\n\s*-\s*cron:/);
  assert.doesNotMatch(workflow, /pull_request:/);
  assert.match(
    workflow,
    /EVAL_TARGET_COMMIT_SHA:\s*\$\{\{\s*github\.sha\s*\}\}/
  );
  assert.match(workflow, /EVAL_EVIDENCE_PROFILE:\s*release/);
  assert.match(
    workflow,
    /uses:\s*actions\/checkout@v4[\s\S]*ref:\s*\$\{\{\s*env\.EVAL_TARGET_COMMIT_SHA\s*\}\}/
  );
});

test("release evidence workflow generates every required report in one Postgres-backed job", async () => {
  const workflow = await readFile(releaseEvidenceWorkflowPath, "utf8");

  assert.match(workflow, /services:\s*\n\s*postgres:/);
  assert.match(workflow, /image:\s*postgres:16/);
  assert.match(workflow, /POSTGRES_DB:\s*agentai_smoke/);
  assert.match(
    workflow,
    /--health-cmd "pg_isready -U postgres -d agentai_smoke"/
  );
  assert.match(
    workflow,
    /POSTGRES_DATABASE_URL:\s*postgresql:\/\/postgres:postgres@127\.0\.0\.1:5432\/agentai_smoke/
  );
  assert.match(
    workflow,
    /LONG_MEMORY_DATABASE_URL:\s*postgresql:\/\/postgres:postgres@127\.0\.0\.1:5432\/agentai_smoke/
  );
  assert.match(
    workflow,
    /OPENAI_API_KEY:\s*\$\{\{\s*secrets\.OPENAI_API_KEY\s*\}\}/
  );
  assert.equal(
    workflow.match(/\$\{\{\s*secrets\.OPENAI_API_KEY\s*\}\}/g)?.length,
    1
  );
  assert.doesNotMatch(workflow, /run:\s*[^\n]*secrets\./);
  assert.match(workflow, /working-directory:\s*server/);
  assert.match(workflow, /node-version:\s*"20"/);
  assert.match(workflow, /cache-dependency-path:\s*server\/package-lock\.json/);
  assert.match(workflow, /run:\s*npm ci/);
  assert.match(workflow, /name:\s*Require OpenAI key/);
  assert.match(workflow, /run:\s*test -n "\$OPENAI_API_KEY"/);

  const robustSuiteIndex = workflow.indexOf(
    "run: npm run eval:robust-suite"
  );
  const robustGateCommand =
    "run: npm run quality:gate -- --fail-on-warn --require-robust-suite";
  const robustGateIndex = workflow.indexOf(robustGateCommand);

  assert.ok(robustSuiteIndex >= 0);
  assert.ok(
    robustGateIndex > robustSuiteIndex,
    "the scheduled release job must preserve the historical robust regression gate"
  );
  assert.doesNotMatch(workflow, /quality:gate[^\n]*--no-fail/);

  const reportCommands = [
    "npm run eval:robust-suite",
    "npm run eval:planner -- --provider mock",
    "npm run eval:planner -- --provider real",
    "npm run eval:trajectory",
    "npm run eval:recovery-observability",
    "npm run runtime:smoke",
    "npm run rollout:readiness",
  ];
  let previousCommandIndex = -1;

  for (const command of reportCommands) {
    const commandIndex = workflow.indexOf(`run: ${command}`);
    assert.ok(commandIndex > previousCommandIndex, `${command} must run in order`);
    previousCommandIndex = commandIndex;
  }
});

test("release evidence workflow gates the generated reports against its target SHA", async () => {
  const workflow = await readFile(releaseEvidenceWorkflowPath, "utf8");
  const readinessCommandIndex = workflow.indexOf(
    "run: npm run rollout:readiness"
  );
  const releaseGateCommand =
    'run: npm run release:gate -- --target-commit "$EVAL_TARGET_COMMIT_SHA"';
  const releaseGateCommandIndex = workflow.indexOf(releaseGateCommand);

  assert.ok(readinessCommandIndex >= 0);
  assert.ok(releaseGateCommandIndex > readinessCommandIndex);
  assert.doesNotMatch(workflow, /release:gate[^\n]*--no-fail/);
});

test("release evidence workflow still emits gate evidence after an eval failure", async () => {
  const workflow = await readFile(releaseEvidenceWorkflowPath, "utf8");
  const continueAfterFailure = "if: ${{ !cancelled() }}";

  assert.equal(
    workflow.split(continueAfterFailure).length - 1,
    9,
    "all report generators and both gates must run after prior failures"
  );
  assert.match(
    workflow,
    /name:\s*Check robust quality gate\s+if:\s*\$\{\{\s*!cancelled\(\)\s*\}\}\s+run:\s*npm run quality:gate -- --fail-on-warn --require-robust-suite/
  );
  assert.match(
    workflow,
    /name:\s*Check release evidence gate\s+if:\s*\$\{\{\s*!cancelled\(\)\s*\}\}\s+run:\s*npm run release:gate/
  );
});

test("release evidence workflow uploads the complete JSON and Markdown evidence bundle", async () => {
  const workflow = await readFile(releaseEvidenceWorkflowPath, "utf8");

  assert.match(workflow, /if:\s*always\(\)/);
  assert.match(workflow, /uses:\s*actions\/upload-artifact@v4/);
  assert.match(
    workflow,
    /name:\s*release-evidence-\$\{\{\s*env\.EVAL_TARGET_COMMIT_SHA\s*\}\}/
  );
  assert.match(workflow, /if-no-files-found:\s*error/);

  const reportNames = [
    "latest",
    "latest-rerank-hard-cs",
    "latest-arxiv-rerank",
    "latest-planner-mock",
    "latest-planner-real",
    "latest-trajectory",
    "latest-recovery-observability",
    "latest-runtime-smoke",
    "latest-rollout-readiness",
    "latest-release-evidence",
  ];

  for (const reportName of reportNames) {
    for (const extension of ["json", "md"]) {
      assert.ok(
        workflow.includes(
          `server/evaluation/results/${reportName}.${extension}`
        ),
        `${reportName}.${extension} must be uploaded`
      );
    }
  }
});
