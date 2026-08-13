'use strict';

function timestamp(record, field) {
  const value = new Date(record && record[field] || '').getTime();
  return Number.isFinite(value) ? value : 0;
}

function storeCheckDue(records, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const ttlMs = Number(options.ttlMs) || 0;
  const retryMs = Number(options.retryMs) || 0;
  const confirmedAt = Math.max(0, ...records
    .filter(record => ['available', 'not_found'].includes(record.storeLinkStatus))
    .map(record => timestamp(record, 'storeCheckedAt')));
  if (confirmedAt && now - confirmedAt < ttlMs) return false;
  const attemptedAt = Math.max(0, ...records.map(record => timestamp(record, 'storeCheckAttemptAt')));
  return !attemptedAt || now - attemptedAt >= retryMs;
}

function applyStoreCheck(record, result, checkedAt, fallbackUrl = '') {
  const previousStatus = record.storeLinkStatus || '';
  record.storeLink = result.url || record.storeLink || fallbackUrl;
  record.storeCheckAttemptAt = checkedAt;
  if (result.status === 'unknown') {
    record.storeCheckError = result.error || (result.httpStatus ? `HTTP ${result.httpStatus}` : '商店链接状态未知');
    if (!['available', 'not_found'].includes(previousStatus)) {
      record.storeLinkStatus = 'unknown';
      if (!record.country) record.countryStatus = '商店链接未确认';
    }
    return { changed: false, recovered: false };
  }
  record.storeLinkStatus = result.status;
  record.storeCheckedAt = checkedAt;
  record.storeCheckError = '';
  if (result.status === 'not_found') {
    record.countryStatus = '默认下架';
    return { changed: previousStatus !== 'not_found', recovered: false };
  }
  const recovered = previousStatus === 'not_found' || record.countryStatus === '默认下架';
  record.countryStatus = record.country ? '已采集' : '商店可用';
  return { changed: previousStatus !== 'available', recovered };
}

module.exports = { applyStoreCheck, storeCheckDue };
