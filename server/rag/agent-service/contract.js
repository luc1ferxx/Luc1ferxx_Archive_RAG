// What the public edge (ARCHIVE_RAG_ROLE=api, or all with AGENT_SERVICE_URL)
// and the agent tier (ARCHIVE_RAG_ROLE=agent) of a split deployment agree on.
// Constants only, so health.js can read them without loading either app.

// Answered by the agent tier to any valid internal token for its audience,
// system tokens included. The edge's health check probes every agent replica
// here, which proves reachability and that both sides share a signing key.
export const AGENT_SERVICE_PING_PATH = "/internal/ping";

// The roles whose tokens the agent tier accepts: the public edge, and a
// monolith that forwards agent work to AGENT_SERVICE_URL. A retrieval or
// model-gateway process holds the same keys but never speaks for a user here.
export const AGENT_SERVICE_CALLER_ROLES = Object.freeze(["api", "all"]);

// Claim on a forwarded POST /admin/actions/:action naming the permission the
// edge already granted (and audited) for that action. The agent tier runs the
// action only when the claim matches the action's permission, so a token
// minted for /chat cannot be replayed against an admin action.
export const ADMIN_PERMISSION_CLAIM = "adminPermission";

export const AGENT_EDGE_ERROR_CODES = Object.freeze({
  // The agent tier refused the edge's internal token (keys out of step).
  identityRejected: "SERVICE_IDENTITY_REJECTED",
  // The request could not be sent at all (an unexpected client failure).
  forwardFailed: "SERVICE_FORWARD_FAILED",
  // A forwarded /chat/stream ended before its done event.
  streamInterrupted: "SERVICE_STREAM_INTERRUPTED",
});
