// @ts-check
'use strict';

const AUTH_PROBE_MAX_ATTEMPTS = 3;
const AUTH_PROBE_RETRY_BACKOFF_MS = [2000, 5000];
const AUTH_PROBE_RETRY_AFTER_MAX_MS = 60000;
const AUTH_PROBE_JITTER_MAX_MS = 750;

function probeStatus(result) {
  const status = Number(result && result.status);
  return Number.isFinite(status) ? Math.max(0, Math.floor(status)) : 0;
}

function classifyAuthProbe(result) {
  if (result && result.ok) return 'ok';
  const status = probeStatus(result);
  if (status === 0) {
    const detail = String(result && result.body || '');
    return /abort|timeout|timed out/i.test(detail) ? 'timeout' : 'network';
  }
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  if (status === 401 || status === 403) return 'auth_failed';
  return 'http_error';
}

function isTransientAuthProbe(result) {
  const category = classifyAuthProbe(result);
  return category === 'timeout'
    || category === 'network'
    || category === 'rate_limited'
    || category === 'server_error';
}

function authProbeRetryDelayMs(result, retryNumber, random = Math.random) {
  const index = Math.max(0, Math.min(AUTH_PROBE_RETRY_BACKOFF_MS.length - 1, retryNumber - 1));
  const retryAfterMs = Math.max(0, Number(result && result.retryAfterMs) || 0);
  const baseDelay = probeStatus(result) === 429 && retryAfterMs > 0
    ? Math.min(retryAfterMs, AUTH_PROBE_RETRY_AFTER_MAX_MS)
    : AUTH_PROBE_RETRY_BACKOFF_MS[index];
  const randomValue = Math.max(0, Math.min(1, Number(random()) || 0));
  return baseDelay + Math.round(randomValue * AUTH_PROBE_JITTER_MAX_MS);
}

module.exports = {
  AUTH_PROBE_MAX_ATTEMPTS,
  AUTH_PROBE_RETRY_AFTER_MAX_MS,
  authProbeRetryDelayMs,
  classifyAuthProbe,
  isTransientAuthProbe,
  probeStatus,
};
