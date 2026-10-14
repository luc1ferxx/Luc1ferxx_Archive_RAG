// Module resolve hook, registered with module.register() by
// test/langgraph-prompts-adapter.test.mjs (its own process only). Every import
// of lib/prompt-template.js resolves to the recording stand-in, except the
// stand-in's own import, which must reach the real module.
let captureUrl = null;
let targetUrl = null;

export const initialize = ({ capture, target }) => {
  captureUrl = capture;
  targetUrl = target;
};

export const resolve = async (specifier, context, nextResolve) => {
  const resolved = await nextResolve(specifier, context);

  return resolved.url === targetUrl && context.parentURL !== captureUrl
    ? { ...resolved, url: captureUrl }
    : resolved;
};
