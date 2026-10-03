import { monitorEventLoopDelay } from "node:perf_hooks";

import { getMetricsRegistry } from "./metrics.js";

// Process health under the conventional names (process_*, nodejs_*), so
// ordinary Node dashboards read them: CPU seconds, resident memory, heap, the
// start time, and the event loop's p99 delay.
//
// The delay comes from perf_hooks.monitorEventLoopDelay, started with the
// metrics server (startProcessMetrics). Its histogram is reset after every
// scrape, so the p99 covers the time since the previous scrape; with two
// Prometheus servers scraping one process each sees about half the window.

const registry = getMetricsRegistry();

const cpuSeconds = registry.counter({
  help: "User and system CPU time this process has used, in seconds.",
  name: "process_cpu_seconds_total",
});
const residentMemory = registry.gauge({
  help: "Resident set size of this process, in bytes.",
  name: "process_resident_memory_bytes",
});
const startTime = registry.gauge({
  help: "When this process started, in seconds since the Unix epoch.",
  name: "process_start_time_seconds",
});
const heapUsed = registry.gauge({
  help: "V8 heap in use, in bytes.",
  name: "nodejs_heap_size_used_bytes",
});
const heapTotal = registry.gauge({
  help: "V8 heap allocated, in bytes.",
  name: "nodejs_heap_size_total_bytes",
});
const eventLoopP99 = registry.gauge({
  help: "p99 event loop delay since the previous scrape, in seconds (0 before the first sample).",
  name: "nodejs_eventloop_delay_p99_seconds",
});

const EVENT_LOOP_RESOLUTION_MS = 20;
let eventLoopHistogram = null;

export const collectProcessMetrics = () => {
  const cpu = process.cpuUsage();
  const memory = process.memoryUsage();

  cpuSeconds.setTotal((cpu.user + cpu.system) / 1e6);
  residentMemory.set(memory.rss);
  heapUsed.set(memory.heapUsed);
  heapTotal.set(memory.heapTotal);
  // timeOrigin: when this process started, in epoch milliseconds; constant.
  startTime.set(performance.timeOrigin / 1000);

  if (eventLoopHistogram) {
    const p99 = eventLoopHistogram.count > 0 ? eventLoopHistogram.percentile(99) / 1e9 : 0;

    eventLoopP99.set(Number.isFinite(p99) ? p99 : 0);
    eventLoopHistogram.reset();
  }
};

/** Starts sampling the event loop delay. Idempotent. */
export const startProcessMetrics = () => {
  if (!eventLoopHistogram) {
    eventLoopHistogram = monitorEventLoopDelay({ resolution: EVENT_LOOP_RESOLUTION_MS });
    eventLoopHistogram.enable();
  }
};

/** Stops sampling (tests, shutdown). */
export const stopProcessMetrics = () => {
  eventLoopHistogram?.disable();
  eventLoopHistogram = null;
};

registry.addCollector("process", collectProcessMetrics);
