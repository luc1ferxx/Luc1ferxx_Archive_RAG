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
const rootPackagePath = path.join(repositoryRoot, "package.json");
const serverPackagePath = path.join(repositoryRoot, "server", "package.json");

test("quality gate workflow cancels superseded runs on the same ref", async () => {
  const content = await readFile(workflowPath, "utf8");

  assert.match(
    content,
    /concurrency:\s*\n\s*group:\s*\$\{\{\s*github\.workflow\s*\}\}-\$\{\{\s*github\.ref\s*\}\}\s*\n\s*cancel-in-progress:\s*true/,
    `${path.basename(workflowPath)} must cancel an older run for the same workflow and ref`
  );
});

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

test("server exposes a dedicated robust-suite gate", async () => {
  const packageJson = JSON.parse(await readFile(serverPackagePath, "utf8"));

  assert.equal(
    packageJson.scripts?.["robust:gate"],
    "node evaluation/check-robust-suite.mjs"
  );
});

test("quality gate workflow runs frontend checks in an independent root job", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const frontendJobMatch = workflow.match(
    /\n  frontend-checks:\n([\s\S]*?)(?=\n  [a-zA-Z0-9_-]+:\n|$)/
  );

  assert.ok(frontendJobMatch, "frontend-checks must be a top-level job");

  const frontendJob = frontendJobMatch[0];

  assert.match(frontendJob, /runs-on:\s*ubuntu-24\.04/);
  assert.match(frontendJob, /node-version:\s*"22"/);
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

test("quality gate workflow runs the backend suite once, under the coverage gate", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const serverJobMatch = workflow.match(
    /\n  server-tests:\n([\s\S]*?)(?=\n  [a-zA-Z0-9_-]+:\n|$)/
  );

  assert.ok(serverJobMatch, "server-tests must be a top-level job");

  const serverJob = serverJobMatch[0];
  const installIndex = serverJob.indexOf("run: npm ci");
  const coverageIndex = serverJob.indexOf("run: npm run coverage:gate");

  assert.ok(installIndex >= 0, "server-tests must install dependencies");
  assert.ok(
    coverageIndex > installIndex,
    "server-tests must run the backend tests through the coverage gate"
  );
  assert.equal(
    serverJob.match(/run:\s*npm run coverage:gate/g)?.length,
    1,
    "the coverage gate runs once"
  );
  assert.doesNotMatch(
    serverJob,
    /run:\s*npm (run )?test\b/,
    "npm test would run the same test files a second time"
  );
  assert.match(
    serverJob,
    /\n    timeout-minutes:\s*20\n/,
    "server-tests must have a job-level timeout"
  );
});

test("coverage gate discovers exactly the test files npm test runs", async () => {
  // The workflow drops npm test because coverage:gate runs the same files.
  // Pin both discoveries so that stays true: every test/*.test.mjs except
  // the runner itself, read from the same directory.
  const serverPackage = JSON.parse(await readFile(serverPackagePath, "utf8"));
  const runner = await readFile(path.join(__dirname, "run.test.mjs"), "utf8");
  const coverageGate = await readFile(
    path.join(__dirname, "coverage-gate.mjs"),
    "utf8"
  );
  const compact = (source) => source.replace(/\s+/g, "");

  assert.equal(serverPackage.scripts.test, "node test/run.test.mjs");
  assert.equal(serverPackage.scripts["coverage:gate"], "node test/coverage-gate.mjs");

  assert.ok(compact(runner).includes("readdir(__dirname,"));
  assert.ok(
    compact(runner).includes(
      '.filter((fileName)=>fileName.endsWith(".test.mjs")&&fileName!=="run.test.mjs")'
    ),
    "npm test runs every *.test.mjs except run.test.mjs"
  );

  assert.ok(
    compact(coverageGate).includes(
      'consttestDirectory=path.join(serverDirectory,"test");'
    )
  );
  assert.ok(
    compact(coverageGate).includes(
      'constserverDirectory=path.join(__dirname,"..");'
    )
  );
  assert.ok(compact(coverageGate).includes("readdir(testDirectory,"));
  assert.ok(
    compact(coverageGate).includes(
      'constTEST_FILE_EXCLUDES=newSet(["run.test.mjs",]);'
    ),
    "the coverage gate excludes only the runner"
  );
  assert.ok(
    compact(coverageGate).includes(
      'fileName.endsWith(".test.mjs")&&!TEST_FILE_EXCLUDES.has(fileName)'
    ),
    "the coverage gate runs every *.test.mjs not excluded"
  );
  assert.ok(
    compact(coverageGate).includes(
      "if(coverageResult.exitCode!==0){"
    ),
    "a failing test must fail the coverage gate"
  );
});

test("npm test and the coverage gate hand their test children no LangSmith tracing variable", async () => {
  // Every suite that runs a guarded graph reaches the LangGraph executor (the
  // only graph scheduler since ADR 0001 phase 6), which refuses to run while
  // a LangSmith tracing variable is "true". Both runners strip them from the
  // child environment so a developer shell cannot fail those suites.
  const compact = (source) => source.replace(/\s+/g, "");

  for (const file of ["run.test.mjs", "coverage-gate.mjs"]) {
    const source = compact(await readFile(path.join(__dirname, file), "utf8"));

    assert.ok(
      source.includes('import{LANGSMITH_TRACING_VARIABLES}from"../rag/langgraph/langsmith-guard.js";'),
      `${file} takes the variable list from the production guard`
    );
    assert.ok(
      source.includes(
        "constenvironment={...process.env};for(constnameofLANGSMITH_TRACING_VARIABLES){deleteenvironment[name];}"
      ),
      `${file} removes every LangSmith tracing variable`
    );
    assert.ok(source.includes("env:childEnvironment(),"), `${file} spawns with the stripped environment`);
    assert.equal(source.includes("env:process.env"), false, `${file} never hands the raw environment on`);
  }
});

test("quality gate workflow regenerates and validates current-commit evidence", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /name:\s*Quality Gate/);
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /push:/);
  assert.match(workflow, /branches:\s*\n\s*-\s*main/);
  assert.match(workflow, /working-directory:\s*server/);
  assert.match(workflow, /node-version:\s*"22"/);
  assert.match(workflow, /cache-dependency-path:\s*server\/package-lock\.json/);
  assert.match(workflow, /run:\s*npm ci/);
  assert.match(workflow, /run:\s*npm test/);
  assert.match(workflow, /\n  server-tests:\n/);
  assert.match(
    workflow,
    /server-tests:[\s\S]*run:\s*npm run coverage:gate[\s\S]*quality-gate:/,
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
  assert.doesNotMatch(workflow, /OPENAI_API_KEY/);
  assert.match(workflow, /name:\s*Run planner eval \(mock\)/);
  assert.match(workflow, /run:\s*npm run eval:planner -- --provider mock/);
  assert.doesNotMatch(workflow, /name:\s*Run planner eval \(real\)/);
  assert.doesNotMatch(workflow, /run:\s*npm run eval:planner -- --provider real/);
  assert.match(workflow, /name:\s*Run recovery observability eval/);
  assert.match(workflow, /run:\s*npm run eval:recovery-observability/);
  assert.match(workflow, /name:\s*Run feedback regression eval/);
  assert.match(workflow, /run:\s*npm run eval:feedback/);
  assert.match(workflow, /name:\s*Check current quality gate/);
  assert.match(
    workflow,
    /run:\s*npm run quality:current -- --target-commit "\$EVAL_TARGET_COMMIT_SHA"/
  );
  assert.doesNotMatch(workflow, /--require-planner-real/);
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
  assert.match(workflow, /uses:\s*actions\/upload-artifact@v7/);
  assert.match(
    workflow,
    /server\/evaluation\/results\/latest-current-quality-gate\.\*/
  );
  assert.match(workflow, /if-no-files-found:\s*error/);
});

test("quality gate workflow backs the current profile and the integration suite with pgvector", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const serverTestsJob = workflow.match(
    /\n  server-tests:\n([\s\S]*?)(?=\n  [a-zA-Z0-9_-]+:\n|$)/
  )?.[0];
  const qualityGateJob = workflow.match(
    /\n  quality-gate:\n([\s\S]*?)(?=\n  [a-zA-Z0-9_-]+:\n|$)/
  )?.[0];

  assert.ok(serverTestsJob, "server-tests must be a top-level job");
  assert.ok(qualityGateJob, "quality-gate must be a top-level job");

  // Integration tests need a real pgvector database; the address is passed
  // under a dedicated name so the default-provider tests still see no
  // POSTGRES_DATABASE_URL and keep proving fail-closed behaviour.
  assert.match(serverTestsJob, /image:\s*pgvector\/pgvector:pg16/);
  assert.match(
    serverTestsJob,
    /PGVECTOR_TEST_DATABASE_URL:\s*postgresql:\/\/postgres:postgres@127\.0\.0\.1:5432\/agentai_test/
  );
  assert.doesNotMatch(serverTestsJob, /\n\s*POSTGRES_DATABASE_URL:/);

  // The current quality profile is the PR-time proof that pgvector + hybrid +
  // RRF actually ran; quality:current rejects reports that say otherwise.
  assert.match(qualityGateJob, /image:\s*pgvector\/pgvector:pg16/);
  assert.match(
    qualityGateJob,
    /POSTGRES_DATABASE_URL:\s*postgresql:\/\/postgres:postgres@127\.0\.0\.1:5432\/agentai_quality/
  );
  assert.match(qualityGateJob, /VECTOR_STORE_PROVIDER:\s*pgvector/);
  assert.match(qualityGateJob, /RAG_HYBRID_ENABLED:\s*"true"/);
  assert.match(qualityGateJob, /RAG_HYBRID_FUSION:\s*rrf/);
});

test("real model eval workflow runs a real local model with no API key and gates on its reports", async () => {
  const content = await readFile(
    path.join(repositoryRoot, ".github", "workflows", "real-model-eval.yml"),
    "utf8"
  );
  const serverPackage = JSON.parse(await readFile(serverPackagePath, "utf8"));

  assert.match(content, /workflow_dispatch:/);
  assert.match(content, /schedule:\s*\n\s*- cron:/);
  assert.match(
    content,
    /concurrency:\s*\n\s*group:\s*\$\{\{\s*github\.workflow\s*\}\}-\$\{\{\s*github\.ref\s*\}\}\s*\n\s*cancel-in-progress:\s*true/
  );
  assert.doesNotMatch(content, /secrets\./, "no paid API key: Ollama serves the models");
  assert.match(content, /OPENAI_BASE_URL: http:\/\/127\.0\.0\.1:11434\/v1/);
  assert.match(content, /ollama pull nomic-embed-text/);
  // The blocking steps, each backed by a real package script.
  for (const script of ["verify:quality", "corpus:qasper", "eval:qasper-retrieval", "eval:qasper-answers"]) {
    assert.ok(serverPackage.scripts[script], `server package defines ${script}`);
    assert.match(content, new RegExp(`npm run ${script}`));
  }
  assert.match(content, /eval:qasper-retrieval -- .*--min-hit-at-all 0\.6/);
  assert.match(content, /if: always\(\)\s*\n\s*uses: actions\/upload-artifact@v7/);

  // The answer sample runs under the answer-side protocol (temperature 0 with
  // the output limit, docs/evaluation.md), set on its own step: the blocking
  // steps before it keep the endpoint default.
  const answerStepStart = content.indexOf("- name: QASPER answers");
  const answerStepEnd = content.indexOf("- name: Upload real-model reports");

  assert.ok(answerStepStart > 0 && answerStepEnd > answerStepStart, "the answer step precedes the upload step");

  const answerStep = content.slice(answerStepStart, answerStepEnd);

  assert.match(answerStep, /\n\s*env:\s*\n(?:\s*#[^\n]*\n)*\s*RAG_ANSWER_TEMPERATURE: "0"\s*\n\s*RAG_ANSWER_MAX_TOKENS: "1024"\s*\n/);
  assert.match(answerStep, /npm run eval:qasper-answers/);
  assert.doesNotMatch(content.slice(0, answerStepStart), /RAG_ANSWER_TEMPERATURE|RAG_ANSWER_MAX_TOKENS/);

  // Right before the answer sample, under the same condition, a probe that the
  // endpoint honours the limit's field (evaluation/probe-output-limit.mjs):
  // Ollama ignores max_completion_tokens, and a pinned version that stopped
  // honouring max_tokens would leave the answer step without a limit. Neither
  // step sets the field, so the probe checks the one the answers use.
  // Between the probe and the answers, under the same condition, the chat model
  // is unloaded: the answers start on a freshly loaded model, as they did
  // before the probe existed, so nothing the probe left in Ollama's prompt
  // cache reaches them (docs/evaluation.md "之后在 CI 上").
  const probeStepStart = content.indexOf("- name: Check the answer output limit");
  const unloadStepStart = content.indexOf("- name: Unload the chat model after the probe");
  const retrievalStepStart = content.indexOf("- name: QASPER evidence recall");

  assert.ok(
    retrievalStepStart < probeStepStart && probeStepStart < unloadStepStart && unloadStepStart < answerStepStart,
    "retrieval, then the probe, the unload and the answers"
  );

  const probeStep = content.slice(probeStepStart, unloadStepStart);
  const unloadStep = content.slice(unloadStepStart, answerStepStart);

  assert.equal(probeStep.match(/- name:/g).length, 1, "no other step between the probe and the unload");
  assert.equal(unloadStep.match(/- name:/g).length, 1, "no other step between the unload and the answers");
  for (const step of [probeStep, unloadStep, answerStep]) {
    assert.match(step, /\n\s*if: env\.QASPER_ANSWER_CASES != '0'\s*\n/);
  }
  assert.match(probeStep, /\n\s*run: npm run probe:output-limit\s*$/);
  assert.match(unloadStep, /\n\s*ollama stop "\$OPENAI_CHAT_MODEL"/);
  assert.equal(serverPackage.scripts["probe:output-limit"], "node evaluation/probe-output-limit.mjs");
  assert.doesNotMatch(content, /RAG_LLM_MAX_TOKENS_FIELD/);

  // Every run records the runner's CPU before the model steps: answers at
  // temperature 0 differed between two CI runs (docs/deployment.md), and
  // other hardware is the likelier cause. nproc counts logical CPUs, so the
  // physical cores are read as well.
  const cpuStepStart = content.indexOf("- name: Record the runner's CPU");
  const ollamaStepStart = content.indexOf("- name: Install and start Ollama");
  const verifyStepStart = content.indexOf("- name: Real-model quality verification");

  assert.ok(cpuStepStart > ollamaStepStart && cpuStepStart < verifyStepStart, "the CPU is recorded after Ollama starts, before the first model step");

  const cpuStep = content.slice(cpuStepStart, verifyStepStart);

  assert.equal(cpuStep.match(/- name:/g).length, 1);
  for (const fact of [/model name' \/proc\/cpuinfo/, /Logical CPUs: \$\(nproc\)/, /'cpu cores' \/proc\/cpuinfo/, /\bavx512f\b/, /ollama --version/]) {
    assert.match(cpuStep, fact);
  }
  assert.doesNotMatch(cpuStep, /\n\s*if:/, "recorded on every run");
});
