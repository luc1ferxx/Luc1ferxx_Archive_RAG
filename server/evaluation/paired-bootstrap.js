// paired-bootstrap.js
//
// The paired bootstrap the QASPER harnesses share. Two runs over the same
// questions are compared question by question (this run minus the other), and
// the interval resamples questions, so a question's two outcomes stay
// together. The RNG is mulberry32 with a fixed seed, so a report's intervals
// are reproducible; a caller that draws several intervals from one RNG must
// keep drawing them in the same order.

export const createSeededRandom = (seed) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const roundTo4 = (value) => (value === null ? null : Number(value.toFixed(4)));

/**
 * The 95% percentile interval of the mean of `diffs` over `iterations`
 * resamples with replacement, or null when there is nothing to resample.
 * `random` is consumed in order, iterations x diffs.length draws.
 */
export const bootstrapMeanInterval = (
  diffs,
  { iterations = 4000, random = createSeededRandom(1), roundValue = roundTo4 } = {}
) => {
  if (diffs.length === 0) {
    return null;
  }

  const samples = [];

  for (let index = 0; index < iterations; index += 1) {
    let sum = 0;

    for (let draw = 0; draw < diffs.length; draw += 1) {
      sum += diffs[Math.floor(random() * diffs.length)];
    }

    samples.push(sum / diffs.length);
  }

  samples.sort((left, right) => left - right);

  return [roundValue(samples[Math.floor(iterations * 0.025)]), roundValue(samples[Math.floor(iterations * 0.975)])];
};

/**
 * The 95% percentile interval of the mean of per-question differences when
 * the questions come in clusters (the questions of one paper share its
 * chunks and vectors, so their outcomes move together): each resample draws
 * clusters with replacement and keeps every question of a drawn cluster, so
 * correlated questions are not counted as independent. `clusters` is an
 * array of arrays of differences; `random` is consumed in order, iterations
 * x clusters.length draws. With one question per cluster it equals
 * bootstrapMeanInterval over the same differences and draws.
 */
export const bootstrapClusterMeanInterval = (
  clusters,
  { iterations = 4000, random = createSeededRandom(1), roundValue = roundTo4 } = {}
) => {
  const groups = clusters.filter((group) => group.length > 0);

  if (groups.length === 0) {
    return null;
  }

  const sums = groups.map((group) => group.reduce((sum, value) => sum + value, 0));
  const samples = [];

  for (let index = 0; index < iterations; index += 1) {
    let sum = 0;
    let count = 0;

    for (let draw = 0; draw < groups.length; draw += 1) {
      const pick = Math.floor(random() * groups.length);

      sum += sums[pick];
      count += groups[pick].length;
    }

    samples.push(sum / count);
  }

  samples.sort((left, right) => left - right);

  return [roundValue(samples[Math.floor(iterations * 0.025)]), roundValue(samples[Math.floor(iterations * 0.975)])];
};

/** The paired delta and interval of ready-made per-question differences. */
export const pairedDeltaOfDiffs = (diffs, { iterations = 4000, seed = 1, roundValue = roundTo4 } = {}) => {
  if (diffs.length === 0) {
    return { cases: 0, ci95: null, delta: null };
  }

  return {
    cases: diffs.length,
    ci95: bootstrapMeanInterval(diffs, { iterations, random: createSeededRandom(seed), roundValue }),
    delta: roundValue(diffs.reduce((sum, value) => sum + value, 0) / diffs.length),
  };
};

/** Paired bootstrap of a numeric field, this arm minus the other, by question id. */
export const pairedMeanDelta = (rows, otherRows, field, { iterations = 4000, seed = 1, roundValue = roundTo4 } = {}) => {
  const other = new Map(otherRows.map((row) => [row.id, row]));
  const diffs = rows
    .filter((row) => other.has(row.id))
    .map((row) => (Number(row[field]) || 0) - (Number(other.get(row.id)[field]) || 0));

  return pairedDeltaOfDiffs(diffs, { iterations, seed, roundValue });
};
