/** UTC daily samples. A delta is a net change, including removed stars. */
export const DAY_MS = 86_400_000;

export function utcDate(value = Date.now()) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : null;
}

export function previousUtcDate(value, days) {
  const date = utcDate(value);
  return date ? utcDate(Date.parse(`${date}T00:00:00Z`) - days * DAY_MS) : null;
}

export function validStarCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Compare against the exact UTC date 1, 7 or 30 days earlier. Historical files
 * contain one last successful sample per UTC day, so this is a daily-sample
 * comparison, not an exact rolling 24/168/720-hour event count. A missing date
 * is never replaced with the nearest observation or with zero.
 */
export function calculateGrowth(historyForRepo = {}, currentStars, now = Date.now()) {
  const delta = (days) => {
    const date = previousUtcDate(now, days);
    const baseline = date && historyForRepo?.[date];
    return validStarCount(currentStars) && validStarCount(baseline)
      ? currentStars - baseline
      : null;
  };
  return { todayStars: delta(1), weekStars: delta(7), monthStars: delta(30) };
}

/** Actual consecutive UTC daily differences, with per-point sample coverage. */
export function buildTrendSeries(projects, history = {}, now = Date.now()) {
  const dates = Array.from({ length: 7 }, (_, index) => previousUtcDate(now, 6 - index));
  const points = dates.map((date) => {
    const previous = previousUtcDate(date, 1);
    let total = 0;
    let covered = 0;
    for (const project of projects) {
      const samples = history[project.fullName] || {};
      const current = samples[date];
      const baseline = samples[previous];
      if (validStarCount(current) && validStarCount(baseline)) {
        total += current - baseline;
        covered += 1;
      }
    }
    return { value: covered ? total : null, covered };
  });
  return {
    dates,
    labels: dates.map((date) => date?.slice(5) || ''),
    values: points.map((point) => point.value),
    coverage: points.map((point) => point.covered),
    total: projects.length,
    basis: 'UTC daily samples; net star change among repositories with both dates',
  };
}
