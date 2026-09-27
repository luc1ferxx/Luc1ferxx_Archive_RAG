// Contract for the one-click deployment's cross-encoder reranker
// (docs/deployment.md, "交叉编码器重排"). What the rerank profile deploys must
// be what docs/evaluation.md measured: neural-cross-encoder-endpoint.py with
// the pinned neural-reranker-requirements.txt and BAAI/bge-reranker-v2-m3,
// returning raw logits that the QA gate reads with RAG_CROSS_ENCODER_SCORES=
// logits. A service that returned sigmoid probabilities instead would shift
// that gate without any error, so these files are pinned as text (no YAML
// dependency, like ci-workflow.test.mjs) and the override's app environment is
// fed through the real config readers.
import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getCrossEncoderEndpoint,
  getCrossEncoderModel,
  getCrossEncoderScoreScale,
  getRerankProvider,
  isRerankEnabled,
} from "../rag/config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repositoryRoot = path.resolve(__dirname, "..", "..");
const serverDirectory = path.join(repositoryRoot, "server");
const evaluationDirectory = path.join(serverDirectory, "evaluation");
const serviceDirectory = path.join(evaluationDirectory, "cross-encoder-service");

const composePath = path.join(repositoryRoot, "docker-compose.yml");
const rerankOverridePath = path.join(repositoryRoot, "compose.rerank.yml");
const rerankerDockerfilePath = path.join(serviceDirectory, "Dockerfile");
const rerankerDockerignorePath = path.join(serviceDirectory, "Dockerfile.dockerignore");
const standaloneComposePath = path.join(serviceDirectory, "compose.yaml");
const requirementsPath = path.join(evaluationDirectory, "neural-reranker-requirements.txt");
const endpointPath = path.join(evaluationDirectory, "neural-cross-encoder-endpoint.py");
const serverPackagePath = path.join(serverDirectory, "package.json");
const appDockerignorePath = path.join(repositoryRoot, ".dockerignore");

const measuredModel = "BAAI/bge-reranker-v2-m3";
const rerankerEndpoint = "http://reranker:8081/rerank";
const rerankerEnvironmentKeys = [
  "RAG_RERANK_ENABLED",
  "RAG_RERANK_PROVIDER",
  "RAG_CROSS_ENCODER_ENDPOINT",
  "RAG_CROSS_ENCODER_MODEL",
  "RAG_CROSS_ENCODER_SCORES",
];

const readText = (filePath) => readFile(filePath, "utf8");

const indentationOf = (line) => line.length - line.trimStart().length;

const isContentLine = (line) => {
  const trimmed = line.trim();

  return trimmed !== "" && !trimmed.startsWith("#");
};

// Lines nested under the first `key:` line at `indentation`, inside `lines`.
const nestedLines = (lines, key, indentation) => {
  const startIndex = lines.findIndex(
    (line) => indentationOf(line) === indentation && line.trim() === `${key}:`
  );

  if (startIndex === -1) {
    return null;
  }

  const block = [];

  for (const line of lines.slice(startIndex + 1)) {
    if (isContentLine(line) && indentationOf(line) <= indentation) {
      break;
    }

    block.push(line);
  }

  return block;
};

const serviceLines = (composeText, serviceName) => {
  const services = nestedLines(composeText.split("\n"), "services", 0);

  return services ? nestedLines(services, serviceName, 2) : null;
};

const serviceText = (composeText, serviceName) =>
  (serviceLines(composeText, serviceName) ?? []).join("\n");

// `${NAME:-default}` resolves to its default: the deployment must work with
// no shell variables set.
const resolveComposeDefault = (value) =>
  value.replace(/\$\{[A-Z0-9_]+:-([^}]*)\}/g, "$1");

const unquote = (value) => value.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");

const serviceEnvironment = (composeText, serviceName) => {
  const lines = serviceLines(composeText, serviceName);
  const environmentLines = lines ? nestedLines(lines, "environment", 4) : null;

  if (!environmentLines) {
    return {};
  }

  return Object.fromEntries(
    environmentLines.filter(isContentLine).map((line) => {
      const separator = line.indexOf(":");

      return [
        line.slice(0, separator).trim(),
        resolveComposeDefault(unquote(line.slice(separator + 1).trim())),
      ];
    })
  );
};

// The default the endpoint falls back to for `variable`, read from
// `os.environ.get("VARIABLE", "default")`. The measured run
// (`npm run rerank:cross-encoder`) set no overrides, so these defaults are the
// measured max length and batch size.
const endpointDefault = (endpointText, variable) =>
  endpointText.match(
    new RegExp(`os\\.environ\\.get\\("${variable}",\\s*"([^"]*)"\\)`)
  )?.[1];

const withEnvironment = (t, values) => {
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]])
  );

  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
};

test("the rerank profile builds the measured endpoint with its model cache", async () => {
  const compose = await readText(composePath);
  const reranker = serviceText(compose, "reranker");

  assert.ok(reranker, "docker-compose.yml must define a reranker service");
  assert.match(reranker, /^\s{4}profiles:\s*\["rerank"\]\s*$/m);
  assert.match(reranker, /^\s{6}context:\s*server\/evaluation\s*$/m);
  assert.match(reranker, /^\s{6}dockerfile:\s*cross-encoder-service\/Dockerfile\s*$/m);
  assert.match(
    reranker,
    /^\s{6}-\s*\.\/server\/evaluation\/generated\/huggingface:\/models\/huggingface\s*$/m,
    "the reranker must reuse the local Hugging Face cache instead of downloading again"
  );
  assert.equal(
    serviceEnvironment(compose, "reranker").RAG_CROSS_ENCODER_MODEL,
    measuredModel
  );
  assert.doesNotMatch(
    reranker,
    /^\s{4}ports:/m,
    "the app reaches the reranker on the compose network; no host port is needed"
  );
});

test("the base app service leaves rerank settings to server/.env", async () => {
  const compose = await readText(composePath);
  const appEnvironment = serviceEnvironment(compose, "app");

  assert.ok(Object.keys(appEnvironment).length > 0, "app environment must parse");

  // compose `environment` overrides env_file, so a default here would silently
  // replace a user's own rerank settings on every deployment.
  for (const key of Object.keys(appEnvironment)) {
    assert.doesNotMatch(key, /^RAG_(RERANK|CROSS_ENCODER|QA_MIN_RERANK)_/);
  }
  // Also in any other spelling (list-style `- KEY=value`, a second env block).
  assert.doesNotMatch(serviceText(compose, "app"), /RAG_(RERANK|CROSS_ENCODER|QA_MIN_RERANK)_/);
});

test("the rerank override wires the app to the reranker's logits", async (t) => {
  const [compose, override] = await Promise.all([
    readText(composePath),
    readText(rerankOverridePath),
  ]);
  const appEnvironment = serviceEnvironment(override, "app");

  assert.deepEqual(Object.keys(appEnvironment).sort(), [...rerankerEnvironmentKeys].sort());
  assert.equal(appEnvironment.RAG_CROSS_ENCODER_ENDPOINT, rerankerEndpoint);
  assert.equal(appEnvironment.RAG_CROSS_ENCODER_SCORES, "logits");
  assert.equal(
    appEnvironment.RAG_CROSS_ENCODER_MODEL,
    serviceEnvironment(compose, "reranker").RAG_CROSS_ENCODER_MODEL,
    "the app sends its model name and the endpoint rejects a different one"
  );
  assert.match(
    override,
    /RAG_CROSS_ENCODER_MODEL:\s*\$\{RAG_CROSS_ENCODER_MODEL:-BAAI\/bge-reranker-v2-m3\}/
  );
  assert.match(
    serviceText(override, "app"),
    /depends_on:\s*\n\s+reranker:\s*\n\s+condition:\s*service_healthy/
  );

  withEnvironment(t, appEnvironment);
  assert.equal(isRerankEnabled(), true);
  assert.equal(getRerankProvider(), "cross-encoder");
  assert.equal(getCrossEncoderEndpoint(), rerankerEndpoint);
  assert.equal(getCrossEncoderModel(), measuredModel);
  assert.equal(getCrossEncoderScoreScale(), "logits");
});

test("the reranker image runs neural-cross-encoder-endpoint.py with the pinned requirements", async () => {
  const [dockerfile, dockerignore, requirements, endpoint] = await Promise.all([
    readText(rerankerDockerfilePath),
    readText(rerankerDockerignorePath),
    readText(requirementsPath),
    readText(endpointPath),
  ]);
  const measuredMaxLength = endpointDefault(endpoint, "RAG_CROSS_ENCODER_MAX_LENGTH");
  const measuredBatchSize = endpointDefault(endpoint, "RAG_CROSS_ENCODER_BATCH_SIZE");

  assert.ok(measuredMaxLength && measuredBatchSize, "endpoint defaults must parse");

  assert.match(dockerfile, /^COPY neural-reranker-requirements\.txt \.\/$/m);
  assert.match(dockerfile, /pip install --no-cache-dir -r neural-reranker-requirements\.txt/);
  assert.match(dockerfile, /grep -E '\^torch==' neural-reranker-requirements\.txt/);
  assert.match(dockerfile, /^COPY neural-cross-encoder-endpoint\.py \.\/$/m);
  assert.match(dockerfile, /^CMD \["python", "neural-cross-encoder-endpoint\.py"\]$/m);
  assert.doesNotMatch(dockerfile, /sentence-transformers|app\.py|uvicorn app:app/);

  for (const setting of [
    "HF_HOME=/models/huggingface",
    `RAG_CROSS_ENCODER_MODEL=${measuredModel}`,
    `RAG_CROSS_ENCODER_MAX_LENGTH=${measuredMaxLength}`,
    `RAG_CROSS_ENCODER_BATCH_SIZE=${measuredBatchSize}`,
    "RAG_CROSS_ENCODER_DEVICE=cpu",
    "RAG_CROSS_ENCODER_HOST=0.0.0.0",
    "RAG_CROSS_ENCODER_PORT=8081",
  ]) {
    assert.ok(dockerfile.includes(setting), `Dockerfile must set ${setting}`);
  }

  assert.match(dockerfile, /^HEALTHCHECK .*--start-period=\d+m/m);
  assert.deepEqual(dockerignore.split("\n").filter(isContentLine), [
    "*",
    "!neural-cross-encoder-endpoint.py",
    "!neural-reranker-requirements.txt",
  ]);

  const pins = requirements.split("\n").filter(isContentLine);

  assert.ok(pins.length > 0);
  for (const pin of pins) {
    assert.match(pin, /^[A-Za-z0-9_.\-[\]]+==\S+$/, `${pin} must be pinned exactly`);
  }
  assert.ok(pins.some((pin) => pin.startsWith("torch==")));
  assert.ok(pins.some((pin) => pin.startsWith("transformers==")));
  assert.ok(!pins.some((pin) => pin.startsWith("sentence-transformers")));
});

test("the measured endpoint returns logits and honours the container settings", async () => {
  const endpoint = await readText(endpointPath);

  assert.match(endpoint, /AutoModelForSequenceClassification/);
  assert.match(endpoint, /\.logits\.squeeze\(-1\)/);
  assert.doesNotMatch(endpoint, /sigmoid/);
  assert.match(endpoint, /with self\.lock:/);

  for (const variable of [
    "RAG_CROSS_ENCODER_MODEL",
    "RAG_CROSS_ENCODER_MAX_LENGTH",
    "RAG_CROSS_ENCODER_BATCH_SIZE",
    "RAG_CROSS_ENCODER_DEVICE",
    "RAG_CROSS_ENCODER_HOST",
    "RAG_CROSS_ENCODER_PORT",
  ]) {
    assert.ok(endpoint.includes(`"${variable}"`), `endpoint must read ${variable}`);
  }
  assert.match(endpoint, /@app\.post\("\/rerank"\)/);
  assert.match(endpoint, /@app\.get\("\/health"\)/);
});

test("the standalone reranker compose file builds the same image", async () => {
  const [standalone, packageJson, endpoint] = await Promise.all([
    readText(standaloneComposePath),
    readText(serverPackagePath).then(JSON.parse),
    readText(endpointPath),
  ]);
  const reranker = serviceText(standalone, "reranker");
  const standaloneEnvironment = serviceEnvironment(standalone, "reranker");

  assert.match(reranker, /^\s{6}context:\s*\.\.\s*$/m);
  assert.match(reranker, /^\s{6}dockerfile:\s*cross-encoder-service\/Dockerfile\s*$/m);
  assert.match(reranker, /^\s{6}-\s*\.\.\/generated\/huggingface:\/models\/huggingface\s*$/m);
  assert.equal(standaloneEnvironment.RAG_CROSS_ENCODER_MODEL, measuredModel);
  for (const variable of ["RAG_CROSS_ENCODER_MAX_LENGTH", "RAG_CROSS_ENCODER_BATCH_SIZE"]) {
    assert.equal(
      standaloneEnvironment[variable],
      endpointDefault(endpoint, variable),
      `${variable} must default to the measured value`
    );
  }

  const dockerScript = packageJson.scripts?.["rerank:cross-encoder:docker"] ?? "";
  const composeFile = dockerScript.match(/-f\s+(\S+)/)?.[1];

  assert.ok(composeFile, "rerank:cross-encoder:docker must name its compose file");
  await access(path.join(serverDirectory, composeFile));
  assert.equal(path.join(serverDirectory, composeFile), standaloneComposePath);
});

test("the app image context leaves out secrets, the model cache and the reranker venv", async () => {
  // The app Dockerfile copies server/ whole; anything not ignored here ends up
  // in the image (server/.env, the 2 GB Hugging Face cache, the 1 GB venv).
  const patterns = (await readText(appDockerignorePath)).split("\n").filter(isContentLine);

  for (const pattern of ["**/.env", "server/evaluation/generated", "server/evaluation/.venv*"]) {
    assert.ok(patterns.includes(pattern), `.dockerignore must contain ${pattern}`);
  }
});
