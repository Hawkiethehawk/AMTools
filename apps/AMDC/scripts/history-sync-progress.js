'use strict';

function clampProgress(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, number));
}

function aggregateBatchSyncProgress(items) {
  const list = Array.isArray(items) ? items : [];
  const total = list.length;
  let completed = 0;
  let failed = 0;
  let progressPoints = 0;
  let active = 0;

  for (const item of list) {
    const status = String(item && item.status || 'waiting');
    const terminal = status === 'done' || status === 'failed';
    if (terminal) completed += 1;
    if (status === 'failed') failed += 1;
    if (status === 'syncing') active += 1;
    progressPoints += terminal ? 100 : clampProgress(item && item.progress);
  }

  const progress = total ? Math.min(100, Math.floor(progressPoints / total)) : 0;
  return {
    total,
    completed,
    failed,
    active,
    progress: completed === total && total > 0 ? 100 : progress,
  };
}

module.exports = { aggregateBatchSyncProgress };
