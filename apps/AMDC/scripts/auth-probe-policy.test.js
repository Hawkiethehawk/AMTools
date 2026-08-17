// @ts-check
'use strict';

const assert = require('assert');
const {
  AUTH_PROBE_MAX_ATTEMPTS,
  AUTH_PROBE_RETRY_AFTER_MAX_MS,
  authProbeRetryDelayMs,
  classifyAuthProbe,
  isTransientAuthProbe,
} = require('./auth-probe-policy');

assert.strictEqual(AUTH_PROBE_MAX_ATTEMPTS, 3);
assert.strictEqual(classifyAuthProbe({ ok: true, status: 200 }), 'ok');
assert.strictEqual(classifyAuthProbe({ ok: false, status: 0, body: 'AbortError: operation aborted' }), 'timeout');
assert.strictEqual(classifyAuthProbe({ ok: false, status: 0, body: 'fetch failed' }), 'network');
assert.strictEqual(classifyAuthProbe({ ok: false, status: 429 }), 'rate_limited');
assert.strictEqual(classifyAuthProbe({ ok: false, status: 503 }), 'server_error');
assert.strictEqual(classifyAuthProbe({ ok: false, status: 401 }), 'auth_failed');
assert.strictEqual(classifyAuthProbe({ ok: false, status: 404 }), 'http_error');
assert.strictEqual(isTransientAuthProbe({ ok: false, status: 0, body: 'fetch failed' }), true);
assert.strictEqual(isTransientAuthProbe({ ok: false, status: 401 }), false);
assert.strictEqual(authProbeRetryDelayMs({ status: 0 }, 1, () => 0), 2000);
assert.strictEqual(authProbeRetryDelayMs({ status: 0 }, 2, () => 0.5), 5375);
assert.strictEqual(
  authProbeRetryDelayMs({ status: 429, retryAfterMs: 120000 }, 1, () => 0),
  AUTH_PROBE_RETRY_AFTER_MAX_MS,
);

console.log('auth probe policy test ok');
