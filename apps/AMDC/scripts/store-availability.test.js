'use strict';

const assert = require('node:assert/strict');
const { applyStoreCheck, storeCheckDue } = require('./store-availability');

const day = 24 * 60 * 60 * 1000;
const hour = 60 * 60 * 1000;
const now = Date.parse('2026-08-12T10:00:00+08:00');

{
  const record = { country: { mature: 76 }, countryStatus: '已采集' };
  applyStoreCheck(record, { status: 'not_found', url: 'https://example.test/app', httpStatus: 404 }, new Date(now).toISOString());
  assert.equal(record.countryStatus, '默认下架');
  assert.equal(record.storeLinkStatus, 'not_found');
  assert.deepEqual(record.country, { mature: 76 }, 'historical country details must be retained');
}

{
  const record = { country: { mature: 76 }, countryStatus: '默认下架', storeLinkStatus: 'not_found' };
  const outcome = applyStoreCheck(record, { status: 'available', url: 'https://example.test/app', httpStatus: 200 }, new Date(now).toISOString());
  assert.equal(record.countryStatus, '已采集');
  assert.equal(record.storeLinkStatus, 'available');
  assert.equal(outcome.recovered, true);
}

{
  const checkedAt = new Date(now - day * 2).toISOString();
  const record = { countryStatus: '默认下架', storeLinkStatus: 'not_found', storeCheckedAt: checkedAt };
  applyStoreCheck(record, { status: 'unknown', httpStatus: 429 }, new Date(now).toISOString());
  assert.equal(record.countryStatus, '默认下架');
  assert.equal(record.storeLinkStatus, 'not_found', 'an uncertain response must not overwrite a confirmed result');
  assert.equal(record.storeCheckError, 'HTTP 429');
}

{
  const fresh = { storeLinkStatus: 'available', storeCheckedAt: new Date(now - hour).toISOString() };
  const stale = { storeLinkStatus: 'available', storeCheckedAt: new Date(now - day * 2).toISOString() };
  const recentFailure = { storeLinkStatus: 'unknown', storeCheckAttemptAt: new Date(now - hour / 2).toISOString() };
  assert.equal(storeCheckDue([fresh], { now, ttlMs: day, retryMs: hour }), false);
  assert.equal(storeCheckDue([stale], { now, ttlMs: day, retryMs: hour }), true);
  assert.equal(storeCheckDue([recentFailure], { now, ttlMs: day, retryMs: hour }), false);
}

console.log('store availability tests passed');
