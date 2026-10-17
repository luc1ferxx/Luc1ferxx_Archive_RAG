// Module resolve hook, registered with module.register() by
// test/langgraph-runtime-parity.test.mjs and the other suites that tap a
// module's import (each in its own process). Each redirect sends the imports
// of `target` made by modules under `fromPrefix` to the recording stand-in
// `capture`; the stand-in's own import of the target is never redirected, so
// it reaches the real module.
let redirects = [];

export const initialize = (data) => {
  redirects = data?.redirects ?? [];
};

export const resolve = async (specifier, context, nextResolve) => {
  const resolved = await nextResolve(specifier, context);
  const parentURL = context.parentURL ?? "";
  const redirect = redirects.find(
    ({ capture, fromPrefix, target }) =>
      resolved.url === target &&
      parentURL !== capture &&
      parentURL.startsWith(fromPrefix)
  );

  return redirect ? { ...resolved, url: redirect.capture } : resolved;
};
