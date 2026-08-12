const assert = require('assert');
const {
  compareLeaderboardSnapshots,
  preliminaryCacheRefreshReason,
  shouldBypassLeaderboardCache,
  shouldProbeLeaderboardCache,
} = require('./leaderboard-cache-policy');

function row(overrides = {}) {
  return {
    rank: 1,
    diff: 0,
    uid: 101,
    name: 'App A',
    publisher: 'Publisher',
    hq: 'US',
    headcount: 10,
    release: '2026-01-01T00:00:00Z',
    storeIds: ['2_200', '1_one'],
    stores: [2, 1],
    tags: [{ id: 2, name: 'Puzzle', type: 'games', parent_ids: [20, 10] }],
    ...overrides,
  };
}

const cached = { rows: [row(), row({ rank: 2, uid: 202, name: 'App B' })] };
const reordered = {
  rows: [
    row({ rank: 2, uid: 202, name: 'App B' }),
    row({ storeIds: ['1_one', '2_200'], stores: [1, 2], tags: [{ id: 2, name: 'Puzzle', type: 'games', parent_ids: [10, 20] }] }),
  ],
};
assert.strictEqual(compareLeaderboardSnapshots(cached, reordered).same, true, 'ordering-only changes must not invalidate cache');

const rankChanged = compareLeaderboardSnapshots(cached, {
  rows: [row({ rank: 2, diff: -1 }), row({ rank: 1, diff: 1, uid: 202, name: 'App B' })],
});
assert.strictEqual(rankChanged.same, false, 'rank changes must invalidate cache');
assert.strictEqual(rankChanged.rankChanged, 2);

const membershipChanged = compareLeaderboardSnapshots(cached, {
  rows: [row(), row({ rank: 2, uid: 303, name: 'App C' })],
});
assert.strictEqual(membershipChanged.same, false, 'application membership changes must invalidate cache');
assert.deepStrictEqual(membershipChanged.added, ['303']);
assert.deepStrictEqual(membershipChanged.removed, ['202']);

const metadataChanged = compareLeaderboardSnapshots(cached, {
  rows: [row({ publisher: 'Updated Publisher' }), row({ rank: 2, uid: 202, name: 'App B' })],
});
assert.strictEqual(metadataChanged.same, false, 'mapped leaderboard metadata changes must invalidate cache');
assert.strictEqual(metadataChanged.metadataChanged, 1);

assert.strictEqual(shouldBypassLeaderboardCache({ forceRefresh: true, batchChild: true, batchPhase: 'leaderboard' }), true);
assert.strictEqual(shouldBypassLeaderboardCache({ forceRefresh: true, batchChild: true, batchPhase: 'application' }), false,
  'fresh unified application phase must reuse the leaderboard confirmed in phase one');
assert.strictEqual(shouldProbeLeaderboardCache({ missingCountriesOnly: false, batchChild: true, batchPhase: 'leaderboard' }), true);
assert.strictEqual(shouldProbeLeaderboardCache({ missingCountriesOnly: false, batchChild: true, batchPhase: 'application' }), false,
  'application phase must not probe or pull the leaderboard a second time');
assert.strictEqual(shouldProbeLeaderboardCache({ missingCountriesOnly: true, batchChild: false, batchPhase: '' }), false,
  'missing-country retries must strictly reuse the confirmed leaderboard');

assert.strictEqual(preliminaryCacheRefreshReason({
  weekAnchor: '2026-08-03',
  fetchedAt: '2026-08-10T01:00:00.000Z',
  now: '2026-08-12T01:30:00.000Z',
}).shouldRefresh, true, 'a Monday snapshot must refresh after the following Wednesday boundary');
assert.strictEqual(preliminaryCacheRefreshReason({
  weekAnchor: '2026-08-03',
  fetchedAt: '2026-08-10T01:00:00.000Z',
  now: '2026-08-11T23:59:59.000Z',
}).shouldRefresh, false, 'preliminary snapshots must remain reusable before the Wednesday boundary');
assert.strictEqual(preliminaryCacheRefreshReason({
  weekAnchor: '2026-08-03',
  fetchedAt: '2026-08-12T00:30:00.000Z',
  now: '2026-08-12T02:00:00.000Z',
}).shouldRefresh, false, 'a snapshot fetched after finalization must not refresh solely because of age');

console.log('leaderboard cache policy tests passed');
