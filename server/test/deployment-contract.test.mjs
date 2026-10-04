// Contract for the one-click deployment's cross-encoder reranker
// (docs/deployment.md, "交叉编码器重排"). What the rerank profile deploys must
// be what docs/evaluation.md measured: neural-cross-encoder-endpoint.py with
// the pinned neural-reranker-requirements.txt and BAAI/bge-reranker-v2-m3,
// returning raw logits that the QA gate reads with RAG_CROSS_ENCODER_SCORES=
// logits. A service that returned sigmoid probabilities instead would shift
// that gate without any error, so these files are pinned as text (no YAML
// dependency, like ci-workflow.test.mjs) and the override's app environment is
// fed through the real config readers.
//
// The split deployment (compose.services.yml) is pinned the same way: four
// services of the one app image, one ARCHIVE_RAG_ROLE each, only the api
// published, internal keys only from the shell (under ed25519 each calling
// tier's own private key from its own variable, the public keys shared, as
// service-keys.mjs exports them), and every tier's environment fed through
// the real topology validator and port resolution, so the URLs the tiers call
// are where their neighbours listen and a tier without keys does not start.
import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  getCrossEncoderEndpoint,
  getCrossEncoderModel,
  getCrossEncoderScoreScale,
  getRerankProvider,
  getServiceShutdownGraceMs,
  isRerankEnabled,
} from "../rag/config.js";
import { resolveRolePort } from "../rag/agent-service/role-server.js";
import { MODEL_GATEWAY_PATHS } from "../rag/model-gateway/protocol.js";
import { signServiceToken, verifyServiceToken } from "../rag/service-identity.js";
import { describeServiceTopology, validateServiceTopology } from "../rag/service-topology.js";
import { COMPOSE_SIGNING_KEY_VARIABLES, runServiceKeysCommand } from "../service-keys.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repositoryRoot = path.resolve(__dirname, "..", "..");
const serverDirectory = path.join(repositoryRoot, "server");
const evaluationDirectory = path.join(serverDirectory, "evaluation");
const serviceDirectory = path.join(evaluationDirectory, "cross-encoder-service");

const composePath = path.join(repositoryRoot, "docker-compose.yml");
const rerankOverridePath = path.join(repositoryRoot, "compose.rerank.yml");
const servicesOverridePath = path.join(repositoryRoot, "compose.services.yml");
const appDockerfilePath = path.join(repositoryRoot, "Dockerfile");
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

// Service name -> ARCHIVE_RAG_ROLE in compose.services.yml.
const tierRoles = Object.freeze({
  agent: "agent",
  api: "api",
  "model-gateway": "model-gateway",
  retrieval: "retrieval",
});
const tierServiceNames = Object.keys(tierRoles);
// What the deploying shell exports for the default (hmac) scheme.
const hmacShell = Object.freeze({ INTERNAL_SERVICE_KEYS: `deploy-contract:${"k".repeat(40)}` });
const identityVariables = [
  "INTERNAL_SERVICE_AUTH",
  "INTERNAL_SERVICE_KEYS",
  "INTERNAL_SERVICE_SIGNING_KEY",
  "INTERNAL_SERVICE_TRUSTED_KEYS",
];

// A service's environment block as written, `${...}` left in place.
const rawServiceEnvironment = (composeText, serviceName) => {
  const lines = serviceLines(composeText, serviceName);
  const environmentLines = lines ? nestedLines(lines, "environment", 4) : null;

  return Object.fromEntries(
    (environmentLines ?? []).filter(isContentLine).map((line) => {
      const separator = line.indexOf(":");

      return [line.slice(0, separator).trim(), unquote(line.slice(separator + 1).trim())];
    })
  );
};

// Compose interpolation: `${NAME:-default}` takes the shell's value when it is
// set and not empty, and the default otherwise.
const interpolate = (value, shell) =>
  value.replace(/\$\{([A-Z0-9_]+):-([^}]*)\}/g, (match, name, fallback) => shell[name] || fallback);

// A tier's environment as the container gets it from `shell`.
const tierEnvironment = (composeText, serviceName, shell = hmacShell) =>
  Object.fromEntries(
    Object.entries(rawServiceEnvironment(composeText, serviceName)).map(([key, value]) => [
      key,
      interpolate(value, shell),
    ])
  );

// The exports `node service-keys.mjs compose` prints, as a shell would hold them.
const generateEd25519Shell = () => {
  const lines = [];
  const code = runServiceKeysCommand({
    argv: ["compose"],
    env: {},
    stderr: { write: () => true },
    stdout: { write: (text) => lines.push(...text.split("\n").filter(Boolean)) },
  });

  assert.equal(code, 0);

  return Object.fromEntries(
    lines.map((line) => {
      const match = line.match(/^export ([A-Z0-9_]+)=(.*)$/);

      assert.ok(match, "the compose command prints export lines only");

      return [match[1], match[2]];
    })
  );
};

// The port a tier listens on, as server.js resolves it for its role.
const listeningPort = (t, environment) => {
  withEnvironment(t, {
    MODEL_GATEWAY_PORT: environment.MODEL_GATEWAY_PORT ?? "",
    PORT: environment.PORT ?? "",
  });

  return resolveRolePort(environment.ARCHIVE_RAG_ROLE, environment);
};

const healthcheckTarget = (composeText, serviceName) => {
  const match = serviceText(composeText, serviceName).match(
    /fetch\('http:\/\/127\.0\.0\.1:(\d+)(\/[a-z]+)'\)/
  );

  return match ? { path: match[2], port: Number(match[1]) } : null;
};

const dependsOn = (composeText, serviceName) => {
  const lines = nestedLines(serviceLines(composeText, serviceName) ?? [], "depends_on", 4) ?? [];
  const dependencies = {};
  let current = null;

  for (const line of lines.filter(isContentLine)) {
    if (indentationOf(line) === 6) {
      current = line.trim().replace(/:$/, "");
      dependencies[current] = null;
    } else if (current) {
      dependencies[current] = line.trim().match(/^condition:\s*(\S+)$/)?.[1] ?? dependencies[current];
    }
  }

  return dependencies;
};

test("the split deployment runs four tiers of the app image, one role each", async () => {
  const [compose, override, dockerfile] = await Promise.all([
    readText(composePath),
    readText(servicesOverridePath),
    readText(appDockerfilePath),
  ]);
  const appImage = serviceText(compose, "app").match(/^\s{4}image:\s*(\S+)\s*$/m)?.[1];

  assert.ok(appImage, "the base app service names its image");
  assert.match(dockerfile, /^CMD \["node", "server\.js"\]$/m, "the image starts every role through server.js");

  for (const serviceName of tierServiceNames) {
    const text = serviceText(override, serviceName);

    assert.ok(text, `compose.services.yml must define ${serviceName}`);
    assert.equal(serviceEnvironment(override, serviceName).ARCHIVE_RAG_ROLE, tierRoles[serviceName]);
    assert.match(text, /^\s{4}build:\s*\.\s*$/m, `${serviceName} builds the app Dockerfile`);
    assert.equal(text.match(/^\s{4}image:\s*(\S+)\s*$/m)?.[1], appImage, `${serviceName} is the app image`);
    // `docker compose up --scale` needs generated container names, and the
    // image's own entry point is what picks the role.
    assert.doesNotMatch(text, /^\s{4}(container_name|command|entrypoint):/m);
    assert.match(text, /^\s{4}healthcheck:/m);
  }
});

test("only the api publishes a port, and internal keys come from the shell alone", async (t) => {
  const override = await readText(servicesOverridePath);

  for (const serviceName of tierServiceNames.filter((name) => name !== "api")) {
    assert.doesNotMatch(serviceText(override, serviceName), /^\s{4}ports:/m, `${serviceName} stays internal`);
  }

  const apiPorts = nestedLines(serviceLines(override, "api"), "ports", 4).filter(isContentLine);

  assert.deepEqual(apiPorts.map((line) => line.trim()), [
    '- "${ARCHIVE_RAG_BIND_HOST:-127.0.0.1}:${ARCHIVE_RAG_API_PORTS:-5001}:5001"',
  ]);
  assert.equal(listeningPort(t, tierEnvironment(override, "api")), 5001);

  for (const serviceName of tierServiceNames) {
    const environment = rawServiceEnvironment(override, serviceName);
    const signingVariable = COMPOSE_SIGNING_KEY_VARIABLES[tierRoles[serviceName]];

    // Every identity setting is a shell variable with no key as its default:
    // the scheme defaults to hmac, every key to nothing.
    assert.equal(environment.INTERNAL_SERVICE_AUTH, "${INTERNAL_SERVICE_AUTH:-hmac}", serviceName);
    assert.equal(environment.INTERNAL_SERVICE_KEYS, "${INTERNAL_SERVICE_KEYS:-}", `${serviceName} shares the hmac keyring`);
    assert.equal(
      environment.INTERNAL_SERVICE_TRUSTED_KEYS,
      "${INTERNAL_SERVICE_TRUSTED_KEYS:-}",
      `${serviceName} shares the trusted public keys`
    );

    // Each calling tier has its own private key in its own shell variable,
    // the one service-keys.mjs exports for it; the gateway calls nobody.
    if (signingVariable) {
      assert.equal(environment.INTERNAL_SERVICE_SIGNING_KEY, `\${${signingVariable}:-}`, `${serviceName} signs with its own key`);
    } else {
      assert.equal(environment.INTERNAL_SERVICE_SIGNING_KEY, undefined, `${serviceName} holds no signing key`);
    }

    // Model keys and public tokens come from server/.env, rerank settings too
    // (as for the base app service): compose `environment` would override them.
    for (const key of Object.keys(environment)) {
      assert.doesNotMatch(key, /^(OPENAI_|API_AUTH_|RAG_(RERANK|CROSS_ENCODER|QA_MIN_RERANK)_)/, `${serviceName}: ${key}`);
    }
  }

  assert.deepEqual(
    Object.keys(COMPOSE_SIGNING_KEY_VARIABLES).sort(),
    tierServiceNames.filter((name) => name !== "model-gateway").map((name) => tierRoles[name]).sort()
  );

  // No literal key and no key default anywhere in the file: every identity
  // line reads the shell, and only the scheme has a (non-secret) default.
  const identityLines = override.split("\n").filter((line) => /^\s+INTERNAL_SERVICE_[A-Z_]+:/.test(line));

  for (const line of identityLines) {
    assert.match(line.trim(), /^INTERNAL_SERVICE_[A-Z_]+: \$\{INTERNAL_SERVICE_[A-Z_]+:-(hmac)?\}$/, line.trim());
  }

  assert.equal(identityLines.length, identityVariables.length * tierServiceNames.length - 1);
});

test("a tier without keys from the shell refuses to start, in either scheme", async () => {
  const override = await readText(servicesOverridePath);

  for (const shell of [{}, { INTERNAL_SERVICE_AUTH: "ed25519" }, { INTERNAL_SERVICE_AUTH: "mixed" }]) {
    for (const serviceName of tierServiceNames) {
      const { errors } = validateServiceTopology(tierEnvironment(override, serviceName, shell));

      assert.ok(errors.length > 0, `${serviceName} under ${JSON.stringify(shell)} must refuse to start`);
    }
  }
});

test("under ed25519 each tier signs with its own key and verifies with the shared list", async () => {
  const override = await readText(servicesOverridePath);
  const shell = generateEd25519Shell();
  const trusted = Object.fromEntries(
    shell.INTERNAL_SERVICE_TRUSTED_KEYS.split(",").map((entry) => {
      const [issuer, keyId] = entry.split(":");

      return [issuer, keyId];
    })
  );
  const environments = Object.fromEntries(
    tierServiceNames.map((serviceName) => [serviceName, tierEnvironment(override, serviceName, shell)])
  );

  assert.equal(shell.INTERNAL_SERVICE_AUTH, "ed25519");

  for (const [serviceName, environment] of Object.entries(environments)) {
    const role = tierRoles[serviceName];
    const description = describeServiceTopology(environment);
    const ownKey = COMPOSE_SIGNING_KEY_VARIABLES[role] ? shell[COMPOSE_SIGNING_KEY_VARIABLES[role]] : null;

    assert.deepEqual(validateServiceTopology(environment), { errors: [], warnings: [] }, serviceName);
    assert.equal(description.internalIdentity.mode, "ed25519");
    assert.equal(description.internalIdentity.issuer, role);
    assert.equal(description.internalIdentity.signingKeyId, trusted[role] ?? null, `${serviceName} signs with its own key id`);
    assert.equal(environment.INTERNAL_SERVICE_SIGNING_KEY ?? "", ownKey ?? "");

    // No tier's environment holds another tier's private key.
    for (const [variable, value] of Object.entries(shell)) {
      if (variable.startsWith("INTERNAL_SERVICE_SIGNING_KEY_") && value !== ownKey) {
        assert.ok(!Object.values(environment).includes(value), `${serviceName} must not hold ${variable}`);
      }
    }
  }

  // The edge's token reaches the agent; the retrieval tier's key cannot speak
  // for the edge there.
  const request = { body: '{"question":"q"}', method: "POST", target: "/chat" };
  const scope = { authenticated: true, userId: "alice", workspaceId: "ws-1" };
  const fromApi = signServiceToken({ accessScope: scope, audience: "agent", env: environments.api, issuer: "api", request });
  const forged = signServiceToken({ accessScope: scope, audience: "agent", env: environments.retrieval, issuer: "api", request });

  assert.equal(
    verifyServiceToken(fromApi, { audience: "agent", env: environments.agent, request: { ...request, hasBody: true } }).issuer,
    "api"
  );
  assert.throws(
    () => verifyServiceToken(forged, { audience: "agent", env: environments.agent, request: { ...request, hasBody: true } }),
    (error) => error.code === "SERVICE_TOKEN_KEY_ISSUER"
  );

  // mixed (the rolling upgrade) also starts on every tier once both sets are exported.
  for (const serviceName of tierServiceNames) {
    const environment = tierEnvironment(override, serviceName, { ...hmacShell, ...shell, INTERNAL_SERVICE_AUTH: "mixed" });

    assert.deepEqual(validateServiceTopology(environment).errors, [], serviceName);
  }
});

test("each tier's environment passes the topology validator and calls its neighbours where they listen", async (t) => {
  const override = await readText(servicesOverridePath);
  const expectedHealthPaths = { agent: "/livez", api: "/livez", "model-gateway": "/health", retrieval: "/health" };
  const tiers = Object.fromEntries(
    tierServiceNames.map((serviceName) => {
      const environment = tierEnvironment(override, serviceName);

      return [serviceName, { environment, port: listeningPort(t, environment) }];
    })
  );

  for (const [serviceName, { environment, port }] of Object.entries(tiers)) {
    const role = tierRoles[serviceName];
    const topology = validateServiceTopology(environment);
    const description = describeServiceTopology(environment);

    assert.deepEqual(topology, { errors: [], warnings: [] }, `${serviceName}: ${JSON.stringify(topology)}`);
    assert.equal(description.role, role);
    assert.equal(description.status, "ok");
    assert.deepEqual(
      Object.entries(description.hosts).filter(([, hosted]) => hosted).map(([tier]) => tier),
      [role === "model-gateway" ? "modelGateway" : role],
      `${serviceName} hosts its own tier only`
    );
    assert.deepEqual(healthcheckTarget(override, serviceName), { path: expectedHealthPaths[serviceName], port });

    for (const variable of ["AGENT_SERVICE_URL", "RETRIEVAL_SERVICE_URL", "MODEL_GATEWAY_URL"]) {
      for (const url of String(environment[variable] ?? "").split(",").filter(Boolean)) {
        const target = new URL(url);
        const neighbour = tiers[target.hostname];

        assert.ok(neighbour, `${serviceName}: ${variable} names a service of this file`);
        assert.equal(
          { AGENT_SERVICE_URL: "agent", MODEL_GATEWAY_URL: "model-gateway", RETRIEVAL_SERVICE_URL: "retrieval" }[variable],
          tierRoles[target.hostname]
        );
        assert.equal(Number(target.port), neighbour.port, `${serviceName}: ${variable} is where ${target.hostname} listens`);
      }
    }
  }

  // Who calls whom: the edge the agent and the gateway, the agent retrieval
  // and the gateway, retrieval the gateway.
  assert.ok(tiers.api.environment.AGENT_SERVICE_URL && tiers.api.environment.MODEL_GATEWAY_URL);
  assert.ok(tiers.agent.environment.RETRIEVAL_SERVICE_URL && tiers.agent.environment.MODEL_GATEWAY_URL);
  assert.ok(tiers.retrieval.environment.MODEL_GATEWAY_URL);
  assert.equal(tiers.retrieval.environment.VECTOR_STORE_PROVIDER, "pgvector");
});

test("tiers start in dependency order and drain before docker stops them", async (t) => {
  const override = await readText(servicesOverridePath);

  assert.deepEqual(dependsOn(override, "api"), {
    agent: "service_healthy",
    "model-gateway": "service_healthy",
    postgres: "service_healthy",
  });
  assert.deepEqual(dependsOn(override, "agent"), {
    "model-gateway": "service_healthy",
    postgres: "service_healthy",
    retrieval: "service_healthy",
  });
  assert.deepEqual(dependsOn(override, "retrieval"), {
    "model-gateway": "service_healthy",
    postgres: "service_healthy",
  });
  assert.deepEqual(dependsOn(override, "model-gateway"), {});

  withEnvironment(t, { SERVICE_SHUTDOWN_GRACE_MS: "" });

  for (const serviceName of tierServiceNames) {
    const seconds = Number(serviceText(override, serviceName).match(/^\s{4}stop_grace_period:\s*(\d+)s\s*$/m)?.[1]);

    assert.ok(seconds * 1000 > getServiceShutdownGraceMs(), `${serviceName} outlasts the drain window`);
  }
});

// The monolith (server.js, role all) drains the same window and then gives its
// finalizers 3 s (SHUTDOWN_FINALIZER_MARGIN_MS) before it exits anyway, so the
// one-click app service must wait longer than both before docker's SIGKILL.
test("the one-click app service outlasts the monolith's drain and finalizers", async (t) => {
  const compose = await readText(composePath);

  withEnvironment(t, { SERVICE_SHUTDOWN_GRACE_MS: "" });

  const seconds = Number(serviceText(compose, "app").match(/^\s{4}stop_grace_period:\s*(\d+)s\s*$/m)?.[1]);

  assert.ok(Number.isFinite(seconds), "the app service sets stop_grace_period in seconds");
  assert.ok(seconds * 1000 > getServiceShutdownGraceMs() + 3_000, "app outlasts the drain window and the finalizers");
});

test("each role has a start script through the image's entry point", async () => {
  const packageJson = JSON.parse(await readText(serverPackagePath));

  for (const role of Object.values(tierRoles)) {
    assert.equal(packageJson.scripts?.[`start:${role}`], `ARCHIVE_RAG_ROLE=${role} node server.js`);
  }

  assert.equal(packageJson.scripts?.start, "node server.js", "the monolith start is unchanged");
});

// Network exposure of the one-click deployment. On Linux a port docker
// publishes bypasses ufw/firewalld, and the defaults (the postgres superuser
// with a known password, Redis without one, API auth off) are only fit for
// loopback. Every published port therefore binds ARCHIVE_RAG_BIND_HOST, which
// defaults to 127.0.0.1; 0.0.0.0 is a deliberate choice (docs/deployment.md).
const composeFilesWithPorts = [composePath, rerankOverridePath, servicesOverridePath];
const bindHostPrefix = "${ARCHIVE_RAG_BIND_HOST:-127.0.0.1}:";

// Every entry of every `ports:` block in a compose file, at any depth, plus
// any long-syntax `published:` key (which would escape the short-form check).
const publishedPorts = (composeText) => {
  const lines = composeText.split("\n");
  const entries = [];

  lines.forEach((line, index) => {
    if (!isContentLine(line) || line.trim() !== "ports:") {
      return;
    }

    for (const next of lines.slice(index + 1)) {
      if (isContentLine(next) && indentationOf(next) <= indentationOf(line)) {
        break;
      }

      if (isContentLine(next)) {
        entries.push(unquote(next.trim().replace(/^-\s*/, "")));
      }
    }
  });

  return {
    entries,
    longSyntax: lines.filter((line) => isContentLine(line) && /^\s*-?\s*(published|host_ip):/.test(line)),
  };
};

test("every published port binds ARCHIVE_RAG_BIND_HOST, loopback by default", async () => {
  const expectedPorts = {
    [composePath]: ["5432:5432", "6379:6379", "5001:5001", "5010:5001"],
    [rerankOverridePath]: [],
    [servicesOverridePath]: ["${ARCHIVE_RAG_API_PORTS:-5001}:5001"],
  };

  for (const filePath of composeFilesWithPorts) {
    const name = path.basename(filePath);
    const { entries, longSyntax } = publishedPorts(await readText(filePath));

    assert.deepEqual(longSyntax, [], `${name}: use the short form so the bind host stays pinned`);
    assert.deepEqual(
      entries.map((entry) => entry.slice(bindHostPrefix.length)),
      expectedPorts[filePath],
      `${name}: published ports`
    );

    for (const entry of entries) {
      assert.ok(entry.startsWith(bindHostPrefix), `${name}: ${entry} must bind ARCHIVE_RAG_BIND_HOST`);
      // As compose resolves it with no shell variables set, and with the LAN opt-in.
      assert.match(interpolate(entry, {}), /^127\.0\.0\.1:[0-9-]+:\d+$/, `${name}: ${entry}`);
      assert.match(interpolate(entry, { ARCHIVE_RAG_BIND_HOST: "0.0.0.0" }), /^0\.0\.0\.0:[0-9-]+:\d+$/);
    }
  }

  // The standalone evaluation reranker (not part of the deployment) already
  // publishes on loopback only.
  const standalone = publishedPorts(await readText(standaloneComposePath));

  assert.deepEqual(standalone.entries, ["127.0.0.1:8081:8081"]);
});

test("the postgres password comes from POSTGRES_PASSWORD, and every database URL follows it", async () => {
  const [compose, override] = await Promise.all([readText(composePath), readText(servicesOverridePath)]);
  const passwordVariable = "${POSTGRES_PASSWORD:-postgres}";

  assert.equal(rawServiceEnvironment(compose, "postgres").POSTGRES_PASSWORD, passwordVariable);
  assert.equal(rawServiceEnvironment(compose, "postgres").POSTGRES_USER, "postgres");

  const urlServices = [
    [compose, "app"],
    ...tierServiceNames.map((serviceName) => [override, serviceName]),
  ];
  let urlCount = 0;

  for (const [text, serviceName] of urlServices) {
    for (const [key, value] of Object.entries(rawServiceEnvironment(text, serviceName))) {
      if (!/^postgres(ql)?:\/\//.test(value)) {
        continue;
      }

      urlCount += 1;
      assert.equal(
        value,
        `postgresql://postgres:${passwordVariable}@postgres:5432/agentai`,
        `${serviceName}.${key} uses the postgres service's password variable`
      );
      // A password set in the shell reaches the server and its clients alike.
      assert.equal(
        new URL(interpolate(value, { POSTGRES_PASSWORD: "from-shell" })).password,
        interpolate(rawServiceEnvironment(compose, "postgres").POSTGRES_PASSWORD, { POSTGRES_PASSWORD: "from-shell" })
      );
    }
  }

  // app (2) and api, agent, retrieval (2 each); the gateway has no database.
  assert.equal(urlCount, 8);

  // No hard-coded password anywhere else in either file.
  for (const [name, text] of [["docker-compose.yml", compose], ["compose.services.yml", override]]) {
    for (const line of text.split("\n").filter(isContentLine)) {
      assert.doesNotMatch(line, /^\s*-?\s*POSTGRES_PASSWORD\s*[:=](?!\s*\$\{POSTGRES_PASSWORD:-)/, `${name}: ${line.trim()}`);
      assert.doesNotMatch(line, /postgres(ql)?:\/\/[^:/@\s]+:(?!\$\{POSTGRES_PASSWORD:-)[^@\s]*@/, `${name}: ${line.trim()}`);
    }
  }
});

// The script of the app image's HEALTHCHECK (`CMD node -e "..."`, shell form).
const imageHealthcheckScript = (dockerfile) => {
  const match = dockerfile.match(/^HEALTHCHECK [^\n]*\\\n\s+CMD node -e "([^"\n]*)"\s*$/m);

  assert.ok(match, "the app Dockerfile has one node -e HEALTHCHECK");

  return match[1];
};

// The URL the HEALTHCHECK probes in a container with `environment`.
const imageHealthcheckUrl = (script, environment) => {
  const urls = [];

  vm.runInNewContext(script, {
    fetch: (url) => {
      urls.push(url);

      return new Promise(() => {});
    },
    process: { env: { ...environment }, exit: () => {} },
  });

  assert.equal(urls.length, 1);

  return urls[0];
};

test("the app service is healthy only when ready; the image probes each role's liveness", async (t) => {
  const [compose, override, dockerfile, systemRoutes, retrievalApp] = await Promise.all([
    readText(composePath),
    readText(servicesOverridePath),
    readText(appDockerfilePath),
    readText(path.join(serverDirectory, "routes", "system.js")),
    readText(path.join(serverDirectory, "rag", "retrieval-service", "app.js")),
  ]);
  const imagePort = dockerfile.match(/^\s+PORT=(\d+) \\$/m)?.[1];

  assert.equal(imagePort, "5001", "the image's own PORT");
  // /health answers 200 whatever it finds; /ready is 503 unless every check passes.
  assert.deepEqual(healthcheckTarget(compose, "app"), { path: "/ready", port: Number(imagePort) });
  assert.match(systemRoutes, /router\.get\("\/ready"[\s\S]*?status\(report\.status === "ok" \? 200 : 503\)/);
  assert.match(systemRoutes, /router\.get\("\/livez"/);

  const script = imageHealthcheckScript(dockerfile);

  // Shell form: nothing the shell would expand or unquote inside "...".
  assert.doesNotMatch(script, /[$`\\"]/);

  // The paths each role's app really serves without an identity: /livez from
  // routes/system.js (all, api, agent), the tiers' own /health otherwise.
  assert.match(retrievalApp, /app\.get\("\/health"/);
  assert.equal(MODEL_GATEWAY_PATHS.health, "/health");

  const livenessPaths = { agent: "/livez", all: "/livez", api: "/livez", "model-gateway": "/health", retrieval: "/health" };
  const cases = [
    // The monolith as the one-click deployment runs it: the image's ENV only.
    { environment: { PORT: imagePort }, role: "all" },
    // Each split tier as compose.services.yml runs it, over the image's ENV.
    ...tierServiceNames.map((serviceName) => ({
      environment: { PORT: imagePort, ...tierEnvironment(override, serviceName) },
      role: tierRoles[serviceName],
    })),
    // A tier started from the image with its own default port.
    { environment: { ARCHIVE_RAG_ROLE: "retrieval" }, role: "retrieval" },
    { environment: { ARCHIVE_RAG_ROLE: "model-gateway" }, role: "model-gateway" },
    { environment: { ARCHIVE_RAG_ROLE: " Model-Gateway ", MODEL_GATEWAY_PORT: "5013", PORT: imagePort }, role: "model-gateway" },
  ];

  for (const { environment, role } of cases) {
    const port = listeningPort(t, { ...environment, ARCHIVE_RAG_ROLE: role });

    assert.equal(
      imageHealthcheckUrl(script, environment),
      `http://127.0.0.1:${port}${livenessPaths[role]}`,
      `${role} with ${JSON.stringify(environment)}`
    );
  }
});
