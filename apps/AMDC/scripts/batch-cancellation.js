'use strict';

function batchStopped(state) {
  return !!(state && (state.state === 'stopped' || state.stopRequested));
}

function stoppedBatchState(state, stoppedAt, detail = '批量采集已停止') {
  const current = state && typeof state === 'object' ? state : {};
  const children = Array.isArray(current.children) ? current.children.map(child => {
    if (!child || child.state === 'done' || child.state === 'failed') return child;
    return {
      ...child,
      state: 'stopped',
      finishedAt: stoppedAt,
      exitCode: -1,
      detail,
    };
  }) : [];
  return {
    ...current,
    state: 'stopped',
    stopRequested: true,
    finishedAt: stoppedAt,
    updatedAt: stoppedAt,
    exitCode: -1,
    detail,
    children,
  };
}

function eventsThroughStop(events) {
  const rows = Array.isArray(events) ? events : [];
  const stoppedAt = rows.reduce((earliest, event) => {
    if (!event || event.message !== '批量采集已停止') return earliest;
    const value = new Date(event.at || '').getTime();
    return Number.isFinite(value) && (!earliest || value < earliest) ? value : earliest;
  }, 0);
  if (!stoppedAt) return rows;
  return rows.filter(event => {
    const value = new Date(event && event.at || '').getTime();
    return !Number.isFinite(value) || value <= stoppedAt;
  });
}

function terminateProcessTree(child, options = {}) {
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0) return false;
  const platform = options.platform || process.platform;
  const execFile = options.execFile || require('child_process').execFile;
  if (platform === 'win32') {
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    return true;
  }
  try {
    child.kill('SIGTERM');
    const timer = setTimeout(() => {
      try { if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL'); } catch {}
    }, Number(options.forceAfterMs) || 5000);
    if (timer.unref) timer.unref();
    return true;
  } catch {
    return false;
  }
}

module.exports = { batchStopped, stoppedBatchState, eventsThroughStop, terminateProcessTree };
