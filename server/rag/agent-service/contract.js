// What the public edge (ARCHIVE_RAG_ROLE=api, or all with AGENT_SERVICE_URL)
// and the agent tier (ARCHIVE_RAG_ROLE=agent) of a split deployment agree on.
// Constants only, so health.js can read them without loading either app.

import { SERVICE_CALL_POLICY } from "../service-identity.js";

// Answered by the agent tier to any valid internal token for its audience,
// system tokens included. The edge's health check probes every agent replica
// here, which proves reachability and that the agent accepts the edge's key.
export const AGENT_SERVICE_PING_PATH = "/internal/ping";

// The roles whose tokens the agent tier accepts: the public edge, and a
// monolith that forwards agent work to AGENT_SERVICE_URL. A retrieval or
// model-gateway process never speaks for a user here. Declared once, in
// service-identity.js SERVICE_CALL_POLICY.
export const AGENT_SERVICE_CALLER_ROLES = SERVICE_CALL_POLICY.agent.callers;

// Claim on a forwarded POST /admin/actions/:action naming the permission the
// edge already granted (and audited) for that action. The agent tier runs the
// action only when the claim matches the action's permission, so a token
// minted for /chat cannot be replayed against an admin action.
export const ADMIN_PERMISSION_CLAIM = "adminPermission";

// Claim on a forwarded call whose authenticated scope names neither a user nor
// a workspace because the caller presented the single shared API_AUTH_TOKEN,
// the single-tenant credential requireTenantScope (auth.js) lets act for the
// whole archive. The agent tier refuses every other such scope outside the
// admin actions (agent-service/app.js), so this is how the edge's exemption
// reaches it. Its only value is SINGLE_TENANT_CREDENTIAL_SCOPE.
export const TENANTLESS_SCOPE_CLAIM = "tenantlessScope";
export const SINGLE_TENANT_CREDENTIAL_SCOPE = "single_tenant_credential";

// Codes of refusals the agent tier makes on a valid identity. They are not
// SERVICE_IDENTITY_ERROR_CODES, so the edge relays them to the client as they
// are instead of reporting the tiers' keys out of step.
export const AGENT_SERVICE_ERROR_CODES = Object.freeze({
  // An authenticated scope that names neither a user nor a workspace.
  tenantScopeRequired: "AGENT_TENANT_SCOPE_REQUIRED",
});

export const AGENT_EDGE_ERROR_CODES = Object.freeze({
  // The agent tier refused the edge's internal token (keys out of step).
  identityRejected: "SERVICE_IDENTITY_REJECTED",
  // The request could not be sent at all (an unexpected client failure).
  forwardFailed: "SERVICE_FORWARD_FAILED",
  // A forwarded /chat/stream ended before its done event.
  streamInterrupted: "SERVICE_STREAM_INTERRUPTED",
});
