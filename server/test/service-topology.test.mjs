import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SERVICE_ROLE,
  describeServiceTopology,
  getAgentServiceUrls,
  getModelGatewayUrls,
  getRetrievalServiceUrls,
  getServiceRole,
  getServiceUrls,
  hostsServiceTier,
  isModelGatewayEnabled,
  isRemoteAgentEnabled,
  isRemoteRetrievalEnabled,
  normalizeServiceUrl,
  SERVICE_ROLES,
  SERVICE_TIERS,
  validateServiceTopology,
} from "../rag/service-topology.js";

const SECRET = "s".repeat(20) + "-topology-secret-0123456789";
const KEYS = `k1:${SECRET}`;

const hasLine = (lines, pattern) => lines.some((line) => pattern.test(line));

test("the role defaults to all and an unknown role throws", () => {
  assert.equal(DEFAULT_SERVICE_ROLE, "all");
  assert.deepEqual(SERVICE_ROLES, ["all", "api", "agent", "retrieval", "model-gateway"]);
  assert.equal(getServiceRole({}), "all");
  assert.equal(getServiceRole({ ARCHIVE_RAG_ROLE: "  " }), "all");
  assert.equal(getServiceRole({ ARCHIVE_RAG_ROLE: " Model-Gateway " }), "model-gateway");
  assert.throws(() => getServiceRole({ ARCHIVE_RAG_ROLE: "gateway" }), /ARCHIVE_RAG_ROLE must be one of/u);
});

test("replica URLs are validated, normalized, and de-duplicated", () => {
  assert.deepEqual(
    getAgentServiceUrls({
      AGENT_SERVICE_URL: " http://agent-1:5001/ , https://agent-2.internal/base/,http://agent-1:5001 ,",
    }),
    ["http://agent-1:5001", "https://agent-2.internal/base"]
  );
  assert.deepEqual(getRetrievalServiceUrls({}), []);
  assert.deepEqual(getModelGatewayUrls({ MODEL_GATEWAY_URL: "http://gw:8080/v1" }), ["http://gw:8080/v1"]);
  assert.deepEqual(getServiceUrls(SERVICE_TIERS.retrieval, { RETRIEVAL_SERVICE_URL: "http://r:1" }), ["http://r:1"]);
  assert.throws(() => getServiceUrls("web", {}), TypeError);

  for (const bad of ["ftp://agent:21", "agent:5001", "http://user:pw@agent:5001", "http://agent/?x=1", "http://agent/#x"]) {
    assert.throws(() => getAgentServiceUrls({ AGENT_SERVICE_URL: bad }), (error) => {
      assert.match(error.message, /AGENT_SERVICE_URL/u);
      assert.ok(!error.message.includes("pw"), "credentials must not be echoed");
      return true;
    });
  }

  assert.equal(normalizeServiceUrl("https://gw.internal:8443///"), "https://gw.internal:8443");
});

test("remote switches follow the URLs but a tier never calls itself", () => {
  const shared = {
    AGENT_SERVICE_URL: "http://agent:5001",
    INTERNAL_SERVICE_KEYS: KEYS,
    MODEL_GATEWAY_URL: "http://gw:8080",
    RETRIEVAL_SERVICE_URL: "http://retrieval:5002",
  };
  const withRole = (role) => ({ ...shared, ARCHIVE_RAG_ROLE: role });

  assert.deepEqual(
    Object.fromEntries(
      SERVICE_ROLES.map((role) => [
        role,
        [isRemoteAgentEnabled(withRole(role)), isRemoteRetrievalEnabled(withRole(role)), isModelGatewayEnabled(withRole(role))],
      ])
    ),
    {
      agent: [false, true, true],
      all: [true, true, true],
      api: [true, true, true],
      "model-gateway": [true, true, false],
      retrieval: [true, false, true],
    }
  );

  assert.equal(isRemoteAgentEnabled({}), false);
  assert.equal(isRemoteRetrievalEnabled({}), false);
  assert.equal(isModelGatewayEnabled({}), false);
  assert.throws(() => isModelGatewayEnabled({ ARCHIVE_RAG_ROLE: "nope" }), /ARCHIVE_RAG_ROLE/u);
});

test("each role owns exactly its tiers", () => {
  const tiers = ["api", SERVICE_TIERS.agent, SERVICE_TIERS.retrieval, SERVICE_TIERS.modelGateway];
  const owned = (env) => tiers.filter((tier) => hostsServiceTier(tier, env));

  assert.deepEqual(owned({}), ["api", "agent", "retrieval"]);
  assert.deepEqual(owned({ ARCHIVE_RAG_ROLE: "api", AGENT_SERVICE_URL: "http://a:1" }), ["api"]);
  assert.deepEqual(owned({ ARCHIVE_RAG_ROLE: "agent" }), ["agent"]);
  assert.deepEqual(owned({ ARCHIVE_RAG_ROLE: "retrieval" }), ["retrieval"]);
  assert.deepEqual(owned({ ARCHIVE_RAG_ROLE: "model-gateway" }), ["model-gateway"]);
  // The monolith hands a tier over once its URL is set.
  assert.deepEqual(owned({ AGENT_SERVICE_URL: "http://a:1" }), ["api", "retrieval"]);
  assert.deepEqual(owned({ RETRIEVAL_SERVICE_URL: "http://r:1" }), ["api", "agent"]);
  assert.throws(() => hostsServiceTier("web", {}), TypeError);
});

test("the default monolith validates clean", () => {
  assert.deepEqual(validateServiceTopology({}), { errors: [], warnings: [] });
  assert.equal(describeServiceTopology({}).status, "ok");
});

test("impossible setups are errors and doubtful ones warnings", () => {
  const apiWithoutAgent = validateServiceTopology({ ARCHIVE_RAG_ROLE: "api", INTERNAL_SERVICE_KEYS: KEYS });

  assert.ok(hasLine(apiWithoutAgent.errors, /needs AGENT_SERVICE_URL/u));

  const roleWithoutKeys = validateServiceTopology({ ARCHIVE_RAG_ROLE: "retrieval" });

  assert.ok(hasLine(roleWithoutKeys.errors, /Role retrieval needs INTERNAL_SERVICE_KEYS/u));

  const remoteWithoutKeys = validateServiceTopology({ MODEL_GATEWAY_URL: "http://gw:8080" });

  assert.ok(hasLine(remoteWithoutKeys.errors, /INTERNAL_SERVICE_KEYS is required/u));

  const shortKey = validateServiceTopology({ ARCHIVE_RAG_ROLE: "agent", INTERNAL_SERVICE_KEYS: "k1:short" });

  assert.ok(hasLine(shortKey.errors, /shorter than 32/u));
  assert.ok(!JSON.stringify(shortKey).includes("short\""));

  // A malformed key list nobody uses is only reported.
  const unusedBadKey = validateServiceTopology({ INTERNAL_SERVICE_KEYS: "k1:short" });

  assert.deepEqual(unusedBadKey.errors, []);
  assert.ok(hasLine(unusedBadKey.warnings, /shorter than 32/u));

  const unknownRole = validateServiceTopology({ ARCHIVE_RAG_ROLE: "edge" });

  assert.ok(hasLine(unknownRole.errors, /ARCHIVE_RAG_ROLE must be one of/u));

  const badUrl = validateServiceTopology({ ARCHIVE_RAG_ROLE: "api", AGENT_SERVICE_URL: "http://u:p@agent:1", INTERNAL_SERVICE_KEYS: KEYS });

  assert.ok(hasLine(badUrl.errors, /must not embed credentials/u));
  assert.ok(hasLine(badUrl.errors, /needs AGENT_SERVICE_URL/u));

  const selfPointing = validateServiceTopology({
    ARCHIVE_RAG_ROLE: "model-gateway",
    INTERNAL_SERVICE_KEYS: KEYS,
    MODEL_GATEWAY_URL: "http://gw:8080",
    RETRIEVAL_SERVICE_URL: "http://r:1",
  });

  assert.deepEqual(selfPointing.errors, []);
  assert.ok(hasLine(selfPointing.warnings, /MODEL_GATEWAY_URL is ignored by role model-gateway/u));
  assert.ok(hasLine(selfPointing.warnings, /RETRIEVAL_SERVICE_URL is not used by role model-gateway/u));

  const agentInProcess = validateServiceTopology({ ARCHIVE_RAG_ROLE: "agent", INTERNAL_SERVICE_KEYS: KEYS });

  assert.deepEqual(agentInProcess.errors, []);
  assert.ok(hasLine(agentInProcess.warnings, /no RETRIEVAL_SERVICE_URL/u));
  assert.ok(hasLine(agentInProcess.warnings, /no MODEL_GATEWAY_URL/u));

  const duplicate = validateServiceTopology({
    ARCHIVE_RAG_ROLE: "api",
    AGENT_SERVICE_URL: "http://a:1,http://a:1/",
    INTERNAL_SERVICE_KEYS: KEYS,
    MODEL_GATEWAY_URL: "http://gw:1",
  });

  assert.deepEqual(duplicate.errors, []);
  assert.deepEqual(duplicate.warnings, ["AGENT_SERVICE_URL lists the same replica more than once; duplicates are ignored."]);
});

test("a complete split validates clean", () => {
  const shared = {
    AGENT_SERVICE_URL: "http://agent-1:5001,http://agent-2:5001",
    INTERNAL_SERVICE_KEYS: KEYS,
    MODEL_GATEWAY_URL: "http://gw:8080",
    RETRIEVAL_SERVICE_URL: "http://retrieval:5002",
  };

  for (const role of ["api", "all"]) {
    assert.deepEqual(validateServiceTopology({ ...shared, ARCHIVE_RAG_ROLE: role }), { errors: [], warnings: [] });
  }

  assert.deepEqual(
    validateServiceTopology({ ...shared, AGENT_SERVICE_URL: undefined, ARCHIVE_RAG_ROLE: "agent" }),
    { errors: [], warnings: [] }
  );
});

test("the health description carries no secrets", () => {
  const env = {
    AGENT_SERVICE_URL: "http://agent-1:5001,http://agent-2:5001/",
    ARCHIVE_RAG_ROLE: "api",
    INTERNAL_SERVICE_KEYS: `k2:${SECRET},k1:${SECRET.toUpperCase()}`,
  };
  const description = describeServiceTopology(env);

  assert.ok(!JSON.stringify(description).includes(SECRET));
  assert.ok(!JSON.stringify(description).includes(SECRET.toUpperCase()));
  assert.equal(description.role, "api");
  assert.equal(description.status, "warning");
  assert.deepEqual(description.hosts, { agent: false, api: true, modelGateway: false, retrieval: false });
  assert.deepEqual(description.internalIdentity, { configured: true, keyIds: ["k2", "k1"], signingKeyId: "k2" });
  assert.deepEqual(description.remotes.agent, {
    enabled: true,
    replicas: 2,
    urls: ["http://agent-1:5001", "http://agent-2:5001"],
  });
  assert.deepEqual(description.remotes.retrieval, { enabled: false, replicas: 0, urls: [] });

  const broken = describeServiceTopology({ ARCHIVE_RAG_ROLE: "edge", AGENT_SERVICE_URL: "http://u:p@a:1" });

  assert.equal(broken.status, "error");
  assert.equal(broken.role, "invalid");
  assert.ok(!JSON.stringify(broken).includes("u:p"));
});
