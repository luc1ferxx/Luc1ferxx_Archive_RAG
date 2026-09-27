// Summaries for the semantic answer cache evaluation (run-semantic-cache-eval.mjs).
// Pure functions, so the numbers the report prints are pinned by
// test/semantic-cache.test.mjs.

const mean = (values) => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);

const median = (values) => {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const createRandom = (seed) => {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;

    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
};

/** Percentile bootstrap 95% interval of the mean of `values`. */
export const bootstrapMeanInterval = (values, { resamples = 2000, seed = 20260927 } = {}) => {
  if (values.length === 0) {
    return null;
  }

  const random = createRandom(seed);
  const means = [];

  for (let round = 0; round < resamples; round += 1) {
    let sum = 0;

    for (let index = 0; index < values.length; index += 1) {
      sum += values[Math.floor(random() * values.length)];
    }

    means.push(sum / values.length);
  }

  means.sort((left, right) => left - right);
  return [means[Math.floor(0.025 * resamples)], means[Math.min(resamples - 1, Math.floor(0.975 * resamples))]];
};

const rate = (numerator, denominator) => (denominator > 0 ? numerator / denominator : null);

const KEY_SEPARATED_CATEGORIES = new Set(["document", "tenant"]);

/**
 * Live runs through chat(): `{ kind, category, hit, baseCached, latencyMs,
 * uncachedLatencyMs?, uncachedAbstained? }`. A repeat or paraphrase is eligible only when its
 * base question was answered and stored; a contrast is meaningful only then,
 * because otherwise there was nothing it could falsely hit. Every contrast hit
 * counts as a false hit, meaningful or not.
 */
export const summarizeSemanticCacheRuns = (runs = [], bootstrapOptions = {}) => {
  const byKind = (kind) => runs.filter((run) => run.kind === kind);
  const summarizeHits = (kind) => {
    const eligible = byKind(kind).filter((run) => run.baseCached);
    const hits = eligible.filter((run) => run.hit).length;

    return { eligible: eligible.length, hits, hitRate: rate(hits, eligible.length) };
  };
  const contrasts = byKind("contrast");
  const meaningful = contrasts.filter((run) => run.baseCached);
  const byCategory = {};

  for (const run of contrasts) {
    const entry = (byCategory[run.category] ??= { total: 0, meaningful: 0, falseHits: 0 });

    entry.total += 1;
    entry.meaningful += run.baseCached ? 1 : 0;
    entry.falseHits += run.hit ? 1 : 0;
  }

  // A hit whose uncached run abstained is not a comparable workload (the gate
  // refused before any model call), so it is counted, not timed.
  const pairs = runs.filter(
    (run) => run.hit && Number.isFinite(run.uncachedLatencyMs) && !run.uncachedAbstained
  );
  const hitsWhereUncachedAbstained = runs.filter((run) => run.hit && run.uncachedAbstained).length;
  const saved = pairs.map((run) => run.uncachedLatencyMs - run.latencyMs);
  const falseHits = contrasts.filter((run) => run.hit).length;

  return {
    repeat: summarizeHits("repeat"),
    paraphrase: summarizeHits("paraphrase"),
    contrast: {
      total: contrasts.length,
      meaningful: meaningful.length,
      falseHits,
      falseHitRate: rate(falseHits, meaningful.length),
      // Over the contrasts that had a stored base to hit.
      falseHitUpperBound95: binomialUpperBound(
        meaningful.filter((run) => run.hit).length,
        meaningful.length
      ),
      byCategory,
    },
    hitsWhereUncachedAbstained,
    latency: {
      pairs: pairs.length,
      meanHitMs: mean(pairs.map((run) => run.latencyMs)),
      medianHitMs: median(pairs.map((run) => run.latencyMs)),
      meanUncachedMs: mean(pairs.map((run) => run.uncachedLatencyMs)),
      medianUncachedMs: median(pairs.map((run) => run.uncachedLatencyMs)),
      meanSavedMs: mean(saved),
      savedCi95: bootstrapMeanInterval(saved, bootstrapOptions),
    },
  };
};

/**
 * Offline decisions, one per follow-up against its own base question:
 * `{ kind, category, similarity, guard: { full, required, none } }`. For each
 * guard mode and threshold, what the cache would have done if the base were
 * stored. Document and tenant contrasts are left out: their words are the
 * base's own, and only the key separates them.
 */
export const sweepSemanticCacheDecisions = (decisions = [], { thresholds = [0.95, 0.96, 0.97, 0.98, 0.99] } = {}) => {
  const rows = [];
  const lexical = decisions.filter((decision) => !KEY_SEPARATED_CATEGORIES.has(decision.category));

  for (const mode of ["none", "required", "full"]) {
    for (const threshold of thresholds) {
      const wouldHit = (decision) => decision.similarity >= threshold && decision.guard[mode] === true;
      const count = (kind) => lexical.filter((decision) => decision.kind === kind);
      const repeats = count("repeat");
      const paraphrases = count("paraphrase");
      const contrasts = count("contrast");
      const falseHitDecisions = contrasts.filter(wouldHit);

      rows.push({
        mode,
        threshold,
        repeatHitRate: rate(repeats.filter(wouldHit).length, repeats.length),
        paraphraseHits: paraphrases.filter(wouldHit).length,
        paraphraseTotal: paraphrases.length,
        paraphraseHitRate: rate(paraphrases.filter(wouldHit).length, paraphrases.length),
        contrastTotal: contrasts.length,
        contrastFalseHits: falseHitDecisions.length,
        falseHitCategories: [...new Set(falseHitDecisions.map((decision) => decision.category))].sort(),
      });
    }
  }

  return rows;
};

const binomialCdf = (successes, trials, probability) => {
  // P(X <= successes) for X ~ Binomial(trials, probability), summed in log space.
  if (probability <= 0) {
    return 1;
  }

  if (probability >= 1) {
    return successes >= trials ? 1 : 0;
  }

  let logCoefficient = 0;
  let sum = 0;

  for (let k = 0; k <= successes; k += 1) {
    if (k > 0) {
      logCoefficient += Math.log(trials - k + 1) - Math.log(k);
    }

    sum += Math.exp(logCoefficient + k * Math.log(probability) + (trials - k) * Math.log1p(-probability));
  }

  return Math.min(1, sum);
};

/**
 * One-sided exact (Clopper-Pearson) upper bound on a rate after `successes`
 * in `trials`: the largest p with P(X <= successes | p) >= 1 - confidence.
 * For 0 of n it is 1 - (1 - confidence)^(1/n), about 3/n at 95%. It assumes
 * independent trials; contrasts written around one base are not.
 */
export const binomialUpperBound = (successes, trials, { confidence = 0.95 } = {}) => {
  if (!(trials > 0)) {
    return null;
  }

  if (successes >= trials) {
    return 1;
  }

  const alpha = 1 - confidence;
  let low = successes / trials;
  let high = 1;

  for (let round = 0; round < 100; round += 1) {
    const middle = (low + high) / 2;

    if (binomialCdf(successes, trials, middle) > alpha) {
      low = middle;
    } else {
      high = middle;
    }
  }

  return high;
};

/**
 * The held-out pairs at one setting: per split, contrast false hits with
 * their one-sided 95% upper bound and per category, and paraphrase hits.
 * `decisions`: `{ split, kind, category, similarity, guard: { full, required, none } }`.
 */
export const summarizeHeldOutDecisions = (decisions = [], { mode = "full", threshold } = {}) => {
  const wouldHit = (decision) => decision.similarity >= threshold && decision.guard[mode] === true;
  const splits = {};

  for (const split of [...new Set(decisions.map((decision) => decision.split))].sort()) {
    const inSplit = decisions.filter((decision) => decision.split === split);
    const contrasts = inSplit.filter((decision) => decision.kind === "contrast");
    const paraphrases = inSplit.filter((decision) => decision.kind === "paraphrase");
    const falseHits = contrasts.filter(wouldHit);
    const byCategory = {};

    for (const contrast of contrasts) {
      const entry = (byCategory[contrast.category] ??= { total: 0, falseHits: 0, aboveThreshold: 0 });

      entry.total += 1;
      entry.falseHits += wouldHit(contrast) ? 1 : 0;
      entry.aboveThreshold += contrast.similarity >= threshold ? 1 : 0;
    }

    splits[split] = {
      contrastTotal: contrasts.length,
      contrastAboveThreshold: contrasts.filter((decision) => decision.similarity >= threshold).length,
      contrastFalseHits: falseHits.length,
      falseHitUpperBound95: binomialUpperBound(falseHits.length, contrasts.length),
      falseHitIds: falseHits.map((decision) => decision.id).filter(Boolean),
      byCategory,
      paraphraseTotal: paraphrases.length,
      paraphraseHits: paraphrases.filter(wouldHit).length,
    };
  }

  return { mode, threshold, splits };
};
