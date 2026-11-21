// The text a client is shown for an error, one rule everywhere: a route's
// `{ error }` answer (routes/helpers.js) and the error text of the agent's
// payloads -- the /chat body's errors.rag and errors.mcp, ragAnswer and
// mcpAnswer, step summaries and records, run, recovery and task records, the
// arXiv and recommendation tasks, the archive MCP tools.

// An answer of the model backend itself (rag/openai-client.js, reranker.js,
// the model gateway's client): its status and text are the provider's (a 401
// is the provider refusing this server's key), never the client's.
export const isUpstreamError = (error) => Number.isInteger(error?.upstreamStatus);

// The agent writes one failure into several payloads (a step summary and
// record, errors.rag, ragAnswer, the Skill runs); its log line is written once.
const loggedErrors = new WeakSet();

/**
 * The message of an error raised for the client: a 4xx, or `expose: true` (an
 * app error written for the user whatever its status: a budget refusal, a
 * cancelled request, a dependency outage), never an upstream answer. Anything
 * else -- no status (a database or file system error naming a host or a
 * path), a 5xx, an upstream error, a value that is not an Error -- is
 * `fallbackMessage`, with the error logged.
 */
export const serializeError = (error, fallbackMessage) => {
  if (
    error instanceof Error &&
    !isUpstreamError(error) &&
    (error.expose === true || (error.status >= 400 && error.status < 500))
  ) {
    return error.message;
  }

  const isObject = error !== null && typeof error === "object";

  if (!isObject || !loggedErrors.has(error)) {
    if (isObject) {
      loggedErrors.add(error);
    }

    console.error(fallbackMessage, error);
  }

  return fallbackMessage;
};
