const MINUTE = 60000;
const DAY = 86400000;
export const REGULAR_TIMES = ['00:05', '01:10', '02:15', '03:20', '05:30', '08:05', '09:10', '10:15'];

export function planRecovery(state, { now = Date.now(), previous = null, lastStartedAt = null,
  attempted = false, before = null, regularTimes = REGULAR_TIMES } = {}) {
  const target = new Date(Math.floor(now / DAY) * DAY).toISOString();
  const targetMs = Date.parse(target);
  const sameDay = previous?.target === target;
  const attemptCount = (sameDay ? previous.attemptCount || 0 : 0) + Number(attempted);
  const historyComplete = !state.staleWindow && state.pending === 0 && state.cutoff === target;
  const metadataComplete = !(state.metadata?.pending > 0);
  const complete = historyComplete && metadataComplete;
  const remainingWork = state.pending + (state.metadata?.pending || 0);
  const previousWork = before ? before.pending + (before.metadata?.pending || 0) : sameDay ? previous.remainingWork : remainingWork;
  const stalledAttempts = attempted ? remainingWork < previousWork ? 0 : (sameDay ? previous.stalledAttempts || 0 : 0) + 1
    : sameDay ? previous.stalledAttempts || 0 : 0;
  const deadlineAt = new Date(targetMs + 4 * 3600000).toISOString(); // 北京时间12:00，逾期仍继续自动重试。
  const common = { target, firstObservedAt: sameDay ? previous.firstObservedAt : new Date(now).toISOString(),
    checkedAt: new Date(now).toISOString(), deadlineAt, complete, historyComplete, metadataComplete, metadata: state.metadata || null, attemptCount, stalledAttempts, remainingWork,
    lastRun: sameDay ? previous.lastRun || null : null,
    pending: state.pending, available: state.available, queuedCandidates: state.queuedCandidates || 0,
    boards: state.boards || [], overdue: !complete && now >= Date.parse(deadlineAt) };
  if (complete) return { ...common, status: 'complete', nextRunAt: null, due: false, reason: 'current-window-complete' };

  // 末轮之前由八轮主任务接力。补偿不占用主任务前的65分钟窗口。
  const lastHistoryMinute = Math.max(...regularTimes.filter(t => Number(t.slice(0, 2)) >= 8).map(toMinutes));
  let next = Math.max(now, targetMs + (lastHistoryMinute - 480 + 65) * MINUTE);
  const reasons = [];
  const defer = (value, reason) => { if (Number.isFinite(value) && value > next) { next = value; reasons.push(reason); } };
  defer(Date.parse(lastStartedAt) + 65 * MINUTE, 'minimum-interval');
  if (sameDay && !attempted) defer(Date.parse(previous.nextRunAt), 'scheduled-retry');
  if (attempted) defer(now + 65 * 2 ** Math.min(Math.max(0, stalledAttempts - 1), 2) * MINUTE, 'backoff');
  defer(Date.parse(state.retryAfter), 'upstream-retry-after');
  if (state.quota?.remaining <= 100) defer(Date.parse(state.quota.resetAt) + MINUTE, 'quota-reset');
  const candidates = [...(state.pendingRepositories || []), ...(state.metadataPendingRepositories || [])];
  if (candidates.length && !candidates.some(p => p.verifyMetadata || !(Date.parse(p.retryAt) > now))) {
    defer(Math.min(...candidates.map(p => Date.parse(p.retryAt))), 'repository-cooldown');
  }
  const localDay = Math.floor((next + 480 * MINUTE) / DAY) * DAY - 480 * MINUTE;
  const upcoming = regularTimes.flatMap(t => [localDay + toMinutes(t) * MINUTE, localDay + DAY + toMinutes(t) * MINUTE])
    .filter(t => t >= next).sort((a, b) => a - b)[0];
  if (upcoming - next < 65 * MINUTE) defer(upcoming + 65 * MINUTE, 'reserve-regular-round');
  return { ...common, status: common.overdue ? 'overdue' : 'retry-pending', due: next <= now,
    nextRunAt: new Date(next).toISOString(), reason: reasons.at(-1) || 'history-pending',
    pendingRepositories: candidates };
}

function toMinutes(t) { return Number(t.slice(0, 2)) * 60 + Number(t.slice(3)); }
