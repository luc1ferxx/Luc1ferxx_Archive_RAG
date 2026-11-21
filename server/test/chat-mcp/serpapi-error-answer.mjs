// Preload (node --import) for test/chat-mcp.test.mjs. In the search server
// (mcp-server.js) every SerpAPI search fails as an answer other than 200 does,
// with the search's query as that answer's body, and no request is sent.
// serpapi keeps its request in _internals for stubbing; the package does not
// export that file, so it is imported by its location.
const { _internals } = await import(new URL("./src/utils.js", import.meta.resolve("serpapi")));

// serpapi rejects such an answer with its body, not an Error. A query that
// starts with "error:" fails as a request that got no answer does: an Error
// with the rest of the query as its message.
_internals.execute = async (_path, { q }) => {
  throw q.startsWith("error:") ? new Error(q.slice("error:".length)) : q;
};
