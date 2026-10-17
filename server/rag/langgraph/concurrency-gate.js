// A launch queue for a scheduler that does not choose when a node starts:
// the rules of the native scheduler's launch queue, which lived in
// agent-execution-graph-runner.js until ADR 0001 phase 6 deleted it.
//
// LangGraph starts every task of a superstep at once (pregel/runner.js
// _executeTasksWithRetry), and its own maxConcurrency must not be used to cap
// them: in 1.5.0 a value below a superstep's width loses tasks (at 1 the step
// ends after its first task; above 1, once a task throws, the tasks not yet
// started are committed as __no_writes__ and never run on resume). So
// LangGraph is told every node may start, and each node asks this gate before
// it does anything a native scheduling pass did.
//
// The rules are the deleted native pass's, kept exactly (the native goldens
// pin them): at most `cap` nodes in flight; a node that
// is not parallelSafe starts only when nothing else runs, and nothing starts
// -- or is even decided -- beside it; and the queue is first come, first
// served, so a node that cannot start blocks the ones behind it rather than
// being overtaken. A node the pass would only skip takes a turn (awaitTurn)
// instead of a slot: it needs no capacity, but it is decided where the pass
// would reach it, after every node ahead of it started, and synchronously
// with those starts, as the native pass decided in one synchronous scan.
//
// "First come" is the native queue's order, the validator's layer order
// (orderExecutionGraphNodeStatesByLayer in agent-execution-graph-node.js):
// LangGraph enters a superstep's nodes in node name order, and
// langgraph/compile-execution-graph.js names nodes so that order is the
// queue's; across supersteps it holds because each layer is one superstep.

/**
 * A gate admitting at most `cap` holders, exclusive holders alone, in arrival
 * order. acquire() resolves to a release function (idempotent) once the
 * caller may start. awaitTurn(onTurn) holds nothing: once every earlier
 * arrival has started and no exclusive holder runs, it calls onTurn()
 * synchronously, in the same turn as the starts granted just before it and
 * before any of their holders resume, and resolves to its return value
 * (rejects with what it throws).
 */
export const createExecutionGraphConcurrencyGate = (cap) => {
  if (!Number.isSafeInteger(cap) || cap < 1) {
    throw new TypeError("A graph concurrency gate needs a positive integer cap.");
  }

  const queue = [];
  let active = 0;
  let exclusiveActive = false;
  let maxActive = 0;

  const pump = () => {
    while (queue.length > 0) {
      // As the native pass that launched an exclusive node stopped there, and
      // the next pass ran only once that node had finished: nothing behind
      // it is started or decided meanwhile.
      if (exclusiveActive) {
        return;
      }

      const head = queue[0];

      if (head.turn) {
        queue.shift();
        head.grant();
        continue;
      }

      if (active >= cap || (head.exclusive && active > 0)) {
        return;
      }

      queue.shift();
      active += 1;
      maxActive = Math.max(maxActive, active);
      exclusiveActive = head.exclusive;
      head.grant();
    }
  };

  return {
    acquire({ exclusive = false } = {}) {
      return new Promise((resolve) => {
        let released = false;
        const release = () => {
          if (released) {
            return;
          }

          released = true;
          active -= 1;

          if (exclusive) {
            exclusiveActive = false;
          }

          pump();
        };

        queue.push({
          exclusive: Boolean(exclusive),
          grant: () => resolve(release),
          turn: false,
        });
        pump();
      });
    },
    awaitTurn(onTurn = () => undefined) {
      return new Promise((resolve, reject) => {
        queue.push({
          exclusive: false,
          grant: () => {
            try {
              resolve(onTurn());
            } catch (error) {
              reject(error);
            }
          },
          turn: true,
        });
        pump();
      });
    },
    get active() {
      return active;
    },
    get maxActive() {
      return maxActive;
    },
    get waiting() {
      return queue.length;
    },
  };
};
