// @ts-check

function uniqueStrings(values) {
  return [...new Set((values || []).map(value => String(value || '').trim()).filter(Boolean))];
}

function buildTwoPhaseWeekPlan(weekAnchors, accounts) {
  const weeks = uniqueStrings(weekAnchors).sort((a, b) => b.localeCompare(a));
  const accountPool = uniqueStrings(accounts);
  // 多周任务必须先确认全部周的榜单，再开始任一周的应用数据采集。
  // 两个阶段都按时间从近到远串行；应用数据阶段由完整账号池共同消费该周队列。
  return {
    weeks,
    accounts: accountPool,
    leaderboardConcurrency: 1,
    applicationConcurrency: 1,
  };
}

function createLeaderboardAccountRotator(accounts, defaultCooldownMs = 120000) {
  const queue = [];
  const seen = new Set();
  for (const account of accounts || []) {
    const dir = String(account && account.dir || '').trim();
    if (!dir || !account.token || seen.has(dir)) continue;
    seen.add(dir);
    queue.push({
      account,
      availableAt: Math.max(0, Number(account.availableAt) || 0),
      rateLimitCount: 0,
    });
  }
  const fallbackCooldownMs = Math.max(1000, Number(defaultCooldownMs) || 120000);

  function selection(nowMs = Date.now()) {
    if (!queue.length) return { account: null, waitMs: 0, allLimited: false };
    const entry = queue[0];
    return {
      account: entry.account,
      waitMs: Math.max(0, entry.availableAt - nowMs),
      allLimited: entry.availableAt > nowMs,
    };
  }

  function markRateLimited(accountDir, cooldownMs, nowMs = Date.now()) {
    const index = queue.findIndex(entry => entry.account.dir === accountDir);
    if (index < 0) throw new Error(`unknown leaderboard account: ${accountDir}`);
    const [entry] = queue.splice(index, 1);
    entry.availableAt = nowMs + Math.max(1000, Number(cooldownMs) || fallbackCooldownMs);
    entry.rateLimitCount++;
    // 限流账号移到队尾；只有前面的可用账号全部依次限流后，队列才会回到它。
    queue.push(entry);
    return selection(nowMs);
  }

  function markSucceeded(accountDir) {
    const entry = queue.find(item => item.account.dir === accountDir);
    if (entry) entry.availableAt = 0;
  }

  function snapshot(nowMs = Date.now()) {
    return queue.map(entry => ({
      dir: entry.account.dir,
      waitMs: Math.max(0, entry.availableAt - nowMs),
      rateLimitCount: entry.rateLimitCount,
    }));
  }

  return {
    selection,
    markRateLimited,
    markSucceeded,
    snapshot,
  };
}

function countryCollectionProgress(categories, complete = false) {
  let total = 0;
  let done = 0;
  for (const category of categories || []) {
    const categoryTotal = Math.max(0, Number(category && category.countryTotal) || 0);
    const categoryDone = Math.max(0, Math.min(categoryTotal, Number(category && category.countryDone) || 0));
    total += categoryTotal;
    done += categoryDone;
  }
  return {
    total,
    done,
    remaining: Math.max(0, total - done),
    overall: total > 0 ? Math.round(done * 100 / total) : (complete ? 100 : 0),
  };
}

function aggregateBatchCountryProgress(progresses) {
  let countryDone = 0;
  let countryTotal = 0;
  for (const progress of progresses || []) {
    countryDone += Math.max(0, Number(progress && progress.countryDone) || 0);
    countryTotal += Math.max(0, Number(progress && progress.countryTotal) || 0);
  }
  return {
    countryDone,
    countryTotal,
    countryRemaining: Math.max(0, countryTotal - countryDone),
    overall: countryTotal > 0 ? Math.round(countryDone * 100 / countryTotal) : 0,
  };
}

function focusMarketSplit(focusApps) {
  const split = {
    mature: 0,
    emerging: 0,
    suspectedDelisted: 0,
    unclassified: 0,
    pending: 0,
    unknown: 0,
  };
  for (const app of focusApps || []) {
    const market = String(app && app.market || '');
    const countryStatus = String(app && app.countryStatus || '');
    if (market.startsWith('偏成熟')) {
      split.mature++;
    } else if (market) {
      split.emerging++;
    } else if ((app && app.suspectedDelisted) || countryStatus === '默认下架') {
      split.suspectedDelisted++;
    } else if (countryStatus === '商店可用' || countryStatus === '商店链接未确认') {
      split.unclassified++;
    } else {
      split.pending++;
    }
  }
  // 保留 unknown 供旧接口使用，但界面不得再把它直接显示成“待采集”。
  split.unknown = split.suspectedDelisted + split.unclassified + split.pending;
  return split;
}

module.exports = {
  buildTwoPhaseWeekPlan,
  createLeaderboardAccountRotator,
  countryCollectionProgress,
  aggregateBatchCountryProgress,
  focusMarketSplit,
};
