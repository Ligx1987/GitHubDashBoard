const DEFAULT_TIMES = ['08:05', '09:10', '10:15'];

export function planCapacity(state, { budget = 4600, now = Date.now(), historyTimes = DEFAULT_TIMES,
  maxNewPerRound = 250, retryFraction = 0.1, quotaReserve = 100 } = {}) {
  if (!Number.isSafeInteger(budget) || budget < 1 || !Number.isSafeInteger(maxNewPerRound) || maxNewPerRound < 0
    || !Number.isFinite(retryFraction) || retryFraction < 0 || retryFraction > 1
    || !Number.isSafeInteger(state.available) || !Number.isSafeInteger(state.pending) || state.pending < 0 || state.pending > state.available
    || !historyTimes.length || new Set(historyTimes).size !== historyTimes.length
    || historyTimes.some(t => !/^\d{2}:\d{2}$/.test(t) || Number(t.slice(0, 2)) > 23 || Number(t.slice(3)) > 59)) {
    throw new Error('无效的历史容量配置');
  }
  const minutes = historyTimes.map(t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3))).sort((a, b) => a - b);
  const available = state.available;
  const capacity = budget * minutes.length;
  const demand = Math.ceil(available * (1 + retryFraction));
  const quota = state.quota;
  const quotaActive = quota && Date.parse(quota.resetAt) > now && Number.isSafeInteger(quota.remaining);
  const effectiveBudget = quotaActive ? Math.min(budget, Math.max(0, quota.remaining - quotaReserve)) : budget;
  const local = new Date(now + 8 * 3600000);
  const currentMinute = local.getUTCHours() * 60 + local.getUTCMinutes();
  const futureWindows = minutes.filter(m => m > currentMinute).length;
  const windowsRemaining = currentMinute < minutes[0] ? minutes.length : 1 + futureWindows;
  const remainingCapacity = currentMinute < minutes[0] ? capacity : effectiveBudget + futureWindows * budget;
  const headroom = Math.max(0, Math.floor(capacity / (1 + retryFraction)) - available);
  const historyPending = available > 0 && (state.staleWindow || state.pending > 0);
  const discoveryLimit = !historyPending ? Math.min(maxNewPerRound, headroom) : 0;
  return { available, queuedCandidates: state.queuedCandidates || 0, budget, effectiveBudget,
    historyWindows: minutes.length, windowsRemaining, capacity, remainingCapacity, demand,
    requiredWindows: Math.ceil(demand / budget), capacityStatus: demand <= capacity ? 'sufficient' : 'insufficient',
    pendingFitsRemaining: state.pending <= remainingCapacity,
    retryFraction, discoveryLimit, discoveryReason: historyPending ? 'history-pending' : headroom ? 'bounded' : 'capacity-full',
    finalHistoryRound: currentMinute >= minutes.at(-1) };
}

export function coverageCompletion(state) {
  const complete = !state.staleWindow && state.pending === 0;
  return { status: complete ? 'complete' : 'partial', complete, cutoff: state.cutoff,
    available: state.available, pending: state.pending, staleWindow: state.staleWindow,
    retryablePending: state.retryablePending ?? state.pending,
    cooldownPending: state.cooldownPending || 0, boards: state.boards || [], queuedCandidates: state.queuedCandidates || 0 };
}
