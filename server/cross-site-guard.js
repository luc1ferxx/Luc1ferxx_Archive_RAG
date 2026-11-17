// Cross-site request guard: CSRF and DNS rebinding.
//
// API auth is off by default, so any request that reaches the server acts. A
// browser sends a page's requests without asking its user: a "simple"
// cross-site request (a form POST, a text/plain or multipart fetch, an <img>
// pointing at GET /chat) needs no CORS preflight, so CORS never stops it -- it
// only stops the page reading the answer. A DNS-rebinding page
// (attacker.example re-resolved to 127.0.0.1) is even same-origin to the
// browser, so it can read too. This guard refuses both, for browser requests
// only: a request with neither Origin nor Sec-Fetch-Site (curl, Node's fetch,
// the MCP server, service-to-service calls, probes) passes untouched, because
// only a browser can be made to send a request its user never meant.

import { isApiAuthEnabled } from "./rag/config.js";

export const CROSS_SITE_REQUEST_REFUSED = "CROSS_SITE_REQUEST_REFUSED";
export const HOST_NOT_ALLOWED = "HOST_NOT_ALLOWED";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const DEFAULT_PORTS = Object.freeze({ "http:": "80", "https:": "443" });
// A Host or X-Forwarded-Host value: a name, an IPv4 address or a bracketed
// IPv6 address, with an optional port. Anything else (userinfo, a path) names
// no host and never matches.
const HOST_PATTERN = /^(\[[0-9a-f:.]+\]|[a-z0-9._-]+)(?::(\d{1,5}))?$/u;

const CROSS_SITE_MESSAGE =
  "Cross-site request refused: a page on another origin may not send this request. If it is your own frontend, add its origin (scheme://host:port) to ALLOWED_ORIGINS.";
const HOST_NOT_ALLOWED_MESSAGE =
  "Host not allowed: with API authentication disabled, a browser may reach this server only as localhost, 127.0.0.1 or [::1] (this blocks DNS rebinding). Enable API authentication (API_AUTH_ENABLED=true) or add the origin you open it on to ALLOWED_ORIGINS.";

/**
 * An http(s) origin as {origin, protocol, hostname, port}, or null for the
 * literal "null" origin, a malformed value or another scheme. URL lower-cases
 * the host and drops a default port, as a browser serializes Origin.
 */
export const parseOrigin = (value) => {
  const text = String(value ?? "").trim();

  if (!text || text === "null") {
    return null;
  }

  let url;

  try {
    url = new URL(text);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }

  return {
    hostname: url.hostname,
    origin: url.origin,
    port: url.port,
    protocol: url.protocol,
  };
};

/** A Host header value as {hostname, port}, or null. */
export const parseHost = (value) => {
  const match = HOST_PATTERN.exec(String(value ?? "").trim().toLowerCase());

  if (!match) {
    return null;
  }

  try {
    // The canonical form an Origin carries (127.1 -> 127.0.0.1, [0::1] -> [::1]).
    return { hostname: new URL(`http://${match[1]}`).hostname, port: match[2] ?? "" };
  } catch {
    return null;
  }
};

export const isLoopbackHostname = (hostname) =>
  LOOPBACK_HOSTNAMES.has(String(hostname ?? "").toLowerCase());

export const isLoopbackOrigin = (origin) => {
  const parsed = parseOrigin(origin);

  return parsed !== null && isLoopbackHostname(parsed.hostname);
};

/** cors's `origin` option while ALLOWED_ORIGINS is empty: loopback pages only. */
export const allowLoopbackOrigin = (origin, callback) => {
  callback(null, isLoopbackOrigin(origin));
};

/**
 * The ALLOWED_ORIGINS entries (app.js parses them) as the guard reads them:
 * their origins, and their hostnames, the names a browser may use for this
 * server while auth is off. An empty list means loopback pages only, as for
 * CORS; an entry that is no http(s) origin matches nothing.
 */
export const compileAllowedOrigins = (entries = []) => {
  const parsed = entries.map(parseOrigin).filter(Boolean);

  return {
    hostnames: new Set(parsed.map((entry) => entry.hostname)),
    loopbackOnly: entries.length === 0,
    origins: new Set(parsed.map((entry) => entry.origin)),
  };
};

export const isAllowedOrigin = (origin, allowed) => {
  const parsed = parseOrigin(origin);

  if (!parsed) {
    return false;
  }

  return allowed.loopbackOnly
    ? isLoopbackHostname(parsed.hostname)
    : allowed.origins.has(parsed.origin);
};

export const isAllowedHost = (host, allowed) => {
  const parsed = parseHost(host);

  return (
    parsed !== null &&
    (isLoopbackHostname(parsed.hostname) || allowed.hostnames.has(parsed.hostname))
  );
};

/** The Origin's host (hostname and port) is the request host; a default port may be written or left out. */
export const isSameOrigin = (origin, requestHost) => {
  const parsedOrigin = parseOrigin(origin);
  const parsedHost = parseHost(requestHost);

  if (!parsedOrigin || !parsedHost) {
    return false;
  }

  const hostPort =
    parsedHost.port === DEFAULT_PORTS[parsedOrigin.protocol] ? "" : parsedHost.port;

  return parsedHost.hostname === parsedOrigin.hostname && hostPort === parsedOrigin.port;
};

// The first X-Forwarded-Host value when the app trusts the peer as a proxy
// (TRUST_PROXY): the same rule Express's req.hostname follows.
const getTrustedForwardedHost = (req) => {
  const forwardedHost = String(req.headers?.["x-forwarded-host"] ?? "").split(",")[0].trim();
  const trust = req.app?.get?.("trust proxy fn");

  return forwardedHost && typeof trust === "function" && trust(req.socket?.remoteAddress, 0)
    ? forwardedHost
    : "";
};

/** The host a request was sent to: a trusted X-Forwarded-Host, else the Host header. */
export const getRequestHost = (req) =>
  getTrustedForwardedHost(req) || String(req.headers?.host ?? "").trim();

/**
 * Every method but GET, HEAD and OPTIONS, and GET /chat, which starts an agent
 * run (a run record, session and memory writes). Express answers HEAD with a
 * GET handler and matches paths case-insensitively with an optional trailing
 * slash, so HEAD /chat, /CHAT and /chat/ count too.
 */
export const isStateChangingRequest = (req) => {
  const method = String(req.method ?? "").toUpperCase();

  if (!SAFE_METHODS.has(method)) {
    return true;
  }

  return (
    method !== "OPTIONS" &&
    String(req.path ?? "").toLowerCase().replace(/\/+$/u, "") === "/chat"
  );
};

const refuse = (res, code, error) => {
  res.status(403).json({ code, error });
};

/**
 * Mounted right after cors in createApp. For a browser request (Origin or
 * Sec-Fetch-Site present; Node's fetch sends Sec-Fetch-Mode, so that one is
 * no sign of a browser):
 * - while API auth is off (read per request, as requireApiAuth does), every
 *   host it names must be loopback or an ALLOWED_ORIGINS hostname, else 403
 *   HOST_NOT_ALLOWED. With auth on a rebinding page holds no credential, and
 *   docs/deployment.md requires auth before the server leaves localhost.
 * - a state-changing request must come from the request's own origin or an
 *   allowed one (never "null"); without Origin, Sec-Fetch-Site: cross-site is
 *   refused. Else 403 CROSS_SITE_REQUEST_REFUSED.
 */
export const createCrossSiteGuard = ({ allowedOrigins = [] } = {}) => {
  const allowed = compileAllowedOrigins(allowedOrigins);

  return (req, res, next) => {
    const origin = req.headers.origin;
    const fetchSite = req.headers["sec-fetch-site"];

    if (origin === undefined && fetchSite === undefined) {
      next();
      return;
    }

    if (!isApiAuthEnabled()) {
      // A trusted X-Forwarded-Host is checked as well as the Host header, so a
      // page that reaches the server directly cannot pass by naming a loopback
      // host in the header it is free to set.
      const forwardedHost = getTrustedForwardedHost(req);
      const hosts = forwardedHost ? [req.headers.host, forwardedHost] : [req.headers.host];

      if (!hosts.every((host) => isAllowedHost(host, allowed))) {
        refuse(res, HOST_NOT_ALLOWED, HOST_NOT_ALLOWED_MESSAGE);
        return;
      }
    }

    if (isStateChangingRequest(req)) {
      const accepted =
        origin === undefined
          ? String(fetchSite).trim().toLowerCase() !== "cross-site"
          : isSameOrigin(origin, getRequestHost(req)) || isAllowedOrigin(origin, allowed);

      if (!accepted) {
        refuse(res, CROSS_SITE_REQUEST_REFUSED, CROSS_SITE_MESSAGE);
        return;
      }
    }

    next();
  };
};
