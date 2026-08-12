const crypto = require('crypto');

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sortedStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(value => String(value)))]
    .sort((a, b) => a.localeCompare(b));
}

function normalizeTag(tag) {
  return {
    id: String(tag && tag.id != null ? tag.id : ''),
    name: String(tag && tag.name || ''),
    type: String(tag && tag.type || ''),
    parentIds: sortedStrings(tag && tag.parent_ids),
  };
}

function normalizeLeaderboardRow(row) {
  return {
    rank: numberOrNull(row && row.rank),
    diff: numberOrNull(row && row.diff),
    uid: String(row && row.uid != null ? row.uid : ''),
    name: String(row && row.name || ''),
    publisher: String(row && row.publisher || ''),
    hq: String(row && row.hq || ''),
    headcount: numberOrNull(row && row.headcount),
    release: String(row && row.release || ''),
    storeIds: sortedStrings(row && row.storeIds),
    stores: sortedStrings(row && row.stores),
    tags: (Array.isArray(row && row.tags) ? row.tags : [])
      .map(normalizeTag)
      .sort((a, b) => `${a.id}|${a.type}|${a.name}`.localeCompare(`${b.id}|${b.type}|${b.name}`)),
  };
}

function normalizeLeaderboardSnapshot(snapshot) {
  return (Array.isArray(snapshot && snapshot.rows) ? snapshot.rows : [])
    .map(normalizeLeaderboardRow)
    .sort((a, b) => (a.rank == null ? Number.MAX_SAFE_INTEGER : a.rank) - (b.rank == null ? Number.MAX_SAFE_INTEGER : b.rank)
      || a.uid.localeCompare(b.uid));
}

function fingerprintNormalizedRows(rows) {
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function leaderboardSnapshotFingerprint(snapshot) {
  return fingerprintNormalizedRows(normalizeLeaderboardSnapshot(snapshot));
}

function compareLeaderboardSnapshots(cachedSnapshot, liveSnapshot) {
  const cached = normalizeLeaderboardSnapshot(cachedSnapshot);
  const live = normalizeLeaderboardSnapshot(liveSnapshot);
  const cachedFingerprint = fingerprintNormalizedRows(cached);
  const liveFingerprint = fingerprintNormalizedRows(live);
  if (cachedFingerprint === liveFingerprint) {
    return {
      same: true,
      cachedFingerprint,
      liveFingerprint,
      cachedRows: cached.length,
      liveRows: live.length,
      added: [],
      removed: [],
      changed: 0,
      rankChanged: 0,
      metadataChanged: 0,
    };
  }

  const cachedByUid = new Map(cached.map(row => [row.uid, row]));
  const liveByUid = new Map(live.map(row => [row.uid, row]));
  const added = [...liveByUid.keys()].filter(uid => !cachedByUid.has(uid));
  const removed = [...cachedByUid.keys()].filter(uid => !liveByUid.has(uid));
  let changed = 0;
  let rankChanged = 0;
  let metadataChanged = 0;

  for (const [uid, liveRow] of liveByUid) {
    const cachedRow = cachedByUid.get(uid);
    if (!cachedRow || JSON.stringify(cachedRow) === JSON.stringify(liveRow)) continue;
    changed++;
    if (cachedRow.rank !== liveRow.rank || cachedRow.diff !== liveRow.diff) rankChanged++;
    else metadataChanged++;
  }

  return {
    same: false,
    cachedFingerprint,
    liveFingerprint,
    cachedRows: cached.length,
    liveRows: live.length,
    added: added.slice(0, 10),
    removed: removed.slice(0, 10),
    changed,
    rankChanged,
    metadataChanged,
  };
}

function shouldBypassLeaderboardCache({ forceRefresh, batchChild, batchPhase }) {
  return !!forceRefresh && !(batchChild && batchPhase === 'application');
}

function shouldProbeLeaderboardCache({ missingCountriesOnly, batchChild, batchPhase }) {
  return !missingCountriesOnly && !(batchChild && batchPhase === 'application');
}

function preliminaryCacheRefreshReason({ weekAnchor, fetchedAt, now = new Date() }) {
  const anchor = new Date(`${String(weekAnchor || '')}T00:00:00Z`);
  const fetched = new Date(fetchedAt || 0);
  const current = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(anchor.getTime()) || anchor.getUTCDay() !== 1 ||
      !Number.isFinite(fetched.getTime()) || !Number.isFinite(current.getTime())) {
    return { shouldRefresh: false, boundary: '', fetchedAt: '' };
  }
  // A weekly snapshot taken before the following Wednesday is preliminary.
  const boundary = new Date(anchor.getTime() + 9 * 24 * 60 * 60 * 1000);
  return {
    shouldRefresh: current.getTime() >= boundary.getTime() && fetched.getTime() < boundary.getTime(),
    boundary: boundary.toISOString(),
    fetchedAt: fetched.toISOString(),
  };
}

module.exports = {
  compareLeaderboardSnapshots,
  leaderboardSnapshotFingerprint,
  normalizeLeaderboardSnapshot,
  preliminaryCacheRefreshReason,
  shouldBypassLeaderboardCache,
  shouldProbeLeaderboardCache,
};
