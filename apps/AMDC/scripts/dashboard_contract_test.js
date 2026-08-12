#!/usr/bin/env node
// @ts-check
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildTwoPhaseWeekPlan, createLeaderboardAccountRotator, countryCollectionProgress, aggregateBatchCountryProgress, focusMarketSplit } = require('./collection-plan');
const { aggregateBatchSyncProgress } = require('./history-sync-progress');

const port = String(18000 + Math.floor(Math.random() * 1000));
const testProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amdc-contract-'));
seedHistoryFixture();
const server = spawn(process.execPath, [require.resolve('./progress-server.js')], {
  env: {
    ...process.env,
    AMDC_PORT: port,
    AMDC_NO_OPEN: '1',
    AMDC_PROJECT_DIR: testProjectDir,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let output = '';
server.stdout.on('data', chunk => { output += String(chunk); });
server.stderr.on('data', chunk => { output += String(chunk); });

function closeServer() {
  if (!server.killed) server.kill();
  try { fs.rmSync(testProjectDir, { recursive: true, force: true }); } catch {}
}

function seedHistoryFixture() {
  const cacheDir = path.join(testProjectDir, 'Cache');
  const historyDir = path.join(cacheDir, 'history');
  const records = [
    {
      id: '20260802-010000-aaaa',
      outputDir: path.join(historyDir, '20260802-010000-aaaa'),
      status: 'done',
      startedAt: '2026-08-02T01:00:00.000Z',
      finishedAt: '2026-08-02T01:01:00.000Z',
      weekAnchor: '2026-07-27',
      batchId: 'batch-old',
      resultSummary: { categories: 7, records: 100, focusCount: 10 },
      source: 'scheduled',
    },
    {
      id: '20260803-012000-bbbb',
      outputDir: path.join(historyDir, '20260803-012000-bbbb'),
      status: 'done',
      startedAt: '2026-08-03T01:20:00.000Z',
      finishedAt: '2026-08-03T01:21:00.000Z',
      weekAnchor: '2026-07-27',
      batchId: 'batch-new',
      resultSummary: { categories: 7, records: 120, focusCount: 12 },
      source: 'manual',
      autoFresh: false,
      autoFreshReasons: [],
    },
  ];
  fs.mkdirSync(historyDir, { recursive: true });
  fs.writeFileSync(path.join(historyDir, 'index.json'), JSON.stringify(records, null, 2));
  for (const record of records) {
    fs.mkdirSync(record.outputDir, { recursive: true });
    fs.writeFileSync(path.join(record.outputDir, 'metadata.json'), JSON.stringify(record, null, 2));
    if (record.id === '20260803-012000-bbbb') {
      fs.writeFileSync(path.join(record.outputDir, 'amdc-run-state.json'), JSON.stringify({
        _meta: {
          autoFresh: true,
          autoFreshReasons: [
            { category: '休闲', mismatchCount: 1 },
            { category: '壁纸', mismatchCount: 2 },
          ],
        },
      }, null, 2));
    }
  }
  for (const week of ['20260727', '20260720']) {
    const legacyDir = path.join(cacheDir, week);
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'amdc-legacy-weekly.json'), '{}');
  }
}

async function fetchWithRetry(url, options) {
  let lastError = null;
  for (let i = 0; i < 40; i++) {
    try {
      return await fetch(url, options);
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw lastError || new Error('fetch failed');
}

async function postJson(url, token) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'X-AMDC-Token': token },
  });
  let body = {};
  try { body = await res.json(); } catch {}
  return { res, body };
}

async function postJsonBody(url, token, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-AMDC-Token': token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  let body = {};
  try { body = await res.json(); } catch {}
  return { res, body };
}

async function main() {
  const plan = buildTwoPhaseWeekPlan(
    ['2026-06-22', '2026-07-13', '2026-06-29', '2026-07-06'],
    ['.amdc-userdata', '.amdc-userdata-b', '.amdc-userdata'],
  );
  if (plan.leaderboardConcurrency !== 1 || plan.applicationConcurrency !== 1 ||
      plan.weeks.join(',') !== '2026-07-13,2026-07-06,2026-06-29,2026-06-22' ||
      plan.accounts.length !== 2) {
    throw new Error(`multi-week collection must be sequential, newest first, in both phases: ${JSON.stringify(plan)}`);
  }
  const rotationNow = 1000;
  const leaderboardRotator = createLeaderboardAccountRotator([
    { dir: 'A', token: 'token-a' },
    { dir: 'B', token: 'token-b' },
    { dir: 'C', token: 'token-c' },
  ], 1000);
  if (leaderboardRotator.selection(rotationNow).account.dir !== 'A' ||
      leaderboardRotator.markRateLimited('A', 1000, rotationNow).account.dir !== 'B' ||
      leaderboardRotator.markRateLimited('B', 1000, rotationNow + 100).account.dir !== 'C') {
    throw new Error('rate-limited leaderboard accounts must move to the tail and hand work to the next account');
  }
  const wrapped = leaderboardRotator.markRateLimited('C', 1000, rotationNow + 200);
  if (wrapped.account.dir !== 'A' || wrapped.waitMs !== 800 || !wrapped.allLimited ||
      leaderboardRotator.selection(rotationNow + 1000).account.dir !== 'A') {
    throw new Error(`leaderboard rotation must return to the first limited account only after the pool is exhausted: ${JSON.stringify(wrapped)}`);
  }
  const countryProgress = countryCollectionProgress([
    { countryDone: 4, countryTotal: 6 },
    { countryDone: 3, countryTotal: 4 },
  ]);
  if (countryProgress.done !== 7 || countryProgress.total !== 10 || countryProgress.overall !== 70) {
    throw new Error(`overall progress must use collected-country apps / all-country apps: ${JSON.stringify(countryProgress)}`);
  }
  const batchProgress = aggregateBatchCountryProgress([
    { countryDone: 4, countryTotal: 6 },
    { countryDone: 3, countryTotal: 4 },
    { countryDone: 0, countryTotal: 10 },
  ]);
  if (batchProgress.countryDone !== 7 || batchProgress.countryTotal !== 20 || batchProgress.countryRemaining !== 13 || batchProgress.overall !== 35) {
    throw new Error(`batch progress must aggregate every selected week: ${JSON.stringify(batchProgress)}`);
  }
  const marketSplit = focusMarketSplit([
    { market: '偏成熟(成熟60.0%/新兴40.0%)' },
    { market: '偏新兴(新兴70.0%/成熟30.0%)' },
    { suspectedDelisted: true, countryStatus: '默认下架' },
    { countryStatus: '商店可用' },
    { countryStatus: '商店链接未确认' },
    {},
  ]);
  if (marketSplit.mature !== 1 || marketSplit.emerging !== 1 ||
      marketSplit.suspectedDelisted !== 1 || marketSplit.unclassified !== 2 ||
      marketSplit.pending !== 1 || marketSplit.unknown !== 4) {
    throw new Error(`market split must separate terminal no-country states from truly pending apps: ${JSON.stringify(marketSplit)}`);
  }
  const batchSyncProgress = aggregateBatchSyncProgress([
    { status: 'done', progress: 100 },
    { status: 'syncing', progress: 50 },
    { status: 'waiting', progress: 0 },
    { status: 'failed', progress: 12 },
  ]);
  if (batchSyncProgress.total !== 4 || batchSyncProgress.completed !== 2 || batchSyncProgress.failed !== 1 || batchSyncProgress.progress !== 62) {
    throw new Error(`batch Feishu sync progress must aggregate all selected weeks: ${JSON.stringify(batchSyncProgress)}`);
  }
  const powershellRunner = fs.readFileSync(path.join(__dirname, 'run_amdc_weekly.ps1'), 'utf8');
  if (!powershellRunner.includes('[string[]]($env:AMDC_CATEGORIES | ConvertFrom-Json)') ||
      !powershellRunner.includes('ConvertTo-Json -InputObject @($Categories) -Compress')) {
    throw new Error('PowerShell category JSON must be normalized to a real string array');
  }
  const readSource = name => fs.readFileSync(path.join(__dirname, name), 'utf8').replace(/\r\n/g, '\n');
  const progressServerSource = readSource('progress-server.js');
  const cliSource = readSource('../am.js');
  const scheduledRunnerSource = readSource('run_amdc_scheduled.ps1');
  const amdaTriggerSource = readSource('run_amda_after_amdc.ps1');
  const scheduleRegistrationSource = readSource('../schedules/register-windows-tasks.ps1');
  const weeklyScheduleSource = readSource('../schedules/weekly-run.sh');
  const weeklyTaskSource = fs.readFileSync(path.join(__dirname, '..', 'schedules', 'weekly-run.xml'), 'utf16le');
  const accountSyncTaskSource = fs.readFileSync(path.join(__dirname, '..', 'schedules', 'account-sync.xml'), 'utf16le');
  const xlsxSource = readSource('amdc_xlsx_common.py');
  const feishuSyncSource = readSource('amdc_feishu_sync.py');
  const accountSyncSource = readSource('sync-account-profiles.ps1');
  if (!progressServerSource.includes("'pwsh', 'pwsh.exe'") ||
      !progressServerSource.includes('PowerShell 7 (pwsh) is required') ||
      progressServerSource.includes("commandExists('powershell.exe')")) {
    throw new Error('dashboard must require PowerShell 7 without a Windows PowerShell fallback');
  }
  if (!cliSource.includes('const command = powershell7Command();') ||
      !cliSource.includes('PowerShell 7 (pwsh) is required') ||
      cliSource.includes("commandExists('powershell.exe')") ||
      !cliSource.includes('spawn(powershellCommand(),')) {
    throw new Error('AMDC CLI must require PowerShell 7 for profile email lookup');
  }
  const weeklySource = readSource('amdc-weekly.js');
  if (!weeklySource.includes("probe.status === 0") || !weeklySource.includes("transport: 'browser-fallback'")) {
    throw new Error('leaderboard depth probe must fall back to the authenticated browser on direct network failure');
  }
  if (!weeklySource.includes("if (firstInTop100) {") ||
      !weeklySource.includes("reasons.push(u(0x9996, 0x6B21, 0x8FDB, 0x5165) + 'Top100');\n      r._focus = true;")) {
    throw new Error('every first-in-Top100 app should be marked for Excel focus attention');
  }
  if (!progressServerSource.includes('全部采集周') || !progressServerSource.includes('id="batchWeeks"') ||
      !progressServerSource.includes('weekSummaries') ||
      !progressServerSource.includes('data-week-toggle=') ||
      !progressServerSource.includes("snapshot(parsedUrl.searchParams.get('historyId') || '')") ||
      !progressServerSource.includes("'?historyId=' + encodeURIComponent(requestedHistoryId)")) {
    throw new Error('batch dashboard must show every collection week together and retain history snapshots for expanded detail');
  }
  if (!progressServerSource.includes('function collapseHistoryRecords(records)') ||
      !progressServerSource.includes('Prefer any modern run for the same collection week') ||
      progressServerSource.includes("record.source === 'scheduled'")) {
    throw new Error('history must collapse each collection week and avoid displaying scheduled/manual source labels');
  }
  if (!progressServerSource.includes('requestSeq !== S.snapshotRequestSeq') ||
      !progressServerSource.includes("requestedHistoryId !== (S.selectedRunId || '')")) {
    throw new Error('stale snapshot responses must not overwrite the currently selected collection week');
  }
  if (!weeklySource.includes('async function runUnifiedBatch(manifest)') ||
      !weeklySource.includes('runtime = await createCollectorRuntime();') ||
      !weeklySource.includes('const outcome = await main(runtime);') ||
      !weeklySource.includes("configureRunScope(item.weekAnchor, item.outputDir, true, 'leaderboard')") ||
      !weeklySource.includes("configureRunScope(item.weekAnchor, item.outputDir, false, 'application')") ||
      !progressServerSource.includes('batchManifest: manifest') ||
      !progressServerSource.includes('unified: true')) {
    throw new Error('multi-week runs must use one collector runtime for all leaderboard and application task units');
  }
  if (!weeklySource.includes('compareLeaderboardSnapshots(weekData[WEEKS[0]], liveSeed[WEEKS[0]])') ||
      !weeklySource.includes('fetchCategoryDates(page, [WEEKS[0]], cat, tag, leaderboardAccountRotator)') ||
      !weeklySource.includes('fetchCategoryWeeks(page, cat, tag, leaderboardAccountRotator, liveSeed)') ||
      !weeklySource.includes('preliminaryCacheRefreshReason({') ||
      !weeklySource.includes("type: 'preliminary_cache_crossed_finalization'") ||
      !weeklySource.includes("refreshKind: 'auto'") ||
      !weeklySource.includes('shouldBypassLeaderboardCache({ forceRefresh: FORCE_REFRESH, batchChild: BATCH_CHILD, batchPhase: BATCH_PHASE })') ||
      !weeklySource.includes('autoFreshIssues = carriedAutoFreshIssues(weekData);')) {
    throw new Error('cached collection must compare the live target week, refresh changed categories, and reuse the confirmed leaderboard in application phase');
  }
  if (!weeklySource.includes('AMDC_BATCH_EVENT_FILE') ||
      !weeklySource.includes("fs.appendFileSync(BATCH_EVENT_FILE, JSON.stringify(event) + '\\n'") ||
      !progressServerSource.includes("if (url === '/api/batch-events')") ||
      !progressServerSource.includes('return merged.slice(-1000);') ||
      !progressServerSource.includes("if (e.app) parts.push('应用：'") ||
      !progressServerSource.includes("if (e.storeUrl) parts.push('商店：'")) {
    throw new Error('batch event logs must persist completely and render app/store details');
  }
  if (!weeklySource.includes("['默认下架', '商店可用'].includes(record.countryStatus)") ||
      weeklySource.includes("['默认下架', '商店可用', '商店链接未确认'].includes(record.countryStatus)")) {
    throw new Error('unconfirmed store links must block weekly and batch completion');
  }
  if (!weeklySource.includes("if (!BATCH_CHILD) {\n    appendRunEvent('info', '周任务完成'") ||
      !progressServerSource.includes("message: '总任务完成'") ||
      !progressServerSource.includes("detail: stopped ? '批量采集已停止' : (failed ? '批量采集失败，自动重试耗尽，请手工处理' : '总任务完成')")) {
    throw new Error('completion events must distinguish weekly completion from all-weeks completion');
  }
  if (!weeklySource.includes('await syncCategoryTagsWithWebsite(leaderAccount.token);') ||
      !weeklySource.includes('writeBatchPreflight(usablePool.map(account => account.dir));') ||
      !weeklySource.includes("BATCH_PHASE === 'application'") ||
      !weeklySource.includes('`复用已确认榜单：${cat}`') ||
      !progressServerSource.includes("AMDC_BATCH_PREFLIGHT_FILE = path.join(HISTORY_DIR, 'batch-preflight'") ||
      !progressServerSource.includes("['任务初始化', '账号池就绪', 'tags检查无误']")) {
    throw new Error('batch runs must initialize once, validate tags once, and reuse confirmed leaderboards during application collection');
  }
  if (!progressServerSource.includes("任务运行中，无法刷新看板") ||
      !progressServerSource.includes("refreshBtn.disabled = refreshBlocked") ||
      !progressServerSource.includes("if ((S.run && S.run.active) || historyBatchSyncActive()")) {
    throw new Error('dashboard refresh must be blocked while collection or sync tasks are running');
  }
  if (!progressServerSource.includes('replacedHistoryIds') ||
      !progressServerSource.includes('restoreReplacedHistory') ||
      !progressServerSource.includes('finalizeReplacedHistory')) {
    throw new Error('cancelling a rerun must restore the previous history record instead of leaving a stopped record');
  }
  if (!progressServerSource.includes('batchProgress: batchCountryProgress(requestedHistoryId)') ||
      !progressServerSource.includes('var progressScope = batchProgress || p;')) {
    throw new Error('overall progress must stay scoped to the full batch when the current collection week changes');
  }
  if (!weeklySource.includes('country_done: stats.countryDone') ||
      !weeklySource.includes('country_total: stats.countryTotal') ||
      !weeklySource.includes('overall: countryProgress.overall')) {
    throw new Error('scraper progress must be based on apps with country data divided by all target apps');
  }
  if (!weeklySource.includes('async function checkStoreAvailability(page, storeIds)') ||
      !weeklySource.includes("r.countryStatus = '默认下架';") ||
      !weeklySource.includes("r.countryStatus = '商店可用';") ||
      !weeklySource.includes("r.countryStatus = '商店链接未确认';") ||
      !weeklySource.includes("['默认下架', '商店可用'].includes(record.countryStatus)") ||
      !weeklySource.includes("c.countryStatus !== '默认下架' || c.storeLinkStatus === 'not_found'")) {
    throw new Error('missing country data must be classified by store-link availability without repeated country retries');
  }
  if (!weeklySource.includes('国别采集进度：${stats.done}/${stats.total}') ||
      !progressServerSource.includes('function stableBatchWeekProgress(batchId, weekAnchor, current)') ||
      !progressServerSource.includes('const batchWeekProgressCache = new Map();') ||
      !progressServerSource.includes('const batchEventCache = new Map();') ||
      !progressServerSource.includes('function activeDisplayRunDir()') ||
      !progressServerSource.includes("batchPhase === 'leaderboard'")) {
    throw new Error('event flow must include collection progress and batch retries must preserve a week baseline across new history directories');
  }
  if (!weeklySource.includes('catCache.complete = pending.length === 0;') ||
      !weeklySource.includes('if (built.focus.every(countryResolved)) completeCats.add(cat);') ||
      weeklySource.includes('if (cc.complete) completeCats.add(cat);')) {
    throw new Error('missing-country retries must not skip a category merely because a prior incomplete queue ended');
  }
  if (!progressServerSource.includes('<span class="new-tag suspected-delisted-tag">疑似下架</span>') ||
      !progressServerSource.includes("const suspectedDelisted = r.countryStatus === '默认下架'") ||
      !progressServerSource.includes('const authoritative = metadata.status ? metadata.status === \'done\' : !provisional;') ||
      !progressServerSource.includes('live: provisional') ||
      !progressServerSource.includes('live: true') ||
      !progressServerSource.includes('.suspected-delisted-tag')) {
    throw new Error('focus apps without country data must render an orange suspected-delisted tag');
  }
  if (!progressServerSource.includes('失败周等待重试期间，必须立即继续启动后续已就绪周') ||
      !progressServerSource.includes("!retryKind && scheduleBatchRetry(batchId, index, failedChild, history, detail, retryKind)) {") ||
      !progressServerSource.includes('if (!runJob.stopRequested) launchNextBatchChild(batchId);') ||
      !progressServerSource.includes("const index = runJob.children.findIndex(child => child.state === 'queued' && (!child.retryAt || new Date(child.retryAt).getTime() <= Date.now()));")) {
    throw new Error('a failed middle week must leave later ready weeks eligible to run');
  }
  if (!progressServerSource.includes("message: '任务初始化'") ||
      !progressServerSource.includes('if (!progressEvents.length && !batchProgress && S.run && S.run.job && S.run.job.batchId)') ||
      !progressServerSource.includes('旧快照不能覆盖已经显示的新事件流') ||
      !progressServerSource.includes('incomingAt < currentAt') ||
      !progressServerSource.includes('function mergeEventStream(previous, incoming)') ||
      !progressServerSource.includes('events: mergeEventStream(previousBatch.events, incomingBatch.events)') ||
      !progressServerSource.includes('renderRight(currentData.progress || null, currentBatch, currentResults)') ||
      !progressServerSource.includes('function renderProgressEventNodes(eventBody, items)') ||
      !progressServerSource.includes("node.setAttribute('data-event-key', item.key)") ||
      !progressServerSource.includes('.event.newest::before { background: var(--cyan); box-shadow: 0 0 10px rgba(0,229,255,0.8); animation: none; }') ||
      progressServerSource.includes('renderRight(S.data && S.data.progress || null)')) {
    throw new Error('event stream must keep a stable initialization entry and reject stale SSE or polling snapshots');
  }
  if (!progressServerSource.includes("runJob.children.every(child => child.state === 'leaderboard_done')") ||
      !progressServerSource.includes("detail: '榜单确认状态不完整，未开始应用数据采集'")) {
    throw new Error('application collection must start only after every weekly leaderboard is explicitly confirmed');
  }
  const base = `http://127.0.0.1:${port}`;
  const healthRes = await fetchWithRetry(`${base}/api/health`);
  if (!healthRes.ok) throw new Error(`health failed: ${healthRes.status}`);

  const noToken = await fetch(`${base}/api/run/stop`, { method: 'POST' });
  if (noToken.status !== 403) throw new Error(`POST without token should be 403, got ${noToken.status}`);

  const page = await (await fetch(`${base}/`)).text();
  if (!page.includes('alt="AMTools 实时看板"')) throw new Error('AMTools dashboard brand is missing');
  if (!page.includes('title="AMTools v1.0.0">v1.0.0</span>')) throw new Error('AMTools version is missing');
  const tokenMatch = page.match(/X-AMDC-Token': '([a-f0-9]+)'/);
  if (!tokenMatch) throw new Error('dashboard token not embedded in page');
  const token = tokenMatch[1];
  const historyBody = await (await fetch(`${base}/api/history`)).json();
  const historyRows = historyBody.records || [];
  if (!historyBody.ok || historyRows.length !== 2 ||
      historyRows.map(record => record.weekAnchor).join(',') !== '2026-07-27,2026-07-20' ||
      historyRows[0].id !== '20260803-012000-bbbb' ||
      historyRows.some(record => record.id === 'legacy-20260727')) {
    throw new Error(`history must keep only the latest modern record per week and sort weeks newest first: ${JSON.stringify(historyRows)}`);
  }
  const expectedAutoFreshReasons = [
    { category: '休闲', mismatchCount: 1 },
    { category: '壁纸', mismatchCount: 2 },
  ];
  const repairedMetadata = JSON.parse(fs.readFileSync(path.join(testProjectDir, 'Cache', 'history', '20260803-012000-bbbb', 'metadata.json'), 'utf8'));
  const repairedIndex = JSON.parse(fs.readFileSync(path.join(testProjectDir, 'Cache', 'history', 'index.json'), 'utf8'));
  const repairedIndexRecord = repairedIndex.find(record => record.id === '20260803-012000-bbbb');
  if (!historyRows[0].autoFresh || JSON.stringify(historyRows[0].autoFreshReasons) !== JSON.stringify(expectedAutoFreshReasons) ||
      !repairedMetadata.autoFresh || JSON.stringify(repairedMetadata.autoFreshReasons) !== JSON.stringify(expectedAutoFreshReasons) ||
      !repairedIndexRecord || !repairedIndexRecord.autoFresh || JSON.stringify(repairedIndexRecord.autoFreshReasons) !== JSON.stringify(expectedAutoFreshReasons)) {
    throw new Error(`completed history must restore autoFresh metadata from amdc-run-state.json: ${JSON.stringify({ api: historyRows[0], metadata: repairedMetadata, index: repairedIndexRecord })}`);
  }
  const scheduleConfig = JSON.parse(fs.readFileSync(path.join(testProjectDir, 'amdc-config.json'), 'utf8'));
  const scheduleToken = String(scheduleConfig && scheduleConfig.schedule && scheduleConfig.schedule.apiToken || '');
  const cliToken = String(scheduleConfig && scheduleConfig.cli && scheduleConfig.cli.apiToken || '');
  if (scheduleToken.length < 32 || cliToken.length < 32 || !progressServerSource.includes("url === '/api/run/scheduled'") ||
      !progressServerSource.includes("source: 'scheduled'") ||
      !progressServerSource.includes("parsedUrl.searchParams.get('source') === 'ai' ? 'ai' : 'manual'") ||
      !progressServerSource.includes("token === CLI_TOKEN && cliRoute") ||
      !progressServerSource.includes('autoSync: true') ||
      !progressServerSource.includes('notifyStages: true') ||
      !progressServerSource.includes('async function emitRunNotification') ||
      !progressServerSource.includes('async function finishAutomatedCollection') ||
      !progressServerSource.includes("job.options.source !== 'scheduled'") ||
      !progressServerSource.includes('run_amda_after_amdc.ps1') ||
      !progressServerSource.includes("飞书自动同步存在失败，未触发 AMDA 更新") ||
      !progressServerSource.includes("args.push('-SkipFeishuSync', '-SkipNotifications')") ||
      !powershellRunner.includes('[switch]$SkipFeishuSync') ||
      !powershellRunner.includes('[switch]$SkipNotifications') ||
      !scheduledRunnerSource.includes('/api/run/scheduled') ||
      !scheduledRunnerSource.includes('WindowStyle Hidden') ||
      !amdaTriggerSource.includes("source = 'scheduled'") ||
      amdaTriggerSource.includes('pending_confirmation') ||
      amdaTriggerSource.includes("Send-AmdaNotification 'amda_update_started'") ||
      amdaTriggerSource.includes("Send-AmdaNotification 'amda_update_pending'") ||
       !amdaTriggerSource.includes('AMDA_AUTOMATION_FINAL_OK') ||
       !amdaTriggerSource.includes('$FinalNotificationSent') ||
       !amdaTriggerSource.includes('amda_update_complete') ||
       !amdaTriggerSource.includes('verify-formal-parity.ps1') ||
       !amdaTriggerSource.includes('Formal parity gate failed') ||
       !amdaTriggerSource.includes('$DemoCandidateFile') ||
       !amdaTriggerSource.includes('$DemoAfterFile') ||
       amdaTriggerSource.includes('$DemoBeforeFile') ||
       !amdaTriggerSource.includes('-RemoteReadback') ||
       !amdaTriggerSource.includes('output\\charts') ||
      !scheduleRegistrationSource.includes("Join-Path $PSHOME 'pwsh.exe'") ||
      !weeklyScheduleSource.includes("^([7-9]|[1-9][0-9]+)$") ||
      !scheduleRegistrationSource.includes('Register-ScheduledTask') ||
      !scheduleRegistrationSource.includes('configurationHealthy') ||
      !scheduleRegistrationSource.includes('$commandNode.InnerText = $PwshPath') ||
      !weeklyTaskSource.includes('<Command>pwsh.exe</Command>') ||
      !accountSyncTaskSource.includes('<Command>pwsh.exe</Command>') ||
      /[A-Z]:\\/.test(weeklyTaskSource) ||
      /[A-Z]:\\/.test(accountSyncTaskSource) ||
      !amdaTriggerSource.includes('formal market analysis document')) {
    throw new Error('scheduled dashboard orchestration, worker handoff, or hidden runner is missing');
  }
  const scheduledWithPageToken = await postJson(`${base}/api/run/scheduled`, token);
  if (scheduledWithPageToken.res.status !== 403) {
    throw new Error(`scheduled endpoint must require its dedicated token, got ${scheduledWithPageToken.res.status}`);
  }
  const scheduledNoAccounts = await postJson(`${base}/api/run/scheduled`, scheduleToken);
  if (scheduledNoAccounts.res.status !== 409 || !/至少需要一个/.test(String(scheduledNoAccounts.body.error || ''))) {
    throw new Error(`scheduled endpoint should create a normal run request and reject only missing accounts: ${scheduledNoAccounts.res.status} ${JSON.stringify(scheduledNoAccounts.body)}`);
  }
  const cliForbidden = await postJson(`${base}/api/run/stop`, cliToken);
  if (cliForbidden.res.status !== 403) {
    throw new Error(`CLI token must not authorize unrelated write routes, got ${cliForbidden.res.status}`);
  }
  const cliStartValidation = await postJson(`${base}/api/run/start?weekAnchor=2026-07-12&weekAnchorsConfirmed=1&source=ai`, cliToken);
  if (cliStartValidation.res.status !== 409 || !/Monday|周一/.test(String(cliStartValidation.body.error || ''))) {
    throw new Error(`CLI token should reach run validation without starting a worker: ${cliStartValidation.res.status} ${JSON.stringify(cliStartValidation.body)}`);
  }
  const cliSyncValidation = await postJson(`${base}/api/history/missing/sync-feishu`, cliToken);
  if (cliSyncValidation.res.status !== 404) {
    throw new Error(`CLI token should authorize only the single-history sync route, got ${cliSyncValidation.res.status}`);
  }

  if (!page.includes('font-family: "MiSans"') || !page.includes('--font: "MiSans"') || !page.includes('rel="license" href="/assets/fonts/MiSans-License.pdf"')) {
    throw new Error('bundled MiSans font setup or attribution missing');
  }
  const fontRes = await fetch(`${base}/assets/fonts/MiSans-Regular.woff2`);
  if (!fontRes.ok || fontRes.headers.get('content-type') !== 'font/woff2' || (await fontRes.arrayBuffer()).byteLength < 4_000_000) {
    throw new Error('bundled MiSans font asset is not served correctly');
  }
  const licenseRes = await fetch(`${base}/assets/fonts/MiSans-License.pdf`);
  if (!licenseRes.ok || licenseRes.headers.get('content-type') !== 'application/pdf') {
    throw new Error('MiSans license asset is not served correctly');
  }

  const settings = await (await fetch(`${base}/api/settings`)).json();
  if (settings.env.TOP_DEPTH !== '100') throw new Error(`default TOP_DEPTH should be 100, got ${settings.env.TOP_DEPTH}`);
  if (!Array.isArray(settings.categoryOptions) || !settings.categoryOptions.includes('壁纸') || settings.categoryOptions.length !== 7) {
    throw new Error('category options should expose all seven supported categories');
  }
  if (!page.includes('id="weekAnchorInput" type="text"')) {
    throw new Error('date input missing');
  }
  if (page.includes('id="weekAnchorInput" type="date" min=') || page.includes('id="weekAnchorInput" type="date" step=')) {
    throw new Error('date input must not restrict year/month with min/step');
  }
  if (!page.includes('data-event-filter="all">全部周') ||
      !page.includes('data-event-filter="current">当前运行周') ||
      !page.includes('data-event-filter="errors">仅异常') ||
      page.includes("eventItem('info', '/api/results'") || page.includes("eventItem('info', '/api/health'")) {
    throw new Error('event filters must cover the whole batch without exposing API paths');
  }
  if (!page.includes('id="pageRefresh"') || !page.includes('刷新看板') || !page.includes('/api/dashboard/clear') || page.includes('id="cacheClear"') || page.includes('/api/cache/clear')) {
    throw new Error('dashboard-clear action should replace the old page refresh without restoring cache-clear UI');
  }
  if (!page.includes('class="batch-week-summary"') ||
      !page.includes('class="batch-week-detail"') ||
      !page.includes('data-week-history-id=') ||
      !page.includes('当前应用</th>')) {
    throw new Error('all-week summary and inline category detail layout missing');
  }
  if (!page.includes('.cat-chip { display: inline-block') || !page.includes('text-overflow: ellipsis')) {
    throw new Error('focus-app category collision protection missing');
  }
  if (!page.includes('function minColumnWidths(total)') || !page.includes("rem * 48") || !page.includes("rem * 30")) {
    throw new Error('content-aware panel resize limits missing');
  }
  if (!page.includes('.batch-week-detail {') || !page.includes('overflow-x: auto') ||
      !page.includes('.batch-week-detail table { table-layout: fixed; min-width: 44rem; }')) {
    throw new Error('multi-week inline detail collision protection missing');
  }
  if (!page.includes('class="week-progress-cell"') ||
      !page.includes('grid-template-columns: 5.5rem 3.2rem') ||
      !page.includes('.batch-week-detail .week-progress-count { width: 3.2rem; text-align: center;')) {
    throw new Error('single-digit and double-digit weekly app progress must share fixed bar and count columns');
  }
  if (!page.includes('vertical-align: middle !important') ||
      !page.includes('.batch-week-detail th:nth-child(6) { width: 24%; }') ||
      !page.includes('.batch-week-detail .current-app-cell { max-width: 0; }')) {
    throw new Error('tables should vertically center content and protect inline week detail columns');
  }
  if (!page.includes('@media (max-width: 1400px)') || !page.includes("matchMedia('(max-width: 1400px)')")) {
    throw new Error('half-screen layouts should switch to one column before tables become cramped');
  }
  if (!page.includes('font-size: 0.86rem; font-weight: 600') || !page.includes('table tbody * { font-weight: 400 !important; }')) {
    throw new Error('table typography rules missing');
  }
  if (!page.includes('table th:not(:last-child)') || !page.includes('border-right: 1px solid rgba(129, 156, 190, 0.16)') || !page.includes('table thead th:not(:last-child)') || !page.includes('border-right-color: rgba(129, 156, 190, 0.16)')) {
    throw new Error('table column divider rules missing');
  }
  if (!page.includes('id="amdcLoginSite" href="https://appmagic.rocks/top-charts/apps"') || !page.includes('打开登录网站')) {
    throw new Error('AMDC login-site action missing from login dialog');
  }
  if (!page.includes('id="accountLoginOverlay"') || !page.includes('data-account-login=') || !page.includes('/api/accounts/login-link') || !page.includes('id="accountLoginUrl"')) {
    throw new Error('account login dialog flow missing');
  }
  if (page.includes('data-login-link-form=') || page.includes('data-login="') || page.includes('捕捉')) {
    throw new Error('legacy browser-capture UI should be removed');
  }
  if (page.includes('<label>AMDC 登录网站</label>') || page.includes('id="accountLoginCheck"') || page.includes('checkLoginDialogAccount')) {
    throw new Error('settings login-site module and dialog auth-check action should be removed');
  }
  if (!page.includes('登录成功，登录态检测通过') || !page.includes("dialog.success ? '确定' : '登录'")) {
    throw new Error('login dialog confirmation state missing');
  }
  if (!page.includes("var detail = row.state === 'ok'")) {
    throw new Error('successful auth detail should be hidden from the settings table');
  }
  if (!page.includes('var blocking = !automatic') || !page.includes('S.accounts.backgroundChecking = true')) {
    throw new Error('automatic auth check should run in background without blocking collection controls');
  }
  if (!page.includes("if (key === 'rank' || key === 'change')")) {
    throw new Error('potential new apps should stay first for rank and rise sorting');
  }
  if (!page.includes('<th>账号目录</th>') || !page.includes("MISSING: '未填写'") || !page.includes("UNKNOWN: '未知状态'")) {
    throw new Error('account directory and email-state localization missing');
  }
  if (page.includes('<th>Profile</th>') || page.includes('本机 profile') || page.includes('未发现账号 profile')) {
    throw new Error('legacy profile labels should be removed from the UI');
  }
  if (!page.includes('class="wrap focus-app-cell"') || !page.includes('.focus-app-cell, .focus-app-cell a') || !page.includes('word-break: keep-all')) {
    throw new Error('focus-app word wrapping rules missing');
  }
  if (!page.includes('<th>总部</th><th>上线日期</th><th>排名概述</th>') ||
      page.includes('<th class="num">变化</th>') || page.includes('<th>市场属性</th>') ||
      !page.includes('releaseDate(f.release)') || !page.includes('colspan="8"')) {
    throw new Error('focus-app column layout should show release date and omit change/market columns');
  }
  if (!page.includes('function rankSummary(f)') || !page.includes("'名（上周' + lastWeek + '名，+'") || !page.includes('esc(rankSummary(f))') ||
      page.includes("esc((f.reasons || []).join('；'))")) {
    throw new Error('focus-app rank summary should show rank movement only with last-week rank');
  }
  if (!page.includes('id="sortMenu"') || !page.includes('id="sortOptions" role="listbox"') || !page.includes('function setFocusSort(value, persist)')) {
    throw new Error('focus-app sort control should use a page-native menu');
  }
  if (!page.includes('id="topDepthMenu"') || !page.includes('id="topDepthOptions" role="listbox"') || !page.includes('function setTopDepth(value, persist)')) {
    throw new Error('top-depth control should use a page-native menu');
  }
  if (!page.includes('id="categoryOptions"') || !page.includes('data-category value="壁纸"') || !page.includes('id="categoriesSelectAll"') || !page.includes("params.append('category', category)")) {
    throw new Error('category selection control and run-query propagation missing');
  }
  if (!page.includes('grid-template-columns: repeat(4, 12.75rem)') || !page.includes('.category-field { min-width: 0; grid-column: span 2; }') ||
      !page.includes('.category-option:nth-child(-n+4)') || !page.includes('.category-option:nth-child(n+5)')) {
    throw new Error('settings categories should be two account modules wide with a balanced 4+3 option layout');
  }
  if (!page.includes('font-size: 1.1rem; font-weight: 700') || !page.includes('color: rgba(141,154,184,0.75); font-size: 0.86rem') ||
      !page.includes('.sub { color: var(--muted); font-size: 0.86rem; }') || !page.includes('.panel > .head h2 { font-size: 1rem; }')) {
    throw new Error('module titles should be prominent while table headers and focus-app body text share a uniform size');
  }
  if (page.includes('class="category-meta"') ||
      !page.includes("var categoryText = num(waitingForApplication ? 0 : week.categoriesDone)")) {
    throw new Error('queued application weeks should not reuse leaderboard completion counts');
  }
  if (!page.includes('.history-detail > .empty') || !page.includes('place-items: center')) {
    throw new Error('history empty state should be centered');
  }
  if (!page.includes('S.history.viewingId = id') || !page.includes('if (S.history.viewingId !== id) return') ||
      page.includes('S.history.detail = null;\n    renderHistory();')) {
    throw new Error('history detail should switch atomically without clearing and redrawing the table first');
  }
  if (!page.includes('history-action-col') || !page.includes('width: 13.5rem')) {
    throw new Error('history action column should fit its buttons instead of stretching');
  }
  if (!page.includes('weekAnchorsConfirmed') || !page.includes('data-calendar-confirm') ||
      !page.includes('function requestWeekAnchorConfirmation()') || !page.includes('请先确认采集日期')) {
    throw new Error('collection-week picker should require confirmed multi-date selection and guide users to confirm it before starting');
  }
  if (!page.includes('data-calendar-clear>清空</button>') ||
      !page.includes("if (e.target.closest('[data-calendar-clear]'))") ||
      !page.includes('pendingWeekAnchors = [];\n        renderWeekAnchorCalendar();')) {
    throw new Error('calendar clear action should remove every pending collection week without closing the picker');
  }
  if (!page.includes('width: 100%; min-width: 0; box-sizing: border-box') ||
      !page.includes('function calendarHistoryState(weekAnchor)') ||
      !page.includes('CATEGORY_OPTIONS.every(function (category)') ||
      !page.includes('actualCategoryCount >= CATEGORY_OPTIONS.length') ||
      !page.includes('history-collected') || !page.includes('history-failed') ||
      !page.includes('if (!S.history.records.length && !S.history.loading) loadHistory();') ||
      !page.includes('.calendar-day.history-collected { color: #67e8f9; background: rgba(34,211,238,0.16); box-shadow: none; }') ||
      !page.includes('.calendar-day.history-failed { color: #ffb347; background: rgba(245,158,11,0.2); box-shadow: none; }') ||
      !page.includes('.calendar-day.selected.history-collected { color: #fff; background: #0891b2;') ||
      !page.includes('.calendar-day.selected.history-failed { color: #fff; background: #d97706;') ||
      !page.includes('.calendar-day.selected.history-collected:hover { color: #fff; background: #0ea5c6;') ||
      !page.includes('.calendar-day.selected.history-failed:hover { color: #fff; background: #ea8a00;')) {
    throw new Error('calendar width and collection-history highlighting are missing');
  }
  if (!xlsxSource.includes("('应用标题', 28, 'l')") ||
      !xlsxSource.includes("'应用标题': app_name") ||
      !xlsxSource.includes('def suspected_delisted(r):') ||
      !xlsxSource.includes('def potential_new(r):') ||
      !xlsxSource.includes("'潜力新品' in str(reason)") ||
      !xlsxSource.includes('SUSPECTED_DELISTED_TITLE_FILL') ||
      !xlsxSource.includes('POTENTIAL_NEW_TITLE_FILL') ||
      !xlsxSource.includes('name_cell.fill = SUSPECTED_DELISTED_TITLE_FILL') ||
      !xlsxSource.includes('name_cell.fill = POTENTIAL_NEW_TITLE_FILL')) {
    throw new Error('Excel export should rename the title column and prioritize title-cell fills');
  }
  if (!feishuSyncSource.includes('def report_columns_match(ws, max_row, url_args, sheet_id, existing_rows):') ||
      !feishuSyncSource.includes("csv.reader(io.StringIO(raw or ''), skipinitialspace=True)") ||
      !feishuSyncSource.includes("'--range', f'{get_column_letter(col)}5:{get_column_letter(col)}{remote_end}'") ||
      !feishuSyncSource.includes("'skipped': True, 'skipReason': '标题列和本周排名列完全重复'")) {
    throw new Error('Feishu sync should skip writes only when title and current-rank columns match');
  }
  if (!feishuSyncSource.includes('def configured_feishu_url():') ||
      !feishuSyncSource.includes("integrations.get('feishuSheetUrl')") ||
      feishuSyncSource.includes('DEFAULT_URL =')) {
    throw new Error('Feishu target must come from private local configuration or an explicit override');
  }
  if (!accountSyncSource.includes('$config.integrations.accountRepositoryUrl') ||
      !accountSyncSource.includes('AMDC_ACCOUNT_REPOSITORY_URL') ||
      /Hawkiethehawk\/[A-Za-z0-9._-]+\.git/.test(accountSyncSource)) {
    throw new Error('account backup target must come from private local configuration or an explicit override');
  }
  const duplicateSkipStart = feishuSyncSource.indexOf('if not created and report_columns_match');
  const duplicateSkipEnd = feishuSyncSource.indexOf('            return', duplicateSkipStart);
  const duplicateSkipBlock = duplicateSkipStart >= 0 && duplicateSkipEnd > duplicateSkipStart
    ? feishuSyncSource.slice(duplicateSkipStart, duplicateSkipEnd)
    : '';
  if (!feishuSyncSource.includes('def sort_workbook_date_sheets(url_args):') ||
      !duplicateSkipBlock.includes('sheet_order = sort_workbook_date_sheets(url_args)') ||
      !duplicateSkipBlock.includes("'sheetOrder': sheet_order") ||
      !feishuSyncSource.includes("transaction_result('cleanup-temporary', '', '', removedSheets=removed, removedCount=len(removed), sheetOrder=sheet_order)") ||
      !feishuSyncSource.includes('SHEET_ORDER_LOCK_TIMEOUT_SECONDS = 300') ||
      !feishuSyncSource.includes('msvcrt.LK_NBLCK') ||
      !feishuSyncSource.includes('Timed out waiting for the Feishu workbook sheet-order lock')) {
    throw new Error('Feishu duplicate skips, transaction cleanup, and concurrent sheet ordering must restore the complete workbook date order');
  }
  if (!page.includes("params.append('weekAnchor'") || !page.includes("params.set('weekAnchorsConfirmed'")) {
    throw new Error('dashboard should submit every confirmed collection week for batch collection');
  }
  if (!page.includes('.system-dialog-message.is-multiline { text-align: left; text-indent: 0; }') ||
      !page.includes('function layoutSystemDialogMessage(message, item)') ||
      !page.includes("message.classList.toggle('is-multiline'") ||
      !page.includes("window.addEventListener('resize', function () {") ||
      !page.includes('if (activeSystemDialog) layoutSystemDialogMessage')) {
    throw new Error('multiline system dialog messages must be left-aligned without indentation');
  }
  if (!page.includes('id="systemDialogOverlay"') ||
      !page.includes('function showSystemAlert(message, title, tone)') ||
      !page.includes('function showSystemConfirm(message, title, confirmText, tone)') ||
      !page.includes('systemDialogQueue') ||
      /window\.(alert|confirm|prompt)\s*\(/.test(page)) {
    throw new Error('dashboard native system dialogs must use the page-style dialog component');
  }
  if (!page.includes('function requestWeekAnchorConfirmation()') ||
      !page.includes('请先确认采集日期') ||
      !page.includes('window.setTimeout(openWeekAnchorCalendar, 0);') ||
      !page.includes('runBtn.disabled = !!box.loading || !!run.loading || running || !authReady.ready;') ||
      !page.includes('freshBtn.disabled = !!box.loading || !!run2.loading || S.freshHistoryCheckLoading || running2 || !authReady.ready;') ||
      page.includes('reportValidity(')) {
    throw new Error('unconfirmed collection dates must open the page-style guidance dialog instead of disabling start or showing native validation');
  }
  if (!page.includes('已有历史记录会保留；完成后会更新该周共享缓存和 Excel 文件。') ||
      page.includes('清除采集周「')) {
    throw new Error('fresh collection confirmation must describe cache replacement without claiming that independent history is deleted');
  }
  if (!page.includes('data-history-sync=') || !page.includes('同步到飞书') || !page.includes('/sync-feishu') || !page.includes('完整覆盖飞书工作表')) {
    throw new Error('manual historical Feishu sync action with confirmation is missing');
  }
  if (!progressServerSource.includes('function childFailureDetail(error') ||
      !progressServerSource.includes('阶段：${syncPhase}') ||
      !progressServerSource.includes('failure.exitCode = code')) {
    throw new Error('Feishu sync failures must preserve the phase, subprocess output, and exit code');
  }
  if (!progressServerSource.includes('const duplicateSkip = duplicateSkipObserved || syncResult.skipped === true') ||
      !progressServerSource.includes('repairDuplicateSkipSyncRecords()')) {
    throw new Error('duplicate-column skip results must be treated as successful Feishu syncs');
  }
  if (!page.includes('id="historyBatchSync"') || !page.includes('data-history-select=') ||
      !page.includes('/api/history/batch-sync-feishu?') || !page.includes('最多 2 个任务并行')) {
    throw new Error('confirmed parallel batch Feishu sync action is missing');
  }
  if (!page.includes('function selectableHistorySyncRecords()') ||
      !page.includes("syncStatus !== 'syncing' && syncStatus !== 'queued'") ||
      !page.includes('function togglePendingHistorySyncSelection()') ||
      !page.includes("key === 'unsynced'") ||
      !page.includes("key === 'failed'") ||
      !page.includes('var allPendingSelected = pendingIds.length > 0') ||
      !page.includes("S.history.batchSelectMode = pendingIds.length ? 'pending' : '';") ||
      !page.includes("S.history.batchSelectMode = '';") ||
      !page.includes("historySelectAll').addEventListener('change'") ||
      !page.includes('批量选择：选择未同步和同步失败记录')) {
    throw new Error('history batch selector must select unsynced and failed weeks on first click');
  }
  if (!page.includes('function maskAccountEmail(email)') || !page.includes('maskAccountEmail(row.email)')) {
    throw new Error('account emails must be masked in the settings panel');
  }
  if (!page.includes('S.history.batchRequestPending = true;') ||
      !page.includes('function batchSyncFailureDetails(result)') ||
      !page.includes('失败明细：') ||
      !page.includes("showSystemAlert('批量同步失败：' + (e && e.message ? e.message : '请求未完成'), '批量同步失败', 'danger')")) {
    throw new Error('batch Feishu sync should keep the pending request state and show page-style detailed failures');
  }
  if (!page.includes('批量同步整体进度') || !page.includes('batchButton.disabled = batchActive') ||
      !page.includes("status: 'queued', progress: 0, message: '等待批量同步'") ||
      !page.includes("? '已同步'") || !page.includes('batchRequestPending') ||
      !progressServerSource.includes('batchSync: historyBatchSyncSnapshot()') ||
      !progressServerSource.includes('aggregateBatchSyncProgress(items)')) {
    throw new Error('batch Feishu sync must freeze sync controls and expose one aggregate progress state');
  }
  if (!page.includes('id="historyBatchSyncStop"') ||
      !page.includes('function stopHistoryBatchSync()') ||
      !page.includes('确认停止批量同步吗？') ||
      !progressServerSource.includes("url === '/api/history/batch-sync-feishu/stop'") ||
      !progressServerSource.includes('function requestBatchSyncStop()') ||
      !progressServerSource.includes('async function rollbackBatchSync(job)') ||
      !progressServerSource.includes('async function cleanupHistoryTemporarySheets(job)') ||
      !progressServerSource.includes("runHistoryTransaction(null, 'cleanup-temporary', null, job)") ||
      !progressServerSource.includes('await cleanupHistoryTemporarySheets(historyBatchSyncJob)') ||
      !progressServerSource.includes('historyTemporaryCleanupActive') ||
      !feishuSyncSource.includes("'cleanup-temporary'") ||
      !feishuSyncSource.includes("def cleanup_temporary_transactions(url_args):") ||
      !feishuSyncSource.includes("temporary transaction sheets remain") ||
      !progressServerSource.includes('function recoverInterruptedHistorySyncs()') ||
      !progressServerSource.includes("批量同步已停止（看板重启中断）")) {
    throw new Error('batch sync stop, rollback, and temporary-sheet cleanup flow missing');
  }
  if (!page.includes('history-sync-module') || !page.includes('history-sync-track') || !page.includes('resumeSyncingHistoryRecord') || !page.includes('startHistorySyncPolling')) {
    throw new Error('Feishu sync should show a live progress module in the history detail');
  }
  if (!page.includes('history-failure-reason') || !page.includes('失败原因') || !page.includes('progressEvents') || !page.includes('事件流的“进度”页')) {
    throw new Error('batch collection failures should be visible in history details and the progress event stream');
  }
  if (!page.includes('.panel[data-panel="market-split"] { padding-bottom: 0.25rem; }') || !page.includes('min-height: 2rem')) {
    throw new Error('initial market split panel should keep comfortable spacing from its borders');
  }
  if (!progressServerSource.includes("var applicationMetricsReady = !(batchProgress && batchProgress.phase === 'leaderboard')") ||
      !progressServerSource.includes("document.getElementById('overallPct').textContent = applicationMetricsReady ? (overall + '%') : '--%'") ||
      !progressServerSource.includes("renderSplit(applicationMetricsReady ? taskResults : { marketSplit: null })") ||
      !progressServerSource.includes('疑似下架') || !progressServerSource.includes('无市场分类') ||
      !progressServerSource.includes("待采集 ' + pending") ||
      progressServerSource.includes("'待采集 ' + s.unknown")) {
    throw new Error('leaderboard phase must preserve initialized metrics and market split must distinguish terminal no-country states');
  }
  if (!page.includes('display: flex; flex-wrap: wrap; gap: 1px;') ||
      !page.includes('grid-template-rows: minmax(0, 0.6fr) minmax(0, 1.4fr);') ||
      !page.includes('min-height: 4.75rem;') ||
      !page.includes('.kpi-content { display: contents; }') ||
      !page.includes('.kpi .k, .kpi .v { display: flex; align-items: center; justify-content: center;') ||
      page.includes('style="font-size:0.85rem"') ||
      page.includes('.kpi .v.rate-limit-accounts { font-size:') ||
      page.includes('grid-template-columns: repeat(4, 1fr);') ||
      !page.includes('rate-limit-accounts') ||
      !page.includes('grid-template-columns: repeat(6, minmax(0, 1fr));')) {
    throw new Error('KPI cards must fill wrapped rows without a phantom grid cell, and mid-width toolbar actions must be evenly distributed');
  }
  if (!page.includes('justify-content: center; align-items: end;') ||
      !page.includes('marketBase = clamp(Math.round(total * DEFAULT_LAYOUT.rightRows[1]), 72, 96)') ||
      !page.includes('preferredLockedHeight(rightPanels[0], marketBase, 64, 140)') ||
      !page.includes('已分配的空白也会被算进内容高度')) {
    throw new Error('settings controls should be centered and fixed panels should shrink to their real content');
  }
  if (!page.includes('.batch-weeks-body') ||
      !page.includes('grid-template-columns: minmax(0, 1fr)') ||
      !page.includes('.batch-week-list') ||
      !page.includes('.batch-week-summary') ||
      page.includes('.batch-week-detail-head') ||
      !page.includes("(expanded\n          ? '<div class=\"batch-week-detail\"") ||
      page.includes('data-panel="alerts"') ||
      !page.includes("S.expandedWeekId = S.expandedWeekId === key ? '' : key") ||
      !page.includes('S.expandedWeekId === null') ||
      !page.includes('用户主动收起') ||
      !page.includes("leftRows: [0.58, 0.42]") ||
      !page.includes('function initFixedPanels()') ||
      !page.includes('colSplit: 0.8') ||
      !page.includes('grid-template-columns: minmax(0, 4fr) minmax(19rem, 1fr)') ||
      page.includes('resizer')) {
    throw new Error('multi-week overview must keep one-line summaries with downward inline details and no batch-alert module');
  }
  if (page.includes('id="currentRunWeekTrigger"') ||
      page.includes('id="currentRunWeekOptions"')) {
    throw new Error('the batch dashboard must not retain the old current-week dropdown');
  }
  if (!page.includes("['采集周', esc(collectionWeeks.length ? collectionWeeks.join('，') : '--')]") ||
      !page.includes('batchProgress.weekSummaries.map(function (week) { return week.weekAnchor; })') ||
      !page.includes('S.run.job.options.weekAnchors.slice()')) {
    throw new Error('runtime context should show exactly the confirmed collection weeks');
  }
  if (!page.includes("mature * 100 / total") || !page.includes("suspectedDelisted * 100 / total") ||
      !page.includes("unclassified * 100 / total") || !page.includes("pending * 100 / total") ||
      !page.includes("bar.setAttribute('aria-label'")) {
    throw new Error('market split bar should render explicit visible percentage widths');
  }
  if (!weeklySource.includes('榜单账号 ${currentAccount.dir} 触发 429，切换账号 ${next.account.dir}') ||
      !weeklySource.includes('全部榜单账号均限流，等待 ${waitSeconds} 秒后返回账号 ${selected.account.dir}') ||
      !weeklySource.includes('result.err !== 429') ||
      !weeklySource.includes('leaderboardAccountRotator: createLeaderboardAccountRotator') ||
      !weeklySource.includes('queue.push(task);') ||
      !weeklySource.includes('任务回到共享队列，由未受限账号优先领取')) {
    throw new Error('leaderboard and application 429 handling must hand work to another available account');
  }
  if (!progressServerSource.includes('rateLimitedAccounts: Array.from(rateLimitedAccounts).sort') ||
      !page.includes("kpi('周完成'") || !page.includes('var taskResults = batchProgress && batchProgress.results ? batchProgress.results : r;') ||
      !page.includes('renderRight(p, batchProgress, taskResults);')) {
    throw new Error('top metrics and right-side summaries must aggregate the full batch and sort rate-limited accounts');
  }
  const finalizeFunctionStart = progressServerSource.indexOf('async function finishAutomatedCollection');
  const finalizeFunctionEnd = progressServerSource.indexOf('\nfunction historyBatchSyncSnapshot', finalizeFunctionStart);
  const finalizeFunctionSource = progressServerSource.slice(finalizeFunctionStart, finalizeFunctionEnd);
  const finalizeReadinessCheck = finalizeFunctionSource.indexOf('if (!children.length || records.length !== children.length)');
  const finalizeLockAssignment = finalizeFunctionSource.indexOf('autoFinalizeStarted: true');
  const amdaTriggerFunctionStart = progressServerSource.indexOf('function triggerScheduledAMDAUpdate');
  const amdaTriggerFunctionEnd = progressServerSource.indexOf('\nfunction scheduleAutomatedCollectionFinalizeRetry', amdaTriggerFunctionStart);
  const amdaTriggerFunctionSource = progressServerSource.slice(amdaTriggerFunctionStart, amdaTriggerFunctionEnd);
  if (!progressServerSource.includes('const AUTOMATED_FINALIZE_RETRY_DELAY_MS = 500') ||
      !progressServerSource.includes('const AUTOMATED_FINALIZE_MAX_RETRIES = 120') ||
      !progressServerSource.includes('function scheduleAutomatedCollectionFinalizeRetry') ||
      !progressServerSource.includes('autoFinalizeRetryScheduled') ||
      !progressServerSource.includes('autoFinalizeRetryExhausted') ||
      !progressServerSource.includes('autoFinalizeInFlight: false') ||
      finalizeReadinessCheck < 0 || finalizeLockAssignment < 0 || finalizeReadinessCheck > finalizeLockAssignment ||
      !amdaTriggerFunctionSource.includes("child.once('close'") ||
      amdaTriggerFunctionSource.includes('detached: true') ||
      amdaTriggerFunctionSource.includes('child.unref()') ||
      !finalizeFunctionSource.includes("job.options.source === 'scheduled'")) {
    throw new Error('automated Feishu/AMDA handoff must wait for all history records, retry the write race, and remain scheduled-only');
  }
  if (!progressServerSource.includes('function rawHistoryRecordById(id)') ||
      !progressServerSource.includes('function repairHistoryResultSummaries()') ||
      !progressServerSource.includes("if (child.state === 'done') patch.resultSummary = historyResultSummary") ||
      !progressServerSource.includes('repairHistoryResultSummaries();')) {
    throw new Error('completed unified batch histories must refresh and backfill their final result summaries');
  }
  if (page.includes('预计剩余') || !page.includes("kpi('运行时间'") ||
      !page.includes('function runElapsedText(batchProgress, p)') ||
      !page.includes('window.setInterval(refreshRunElapsedKpi, 1000)') ||
      !progressServerSource.includes('startedAt: batchStartedAt') ||
      !progressServerSource.includes('finishedAt: batchFinishedAt') ||
      !progressServerSource.includes('AMDC_BATCH_STARTED_AT') ||
      !weeklySource.includes('const BATCH_STARTED_AT = String(process.env.AMDC_BATCH_STARTED_AT')) {
    throw new Error('runtime KPI must measure from collection click until terminal batch completion and freeze after completion');
  }
  if (!progressServerSource.includes('BATCH_MAX_ATTEMPTS') ||
      !progressServerSource.includes('scheduleBatchRetry(batchId, index, failedChild, history, detail)') ||
      !progressServerSource.includes('自动重试耗尽') ||
      !progressServerSource.includes("child.state === 'queued' && (!child.retryAt")) {
    throw new Error('failed batch weeks must automatically retry with a delayed queue and only fail after attempts are exhausted');
  }
  if (!progressServerSource.includes("state: 'queued',\n        phase: 'application',\n        attempts: 0,") ||
      !progressServerSource.includes("status: 'queued',\n      exitCode: null,\n      retryAttempt: 0,")) {
    throw new Error('application collection must reset retry counts after the leaderboard-confirmation phase');
  }
  if (!progressServerSource.includes("runJob.phase === 'application'") ||
      !progressServerSource.includes('国别数据采集未完成：${countryDone}/${countryTotal}') ||
      !progressServerSource.includes('商店链接核验未完成，未自动重试，请手工处理') ||
      !progressServerSource.includes("childInfo.retryKind === 'missing-country'") ||
      !weeklySource.includes('const MISSING_COUNTRY_ONLY') ||
      !weeklySource.includes('无法只补采缺失国别数据')) {
    throw new Error('batch completion must stop unresolved store-link checks without retrying the week');
  }
  if (!weeklySource.includes('if (!LIST_ONLY && countryRemaining > 0)') ||
      !weeklySource.includes("appendRunEvent('error', '国别数据采集未完成'") ||
      !weeklySource.includes('process.exitCode = 1') ||
      !progressServerSource.includes('const AUTO_RETRY_LIMIT = 3') ||
      !progressServerSource.includes('function scheduleSingleRetry(detail, attempts)') ||
      !page.includes("showSystemAlert(failedScope + '\\n\\n' + failedChildren.map(failedChildAlertText).join('\\n\\n')")) {
    throw new Error('unresolved country data must fail the collection and show a page-style notice for manual handling without retrying the week');
  }
  if (!weeklySource.includes('const tmp = `${PROGRESS_JSON}.${process.pid}.tmp`') ||
      !weeklySource.includes('fs.renameSync(tmp, PROGRESS_JSON)') ||
      !progressServerSource.includes('const progressReadCache = new Map()') ||
      !progressServerSource.includes('previousTotal > 0 && currentTotal === 0')) {
    throw new Error('batch progress must remain stable while a child atomically writes or initializes its progress file');
  }
  if (!progressServerSource.includes("currentBatch.phase === 'application'") ||
      !progressServerSource.includes('countryTotal: Number(progress.totalFocus)') ||
      !progressServerSource.includes('countryRemaining: Number(progress.totalFocus)')) {
    throw new Error('application-phase batch progress must lock queued-week denominators');
  }
  if (!page.includes('failedChildAlertKeys') ||
      !page.includes('function failedChildAlertText(child)') ||
      !page.includes('未采集到国别的应用：') ||
      !progressServerSource.includes('function missingCountryApps(historyId)') ||
      !progressServerSource.includes('missingApps: !ok && !leaderboardPhase ? missingCountryApps(history.id) : []')) {
    throw new Error('a retry-exhaustion notice must identify the failed week and every missing app without invalid retry counts');
  }
  if (!progressServerSource.includes('latestStartedAt <= dashboardClearAt()') ||
      !page.includes("S.selectedRunId = '';\n        S.run.active = false;")) {
    throw new Error('dashboard clear should persist across polling and browser reloads');
  }
  if (!page.includes("message: '正在生成 Excel'") || !page.includes('S.history.selected = syncingRecord')) {
    throw new Error('Feishu sync should render an initial progress state immediately');
  }
  if (!page.includes('飞书同步已完成。') || !page.includes("showSystemAlert('飞书同步失败：' + singleFailure, '飞书同步失败', 'danger')")) {
    throw new Error('Feishu sync completion notification is missing');
  }
  if (!page.includes("sync.status === 'done' ? '同步时间' : '飞书同步'") ||
      !page.includes("sync.status === 'done' ? historyTime(sync.syncedAt)")) {
    throw new Error('completed Feishu sync should show its syncedAt time using the history time formatter');
  }
  if (!page.includes('S.history.selected = j.record')) {
    throw new Error('Feishu sync completion should replace stale progress before reloading history');
  }
  if (!page.includes('.history-table td.empty { text-align: center !important; }') || !page.includes("box.loading ? '正在读取账号目录…' : '未发现账号目录'")) {
    throw new Error('history loading state and account-directory loading state should not be misleadingly aligned or empty');
  }
  if (!page.includes('.event { position: relative; display: grid; gap: 0.18rem') ||
      !page.includes('.event .t, .event .m, .event .d { font-size: 0.8rem; line-height: 1.35; }') ||
      !page.includes('.event .d { color: var(--muted);')) {
    throw new Error('event stream typography, spacing, and duration color should be consistent');
  }

  const legacyCapture = await postJson(`${base}/api/accounts/login?profile=.amdc-userdata`, token);
  if (legacyCapture.res.status !== 404) {
    throw new Error(`legacy browser-capture API should be removed, got ${legacyCapture.res.status}`);
  }

  const badLoginLink = await postJsonBody(`${base}/api/accounts/login-link?profile=.amdc-userdata`, token, {
    url: 'https://example.com/not-amdc',
  });
  if (badLoginLink.res.status !== 400 || !/appmagic\.rocks/i.test(String(badLoginLink.body.error || ''))) {
    throw new Error(`non-AMDC login link should be rejected: ${badLoginLink.res.status} ${JSON.stringify(badLoginLink.body)}`);
  }

  const badWeek = await postJson(`${base}/api/run/start?weekAnchor=2026-07-12&weekAnchorsConfirmed=1&account=.amdc-userdata&topDepth=1000`, token);
  if (badWeek.res.status !== 409 || !/Monday|周一/.test(String(badWeek.body.error || ''))) {
    throw new Error(`invalid weekAnchor should be rejected: ${badWeek.res.status} ${JSON.stringify(badWeek.body)}`);
  }

  const now = new Date();
  const currentMonday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  const currentMondayText = `${currentMonday.getFullYear()}-${String(currentMonday.getMonth() + 1).padStart(2, '0')}-${String(currentMonday.getDate()).padStart(2, '0')}`;
  const currentWeek = await postJson(`${base}/api/run/start?weekAnchor=${currentMondayText}&weekAnchorsConfirmed=1&account=.amdc-userdata&topDepth=100`, token);
  if (currentWeek.res.status !== 409 || !/当前周|未来周/.test(String(currentWeek.body.error || ''))) {
    throw new Error(`current collection week should be rejected: ${currentWeek.res.status} ${JSON.stringify(currentWeek.body)}`);
  }

  const badDepth = await postJson(`${base}/api/run/start?weekAnchor=2026-07-13&weekAnchorsConfirmed=1&account=.amdc-userdata&topDepth=999`, token);
  if (badDepth.res.status !== 409 || !/topDepth/.test(String(badDepth.body.error || ''))) {
    throw new Error(`invalid topDepth should be rejected: ${badDepth.res.status} ${JSON.stringify(badDepth.body)}`);
  }

  const badCategory = await postJson(`${base}/api/run/start?weekAnchor=2026-07-13&weekAnchorsConfirmed=1&account=.amdc-userdata&topDepth=100&category=not-a-category`, token);
  if (badCategory.res.status !== 409 || !/不支持的采集品类/.test(String(badCategory.body.error || ''))) {
    throw new Error(`invalid category should be rejected: ${badCategory.res.status} ${JSON.stringify(badCategory.body)}`);
  }

  const badProfile = await postJson(`${base}/api/run/start?weekAnchor=2026-07-13&weekAnchorsConfirmed=1&account=.amdc-userdata-x&topDepth=1000`, token);
  if (badProfile.res.status !== 409 || !/不支持的账号目录/.test(String(badProfile.body.error || ''))) {
    throw new Error(`invalid profile should be rejected: ${badProfile.res.status} ${JSON.stringify(badProfile.body)}`);
  }

  console.log('dashboard contract ok');
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  console.error(output);
  process.exitCode = 1;
}).finally(closeServer);
