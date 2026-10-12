import { after, beforeEach } from "node:test";

// Preloaded into every test file's process with --import by run.test.mjs and
// coverage-gate.mjs (the node --test parent itself never evaluates it), so a
// suite does not need a copy of its own.
//
// Production timers are unref'd so they never hold a process open: request
// deadlines, metrics collectors, service-client call timeouts, shutdown
// timers. A test that awaits one needs something else keeping the event loop
// alive. Node 24's runner keeps the loop alive while tests are pending; Node
// 20 and 22 (CI) do not, so the loop drains, the runner reports "Promise
// resolution is still pending but the event loop has already resolved", and
// that test and every later one in the file are cancelled.
//
// The interval is ref'd when the first test starts, not when this module
// loads: a root before() hook runs as soon as it is registered, and in a file
// that registers no test only a drained event loop runs the after() hooks, so
// a ref'd interval from the start would hang that file forever. Work before
// the first test starts (a describe()'s own before hook) is not covered. The
// root after() hook runs once every top-level test has finished, before the
// file's own root after() hooks.
const keepEventLoopAlive = setInterval(() => {}, 2 ** 31 - 1);
keepEventLoopAlive.unref();

beforeEach(() => {
  keepEventLoopAlive.ref();
});

after(() => {
  clearInterval(keepEventLoopAlive);
});
