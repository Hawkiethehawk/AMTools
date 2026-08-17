// AMDC 本地实时看板 — localhost only, SSE 推送, 全屏自适应
// 主题：霓虹驾驶舱（theme-factory 自定义：Tech Innovation 电光蓝 #0066ff/霓虹青 #00ffff + Midnight Galaxy 紫 #2b1e3e/#4a4e8f 渐变底）
// 字体：中文 微软雅黑，英文/数字 Times New Roman
const http = require('http');
const fs = require('fs');
const path = require('path');
const { batchStopped, stoppedBatchState, eventsThroughStop, terminateProcessTree } = require('./batch-cancellation');
const cp = require('child_process');
const crypto = require('crypto');
const { buildTwoPhaseWeekPlan, aggregateBatchCountryProgress, focusMarketSplit } = require('./collection-plan');
const { aggregateBatchSyncProgress } = require('./history-sync-progress');

const PROJECT_DIR = path.resolve(process.env.AMDC_PROJECT_DIR || process.cwd());
const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..', '..');
const AMTOOLS_VERSION = (() => {
  try {
    return fs.readFileSync(path.join(REPOSITORY_ROOT, 'VERSION'), 'utf-8').trim() || '未知';
  } catch {
    return '未知';
  }
})();
const OUTPUT_DIR = path.join(PROJECT_DIR, 'output');
const CACHE_DIR = path.join(PROJECT_DIR, 'Cache');
const HISTORY_DIR = path.join(CACHE_DIR, 'history');
const HISTORY_INDEX_FILE = path.join(HISTORY_DIR, 'index.json');
const DASHBOARD_CLEAR_FILE = path.join(CACHE_DIR, 'dashboard-cleared.json');
const AUTH_STATUS_CACHE_FILE = path.join(CACHE_DIR, 'amdc-auth-status.json');
const HISTORY_ID_RE = /^\d{8}-\d{6}-[a-f0-9]{4}$/;
const progressReadCache = new Map();
// 同一批次某周重试时会创建新的历史目录；按“批次+周”保留最后一次完整口径，
// 不能再只按目录缓存，否则新目录初始化会让这一周短暂从总进度中消失。
const batchWeekProgressCache = new Map();
// 子周 progress 文件会在初始化、切换和完成时被重写，事件数组可能变短；
// 批次事件流必须只增不减，避免前端时间线回闪到“任务初始化”。
const batchEventCache = new Map();
function isWSL() {
  if (process.platform !== 'linux') return false;
  try { return require('fs').readFileSync('/proc/version', 'utf-8').toLowerCase().includes('microsoft'); } catch { return false; }
}
const PORT = parseInt(process.env.AMDC_PORT || (isWSL() ? '8788' : '8787'), 10);
const HOST = process.env.AMDC_HOST || (isWSL() ? '0.0.0.0' : '127.0.0.1');
const AUTO_OPEN = process.env.AMDC_NO_OPEN !== '1';
const POLL_MS = 1000;
const parsedBatchMaxAttempts = Number(process.env.AMDC_BATCH_MAX_ATTEMPTS);
// 首次执行后最多自动重试三次；环境变量值表示总执行次数。
const AUTO_RETRY_LIMIT = 3;
const BATCH_MAX_ATTEMPTS = Number.isFinite(parsedBatchMaxAttempts)
  ? Math.max(1, Math.min(6, Math.floor(parsedBatchMaxAttempts)))
  : AUTO_RETRY_LIMIT + 1;
const parsedBatchRetryDelay = Number(process.env.AMDC_BATCH_RETRY_DELAY_MS);
const BATCH_RETRY_DELAY_MS = Number.isFinite(parsedBatchRetryDelay)
  ? Math.max(5_000, Math.min(10 * 60_000, Math.floor(parsedBatchRetryDelay)))
  : 60_000;
// 统一批次状态文件和历史元数据不是同一份原子写入；完成状态先落盘时，
// 自动收尾必须等待历史记录变为 done，不能把一次未就绪检查当成已启动。
const AUTOMATED_FINALIZE_RETRY_DELAY_MS = 500;
const AUTOMATED_FINALIZE_MAX_RETRIES = 120;
const CONFIG_FILE = path.join(PROJECT_DIR, 'amdc-config.json');
const MONOREPO_DIR = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_AMDA_PROJECT_DIR = path.join(MONOREPO_DIR, 'skills', 'AMDA');
const AMDA_PROJECT_DIR = process.env.AMDA_PROJECT_DIR || DEFAULT_AMDA_PROJECT_DIR;
const AMDA_TRIGGER_SCRIPT = path.join(__dirname, 'run_amda_after_amdc.ps1');
function ensureScheduleToken() {
  let config = {};
  try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8').replace(/^\uFEFF/, '')); } catch {}
  if (!config || typeof config !== 'object' || Array.isArray(config)) config = {};
  if (!config.schedule || typeof config.schedule !== 'object' || Array.isArray(config.schedule)) config.schedule = {};
  if (typeof config.schedule.apiToken === 'string' && config.schedule.apiToken.length >= 32) return config.schedule.apiToken;
  const token = crypto.randomBytes(24).toString('hex');
  config.schedule.apiToken = token;
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', 'utf-8'); } catch {}
  return token;
}
const DASHBOARD_TOKEN = crypto.randomBytes(24).toString('hex');
function ensureCliToken() {
  let config = {};
  try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8').replace(/^\uFEFF/, '')); } catch {}
  if (!config || typeof config !== 'object' || Array.isArray(config)) config = {};
  if (!config.cli || typeof config.cli !== 'object' || Array.isArray(config.cli)) config.cli = {};
  if (typeof config.cli.apiToken === 'string' && config.cli.apiToken.length >= 32) return config.cli.apiToken;
  const token = crypto.randomBytes(24).toString('hex');
  config.cli.apiToken = token;
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', 'utf-8'); } catch {}
  return token;
}
// 定时任务和本机 CLI 使用各自的持久令牌；网页使用服务启动时生成的短期令牌。
const SCHEDULE_TOKEN = ensureScheduleToken();
const CLI_TOKEN = ensureCliToken();
const parsedAuthCheckCooldownHours = Number(process.env.AUTH_CHECK_COOLDOWN_HOURS);
const AUTH_CHECK_COOLDOWN_HOURS = Number.isFinite(parsedAuthCheckCooldownHours)
  ? Math.max(0, Math.min(24 * 7, parsedAuthCheckCooldownHours))
  : 6;
const AUTH_CHECK_COOLDOWN_MS = Math.round(AUTH_CHECK_COOLDOWN_HOURS * 60 * 60 * 1000);
const CATEGORY_OPTIONS = [
  '超休闲',
  '休闲',
  '壁纸',
  'Launcher',
  '杀毒软件、清理',
  '文件恢复',
  'PDF阅读器',
];
const CATEGORY_SET = new Set(CATEGORY_OPTIONS);

function parseTopDepth(value) {
  const n = parseInt(value, 10);
  return n === 1000 ? 1000 : 100;
}

function validateWeekAnchor(value) {
  const s = String(value || '').trim();
  if (!s) return { ok: true, value: '' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return { ok: false, error: 'weekAnchor must use YYYY-MM-DD' };
  const d = new Date(`${s}T00:00:00Z`);
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== s) return { ok: false, error: 'weekAnchor is not a valid date' };
  if (d.getUTCDay() !== 1) return { ok: false, error: '采集周起点日只能选择周一' };
  const now = new Date();
  const localToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const currentMonday = new Date(localToday);
  currentMonday.setDate(localToday.getDate() - ((localToday.getDay() + 6) % 7));
  const latestSelectable = new Date(currentMonday);
  latestSelectable.setDate(currentMonday.getDate() - 7);
  const latestText = `${latestSelectable.getFullYear()}-${String(latestSelectable.getMonth() + 1).padStart(2, '0')}-${String(latestSelectable.getDate()).padStart(2, '0')}`;
  if (s > latestText) return { ok: false, error: `不能选择当前周或未来周，最晚可选择 ${latestText}` };
  return { ok: true, value: s };
}

function validateTopDepth(value) {
  const s = String(value || '').trim();
  if (!s) return { ok: true, value: parseTopDepth(process.env.TOP_DEPTH || '100') };
  if (s !== '100' && s !== '1000') return { ok: false, error: 'topDepth must be 100 or 1000' };
  return { ok: true, value: Number(s) };
}

function commandExists(command) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    cp.execFileSync(finder, [command], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function powershellCommand() {
  const candidates = [
    process.env.AMDC_POWERSHELL,
    'pwsh',
    'pwsh.exe',
    process.platform === 'win32' && process.env.SystemRoot
      ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : '',
    process.platform === 'win32' ? 'powershell.exe' : '',
  ].filter(Boolean);
  for (const candidate of [...new Set(candidates)]) {
    const probe = cp.spawnSync(candidate, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
      encoding: 'utf-8',
      windowsHide: true,
    });
    const version = String(probe.stdout || '').trim().split('.').map(Number);
    if (probe.status === 0 && (version[0] > 5 || (version[0] === 5 && version[1] >= 1))) return candidate;
  }
  throw new Error('PowerShell 7 or Windows PowerShell 5.1 is required');
}

function openWindowsPath(target) {
  const escaped = String(target).replace(/"/g, '""');
  cp.exec(`start "" explorer.exe /n,/e,"${escaped}"`, { windowsHide: true, shell: 'cmd.exe' }, () => {});
}

function pathForPowerShell(command, filePath) {
  if (process.platform === 'win32' || !/(?:pwsh|powershell)\.exe$/i.test(command)) return filePath;
  if (!commandExists('wslpath')) return filePath;
  try {
    return cp.execFileSync('wslpath', ['-w', filePath], { encoding: 'utf-8' }).trim() || filePath;
  } catch {
    return filePath;
  }
}

// ---------- 数据层 ----------

function listLegacyRunDirs() {
  const base = path.resolve(CACHE_DIR);
  try {
    return fs.readdirSync(base)
      .filter(d => /^\d{8}$/.test(d))
      .map(d => path.join(base, d))
      .filter(dir => {
        // 仅将实际包含采集数据的旧日期目录视为历史记录。看板启动日志
        // （如 amdc-dashboard.log）不能单独生成一条“旧版数据”。
        try {
          if (!fs.statSync(dir).isDirectory()) return false;
          return fs.readdirSync(dir).some(file => /^amdc-(?!dashboard\.log$).+\.json$/i.test(file));
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

function validateCategories(value) {
  const requested = Array.isArray(value) ? [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))] : [];
  if (!requested.length) return { ok: true, value: CATEGORY_OPTIONS.slice() };
  const unsupported = requested.filter(label => !CATEGORY_SET.has(label));
  if (unsupported.length) return { ok: false, error: `不支持的采集品类：${unsupported.join('、')}` };
  return { ok: true, value: requested };
}

function listHistoryRunDirs() {
  try {
    return fs.readdirSync(HISTORY_DIR)
      .filter(d => HISTORY_ID_RE.test(d))
      .map(d => path.join(HISTORY_DIR, d));
  } catch {
    return [];
  }
}

function listRunDirs() {
  return [...listLegacyRunDirs(), ...listHistoryRunDirs()];
}

function readHistoryIndex() {
  const index = readJsonSafe(HISTORY_INDEX_FILE);
  return Array.isArray(index) ? index : [];
}

function writeHistoryIndex(records) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  fs.writeFileSync(HISTORY_INDEX_FILE, JSON.stringify(records, null, 2), 'utf-8');
}

function isRecordedWeekAnchor(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text && date.getUTCDay() === 1;
}

// 批量采集的状态文件会保留“历史记录 ID -> 采集周”的完整映射。
// 当服务被强制中断、元数据文件意外缺失时，用它恢复历史记录，不能把有效结果显示成“--”。
function readBatchHistoryHints() {
  const hints = new Map();
  const batchStateDir = path.join(HISTORY_DIR, 'batch-state');
  let files = [];
  try { files = fs.readdirSync(batchStateDir).filter(name => /^\d{8}-\d{6}-[a-f0-9]{4}\.json$/.test(name)); } catch {}
  for (const name of files) {
    const state = readJsonSafe(path.join(batchStateDir, name));
    if (!state || !Array.isArray(state.children)) continue;
    const batchId = HISTORY_ID_RE.test(String(state.batchId || '')) ? state.batchId : name.slice(0, -'.json'.length);
    const batchWeeks = state.children.map(child => String(child && child.weekAnchor || '').trim()).filter(isRecordedWeekAnchor);
    for (const child of state.children) {
      const historyId = String(child && child.historyId || '');
      const weekAnchor = String(child && child.weekAnchor || '').trim();
      if (!HISTORY_ID_RE.test(historyId) || !isRecordedWeekAnchor(weekAnchor)) continue;
      hints.set(historyId, {
        batchId,
        batchWeeks,
        weekAnchor,
        status: child.state === 'leaderboard_done' ? 'queued' : (child.state || ''),
        startedAt: child.startedAt || '',
        finishedAt: child.finishedAt || '',
        exitCode: child.exitCode,
        detail: child.detail || '',
      });
    }
  }
  return hints;
}

function weekAnchorFromRunState(dir) {
  const state = readJsonSafe(path.join(dir, 'amdc-run-state.json'));
  const events = state && state._meta && Array.isArray(state._meta.events) ? state._meta.events : [];
  for (const event of events) {
    const weekAnchor = String(event && event.weekAnchor || '').trim();
    if (isRecordedWeekAnchor(weekAnchor)) return weekAnchor;
  }
  return '';
}

function recoveredHistoryRecord(id, dir, indexedRecord, metadata, batchHints) {
  const indexed = indexedRecord || {};
  const saved = metadata || {};
  const batch = batchHints.get(id) || {};
  const storedWeekAnchor = isRecordedWeekAnchor(indexed.weekAnchor)
    ? indexed.weekAnchor
    : (isRecordedWeekAnchor(saved.weekAnchor) ? saved.weekAnchor : '');
  const weekAnchor = storedWeekAnchor || batch.weekAnchor || weekAnchorFromRunState(dir);
  const stat = (() => { try { return fs.statSync(dir); } catch { return null; } })();
  const startedAt = indexed.startedAt || saved.startedAt || batch.startedAt || (stat ? new Date(stat.mtimeMs).toISOString() : '');
  const autoFreshState = historyAutoFreshState(dir, {
    autoFresh: !!(indexed.autoFresh || saved.autoFresh),
    autoFreshReasons: mergeAutoFreshReasons(indexed.autoFreshReasons, saved.autoFreshReasons),
  });
  return {
    ...saved,
    ...indexed,
    id,
    outputDir: dir,
    status: indexed.status || saved.status || batch.status || 'done',
    startedAt,
    finishedAt: indexed.finishedAt || saved.finishedAt || batch.finishedAt || '',
    weekAnchor,
    topDepth: indexed.topDepth || saved.topDepth || '',
    categories: indexed.categories || saved.categories || [],
    accounts: indexed.accounts || saved.accounts || [],
    fresh: !!(indexed.fresh || saved.fresh),
    autoFresh: autoFreshState.autoFresh,
    autoFreshReasons: autoFreshState.autoFreshReasons,
    batchId: indexed.batchId || saved.batchId || batch.batchId || '',
    batchWeeks: indexed.batchWeeks || saved.batchWeeks || batch.batchWeeks || [],
    replacedHistoryIds: indexed.replacedHistoryIds || saved.replacedHistoryIds || [],
    listOnly: !!(indexed.listOnly || saved.listOnly),
    skipExcel: !!(indexed.skipExcel || saved.skipExcel),
    exitCode: indexed.exitCode == null ? (saved.exitCode == null ? (batch.exitCode == null ? null : batch.exitCode) : saved.exitCode) : indexed.exitCode,
    detail: indexed.detail || saved.detail || batch.detail || '历史目录',
    resultSummary: indexed.resultSummary || saved.resultSummary || null,
    feishuSync: indexed.feishuSync || saved.feishuSync,
    source: indexed.source || saved.source || 'manual',
    triggeredAt: indexed.triggeredAt || saved.triggeredAt || startedAt,
    notifications: indexed.notifications || saved.notifications || {},
  };
}

function historyRecordTimestamp(record, field) {
  const value = new Date(record && record[field] || '').getTime();
  return Number.isFinite(value) ? value : 0;
}

function historyRecordStatusRank(record) {
  return {
    done: 5,
    running: 4,
    starting: 4,
    failed: 3,
    stopped: 2,
    queued: 1,
    legacy: 0,
  }[String(record && record.status || '')] || 0;
}

function isPreferredHistoryRecord(candidate, current) {
  // A legacy Cache/YYYYMMDD directory is a compatibility view of shared data,
  // not an independent run. Prefer any modern run for the same collection week.
  const candidateLegacy = !!(candidate && candidate.legacy);
  const currentLegacy = !!(current && current.legacy);
  if (candidateLegacy !== currentLegacy) return !candidateLegacy;

  const candidateStartedAt = historyRecordTimestamp(candidate, 'startedAt');
  const currentStartedAt = historyRecordTimestamp(current, 'startedAt');
  if (candidateStartedAt !== currentStartedAt) return candidateStartedAt > currentStartedAt;

  const candidateFinishedAt = historyRecordTimestamp(candidate, 'finishedAt');
  const currentFinishedAt = historyRecordTimestamp(current, 'finishedAt');
  if (candidateFinishedAt !== currentFinishedAt) return candidateFinishedAt > currentFinishedAt;

  const candidateStatus = historyRecordStatusRank(candidate);
  const currentStatus = historyRecordStatusRank(current);
  if (candidateStatus !== currentStatus) return candidateStatus > currentStatus;
  return String(candidate && candidate.id || '').localeCompare(String(current && current.id || '')) > 0;
}

function collapseHistoryRecords(records) {
  const latestByWeek = new Map();
  const unscoped = [];
  for (const record of records || []) {
    const weekAnchor = String(record && record.weekAnchor || '').trim();
    if (!weekAnchor) {
      unscoped.push(record);
      continue;
    }
    const current = latestByWeek.get(weekAnchor);
    if (!current || isPreferredHistoryRecord(record, current)) latestByWeek.set(weekAnchor, record);
  }

  return [...latestByWeek.values(), ...unscoped].sort((a, b) => {
    const weekOrder = String(b && b.weekAnchor || '').localeCompare(String(a && a.weekAnchor || ''));
    if (weekOrder) return weekOrder;
    const startedOrder = historyRecordTimestamp(b, 'startedAt') - historyRecordTimestamp(a, 'startedAt');
    if (startedOrder) return startedOrder;
    return String(b && b.id || '').localeCompare(String(a && a.id || ''));
  });
}

function historyDirForId(id) {
  const value = String(id || '');
  const legacy = /^legacy-(\d{8})$/.exec(value);
  if (legacy) return path.join(CACHE_DIR, legacy[1]);
  if (HISTORY_ID_RE.test(value)) return path.join(HISTORY_DIR, value);
  return null;
}

function historyId() {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `${stamp.slice(0, 8)}-${stamp.slice(8, 14)}-${crypto.randomBytes(2).toString('hex')}`;
}

function upsertHistoryRecord(record) {
  if (!record || !HISTORY_ID_RE.test(record.id)) return;
  const records = readHistoryIndex().filter(x => x && x.id !== record.id);
  records.push(record);
  records.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
  writeHistoryIndex(records);
  const dir = historyDirForId(record.id);
  if (dir) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(record, null, 2), 'utf-8');
  }
}

function modernHistoryRecordsForWeek(weekAnchor) {
  const targetWeek = String(weekAnchor || '').trim();
  if (!isRecordedWeekAnchor(targetWeek)) return [];
  const indexed = new Map(readHistoryIndex().filter(x => x && HISTORY_ID_RE.test(x.id)).map(x => [x.id, x]));
  const batchHints = readBatchHistoryHints();
  const records = [];
  for (const dir of listHistoryRunDirs()) {
    const id = path.basename(dir);
    const record = recoveredHistoryRecord(
      id,
      dir,
      indexed.get(id),
      readJsonSafe(path.join(dir, 'metadata.json')),
      batchHints,
    );
    if (record.weekAnchor === targetWeek) records.push(record);
  }
  return records;
}

function removeHistoryWeek(weekAnchor) {
  const mon = String(weekAnchor || '').replace(/-/g, '');
  if (!/^\d{8}$/.test(mon)) return [];
  const removedIds = modernHistoryRecordsForWeek(weekAnchor).map(record => record.id);
  for (const id of removedIds) {
    const dir = historyDirForId(id);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
  const legacyDir = path.join(CACHE_DIR, mon);
  if (fs.existsSync(legacyDir)) fs.rmSync(legacyDir, { recursive: true, force: true });
  writeHistoryIndex(readHistoryIndex().filter(x => x && !removedIds.includes(x.id) && x.weekAnchor !== weekAnchor));
  for (const key of resultCache.keys()) {
    if (removedIds.some(id => String(key).includes(path.join(HISTORY_DIR, id)))) resultCache.delete(key);
  }
  return removedIds;
}

function createHistoryRecord(opts) {
  const id = historyId();
  const outputDir = path.join(HISTORY_DIR, id);
  const record = {
    id,
    outputDir,
    status: 'starting',
    startedAt: new Date().toISOString(),
    finishedAt: '',
    weekAnchor: opts.weekAnchor || '',
    topDepth: opts.topDepth,
    categories: opts.categories || CATEGORY_OPTIONS.slice(),
    accounts: opts.accounts || [],
    fresh: !!opts.fresh,
    autoFresh: false,
    autoFreshReasons: [],
    batchId: opts.batchId || '',
    batchWeeks: Array.isArray(opts.batchWeeks) ? opts.batchWeeks.slice() : [],
    // 重跑已有周时，新记录是事务性替代项：成功后清理旧记录，取消时删除本次临时记录。
    replacedHistoryIds: Array.isArray(opts.replacedHistoryIds) ? opts.replacedHistoryIds.slice() : [],
    listOnly: !!opts.listOnly,
    skipExcel: !!opts.skipExcel,
    exitCode: null,
    detail: 'launching collection',
    resultSummary: null,
    source: opts.source || 'manual',
    triggeredAt: opts.triggeredAt || new Date().toISOString(),
    notifications: opts.notifications || {},
  };
  fs.mkdirSync(outputDir, { recursive: true });
  upsertHistoryRecord(record);
  return record;
}

function removeHistoryRecordData(id) {
  const dir = historyDirForId(id);
  const root = path.resolve(HISTORY_DIR) + path.sep;
  const resolved = path.resolve(dir || '');
  if (!dir || !resolved.startsWith(root)) return false;
  fs.rmSync(resolved, { recursive: true, force: true });
  writeHistoryIndex(readHistoryIndex().filter(x => x && x.id !== id));
  for (const key of resultCache.keys()) {
    if (String(key).startsWith(resolved)) resultCache.delete(key);
  }
  return true;
}

function finalizeReplacedHistory(record) {
  if (!record || !isRecordedWeekAnchor(record.weekAnchor)) return;
  const supersededIds = new Set([
    ...(record.replacedHistoryIds || []),
    ...modernHistoryRecordsForWeek(record.weekAnchor).map(item => item.id),
  ]);
  supersededIds.delete(record.id);
  for (const id of supersededIds) removeHistoryRecordData(id);
}

function restoreReplacedHistory(historyId) {
  const record = historyRecordById(historyId);
  if (!record || !record.replacedHistoryIds || !record.replacedHistoryIds.length) return false;
  const removed = removeHistoryRecordData(historyId);
  if (removed) {
    lastSig = '';
    broadcast();
  }
  return removed;
}

function replacedHistoryIdsForWeek(weekAnchor) {
  return modernHistoryRecordsForWeek(weekAnchor).map(record => record.id);
}

function historyRecords() {
  const indexed = new Map(readHistoryIndex().filter(x => x && HISTORY_ID_RE.test(x.id)).map(x => [x.id, x]));
  const batchHints = readBatchHistoryHints();
  const records = [];
  for (const dir of listHistoryRunDirs()) {
    const id = path.basename(dir);
    const record = recoveredHistoryRecord(
      id,
      dir,
      indexed.get(id),
      readJsonSafe(path.join(dir, 'metadata.json')),
      batchHints,
    );
    const resultSummary = record.resultSummary || historyResultSummary(dir);
    const detail = record.status === 'failed'
      ? collectionFailureDetail({ amdcLogFile: path.join(dir, 'collection.log') }, record.detail || '采集失败')
      : record.detail;
    records.push({ ...record, outputDir: dir, resultSummary, detail });
  }
  for (const dir of listLegacyRunDirs()) {
    const name = path.basename(dir);
    let mtime = 0;
    try { mtime = fs.statSync(dir).mtimeMs; } catch {}
    const legacyRecord = {
      id: `legacy-${name}`,
      outputDir: dir,
      status: 'legacy',
      startedAt: mtime ? new Date(mtime).toISOString() : `${name.slice(0, 4)}-${name.slice(4, 6)}-${name.slice(6)}T00:00:00.000Z`,
      finishedAt: '',
      weekAnchor: `${name.slice(0, 4)}-${name.slice(4, 6)}-${name.slice(6)}`,
      topDepth: '',
      accounts: [],
      fresh: false,
      detail: '旧版缓存目录',
      legacy: true,
    };
    records.push({ ...legacyRecord, resultSummary: historyResultSummary(dir) });
  }
  return collapseHistoryRecords(records);
}

function previousWeekMondayValue() {
  const today = new Date();
  const currentMonday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7));
  currentMonday.setDate(currentMonday.getDate() - 7);
  return `${currentMonday.getFullYear()}-${String(currentMonday.getMonth() + 1).padStart(2, '0')}-${String(currentMonday.getDate()).padStart(2, '0')}`;
}

function historyResultSummary(dir) {
  try {
    const results = readResults(dir);
    return {
      categories: (results.categories || []).length,
      records: (results.categories || []).reduce((n, x) => n + (x.records || 0), 0),
      focusCount: (results.categories || []).reduce((n, x) => n + (x.focusCount || 0), 0),
      risers: (results.risers || []).length,
    };
  } catch {
    return null;
  }
}

function mergeAutoFreshReasons(...groups) {
  const merged = [];
  const seen = new Set();
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const reason of group) {
      if (reason == null) continue;
      const key = typeof reason === 'string' ? `text:${reason}` : `json:${JSON.stringify(reason)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(reason);
    }
  }
  return merged;
}

function historyAutoFreshState(dir, storedRecord = {}) {
  const progress = readProgress(dir) || {};
  const runState = readJsonSafe(path.join(dir, 'amdc-run-state.json')) || {};
  const runMeta = runState._meta && typeof runState._meta === 'object' ? runState._meta : {};
  return {
    autoFresh: !!(storedRecord.autoFresh || progress.autoFresh || runMeta.autoFresh),
    autoFreshReasons: mergeAutoFreshReasons(
      storedRecord.autoFreshReasons,
      progress.autoFreshReasons,
      runMeta.autoFreshReasons,
    ),
  };
}

function historyRecordById(id) {
  const dir = historyDirForId(id);
  if (!dir || !fs.existsSync(dir)) return null;
  return historyRecords().find(x => x.id === id) || null;
}

function rawHistoryRecordById(id) {
  if (!HISTORY_ID_RE.test(String(id || ''))) return null;
  const indexed = readHistoryIndex().find(record => record && record.id === id);
  if (indexed) return indexed;
  const dir = historyDirForId(id);
  return dir ? readJsonSafe(path.join(dir, 'metadata.json')) : null;
}

function updateHistoryRecord(id, patch) {
  // 运行中只读取原始元数据，避免把结果文件尚未生成时临时计算出的 0 汇总写回磁盘。
  const current = rawHistoryRecordById(id);
  if (!current || current.legacy) return;
  upsertHistoryRecord({ ...current, ...patch, outputDir: historyDirForId(id) });
}

function repairIncompleteHistoryRecords() {
  const indexed = new Map(readHistoryIndex().filter(x => x && HISTORY_ID_RE.test(x.id)).map(x => [x.id, x]));
  const batchHints = readBatchHistoryHints();
  let repaired = 0;
  for (const dir of listHistoryRunDirs()) {
    const id = path.basename(dir);
    const saved = readJsonSafe(path.join(dir, 'metadata.json'));
    const current = indexed.get(id) || saved;
    if (current && isRecordedWeekAnchor(current.weekAnchor)) continue;
    const recovered = recoveredHistoryRecord(id, dir, indexed.get(id), saved, batchHints);
    // 只在批量状态或运行状态提供了可验证的周一日期时补写，绝不猜测历史数据。
    if (!isRecordedWeekAnchor(recovered.weekAnchor)) continue;
    upsertHistoryRecord(recovered);
    repaired += 1;
  }
  return repaired;
}

function repairHistoryResultSummaries() {
  let repaired = 0;
  for (const dir of listHistoryRunDirs()) {
    const id = path.basename(dir);
    const record = rawHistoryRecordById(id);
    if (!record || record.status !== 'done') continue;
    const summary = historyResultSummary(dir);
    const previous = record.resultSummary || {};
    const summaryChanged = !!(summary && summary.categories > 0) &&
      ['categories', 'records', 'focusCount', 'risers'].some(key => Number(previous[key]) !== Number(summary[key]));
    const autoFreshState = historyAutoFreshState(dir, record);
    const autoFreshChanged = !!record.autoFresh !== autoFreshState.autoFresh ||
      JSON.stringify(record.autoFreshReasons || []) !== JSON.stringify(autoFreshState.autoFreshReasons);
    if (!summaryChanged && !autoFreshChanged) continue;
    upsertHistoryRecord({
      ...record,
      outputDir: dir,
      ...(summaryChanged ? { resultSummary: summary } : {}),
      autoFresh: autoFreshState.autoFresh,
      autoFreshReasons: autoFreshState.autoFreshReasons,
    });
    repaired += 1;
  }
  return repaired;
}

function repairDuplicateSkipSyncRecords() {
  for (const record of historyRecords()) {
    const sync = record.feishuSync || {};
    if (sync.status !== 'failed' || !/标题(?:列)?和本周排名.*重复/.test(String(sync.error || ''))) continue;
    const { error, ...rest } = sync;
    updateHistoryRecord(record.id, {
      feishuSync: {
        ...rest,
        status: 'done',
        syncedAt: sync.failedAt || new Date().toISOString(),
        skipped: true,
        progress: 100,
        message: '标题和本周排名完全重复，已跳过同步',
      },
    });
  }
}

function recoverInterruptedHistorySyncs() {
  const interruptedAt = new Date().toISOString();
  let recovered = false;
  for (const record of historyRecords()) {
    const sync = record.feishuSync || {};
    if (!['syncing', 'queued'].includes(sync.status)) continue;
    recovered = true;
    updateHistoryRecord(record.id, {
      feishuSync: {
        ...sync,
        status: 'stopped',
        stoppedAt: interruptedAt,
        progress: Math.max(0, Math.min(100, Number(sync.progress) || 0)),
        message: '批量同步已停止（看板重启中断）',
        error: '看板重启后未检测到仍在运行的同步任务，已解除残留状态',
      },
    });
  }
  return recovered;
}

function finishHistoryRecord(job, state, exitCode, detail) {
  if (!job || !job.historyId) return;
  const dir = historyDirForId(job.historyId);
  let resultSummary = null;
  let autoFreshState = { autoFresh: false, autoFreshReasons: [] };
  if (dir && fs.existsSync(dir)) {
    try {
      const results = readResults(dir);
      resultSummary = {
        categories: (results.categories || []).length,
        records: (results.categories || []).reduce((n, x) => n + (x.records || 0), 0),
        focusCount: (results.categories || []).reduce((n, x) => n + (x.focusCount || 0), 0),
        risers: (results.risers || []).length,
      };
    } catch {}
    autoFreshState = historyAutoFreshState(dir, rawHistoryRecordById(job.historyId) || {});
  }
  updateHistoryRecord(job.historyId, {
    status: state,
    finishedAt: new Date().toISOString(),
    exitCode: exitCode == null ? null : exitCode,
    detail: detail || '',
    resultSummary,
    autoFresh: autoFreshState.autoFresh,
    autoFreshReasons: autoFreshState.autoFreshReasons,
  });
}

function deleteHistoryRecord(id) {
  const record = historyRecordById(id);
  if (!record) return { ok: false, error: 'history record not found' };
  if (record.legacy) return { ok: false, error: '旧版历史记录不支持单独删除' };
  if (runJob && activeRunJob() && (runJob.historyId === id || (runJob.children || []).some(child => child.historyId === id))) {
    return { ok: false, error: '当前采集正在运行，不能删除' };
  }
  const removedIds = removeHistoryWeek(record.weekAnchor);
  if (!removedIds.includes(id)) return { ok: false, error: 'invalid history path' };
  lastSig = '';
  broadcast();
  return { ok: true, id, weekAnchor: record.weekAnchor, removedCount: removedIds.length };
}

function isDashboardStateFile(file) {
  return file === 'amdc-progress.json'
    || file === 'amdc-run-state.json'
    || /^amdc-(weekly-cache|enrich-cache)-.+\.json$/.test(file)
    || /^amdc-(?!weekly-cache|enrich-cache).+-weekly\.json$/.test(file)
    || /^AMDC-.+\d{8}\.xlsx$/.test(file)
    || file === 'SUMMARY.md';
}

function dashboardFileMtime(dir) {
  let best = -1;
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return best; }
  for (const file of files) {
    if (!isDashboardStateFile(file)) continue;
    try { best = Math.max(best, fs.statSync(path.join(dir, file)).mtimeMs); } catch {}
  }
  return best;
}

function latestRunDir() {
  let best = null;
  let bestTime = -1;
  for (const dir of listRunDirs()) {
    const t = dashboardFileMtime(dir);
    if (t > bestTime) { bestTime = t; best = dir; }
  }
  return best;
}

function dashboardClearAt() {
  const saved = readJsonSafe(DASHBOARD_CLEAR_FILE);
  const at = new Date(saved && saved.clearedAt || '').getTime();
  return Number.isFinite(at) ? at : 0;
}

function activeDisplayRunDir() {
  const active = activeRunJob();
  if (!active) return null;
  if (active.historyId) {
    const dir = historyDirForId(active.historyId);
    if (dir && fs.existsSync(dir)) return dir;
  }
  const children = Array.isArray(active.children) ? active.children : [];
  // 优先当前正在启动/运行的周；切换瞬间若子进程刚退出，则先取下一条排队周，
  // 防止新历史目录尚未写入文件时回退到上一轮已完成目录。
  const current = children.find(child => ['starting', 'running', 'stopping'].includes(child.state))
    || children.find(child => child.state === 'queued');
  if (!current || !current.historyId) return null;
  const dir = historyDirForId(current.historyId);
  return dir && fs.existsSync(dir) ? dir : null;
}

function latestVisibleRunDir() {
  const activeDir = activeDisplayRunDir();
  if (activeDir) return activeDir;
  const runDir = latestRunDir();
  if (!runDir) return null;
  return dashboardFileMtime(runDir) > dashboardClearAt() ? runDir : null;
}

function clearDashboardView() {
  if (activeRunJob() || isFreshProgressActive() || historyBatchSyncJob) return { ok: false, error: '任务运行中，无法刷新看板' };
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const clearedAt = new Date().toISOString();
    fs.writeFileSync(DASHBOARD_CLEAR_FILE, JSON.stringify({ clearedAt }), 'utf-8');
    resultCache.clear();
    lastSig = '';
    broadcast();
    return { ok: true, clearedAt };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : '清空面板失败' };
  }
}

function readJsonSafe(file) {
  try {
    const raw = fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readProgress(runDir) {
  if (!runDir) return null;
  const file = path.join(runDir, 'amdc-progress.json');
  const current = readJsonSafe(file);
  const previous = progressReadCache.get(file);
  if (!current) return previous || null;
  // 应用阶段初始化会先写出 countryTotal=0；在同一周恢复有效总数前，
  // 继续使用该周最后一次完整国别口径，避免批次总进度瞬间回退。
  const currentTotal = Math.max(0, Number(current.countryTotal) || 0);
  const previousTotal = Math.max(0, Number(previous && previous.countryTotal) || 0);
  if (previous && previousTotal > 0 && currentTotal === 0) {
    const preserved = {
      ...current,
      countryDone: previous.countryDone,
      countryTotal: previous.countryTotal,
      countryRemaining: previous.countryRemaining,
      totalFocus: previous.totalFocus,
      overall: previous.overall,
    };
    progressReadCache.set(file, preserved);
    return preserved;
  }
  progressReadCache.set(file, current);
  return current;
}

function stableBatchWeekProgress(batchId, weekAnchor, current) {
  const key = `${batchId || ''}|${weekAnchor || ''}`;
  if (!key || key === '|') return current;
  const previous = batchWeekProgressCache.get(key);
  if (!current) return previous || null;
  const currentTotal = Math.max(0, Number(current.countryTotal) || 0);
  const currentDone = Math.max(0, Number(current.countryDone) || 0);
  const previousTotal = Math.max(0, Number(previous && previous.countryTotal) || 0);
  const previousDone = Math.max(0, Number(previous && previous.countryDone) || 0);
  // 仅在重试进程尚未恢复到上一轮的完整口径时使用缓存；真正前进时立即接受新值。
  if (previous && (currentTotal === 0 || currentTotal < previousTotal || (currentTotal === previousTotal && currentDone < previousDone))) {
    return {
      ...current,
      countryDone: previous.countryDone,
      countryTotal: previous.countryTotal,
      countryRemaining: previous.countryRemaining,
      totalFocus: previous.totalFocus,
      overall: previous.overall,
    };
  }
  if (currentTotal > 0) batchWeekProgressCache.set(key, current);
  return current;
}

function appendBatchEvent(batchId, level, message, extra = {}) {
  if (!runJob || runJob.batchId !== batchId) return;
  const events = Array.isArray(runJob.events) ? runJob.events.slice(-99) : [];
  events.push({ at: new Date().toISOString(), level, message, batch: true, ...extra });
  runJob = { ...runJob, events: events.slice(-100) };
}

function appendPersistedBatchEvent(file, event) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(event) + '\n', 'utf-8');
  } catch {}
}

function writeJsonAtomic(file, value) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf-8');
  try {
    fs.renameSync(tmp, file);
  } catch {
    try { fs.unlinkSync(file); } catch {}
    fs.renameSync(tmp, file);
  }
}

function batchEventKey(event) {
  if (!event) return '';
  if (['任务初始化', '账号池就绪', 'tags检查无误'].includes(event.message)) {
    return `batch-once|${event.message}`;
  }
  if (event.message === '批量采集已停止') return `batch-stop|${event.weekAnchor || ''}`;
  if (event.message === '总任务完成') return `batch-complete|${event.weekAnchor || ''}`;
  return [event.at || '', event.level || '', event.message || '', event.weekAnchor || '', event.category || '', event.account || ''].join('|');
}

function stableBatchEvents(batchId, incoming) {
  if (!batchId) return (incoming || []).slice(-1000);
  const merged = [];
  const seen = new Set();
  for (const event of eventsThroughStop((batchEventCache.get(batchId) || []).concat(incoming || []))) {
    const key = batchEventKey(event);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(event);
  }
  merged.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  const stable = merged.slice(-1000);
  batchEventCache.set(batchId, stable);
  // 只保留少量最近批次，避免长期运行的看板进程积累历史事件。
  if (batchEventCache.size > 20) {
    const oldest = batchEventCache.keys().next().value;
    if (oldest && oldest !== batchId) batchEventCache.delete(oldest);
  }
  return stable;
}

function storeUrl(storeIds, country) {
  const market = typeof country === 'string' ? country : (country && country.dlList);
  const countryMatch = String(market || '').match(/\b([A-Z]{2})\b/);
  const appStoreCountry = countryMatch ? `/${countryMatch[1].toLowerCase()}` : '';
  for (const s of (storeIds || [])) {
    const i = s.indexOf('_');
    const store = +s.slice(0, i);
    const id = s.slice(i + 1);
    if (store === 1) return 'https://play.google.com/store/apps/details?id=' + id;
    if (store === 2 || store === 3) return 'https://apps.apple.com' + appStoreCountry + '/app/id' + id;
  }
  return '';
}

function dlTop(country, n) {
  if (!country || !country.dlList) return '';
  return country.dlList.split(' / ').slice(0, n).join(' / ');
}

// 结果摘要缓存：按文件 mtime 失效
const resultCache = new Map(); // key -> { mtime, digest }
function isFirstInTop100Trajectory(rank, history) {
  return rank <= 100
    && Array.isArray(history)
    && history.length >= 4
    && history.slice(-3).every(h => h == null)
    && history.slice(1).every(h => h == null || h > 100);
}

const BIG_PUBS = ['voodoo','saygames','supercent','azur','miniclip','rollic','kwalee','homa','habby','lion studios','crazylabs','good job games','bytedance','tencent','outfit7','zynga','playgendary','ketchapp','sybo','gameloft','tap2play','unico','poki','yso','abi global','mattel','popcore','geisha','bestplay','freeplay','aiby'];
function isBigPublisher(publisher) {
  const s = String(publisher || '').toLowerCase();
  return BIG_PUBS.some(b => s.includes(b));
}

function isReleasedWithinPreviousThreeMonths(release, weekAnchor) {
  const anchor = String(weekAnchor || '').slice(0, 10);
  const released = String(release || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor) || !/^\d{4}-\d{2}-\d{2}$/.test(released)) return false;
  const anchorDate = new Date(`${anchor}T00:00:00Z`);
  const releaseDate = new Date(`${released}T00:00:00Z`);
  if (!Number.isFinite(anchorDate.getTime()) || !Number.isFinite(releaseDate.getTime())) return false;
  const cutoffMonth = anchorDate.getUTCMonth() - 3;
  const cutoffYear = anchorDate.getUTCFullYear() + Math.floor(cutoffMonth / 12);
  const normalizedMonth = (cutoffMonth + 12) % 12;
  const cutoffDay = Math.min(
    anchorDate.getUTCDate(),
    new Date(Date.UTC(cutoffYear, normalizedMonth + 1, 0)).getUTCDate(),
  );
  const cutoffDate = new Date(Date.UTC(cutoffYear, normalizedMonth, cutoffDay));
  return releaseDate >= cutoffDate && releaseDate <= anchorDate;
}

function isPotentialNewFocus(r, country, firstInTop100, weekAnchor) {
  if (!isReleasedWithinPreviousThreeMonths(r.release, weekAnchor)) return false;
  const history = r.history || [];
  const weeksOnBoard = r.weeksOnBoard || history.filter(h => h != null).length;
  return !!firstInTop100
    && weeksOnBoard <= 3
    && !isBigPublisher(r.publisher)
    && !!country
    && ((country.mature || 0) >= 25 || (country.matureRev || 0) >= 25);
}

function focusEntry(r, country, extra) {
  const firstInTop100 = !!(extra && extra.firstInTop100);
  const weekAnchor = extra && extra.weekAnchor;
  // 榜单阶段/实时摘要只有榜单数据，国别尚未开始补采；此时缺少 country
  // 代表“尚未采集”，不能提前标成疑似下架。只有明确得到“默认下架”
  // 的结果才在实时阶段显示该标签，避免全新采集一开始所有焦点应用都变橙色。
  const live = !!(extra && extra.live);
  const authoritative = !!(extra && extra.authoritative);
  const storeChecked = ['商店可用', '商店链接未确认'].includes(r.countryStatus);
  const suspectedDelisted = r.countryStatus === '默认下架'
    || (!live && authoritative && !country && !storeChecked);
  return {
    rank: r.rank,
    name: r.name,
    publisher: r.publisher,
    hq: r.hq || '',
    change: r.change,
    lastWeek: r.lastWeek,
    history: r.history || [],
    streak50: r.streak50 || 0,
    rating: r.rating,
    reviews: r.reviews,
    release: r.release || '',
    market: country ? country.market : '',
    dlTop: dlTop(country, 3),
    url: storeUrl(r.storeIds, country) || r.url,
    potentialNew: isPotentialNewFocus(r, country, firstInTop100, weekAnchor),
    suspectedDelisted,
    countryStatus: r.countryStatus || '',
    storeLinkStatus: r.storeLinkStatus || '',
    ...extra,
  };
}

// 最终产物摘要（跑完后的权威数据）
function digestCategory(file, runDirName) {
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch { return null; }
  const hit = resultCache.get(file);
  if (hit && hit.mtime === mtime) return hit.digest;

  const data = readJsonSafe(file);
  if (!data || !data.category) return null;
  // 两阶段采集的榜单确认子进程会先写出 listOnly 产物。该文件没有国别
  // 富化结果，只能用于展示榜单，不能把所有缺失 country 的应用判为下架。
  const metadata = readJsonSafe(path.join(path.dirname(file), 'metadata.json')) || {};
  const provisional = metadata.listOnly === true;
  // 只有明确完成的完整采集结果，才允许把仍无国别的旧记录视为疑似下架。
  // 运行中、停止或失败的产物仍可能只是半成品，不能提前贴标签。
  const authoritative = metadata.status ? metadata.status === 'done' : !provisional;
  const records = data.records || [];
  const weekAnchor = (data.weeks || [])[0] || '';
  if (!records.length) return null;
  const focus = (data.focus || []).map(r => {
    const history = r.history || [];
    return focusEntry(r, r.country, {
      firstInTop100: isFirstInTop100Trajectory(r.rank, history),
      weekAnchor,
      live: provisional,
      authoritative,
    });
  });
  const digest = {
    category: data.category.label,
    weeks: data.weeks || [],
    generatedAt: data.generatedAt || '',
    runDir: runDirName,
    live: provisional,
    records: records.length,
    focusCount: focus.length,
    newTop100: focus.filter(f => f.firstInTop100).length,
    enriched: focus.filter(f => f.market).length,
    focus,
  };
  resultCache.set(file, { mtime, digest });
  return digest;
}

// 实时摘要：最终 JSON 未落盘时，用榜单缓存 + 采集缓存现算焦点集（与 scraper 同判定逻辑）
function liveDigest(runDir, cat, runDirName) {
  const wcFile = path.join(runDir, 'amdc-weekly-cache-' + cat + '.json');
  const enFile = path.join(runDir, 'amdc-enrich-cache-' + cat + '.json');
  let wcM = 0;
  let enM = 0;
  try { wcM = fs.statSync(wcFile).mtimeMs; } catch { return null; }
  try { enM = fs.statSync(enFile).mtimeMs; } catch {}
  const key = wcFile + '|live';
  const hit = resultCache.get(key);
  if (hit && hit.mtime === wcM + enM) return hit.digest;

  const wc = readJsonSafe(wcFile);
  if (!wc) return null;
  const weeks = Object.keys(wc).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort().reverse();
  if (!weeks.length) return null;
  const rankMaps = {};
  for (const d of weeks) rankMaps[d] = new Map(((wc[d] || {}).rows || []).map(r => [r.uid, r.rank]));
  const curRows = (wc[weeks[0]] || {}).rows || [];
  if (!curRows.length) return null;
  const enrichApps = (readJsonSafe(enFile) || {}).apps || {};
  const riseThreshold = rank => (rank <= 5 ? 3 : rank <= 10 ? 5 : rank <= 50 ? 10 : rank <= 100 ? 20 : rank <= 200 ? 30 : Infinity);

  const focus = [];
  for (const r of curRows) {
    const prevMap = rankMaps[weeks[1]];
    const prevRank = prevMap ? (prevMap.get(r.uid) ?? null) : null;
    const lastWeek = prevRank != null ? prevRank : (r.diff != null ? r.rank + r.diff : null);
    const change = lastWeek != null ? lastWeek - r.rank : null;
    const history = weeks.map(d => rankMaps[d].get(r.uid) ?? null);
    const firstInTop100 = isFirstInTop100Trajectory(r.rank, history);
    const riser = change != null && change >= riseThreshold(r.rank);
    if (!riser && !firstInTop100) continue;
    let streak50 = 0;
    for (const h of history) {
      if (!(h != null && h <= 50)) break;
      streak50++;
    }
    const e = enrichApps[r.uid] || {};
    const reasons = [];
    if (change != null && change > 0 && r.rank > 0) {
      reasons.push('排名上升' + change + '名（+' + ((change / r.rank) * 100).toFixed(0) + '%）');
    }
    focus.push(focusEntry(
      { ...r, change, lastWeek, history, streak50, rating: e.rating, reviews: e.reviews, release: e.release || r.release, countryStatus: e.countryStatus || '', storeLinkStatus: e.storeLinkStatus || '' },
      e.country,
      { reasons, firstInTop100, weekAnchor: weeks[0], live: true },
    ));
  }
  const digest = {
    category: cat,
    weeks,
    generatedAt: '',
    runDir: runDirName,
    live: true,
    records: curRows.length,
    focusCount: focus.length,
    newTop100: focus.filter(f => f.firstInTop100).length,
    enriched: focus.filter(f => f.market).length,
    focus,
  };
  resultCache.set(key, { mtime: wcM + enM, digest });
  return digest;
}

function readResults(runDir) {
  if (!runDir) return { categories: [], risers: [], marketSplit: null };
  const runDirName = path.basename(runDir);
  let names = [];
  try { names = fs.readdirSync(runDir); } catch {}

  const finalOf = {};
  for (const f of names) {
    const m = /^amdc-(.+)-weekly\.json$/.exec(f);
    if (m && !f.includes('cache')) finalOf[m[1]] = path.join(runDir, f);
  }
  const cacheCats = [];
  for (const f of names) {
    const m = /^amdc-weekly-cache-(.+)\.json$/.exec(f);
    if (m) cacheCats.push(m[1]);
  }
  const cats = [...new Set([...Object.keys(finalOf), ...cacheCats])];

  const categories = cats
    .map(cat => {
      const finalDigest = finalOf[cat] ? digestCategory(finalOf[cat], runDirName) : null;
      return finalDigest || liveDigest(runDir, cat, runDirName);
    })
    .filter(Boolean);

  const risers = [];
  const focusApps = [];
  for (const cat of categories) {
    for (const f of cat.focus) {
      focusApps.push(f);
      if (f.change != null && f.change > 0) {
        const risePct = f.rank ? f.change / f.rank : 0;
        risers.push({ ...f, category: cat.category, risePct });
      }
    }
  }
  risers.sort((a, b) => (b.risePct || 0) - (a.risePct || 0) || (b.change || 0) - (a.change || 0));
  return {
    categories,
    risers: risers.slice(0, 20),
    marketSplit: focusMarketSplit(focusApps),
  };
}

function buildBatchWeekSummary(child, progress, result, batchPhase) {
  const resultCategories = result && Array.isArray(result.categories) ? result.categories : [];
  const resultByCategory = new Map(resultCategories.map(category => [category.category || '--', category]));
  const suspectedCount = category => {
    const resultCategory = resultByCategory.get(category || '--');
    return (resultCategory && Array.isArray(resultCategory.focus) ? resultCategory.focus : [])
      .filter(app => app && (app.suspectedDelisted || app.countryStatus === '默认下架')).length;
  };
  const progressCategories = progress && Array.isArray(progress.cats) ? progress.cats : [];
  const categories = progressCategories.length
    ? progressCategories.map(category => ({
        label: category.label || '--',
        status: category.status || '',
        lab: category.lab || '',
        cls: category.cls || '',
        curRows: Math.max(0, Number(category.curRows) || 0),
        focus: Math.max(0, Number(category.focus) || 0),
        pct: Math.max(0, Math.min(100, Number(category.pct) || 0)),
        prog: category.prog || '',
        cur: category.cur || '',
        dur: Math.max(0, Number(category.dur) || 0),
        pending: Math.max(0, Number(category.pending) || 0),
        suspectedDelisted: suspectedCount(category.label),
      }))
    : resultCategories.map(category => ({
        label: category.category || '--',
        status: child.state === 'done' ? 'done' : 'leaderboard',
        lab: child.state === 'done' ? '完成' : '榜单就绪',
        cls: child.state === 'done' ? 'done' : 'wait',
        curRows: Math.max(0, Number(category.records) || 0),
        focus: Math.max(0, Number(category.focusCount) || 0),
        pct: child.state === 'done' ? 100 : 0,
        prog: child.state === 'done' ? 'done' : '',
        cur: '',
        dur: 0,
        pending: 0,
        suspectedDelisted: suspectedCount(category.category),
      }));
  const categoriesTotal = Math.max(
    categories.length,
    Math.max(0, Number(progress && progress.total) || 0),
  );
  const categoriesDone = child.state === 'done'
    ? categoriesTotal
    : Math.max(0, Math.min(categoriesTotal, Number(progress && progress.doneCats) || 0));
  const resultFocus = resultCategories.reduce((sum, category) => sum + Math.max(0, Number(category.focusCount) || 0), 0);
  const marketSplit = result && result.marketSplit || {};
  const rateLimitedAccounts = progress && Array.isArray(progress.rateLimitedAccounts)
    ? progress.rateLimitedAccounts.slice()
    : [];
  const startedAt = new Date(child.startedAt || 0).getTime();
  const finishedAt = new Date(child.finishedAt || 0).getTime();
  const durationMs = Number.isFinite(startedAt) && startedAt > 0 && Number.isFinite(finishedAt) && finishedAt >= startedAt
    ? finishedAt - startedAt
    : Math.max(0, Number(progress && progress.runElapsed) || 0);
  const leaderboardConfirmed = !!child.leaderboardConfirmedAt || child.state === 'leaderboard_done' || child.state === 'done';
  const overall = batchPhase === 'leaderboard'
    ? (leaderboardConfirmed ? 100 : (categoriesTotal ? Math.round(categoriesDone * 100 / categoriesTotal) : 0))
    : (child.state === 'done'
      ? 100
      : Math.max(0, Math.min(100, Number(progress && progress.overall) || 0)));
  return {
    historyId: child.historyId || '',
    weekAnchor: child.weekAnchor || '',
    state: child.state || 'queued',
    phase: child.phase || batchPhase || '',
    detail: child.detail || '',
    attempts: Math.max(0, Number(child.attempts) || 0),
    retryAt: child.retryAt || '',
    startedAt: child.startedAt || '',
    finishedAt: child.finishedAt || '',
    leaderboardConfirmedAt: child.leaderboardConfirmedAt || '',
    leaderboardConfirmed,
    overall,
    categoriesDone,
    categoriesTotal,
    focusCount: Math.max(0, Number(progress && progress.totalFocus) || resultFocus),
    suspectedDelisted: Math.max(0, Number(marketSplit.suspectedDelisted) || 0),
    pendingCountry: Math.max(0, Number(progress && progress.countryRemaining) || 0),
    rateLimited: Math.max(0, Number(progress && progress.rateLimited) || rateLimitedAccounts.length),
    rateLimitedAccounts,
    durationMs,
    categories,
  };
}

function batchCountryProgress(requestedHistoryId = '') {
  syncUnifiedBatchState();
  const requested = requestedHistoryId ? historyRecordById(requestedHistoryId) : null;
  // 服务重启后内存中的 runJob 不存在，仍使用最近一批历史记录恢复总进度，
  // 否则看板会退回单周 progress，周切换时又会出现口径跳变。
  const persistedBatch = !runJob && !requested ? latestPersistedBatchJob() : null;
  const currentBatch = runJob && runJob.batchId ? runJob
    : (persistedBatch && persistedBatch.batchId ? persistedBatch : null);
  const batchId = currentBatch && (!requested || requested.batchId === currentBatch.batchId)
    ? currentBatch.batchId
    : (requested && requested.batchId ? requested.batchId : '');
  if (!batchId) return null;
  const children = currentBatch && currentBatch.batchId === batchId
    ? currentBatch.children || []
    : historyRecords().filter(record => record.batchId === batchId)
      .sort((a, b) => String(b.weekAnchor || '').localeCompare(String(a.weekAnchor || '')))
      .map(record => ({
        historyId: record.id,
        weekAnchor: record.weekAnchor,
        state: record.status,
        startedAt: record.startedAt || '',
        finishedAt: record.finishedAt || '',
        exitCode: record.exitCode,
        detail: record.detail || '',
      }));
  if (!children.length) return null;
  const progresses = [];
  const weekSummaries = [];
  const categories = new Map();
  const marketSplit = { mature: 0, emerging: 0, suspectedDelisted: 0, unclassified: 0, pending: 0, unknown: 0 };
  const events = currentBatch && currentBatch.batchId === batchId
    ? (currentBatch.events || []).slice()
    : [];
  if (currentBatch && currentBatch.unified && currentBatch.batchEventFile) {
    events.push(...readBatchEventFile(currentBatch.batchEventFile));
  } else {
    const persistedEventFile = path.join(HISTORY_DIR, 'batch-events', `${batchId}.ndjson`);
    events.push(...readBatchEventFile(persistedEventFile));
  }
  const rateLimitedAccounts = new Set();
  let totalRows = 0;
  let totalFocus = 0;
  let rateLimited = 0;
  let leaderboardConfirmed = 0;
  const displayBatchPhase = currentBatch && currentBatch.phase
    ? currentBatch.phase
    : (children.some(child => child.state === 'done') ? 'application' : 'leaderboard');
  for (const child of children) {
    const dir = historyDirForId(child.historyId);
    const metadata = readJsonSafe(path.join(dir, 'metadata.json')) || {};
    const result = readResults(dir);
    const resultCategories = result.categories || [];
    const resultFocus = resultCategories.reduce((sum, category) => sum + Math.max(0, Number(category.focusCount) || 0), 0);
    const resultRows = resultCategories.reduce((sum, category) => sum + Math.max(0, Number(category.records) || 0), 0);
    let progress = stableBatchWeekProgress(batchId, child.weekAnchor, readProgress(dir));
    const applicationStartedAt = currentBatch && currentBatch.phase === 'application'
      ? new Date(currentBatch.applicationStartedAt || 0).getTime()
      : 0;
    const childStartedAt = new Date(child.startedAt || 0).getTime();
    const progressUpdatedAt = new Date(progress && progress.updatedAt || 0).getTime();
    // 榜单阶段与应用阶段共用同一历史目录。应用阶段刚切换时，旧的榜单
    // 进度仍可能是“已完成 100%”；若直接汇总，会先满格再回落到 0/总数。
    // 只要该进度早于应用阶段或本次子任务启动时间，就视为旧快照，重置
    // 为当前应用阶段的稳定分母。这样周切换期间总进度只会前进，不会抽搐。
    const staleApplicationProgress = currentBatch && currentBatch.phase === 'application'
      && progress && progress.currentStage === 'done'
      && ((applicationStartedAt && Number.isFinite(progressUpdatedAt) && progressUpdatedAt < applicationStartedAt)
        || (childStartedAt && Number.isFinite(progressUpdatedAt) && progressUpdatedAt < childStartedAt));
    if (staleApplicationProgress) {
      const staleFocus = Math.max(0, Number(progress.totalFocus) || 0, resultFocus, Number(metadata.resultSummary && metadata.resultSummary.focusCount) || 0);
      progress = staleFocus > 0
        ? {
          ...progress,
          currentStage: 'enrich',
          stageLabel: '国别采集',
          countryDone: 0,
          countryTotal: staleFocus,
          countryRemaining: staleFocus,
          totalFocus: staleFocus,
          totalRows: Math.max(0, Number(progress.totalRows) || resultRows),
          overall: 0,
        }
        : null;
    }
    // 子进程尚未写出新的 progress 文件时，用榜单结果中的焦点数先锁定
    // 分母；不能因为文件暂时不存在而把这一周从批次总进度中排除。
    if (!progress && currentBatch && currentBatch.phase === 'application') {
      const pendingFocus = Math.max(0, resultFocus, Number(metadata.resultSummary && metadata.resultSummary.focusCount) || 0);
      if (pendingFocus > 0) {
        progress = {
          currentStage: 'enrich',
          stageLabel: '国别采集',
          updatedAt: new Date().toISOString(),
          countryDone: 0,
          countryTotal: pendingFocus,
          countryRemaining: pendingFocus,
          totalFocus: pendingFocus,
          totalRows: resultRows,
          overall: 0,
          events: [],
          rateLimited: 0,
          rateLimitedAccounts: [],
        };
      }
    }
    if (!progress) {
      weekSummaries.push(buildBatchWeekSummary(child, null, result, displayBatchPhase));
      // 即使某周暂时没有 progress 文件，也保留其榜单结果汇总，避免
      // 当前周明细和批次汇总在同一帧中出现不一致。
      for (const category of resultCategories) {
        const key = category.category || '--';
        const current = categories.get(key) || { category: key, records: 0, focusCount: 0, newTop100: 0, enriched: 0 };
        current.records += Number(category.records) || 0;
        current.focusCount += Number(category.focusCount) || 0;
        current.newTop100 += Number(category.newTop100) || 0;
        current.enriched += Number(category.enriched) || 0;
        categories.set(key, current);
      }
      const split = result.marketSplit || {};
      marketSplit.mature += Number(split.mature) || 0;
      marketSplit.emerging += Number(split.emerging) || 0;
      marketSplit.suspectedDelisted += Number(split.suspectedDelisted) || 0;
      marketSplit.unclassified += Number(split.unclassified) || 0;
      marketSplit.pending += Number(split.pending) || 0;
      marketSplit.unknown += Number(split.unknown) || 0;
      continue;
    }
    // 应用阶段开始时，排队周已经完成榜单确认，但其国别进程文件可能
    // 仍是 0/0 的初始化快照。用榜单焦点数提前锁定该周分母，避免先
    // 把已完成周显示成 100%，下一周初始化后又瞬间回落。
    if (currentBatch && currentBatch.phase === 'application'
      && (Number(progress.countryTotal) || 0) === 0
      && Number(progress.totalFocus) > 0) {
      progress = {
        ...progress,
        countryDone: 0,
        countryTotal: Number(progress.totalFocus),
        countryRemaining: Number(progress.totalFocus),
        overall: 0,
      };
    }
    weekSummaries.push(buildBatchWeekSummary(child, progress, result, displayBatchPhase));
    progresses.push(progress);
    totalRows += Math.max(0, Number(progress.totalRows) || 0);
    totalFocus += Math.max(0, Number(progress.totalFocus) || 0);
    rateLimited += Math.max(0, Number(progress.rateLimited) || 0);
    for (const account of progress.rateLimitedAccounts || []) rateLimitedAccounts.add(account);
    for (const event of progress.events || []) {
      if (event && event.account && /429/.test(String(event.message || ''))) rateLimitedAccounts.add(event.account);
      events.push({ ...event, weekAnchor: child.weekAnchor });
    }
    const failureText = `${metadata.detail || ''}`;
    if (/429/.test(failureText) && progress.leaderboardAccount) rateLimitedAccounts.add(progress.leaderboardAccount);
    try {
      const log = fs.readFileSync(path.join(dir, 'collection.log'), 'utf8');
      for (const match of log.matchAll(/\.amdc-userdata(?:-[b-j])?/g)) {
        const lineStart = Math.max(0, log.lastIndexOf('\n', match.index) + 1);
        const lineEnd = log.indexOf('\n', match.index);
        const line = log.slice(lineStart, lineEnd < 0 ? log.length : lineEnd);
        if (/429/.test(line)) rateLimitedAccounts.add(match[0]);
      }
    } catch {}
    for (const category of resultCategories) {
      const key = category.category || '--';
      const current = categories.get(key) || { category: key, records: 0, focusCount: 0, newTop100: 0, enriched: 0 };
      current.records += Number(category.records) || 0;
      current.focusCount += Number(category.focusCount) || 0;
      current.newTop100 += Number(category.newTop100) || 0;
      current.enriched += Number(category.enriched) || 0;
      categories.set(key, current);
    }
    const split = result.marketSplit || {};
    marketSplit.mature += Number(split.mature) || 0;
    marketSplit.emerging += Number(split.emerging) || 0;
    marketSplit.suspectedDelisted += Number(split.suspectedDelisted) || 0;
    marketSplit.unclassified += Number(split.unclassified) || 0;
    marketSplit.pending += Number(split.pending) || 0;
    marketSplit.unknown += Number(split.unknown) || 0;
    if ((Number(progress.countryTotal) || 0) > 0) leaderboardConfirmed++;
  }
  const completedWeeks = children.filter(child => child.state === 'done').length;
  const inferredState = children.some(child => child.state === 'failed') ? 'failed'
    : (children.some(child => child.state === 'stopped') ? 'stopped'
      : (children.every(child => child.state === 'done') ? 'done' : 'running'));
  const inferredPhase = children.some(child => child.state === 'done') ? 'application' : 'leaderboard';
  const batchPhase = currentBatch && currentBatch.batchId === batchId
    ? currentBatch.phase || inferredPhase
    : inferredPhase;
  // 榜单确认阶段的 progress 文件可能沿用旧的“国别已完成”快照，
  // 不能把它当成应用采集进度，否则阶段切换会出现 100%→0%。
  const totals = batchPhase === 'leaderboard'
    ? { countryDone: 0, countryTotal: 0, countryRemaining: 0, overall: 0 }
    : aggregateBatchCountryProgress(progresses);
  const inferredPoolSize = progresses.reduce((max, progress) => Math.max(max, Number(progress.poolSize) || 0), 0);
  const batchFinishedAt = currentBatch && currentBatch.finishedAt
    ? currentBatch.finishedAt
    : children.map(child => child.finishedAt).filter(Boolean).sort().slice(-1)[0] || '';
  const batchStartedAt = currentBatch && currentBatch.startedAt
    ? currentBatch.startedAt
    : children.map(child => child.startedAt).filter(Boolean).sort()[0] || '';
  const batchState = currentBatch && currentBatch.batchId === batchId
    ? currentBatch.state || inferredState
    : inferredState;
  const startedMs = new Date(batchStartedAt || 0).getTime();
  const finishedMs = new Date(batchFinishedAt || 0).getTime();
  const terminal = batchState === 'done' || batchState === 'failed' || batchState === 'stopped';
  const runElapsed = Number.isFinite(startedMs) && startedMs > 0
    ? Math.max(0, (terminal && Number.isFinite(finishedMs) && finishedMs >= startedMs ? finishedMs : Date.now()) - startedMs)
    : 0;
  const batchWeekLabel = children.map(child => child.weekAnchor).filter(Boolean).join('、');
  const shouldInferTotalCompletion = inferredState === 'done'
    && !events.some(event => event && event.message === '总任务完成')
    && (!currentBatch || currentBatch.state === 'done');
  const shouldInferStop = batchState === 'stopped'
    && !events.some(event => event && event.message === '批量采集已停止');
  const inferredTerminalEvents = [];
  if (shouldInferStop) inferredTerminalEvents.push({
    at: batchFinishedAt,
    level: 'warn',
    message: '批量采集已停止',
    weekAnchor: batchWeekLabel,
    batch: true,
  });
  if (shouldInferTotalCompletion) inferredTerminalEvents.push({
    at: batchFinishedAt,
    level: 'info',
    message: '总任务完成',
    weekAnchor: batchWeekLabel,
    batch: true,
  });
  const batchEvents = stableBatchEvents(batchId, events.concat(inferredTerminalEvents));
  return {
    batchId,
    phase: batchPhase,
    state: batchState,
    startedAt: batchStartedAt,
    finishedAt: batchFinishedAt,
    runElapsed,
    enrichStartedAt: currentBatch && currentBatch.batchId === batchId ? currentBatch.applicationStartedAt || '' : '',
    enrichElapsed: currentBatch && currentBatch.batchId === batchId && currentBatch.applicationStartedAt
      ? Math.max(0, Date.now() - new Date(currentBatch.applicationStartedAt).getTime())
      : 0,
    poolSize: currentBatch && currentBatch.batchId === batchId && currentBatch.options
      ? (currentBatch.options.accounts || []).length
      : inferredPoolSize,
    weeks: children.length,
    completedWeeks,
    leaderboardConfirmed,
    totalRows,
    totalFocus,
    rateLimited: Math.max(rateLimited, rateLimitedAccounts.size),
    rateLimitedAccounts: Array.from(rateLimitedAccounts).sort((a, b) => (a === '.amdc-userdata' ? -1 : b === '.amdc-userdata' ? 1 : a.localeCompare(b))),
    results: { categories: Array.from(categories.values()), risers: [], marketSplit },
    events: batchEvents,
    weekSummaries,
    ...totals,
  };
}

function snapshot(requestedHistoryId = '') {
  const requestedDir = requestedHistoryId ? historyDirForId(requestedHistoryId) : null;
  const runDir = requestedDir && fs.existsSync(requestedDir) ? requestedDir : latestVisibleRunDir();
  const metadata = runDir ? readJsonSafe(path.join(runDir, 'metadata.json')) : null;
  return {
    at: new Date().toISOString(),
    projectDir: PROJECT_DIR,
    outputDir: OUTPUT_DIR,
    runDir: runDir ? path.basename(runDir) : null,
    historyId: metadata && metadata.id || (runDir && HISTORY_ID_RE.test(path.basename(runDir)) ? path.basename(runDir) : ''),
    weekAnchor: metadata && metadata.weekAnchor || '',
    batchProgress: batchCountryProgress(requestedHistoryId),
    progress: readProgress(runDir),
    results: readResults(runDir),
  };
}

// ---------- SSE ----------

const clients = new Set();
let lastSig = '';

function signature() {
  const runDir = latestVisibleRunDir();
  if (!runDir) return 'none';
  const parts = [runDir];
  try {
    for (const f of fs.readdirSync(runDir)) {
      if (/^amdc-.*\.json$/.test(f)) {
        try { parts.push(f, fs.statSync(path.join(runDir, f)).mtimeMs); } catch {}
      }
    }
  } catch {}
  return parts.join('|');
}

function broadcast() {
  if (!clients.size) return;
  const payload = 'data: ' + JSON.stringify(snapshot()) + '\n\n';
  for (const res of clients) {
    try { res.write(payload); } catch {}
  }
}

setInterval(() => {
  const sig = signature();
  if (sig !== lastSig) {
    lastSig = sig;
    broadcast();
  }
}, POLL_MS);

// SSE 心跳，防代理/浏览器断流
setInterval(() => {
  for (const res of clients) {
    try { res.write(': ping\n\n'); } catch {}
  }
}, 15000);

// ---------- HTTP ----------

function json(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function readJsonBody(req, maxBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// ---------- Account pool management ----------

const MAX_ACCOUNT_PROFILES = 20;
const DEFAULT_ACCOUNT_PROFILES = ['.amdc-userdata'].concat(
  Array.from({ length: MAX_ACCOUNT_PROFILES - 1 }, (_, i) => `.amdc-userdata-${String.fromCharCode(98 + i)}`)
);
const TOKEN_CACHE_NAME = 'amdc-token.json';
const ACCOUNT_META_NAME = 'amdc-account.json';
const accountStatus = new Map(); // profile -> { state, checkedAt, detail, output }
// 浏览器用户目录很大。账号列表、首屏快照和 SSE 会并发读取这里，
// 因此邮箱兜底扫描只能每个目录做一次，不能跟随每次页面刷新重复执行。
const profileEmailCache = new Map(); // profile -> { marker, value }
const loginJobs = new Map(); // profile -> direct-login state
let authCheckAll = null;
let runJob = null;
let runChild = null;
const batchChildProcesses = new Map();
const historySyncJobs = new Map();
let historyBatchSyncJob = null;
let historyTemporaryCleanupActive = false;

function transactionBackupName(batchId, record) {
  const suffix = String(record.weekAnchor || record.id || '').replace(/[^0-9A-Za-z_-]/g, '').slice(-24);
  return `__amdc_rollback_${String(batchId || '').replace(/[^0-9A-Za-z_-]/g, '').slice(-18)}_${suffix}`.slice(0, 90);
}

function parseChildJson(result) {
  const lines = String(result && result.stdout || '').trim().split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch {}
  }
  return {};
}

async function runHistoryTransaction(record, action, backup, job) {
  const env = { ...process.env, AMDC_PROJECT_DIR: PROJECT_DIR };
  const args = [path.join(__dirname, 'amdc_feishu_sync.py'), '--transaction-action', action];
  if (action !== 'cleanup-temporary') {
    args.push('--week', record.weekAnchor, '--transaction-backup', backup.name);
  }
  if (action === 'rollback') {
    args.push('--transaction-existed', backup.existed ? 'true' : 'false');
    args.push('--transaction-index', String(Number.isFinite(backup.originalIndex) ? backup.originalIndex : -1));
  }
  const result = await runChildCommand('python', args, env, null, {
    onSpawn: child => { if (job && job.childProcesses) job.childProcesses.add(child); },
  });
  if (job && job.childProcesses) {
    for (const child of job.childProcesses) if (child.exitCode !== null) job.childProcesses.delete(child);
  }
  const parsed = parseChildJson(result);
  if (!parsed.ok) throw new Error(parsed.error || `同步事务 ${action} 失败`);
  return parsed;
}

async function cleanupHistoryTemporarySheets(job) {
  return runHistoryTransaction(null, 'cleanup-temporary', null, job);
}

function terminateChildProcess(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') cp.spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else child.kill('SIGTERM');
  } catch {}
}

function isSafeProfile(profile) {
  return /^\.amdc-userdata(?:-[A-Za-z0-9_-]+)?$/.test(profile || '');
}

function isManagedProfile(profile) {
  return DEFAULT_ACCOUNT_PROFILES.includes(profile);
}

function profilePath(profile) {
  if (!isSafeProfile(profile)) throw new Error('账号目录无效');
  return path.resolve(PROJECT_DIR, profile);
}

function profileExists(profile) {
  try { return fs.statSync(profilePath(profile)).isDirectory(); } catch { return false; }
}

function profileSortValue(profile) {
  if (profile === '.amdc-userdata') return 0;
  const m = /^\.amdc-userdata-([A-Za-z0-9_-]+)$/.exec(profile);
  if (!m) return 999;
  const first = m[1].slice(0, 1).toLowerCase();
  if (first >= 'b' && first <= 'z') return first.charCodeAt(0) - 'a';
  return 100 + first.charCodeAt(0);
}

function accountLabel(profile) {
  if (profile === '.amdc-userdata') return 'A';
  const m = /^\.amdc-userdata-([A-Za-z0-9_-]+)$/.exec(profile);
  return m ? m[1].slice(0, 1).toUpperCase() : '?';
}

function profileSlotName(index) {
  if (index === 0) return '.amdc-userdata';
  return `.amdc-userdata-${String.fromCharCode(97 + index)}`;
}

function profileSlotIndex(profile) {
  return DEFAULT_ACCOUNT_PROFILES.indexOf(profile);
}

function currentProfileState(profile) {
  const exists = profileExists(profile);
  if (!exists) return 'missing';
  const job = loginJobs.get(profile) || {};
  if (job.state === 'login' || job.state === 'checking') return job.state;
  const stored = accountStatus.get(profile) || {};
  if (stored.state === 'checking') return 'checking';
  const cached = validAuthStatus(profile, stored) ? stored : {};
  if (cached.state) return cached.state;
  const token = readTokenMeta(profile);
  return token.cached ? 'cached' : 'unknown';
}

function listAccountProfiles() {
  const visible = [];
  let canExposeNextAddSlot = true;
  for (const profile of DEFAULT_ACCOUNT_PROFILES) {
    const exists = profileExists(profile);
    if (exists) {
      visible.push(profile);
      if (currentProfileState(profile) !== 'ok') canExposeNextAddSlot = false;
      continue;
    }
    if (canExposeNextAddSlot) visible.push(profile);
    break;
  }
  visible.sort((a, b) => profileSortValue(a) - profileSortValue(b) || a.localeCompare(b));
  return visible.slice(0, MAX_ACCOUNT_PROFILES);
}

function normalizeEmail(email) {
  const m = String(email || '').toLowerCase();
  for (const suffix of ['.com', '.cn', '.net', '.org']) {
    const idx = m.indexOf(suffix);
    if (idx >= 0) return m.slice(0, idx + suffix.length);
  }
  return m;
}

function profileEmailMarker(profile) {
  try {
    const st = fs.statSync(path.join(profilePath(profile), ACCOUNT_META_NAME));
    return `${Math.round(st.mtimeMs)}:${st.size}`;
  } catch {
    // 没有直登元数据时，浏览器目录内容不会在普通刷新中发生变化；
    // 用固定标记复用本进程已扫描出的结果即可。
    return 'no-account-meta';
  }
}

function persistDiscoveredProfileEmail(root, email) {
  const file = path.join(root, ACCOUNT_META_NAME);
  if (!email || fs.existsSync(file)) return;
  try {
    const savedAt = new Date().toISOString();
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ email, savedAt, source: 'legacy-profile-scan' }), 'utf-8');
    if (fs.existsSync(file)) fs.rmSync(tmp, { force: true });
    else fs.renameSync(tmp, file);
  } catch {}
}

function findProfileEmail(profile) {
  if (!profileExists(profile)) return { email: '', emailStatus: 'MISSING' };
  const root = profilePath(profile);
  const marker = profileEmailMarker(profile);
  const cached = profileEmailCache.get(profile);
  if (cached && cached.marker === marker) return cached.value;
  const remember = value => {
    profileEmailCache.set(profile, { marker, value });
    return value;
  };
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(root, ACCOUNT_META_NAME), 'utf-8'));
    const email = normalizeEmail(meta.email);
    if (/^[a-z0-9._%+-]+@[a-z0-9.-]+\.(com|cn|net|org)$/.test(email)) {
      return remember({ email, emailStatus: 'OK' });
    }
  } catch {}
  const counts = new Map();
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const item of items) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) {
        stack.push(file);
        continue;
      }
      if (!item.isFile()) continue;
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (st.size > 20 * 1024 * 1024) continue;
      try {
        const buf = fs.readFileSync(file);
        const texts = [buf.toString('utf8'), buf.toString('utf16le')];
        for (const text of texts) {
          const matches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}/gi) || [];
          for (const raw of matches) {
            const email = normalizeEmail(raw);
            if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.(com|cn|net|org)$/.test(email)) continue;
            if (/example|google|gstatic|sentry|schema|amdc/.test(email)) continue;
            counts.set(email, (counts.get(email) || 0) + 1);
          }
        }
      } catch {}
    }
  }
  if (!counts.size) return remember({ email: '', emailStatus: 'UNKNOWN' });
  const best = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0];
  // 旧账号只需做一次昂贵的 Chromium 目录扫描；将结果补成轻量元数据，
  // 后续进程重启和页面刷新都可以直接读取。
  persistDiscoveredProfileEmail(root, best[0]);
  return remember({ email: best[0], emailStatus: 'OK' });
}

function readTokenMeta(profile) {
  try {
    const file = path.join(profilePath(profile), TOKEN_CACHE_NAME);
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return { cached: !!raw.token, savedAt: raw.savedAt || '' };
  } catch {
    return { cached: false, savedAt: '' };
  }
}

function authStatusFingerprint(profile) {
  const token = readTokenMeta(profile);
  if (!token.cached) return '';
  try {
    const st = fs.statSync(path.join(profilePath(profile), TOKEN_CACHE_NAME));
    return `${token.savedAt}|${Math.round(st.mtimeMs)}`;
  } catch {
    return '';
  }
}

function validAuthStatus(profile, status) {
  return !!status
    && (status.state === 'ok' || status.state === 'fail')
    && !!status.checkedAt
    && Number.isFinite(Date.parse(status.checkedAt))
    && status.fingerprint === authStatusFingerprint(profile);
}

function isAuthCheckFresh(profile, status) {
  if (!validAuthStatus(profile, status)) return false;
  const checkedAt = Date.parse(status.checkedAt);
  return Number.isFinite(checkedAt) && Date.now() - checkedAt >= 0 && Date.now() - checkedAt < AUTH_CHECK_COOLDOWN_MS;
}

function loadAuthStatusCache() {
  const saved = readJsonSafe(AUTH_STATUS_CACHE_FILE);
  const profiles = saved && saved.profiles && typeof saved.profiles === 'object' ? saved.profiles : {};
  for (const [profile, status] of Object.entries(profiles)) {
    if (!isSafeProfile(profile) || !profileExists(profile) || !validAuthStatus(profile, status)) continue;
    accountStatus.set(profile, {
      state: status.state,
      checkedAt: status.checkedAt,
      detail: status.detail || (status.state === 'ok' ? '登录态检测通过' : '登录态检测失败'),
      fingerprint: status.fingerprint,
    });
  }
}

function saveAuthStatusCache() {
  const profiles = {};
  for (const [profile, status] of accountStatus.entries()) {
    if (!profileExists(profile) || !validAuthStatus(profile, status)) continue;
    profiles[profile] = {
      state: status.state,
      checkedAt: status.checkedAt,
      detail: status.detail || '',
      fingerprint: status.fingerprint,
    };
  }
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const tmp = `${AUTH_STATUS_CACHE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), profiles }, null, 2), 'utf-8');
    fs.renameSync(tmp, AUTH_STATUS_CACHE_FILE);
  } catch {}
}

loadAuthStatusCache();

function accountRows() {
  const rows = listAccountProfiles().map(profile => {
    const exists = profileExists(profile);
    const email = findProfileEmail(profile);
    const token = readTokenMeta(profile);
    const stored = accountStatus.get(profile) || {};
    const cached = stored.state === 'checking' || validAuthStatus(profile, stored) ? stored : {};
    const job = loginJobs.get(profile) || {};
    let state = cached.state || (exists ? (token.cached ? 'cached' : 'unknown') : 'missing');
    let detail = cached.detail || '';
    if (job.state === 'login' || job.state === 'checking') {
      state = job.state;
      detail = job.detail || (job.state === 'login' ? '正在登录' : '正在检测登录态');
    }
    return {
      label: accountLabel(profile),
      profile,
      exists,
      addSlot: !exists,
      email: email.email,
      emailStatus: email.emailStatus,
      tokenCached: token.cached,
      tokenSavedAt: token.savedAt,
      state,
      detail,
      checkedAt: cached.checkedAt || '',
      authFresh: isAuthCheckFresh(profile, cached),
      nextAuthCheckAt: cached.checkedAt ? new Date(Date.parse(cached.checkedAt) + AUTH_CHECK_COOLDOWN_MS).toISOString() : '',
      loginJob: job.pid ? job : null,
    };
  });
  const emailCounts = new Map();
  for (const row of rows) {
    if (row.email) emailCounts.set(row.email, (emailCounts.get(row.email) || 0) + 1);
  }
  for (const row of rows) {
    row.duplicate = !!row.email && emailCounts.get(row.email) > 1;
    row.canDelete = row.exists && profileSlotIndex(row.profile) >= 0;
  }
  return rows;
}

function compactAuthError(message) {
  const s = String(message || '').replace(/\s+/g, ' ').trim();
  if (!s) return 'auth check failed';
  if (/ERR_TIMED_OUT|Timeout|timed out/i.test(s)) return '检测超时：网络或 AMDC 无响应';
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND/i.test(s)) return '检测失败：域名解析失败';
  if (/ECONNRESET|ECONNREFUSED|network/i.test(s)) return '检测失败：网络连接异常';
  if (/401|403|unauthorized|forbidden/i.test(s)) return '检测失败：登录态失效';
  return s.length > 160 ? s.slice(0, 157) + '...' : s;
}

function syncProfileMapKeys(map, moves, deletedProfile) {
  const deletedProfiles = Array.isArray(deletedProfile)
    ? deletedProfile
    : (deletedProfile ? [deletedProfile] : []);
  for (const deleted of deletedProfiles) map.delete(deleted);
  for (const [from, to] of Object.entries(moves)) {
    if (!map.has(from)) continue;
    map.set(to, map.get(from));
    map.delete(from);
  }
  const existing = new Set(DEFAULT_ACCOUNT_PROFILES.filter(profileExists));
  for (const key of Array.from(map.keys())) {
    if (profileSlotIndex(key) >= 0 && !existing.has(key)) map.delete(key);
  }
}

function removeProfilesAndCompact(profiles) {
  const uniqueProfiles = [...new Set((profiles || []).filter(isSafeProfile))]
    .filter(profile => profileSlotIndex(profile) >= 0 && profileExists(profile));
  if (!uniqueProfiles.length) return null;

  const projectRoot = path.resolve(PROJECT_DIR) + path.sep;
  for (const profile of uniqueProfiles) {
    const target = profilePath(profile);
    if (!target.startsWith(projectRoot)) throw new Error('账号目录超出项目范围');
    fs.rmSync(target, { recursive: true, force: true });
  }


  const moves = {};
  const remaining = DEFAULT_ACCOUNT_PROFILES.filter(profileExists);
  let nextSlot = 0;
  for (const from of remaining) {
    const to = profileSlotName(nextSlot++);
    if (from === to) continue;
    const fromPath = profilePath(from);
    const toPath = profilePath(to);
    if (fs.existsSync(toPath)) throw new Error(`目标账号目录已存在：${to}`);
    fs.renameSync(fromPath, toPath);
    moves[from] = to;
  }

  syncProfileMapKeys(accountStatus, moves, uniqueProfiles);
  syncProfileMapKeys(loginJobs, moves, uniqueProfiles);
  return {
    ok: true,
    deleted: uniqueProfiles[0],
    deletedProfiles: uniqueProfiles,
    moves,
    accounts: accountRows(),
  };
}

function removeProfileAndCompact(profile) {
  return removeProfilesAndCompact([profile]);
}

function deleteProfile(profile) {
  if (!isSafeProfile(profile)) return { ok: false, error: '账号目录无效', accounts: accountRows() };
  const slot = profileSlotIndex(profile);
  if (slot < 0) return { ok: false, error: '不支持的账号目录位置', accounts: accountRows() };
  if (activeRunJob() || isFreshProgressActive()) {
    return { ok: false, error: '采集正在运行，请停止或等待完成后再删除账号目录', accounts: accountRows() };
  }
  const busyLogin = Array.from(loginJobs.values()).some(job => job && (job.state === 'login' || job.state === 'checking'));
  if (busyLogin || authCheckAll) {
    return { ok: false, error: '账号登录或检测正在运行，请稍后再删除账号目录', accounts: accountRows() };
  }

  const rows = accountRows();
  const row = rows.find(r => r.profile === profile);
  if (!row || !row.exists) return { ok: false, error: '账号目录不存在', accounts: rows };

  return removeProfileAndCompact(profile);
}

function autoClearFailedLoginProfile(profile) {
  if (!isSafeProfile(profile) || !profileExists(profile)) return null;
  const slot = profileSlotIndex(profile);
  if (slot < 0) return null;
  if (activeRunJob() || isFreshProgressActive()) return null;
  return removeProfileAndCompact(profile);
}

function autoClearFailedTailProfiles() {
  if (activeRunJob() || isFreshProgressActive()) return null;
  const existing = [];
  for (const profile of DEFAULT_ACCOUNT_PROFILES) {
    if (!profileExists(profile)) break;
    existing.push({ profile, state: currentProfileState(profile) });
  }
  const firstNonOk = existing.findIndex(row => row.state !== 'ok');
  if (firstNonOk < 0) return null;
  const tail = existing.slice(firstNonOk);
  if (!tail.length || !tail.every(row => row.state === 'fail')) return null;
  return removeProfilesAndCompact(tail.map(row => row.profile));
}

function parseAuthCheckOutput(output, profiles) {
  const seen = new Set();
  const re = /^(OK|FAIL|UNKNOWN)\s+(.+)$/gm;
  let m;
  while ((m = re.exec(output))) {
    const state = m[1] === 'OK' ? 'ok' : (m[1] === 'FAIL' ? 'fail' : 'unknown');
    const profile = m[2].trim();
    if (!isSafeProfile(profile)) continue;
    seen.add(profile);
    accountStatus.set(profile, {
      state,
      checkedAt: new Date().toISOString(),
      detail: state === 'ok'
        ? '登录态检测通过'
        : (state === 'fail' ? '登录态检测失败' : '网络异常，保留本地登录态'),
      output: output.slice(-4000),
      fingerprint: authStatusFingerprint(profile),
    });
  }
  for (const profile of profiles) {
    if (!seen.has(profile) && profileExists(profile)) {
      accountStatus.set(profile, {
        state: 'fail',
        checkedAt: new Date().toISOString(),
        detail: '未获取到登录态检测结果',
        output: output.slice(-4000),
      });
    }
  }
}

function runAuthCheck(profileOrProfiles, options = {}) {
  const force = options.force !== false;
  const explicitProfiles = Array.isArray(profileOrProfiles);
  const profile = typeof profileOrProfiles === 'string' ? profileOrProfiles : '';
  const requestedProfiles = explicitProfiles
    ? [...new Set(profileOrProfiles.filter(isSafeProfile))].filter(profileExists).slice(0, MAX_ACCOUNT_PROFILES)
    : (profile ? [profile] : listAccountProfiles().filter(profileExists));
  const profiles = force ? requestedProfiles : requestedProfiles.filter(p => !isAuthCheckFresh(p, accountStatus.get(p)));
  if (!profiles.length) {
    return Promise.resolve({
      ok: !requestedProfiles.length || requestedProfiles.every(p => isAuthCheckFresh(p, accountStatus.get(p))),
      output: '',
      skipped: !force,
      accounts: accountRows(),
    });
  }
  if (!explicitProfiles && !profile && authCheckAll) return authCheckAll;
  for (const p of profiles) {
    if (!profileExists(p)) continue;
    accountStatus.set(p, { state: 'checking', checkedAt: new Date().toISOString(), detail: '正在检测登录态' });
  }
  const env = { ...process.env, AMDC_PROJECT_DIR: PROJECT_DIR, CHECK_AUTH: '1' };
  if (profile) env.AMDC_USERDATA_DIR = profile;
  if (explicitProfiles) env.AMDC_ACCOUNTS = profiles.join(',');
  const script = path.join(__dirname, 'amdc-weekly.js');
  const promise = new Promise(resolve => {
    cp.execFile(process.execPath, [script], {
      cwd: PROJECT_DIR,
      env,
      timeout: 180000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      const output = `${stdout || ''}${stderr || ''}`;
      parseAuthCheckOutput(output, profiles);
      if (error && !output.match(/^(OK|FAIL|UNKNOWN)\s+(.+)$/m)) {
        for (const p of profiles) {
          if (!profileExists(p)) continue;
          accountStatus.set(p, {
            state: 'fail',
            checkedAt: new Date().toISOString(),
            detail: compactAuthError(error.message || 'auth check failed'),
            output: output.slice(-4000),
            fingerprint: authStatusFingerprint(p),
          });
        }
      }
      let cleanup = null;
      try { cleanup = autoClearFailedTailProfiles(); } catch {}
      for (const p of profiles) {
        const status = accountStatus.get(p);
        if (status && (status.state === 'ok' || status.state === 'fail')) status.fingerprint = authStatusFingerprint(p);
      }
      saveAuthStatusCache();
      resolve({ ok: !error, output, accounts: accountRows(), cleanup });
    });
  }).finally(() => {
    if (!explicitProfiles && !profile) authCheckAll = null;
  });
  if (!explicitProfiles && !profile) authCheckAll = promise;
  return promise;
}

function normalizeAMDCLoginUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 8192) return { ok: false, error: '请粘贴有效的 AMDC 登录链接' };
  try {
    const target = new URL(raw);
    const host = target.hostname.toLowerCase();
    if (target.protocol !== 'https:' || (host !== 'appmagic.rocks' && !host.endsWith('.appmagic.rocks'))) {
      return { ok: false, error: '仅支持 https://appmagic.rocks 及其子域名的登录链接' };
    }
    return { ok: true, value: raw };
  } catch {
    return { ok: false, error: '登录链接格式不正确' };
  }
}

function writeDirectLogin(profile, email, token) {
  const root = profilePath(profile);
  fs.mkdirSync(root, { recursive: true });
  const savedAt = new Date().toISOString();
  fs.writeFileSync(path.join(root, TOKEN_CACHE_NAME), JSON.stringify({ token, savedAt }), 'utf-8');
  fs.writeFileSync(path.join(root, ACCOUNT_META_NAME), JSON.stringify({ email, savedAt }), 'utf-8');
}

function directLoginError(status, body) {
  const message = body && body.error && typeof body.error.message === 'string'
    ? body.error.message
    : (body && typeof body.message === 'string' ? body.message : '');
  if (message) return `AMDC 登录失败：${String(message).replace(/\s+/g, ' ').slice(0, 140)}`;
  return `AMDC 登录失败（HTTP ${status || 'unknown'}）`;
}

async function submitLoginLink(profile, value) {
  if (!isSafeProfile(profile) || !isManagedProfile(profile)) return { ok: false, error: '账号目录无效' };
  const parsed = normalizeAMDCLoginUrl(value);
  if (!parsed.ok) return parsed;
  const target = new URL(parsed.value);
  const code = target.searchParams.get('code') || '';
  const email = normalizeEmail(target.searchParams.get('email') || '');
  if (target.pathname.toLowerCase() !== '/login' || !code || !email) {
    return { ok: false, error: '这不是完整的 AMDC 邮件登录链接（缺少 code 或 email）' };
  }

  const previousJob = loginJobs.get(profile) || {};
  const startedAt = previousJob.startedAt || new Date().toISOString();
  loginJobs.set(profile, { ...previousJob, state: 'login', startedAt, detail: '正在直接交换 AMDC 登录 token' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch('https://appmagic.rocks/api/v2/auth/email', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Origin: 'https://appmagic.rocks',
        Referer: 'https://appmagic.rocks/login',
      },
      body: JSON.stringify({ code, email, lang: 'en' }),
      signal: controller.signal,
    });
    let body = {};
    try { body = await response.json(); } catch {}
    const token = body && typeof body.auth_key === 'string' ? body.auth_key.trim() : '';
    if (!response.ok || !token) throw new Error(directLoginError(response.status, body));

    writeDirectLogin(profile, email, token);
    const exchanged = { ...(loginJobs.get(profile) || previousJob), state: 'exchange_done', detail: '已获取 token，正在验证登录态' };
    loginJobs.set(profile, exchanged);
    await runAuthCheck(profile);
    const status = accountStatus.get(profile);
    if (!status || status.state !== 'ok') {
      const detail = status && status.detail ? status.detail : '登录 token 验证失败';
      loginJobs.set(profile, { ...exchanged, state: 'failed', finishedAt: new Date().toISOString(), detail });
      return { ok: false, error: detail, profile };
    }
    loginJobs.set(profile, { ...exchanged, state: 'done', finishedAt: new Date().toISOString(), checkedAt: new Date().toISOString(), detail: '登录成功' });
    return { ok: true, profile, state: 'done', detail: '登录成功' };
  } catch (error) {
    const detail = error && error.name === 'AbortError'
      ? 'AMDC 登录请求超时'
      : compactAuthError(error && error.message ? error.message : String(error));
    loginJobs.set(profile, { ...previousJob, state: 'failed', finishedAt: new Date().toISOString(), detail });
    accountStatus.set(profile, { state: 'fail', checkedAt: new Date().toISOString(), detail });
    return { ok: false, error: detail, profile };
  } finally {
    clearTimeout(timer);
  }
}

function activeRunJob() {
  if (!runJob) return null;
  if (runJob.state === 'queued' || runJob.state === 'starting' || runJob.state === 'running' || runJob.state === 'stopping') return runJob;
  return null;
}

function runChildCommand(command, args, env, onStdout, options = {}) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(command, args, { cwd: PROJECT_DIR, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (options.onSpawn) options.onSpawn(child);
    let stdout = '';
    let stderr = '';
    let pendingLine = '';
    child.stdout.on('data', chunk => {
      const text = String(chunk);
      stdout = (stdout + text).slice(-16000);
      pendingLine += text;
      const lines = pendingLine.split(/\r?\n/);
      pendingLine = lines.pop() || '';
      if (onStdout) lines.filter(Boolean).forEach(line => onStdout(line));
    });
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-16000); });
    child.on('error', reject);
    child.on('close', code => {
      // `exit` can fire before stdout is fully drained. Wait for `close` so the final JSON result is available.
      if (pendingLine.trim() && onStdout) onStdout(pendingLine);
      pendingLine = '';
      if (code === 0 || options.allowNonZero) resolve({ stdout, stderr, exitCode: code });
      else {
        const detail = (stderr || stdout || `${command} exited with ${code}`).trim().slice(-4000);
        const failure = new Error(detail || `${command} exited with ${code}`);
        failure.exitCode = code;
        failure.stdout = stdout;
        failure.stderr = stderr;
        reject(failure);
      }
    });
  });
}

function childFailureDetail(error, fallback = '同步程序未返回具体失败原因') {
  const stdout = String(error && error.stdout || '');
  const stderr = String(error && error.stderr || '');
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && (parsed.error || parsed.reason || parsed.message)) {
        const phase = parsed.phase ? `阶段：${parsed.phase}；` : '';
        return `${phase}${parsed.error || parsed.reason || parsed.message}`;
      }
    } catch {}
  }
  const detail = (stderr || stdout || error && error.message || '').trim();
  if (detail) return detail.slice(-4000);
  const code = error && error.exitCode != null ? `（退出码 ${error.exitCode}）` : '';
  return `${fallback}${code}`;
}

async function emitRunNotification(historyId, event, durationMs = 0) {
  const record = historyRecordById(historyId);
  if (!record) return { ok: false, error: 'history record not found' };
  const previous = record.notifications || {};
  const duration = Math.max(0, Number(durationMs) || 0);
  updateHistoryRecord(historyId, {
    notifications: { ...previous, [event]: { status: 'sending', startedAt: new Date().toISOString(), durationMs: duration } },
  });
  broadcast();
  const result = await runChildCommand('node', [
    path.join(__dirname, 'notify.js'), record.outputDir,
    '--event', event, '--config', CONFIG_FILE, '--duration-ms', String(duration),
  ], { ...process.env, AMDC_PROJECT_DIR: PROJECT_DIR }, null, { allowNonZero: true });
  const delivered = /\[notify\] ntfy 已发送:/.test(`${result.stdout}\n${result.stderr}`);
  const latest = historyRecordById(historyId);
  updateHistoryRecord(historyId, {
    notifications: {
      ...((latest && latest.notifications) || previous),
      [event]: {
        status: delivered ? 'sent' : 'failed', sentAt: new Date().toISOString(), durationMs: duration,
        error: delivered ? '' : `${result.stderr || result.stdout || 'ntfy 未确认投递成功'}`.slice(-1000),
      },
    },
  });
  broadcast();
  return { ok: delivered };
}

function stageDurationMs(startedAt) {
  const started = new Date(startedAt || 0).getTime();
  return Number.isFinite(started) && started > 0 ? Math.max(0, Date.now() - started) : 0;
}

function triggerScheduledAMDAUpdate(job, primary, batchId) {
  if (!job || !job.options || job.options.source !== 'scheduled') {
    return { ok: false, reason: '非定时批次' };
  }
  if (!primary || !primary.outputDir || !primary.weekAnchor || !fs.existsSync(AMDA_TRIGGER_SCRIPT)) {
    return { ok: false, reason: 'AMDA 触发脚本或采集历史目录不存在' };
  }
  const psCommand = powershellCommand();
  const scriptPath = pathForPowerShell(psCommand, AMDA_TRIGGER_SCRIPT);
  const args = [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath,
    '-BatchId', String(batchId || ''),
    '-WeekAnchor', String(primary.weekAnchor),
    '-RunDir', pathForPowerShell(psCommand, primary.outputDir),
    '-AmdcProjectDir', pathForPowerShell(psCommand, PROJECT_DIR),
    '-AmdaProjectDir', pathForPowerShell(psCommand, AMDA_PROJECT_DIR),
    '-ConfigFile', pathForPowerShell(psCommand, CONFIG_FILE),
  ];
  const child = cp.spawn(psCommand, args, {
    cwd: PROJECT_DIR,
    env: { ...process.env, AMDC_PROJECT_DIR: PROJECT_DIR, AMDA_PROJECT_DIR },
    windowsHide: true,
    stdio: 'ignore',
  });
  child.once('error', error => {
    if (runJob && runJob.batchId === batchId) {
      appendBatchEvent(batchId, 'error', `AMDA 定时更新触发失败：${error.message || String(error)}`);
      broadcast();
    }
  });
  child.once('close', code => {
    if (code !== 0 && runJob && runJob.batchId === batchId) {
      appendBatchEvent(batchId, 'error', `AMDA 定时更新进程退出异常：${code == null ? '未知' : code}`);
      broadcast();
    }
  });
  return { ok: true };
}

function scheduleAutomatedCollectionFinalizeRetry(batchId, retryAttempt) {
  if (!runJob || runJob.batchId !== batchId || runJob.state !== 'done' || runJob.autoFinalizeStarted || runJob.autoFinalizeRetryScheduled || runJob.autoFinalizeRetryExhausted || !runJob.options || !runJob.options.autoSync) return;
  if (retryAttempt >= AUTOMATED_FINALIZE_MAX_RETRIES) {
    runJob = {
      ...runJob,
      autoFinalizeRetryExhausted: true,
      autoFinalizeRetryScheduled: false,
      autoFinalizeRetryAt: '',
      autoFinalizeRetryAttempt: retryAttempt,
      detail: '采集完成，但历史记录未及时落盘，未开始自动飞书同步，请检查 AMDC 日志',
    };
    broadcast();
    return;
  }
  const nextAttempt = retryAttempt + 1;
  const retryAt = new Date(Date.now() + AUTOMATED_FINALIZE_RETRY_DELAY_MS).toISOString();
  runJob = {
    ...runJob,
    autoFinalizeRetryScheduled: true,
    autoFinalizeRetryAt: retryAt,
    autoFinalizeRetryAttempt: nextAttempt,
    detail: `采集完成，等待历史记录落盘后自动同步（第 ${nextAttempt}/${AUTOMATED_FINALIZE_MAX_RETRIES} 次检查）`,
  };
  const timer = setTimeout(() => {
    if (!runJob || runJob.batchId !== batchId || runJob.state !== 'done' || runJob.autoFinalizeStarted || !runJob.options || !runJob.options.autoSync || runJob.autoFinalizeRetryAt !== retryAt) return;
    runJob = { ...runJob, autoFinalizeRetryScheduled: false, autoFinalizeRetryAt: '' };
    void finishAutomatedCollection(batchId, nextAttempt).catch(error => {
      if (runJob && runJob.batchId === batchId) {
        runJob = { ...runJob, autoFinalizeInFlight: false, detail: `自动飞书同步异常：${error && error.message ? error.message : String(error)}` };
        broadcast();
      }
    });
  }, AUTOMATED_FINALIZE_RETRY_DELAY_MS);
  if (timer.unref) timer.unref();
  broadcast();
}

async function finishAutomatedCollection(batchId, retryAttempt = 0) {
  if (!runJob || runJob.batchId !== batchId || runJob.state !== 'done' || runJob.autoFinalizeStarted || runJob.autoFinalizeRetryScheduled || runJob.autoFinalizeRetryExhausted || !runJob.options || !runJob.options.autoSync) return;
  const job = runJob;
  const children = job.children || [];
  const records = children.map(child => historyRecordById(child.historyId)).filter(record => record && record.status === 'done');
  if (!children.length || records.length !== children.length) {
    scheduleAutomatedCollectionFinalizeRetry(batchId, retryAttempt);
    return;
  }
  // 只有全部历史记录都已落盘后才抢占自动收尾锁；否则后续重试会被旧的
  // autoFinalizeStarted 状态挡住，导致定时任务永远跳过飞书同步和 AMDA。
  runJob = {
    ...job,
    autoFinalizeStarted: true,
    autoFinalizeInFlight: true,
    autoFinalizeRetryScheduled: false,
    autoFinalizeRetryAt: '',
    detail: '采集完成，正在自动同步飞书',
  };
  const primary = records[0];
  let allSynced = true;
  if (job.options.notifyStages) await emitRunNotification(primary.id, 'collection_complete', stageDurationMs(job.startedAt));
  for (const record of records) {
    const syncStartedAt = new Date().toISOString();
    if (job.options.notifyStages) await emitRunNotification(record.id, 'feishu_sync_started', 0);
    const synced = await syncHistoryToFeishu(record.id);
    if (!synced.ok) allSynced = false;
    if (job.options.notifyStages && synced.ok) await emitRunNotification(record.id, 'feishu_sync_complete', stageDurationMs(syncStartedAt));
    if (job.options.notifyStages && !synced.ok) await emitRunNotification(record.id, 'failure', stageDurationMs(syncStartedAt));
  }
  if (runJob && runJob.batchId === batchId) {
    let detail = allSynced ? '总任务完成，飞书自动同步已结束' : '飞书自动同步存在失败，未触发 AMDA 更新';
    if (allSynced && job.options.source === 'scheduled') {
      const amda = triggerScheduledAMDAUpdate(job, primary, batchId);
      detail = amda.ok
        ? '总任务完成，飞书自动同步已结束，已触发 AMDA 定时 Demo 更新'
        : `总任务完成，飞书自动同步已结束，未触发 AMDA：${amda.reason}`;
    }
    runJob = { ...runJob, autoFinalizeInFlight: false, detail };
    broadcast();
  }
}

function historyBatchSyncSnapshot() {
  if (!historyBatchSyncJob) return null;
  const recordMap = new Map(historyRecords().map(record => [record.id, record]));
  const items = historyBatchSyncJob.ids.map((id, index) => {
    const record = recordMap.get(id) || {};
    const sync = record.feishuSync || {};
    return {
      id,
      weekAnchor: record.weekAnchor || historyBatchSyncJob.weeks[index] || '',
      status: sync.status || 'queued',
      progress: sync.progress || 0,
      message: sync.message || '',
    };
  });
  const summary = aggregateBatchSyncProgress(items);
  const activeWeeks = items.filter(item => item.status === 'syncing').map(item => item.weekAnchor).filter(Boolean);
  const message = historyBatchSyncJob.status === 'stopping' || historyBatchSyncJob.status === 'rolling_back'
    ? (historyBatchSyncJob.message || '正在停止同步并恢复同步前状态')
    : (activeWeeks.length
      ? `已完成 ${summary.completed}/${summary.total}，正在同步 ${activeWeeks.join('、')}`
      : `已完成 ${summary.completed}/${summary.total}，正在准备后续任务`);
  return {
    id: historyBatchSyncJob.id,
    status: historyBatchSyncJob.status || 'syncing',
    startedAt: historyBatchSyncJob.startedAt,
    ids: historyBatchSyncJob.ids.slice(),
    weeks: historyBatchSyncJob.weeks.slice(),
    concurrency: historyBatchSyncJob.concurrency,
    ...summary,
    message,
  };
}

async function syncHistoryToFeishu(id, options = {}) {
  const record = historyRecordById(id);
  if (!record) return { ok: false, error: 'history record not found' };
  if (record.legacy || record.status !== 'done') return { ok: false, error: '仅已完成的采集记录可以同步到飞书' };
  const batchId = String(options.batchId || '');
  if (historyBatchSyncJob && (batchId !== historyBatchSyncJob.id || !historyBatchSyncJob.ids.includes(id))) {
    return { ok: false, error: '批量同步正在进行，请等待完成后再同步' };
  }
  if (historySyncJobs.has(id)) return { ok: false, error: '该记录正在同步到飞书' };
  if (historyTemporaryCleanupActive) return { ok: false, error: '正在清理飞书历史临时表格，请稍后再同步' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(record.weekAnchor || '')) return { ok: false, error: '采集周格式无效，无法匹配飞书工作表' };
  const outputDir = path.resolve(record.outputDir || '');
  const historyRoot = path.resolve(HISTORY_DIR) + path.sep;
  if (!outputDir.startsWith(historyRoot) || !fs.existsSync(outputDir)) return { ok: false, error: '历史数据目录无效' };

  const batchJob = batchId && historyBatchSyncJob && historyBatchSyncJob.id === batchId ? historyBatchSyncJob : null;
  if (batchJob && batchJob.cancelRequested) return { ok: false, stopped: true, error: '批量同步已请求停止', id, weekAnchor: record.weekAnchor };
  const syncJob = { startedAt: new Date().toISOString(), childProcesses: new Set() };
  historySyncJobs.set(id, syncJob);
  let rollback = batchJob && batchJob.backups.get(id);
  try {
    if (batchJob && !rollback) {
      rollback = { name: transactionBackupName(batchId, record), existed: false, originalIndex: -1, prepared: false };
      batchJob.backups.set(id, rollback);
      const prepared = await runHistoryTransaction(record, 'prepare', rollback, batchJob);
      rollback.existed = !!prepared.existed;
      rollback.originalIndex = Number.isFinite(Number(prepared.originalIndex)) ? Number(prepared.originalIndex) : -1;
      rollback.prepared = true;
      batchJob.preparedIds.add(id);
    }
    if (batchJob && batchJob.cancelRequested) throw new Error('批量同步已请求停止');
  } catch (error) {
    historySyncJobs.delete(id);
    return { ok: false, stopped: !!(batchJob && batchJob.cancelRequested), error: error && error.message ? error.message : String(error), id, weekAnchor: record.weekAnchor };
  }

  const compactWeek = record.weekAnchor.replace(/-/g, '');
  const xlsx = path.join(outputDir, `AMDC-${compactWeek}.xlsx`);
  let syncPhase = '初始化';
  const env = {
    ...process.env,
    AMDC_PROJECT_DIR: PROJECT_DIR,
    AMDC_RUN_DIR: outputDir,
    WEEK_ANCHOR: record.weekAnchor,
    AMDC_MERGED_XLSX: xlsx,
  };
  const setSyncProgress = (progress, message) => {
    const latest = historyRecordById(id);
    updateHistoryRecord(id, {
      feishuSync: {
        ...(latest && latest.feishuSync ? latest.feishuSync : {}),
        status: 'syncing', startedAt: latest && latest.feishuSync && latest.feishuSync.startedAt || new Date().toISOString(), week: compactWeek,
        batchId: batchId || undefined,
        progress: Math.max(0, Math.min(100, Number(progress) || 0)), message: String(message || ''),
      },
    });
    broadcast();
  };
  setSyncProgress(3, '正在生成 Excel')
  broadcast();
  try {
    syncPhase = '生成 Excel';
    await runChildCommand('python', [path.join(__dirname, 'amdc_xlsx_merged.py')], env, null, {
      onSpawn: child => syncJob.childProcesses.add(child),
    });
    if (batchJob && batchJob.cancelRequested) throw new Error('批量同步已请求停止');
    setSyncProgress(8, 'Excel 已生成，正在同步到飞书')
    syncPhase = '写入并校验飞书工作表';
    let duplicateSkipObserved = false;
    const result = await runChildCommand('python', [
      path.join(__dirname, 'amdc_feishu_sync.py'), '--xlsx', xlsx, '--week', record.weekAnchor,
    ], env, line => {
      try {
        const event = JSON.parse(line);
        if (event.event === 'progress') {
          if (Number(event.percent) === 100 && /标题和本周排名.*重复.*跳过同步/.test(String(event.message || ''))) {
            duplicateSkipObserved = true;
          }
          setSyncProgress(event.percent, event.message);
        }
      } catch {}
    }, { allowNonZero: true, onSpawn: child => syncJob.childProcesses.add(child) });
    if (batchJob && batchJob.cancelRequested) throw new Error('批量同步已请求停止');
    const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
    let syncResult = {};
    try { syncResult = JSON.parse(lines[lines.length - 1] || '{}'); } catch {}
    const duplicateSkip = duplicateSkipObserved || syncResult.skipped === true
      || /标题(?:列)?和本周排名.*重复/.test(String(syncResult.skipReason || syncResult.error || ''));
    if (!syncResult.ok && !duplicateSkip) {
      const detail = syncResult.error || syncResult.reason || syncResult.message;
      throw new Error(detail ? `阶段：${syncPhase}；${detail}` : `阶段：${syncPhase}；同步程序返回失败但未提供原因`);
    }
    const latest = historyRecordById(id);
    const feishuSync = {
      ...(latest && latest.feishuSync ? latest.feishuSync : {}),
      status: 'done', syncedAt: new Date().toISOString(), week: compactWeek,
      sheetId: syncResult.sheetId || '', sheetName: syncResult.sheetName || compactWeek,
      rows: syncResult.rows || 0, columns: syncResult.columns || 0,
      skipped: duplicateSkip,
      progress: 100, message: duplicateSkip ? '标题和本周排名完全重复，已跳过同步' : '同步完成',
    };
    updateHistoryRecord(id, { feishuSync });
    return { ok: true, feishuSync, record: historyRecordById(id) };
  } catch (error) {
    const detail = childFailureDetail(error, `阶段：${syncPhase}；同步失败`);
    const latest = historyRecordById(id);
    updateHistoryRecord(id, { feishuSync: {
      ...(latest && latest.feishuSync ? latest.feishuSync : {}),
      status: batchJob && batchJob.cancelRequested ? 'stopped' : 'failed', failedAt: new Date().toISOString(), week: compactWeek,
      progress: 100, message: batchJob && batchJob.cancelRequested ? '等待回滚' : '同步失败', error: detail.slice(-1000),
    } });
    return { ok: false, stopped: !!(batchJob && batchJob.cancelRequested), error: `飞书同步失败：${detail.slice(-1000)}`, record: historyRecordById(id), id, weekAnchor: record.weekAnchor };
  } finally {
    historySyncJobs.delete(id);
    broadcast();
  }
}

async function rollbackBatchSync(job) {
  const errors = [];
  const prepared = [...job.preparedIds];
  for (const id of prepared) {
    const record = job.records.get(id);
    const backup = job.backups.get(id);
    if (!record || !backup || !backup.prepared) continue;
    try {
      await runHistoryTransaction(record, 'rollback', backup, job);
    } catch (error) {
      errors.push(`${record.weekAnchor || id}：${error && error.message ? error.message : String(error)}`);
    }
  }
  for (const [id, raw] of job.preSyncRecords.entries()) {
    try {
      const current = rawHistoryRecordById(id);
      if (current) upsertHistoryRecord({ ...raw, outputDir: historyDirForId(id) });
    } catch (error) {
      errors.push(`${job.records.get(id) && job.records.get(id).weekAnchor || id}：本地同步状态恢复失败：${error && error.message ? error.message : String(error)}`);
    }
  }
  return errors;
}

function requestBatchSyncStop() {
  const job = historyBatchSyncJob;
  if (!job) return { ok: false, error: '当前没有正在进行的批量同步' };
  if (job.cancelRequested) return { ok: true, alreadyRequested: true, batchSync: historyBatchSyncSnapshot() };
  job.cancelRequested = true;
  job.status = 'stopping';
  job.message = '正在停止同步并恢复同步前状态';
  for (const syncJob of historySyncJobs.values()) {
    syncJob.cancelRequested = true;
    for (const child of syncJob.childProcesses || []) terminateChildProcess(child);
  }
  for (const child of job.childProcesses || []) terminateChildProcess(child);
  broadcast();
  return { ok: true, batchSync: historyBatchSyncSnapshot() };
}

async function syncHistoriesToFeishu(ids, concurrency = 2) {
  if (historyBatchSyncJob) return { ok: false, error: '已有批量同步任务正在进行' };
  if (historyTemporaryCleanupActive) return { ok: false, error: '正在清理飞书历史临时表格，请稍后再同步' };
  if (historySyncJobs.size) return { ok: false, error: '有历史记录正在同步，请等待完成后再批量同步' };
  const requested = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))];
  const records = requested.map(historyRecordById).filter(record => record && !record.legacy && record.status === 'done');
  const latestByWeek = new Map();
  for (const record of records) {
    const current = latestByWeek.get(record.weekAnchor);
    if (!current || String(record.startedAt || '').localeCompare(String(current.startedAt || '')) > 0) {
      latestByWeek.set(record.weekAnchor, record);
    }
  }
  const queue = [...latestByWeek.values()].sort((a, b) => String(b.weekAnchor).localeCompare(String(a.weekAnchor)));
  if (!queue.length) return {
    ok: false, requested: requested.length, valid: records.length, synced: 0, failed: 0,
    error: '没有找到可同步的已完成历史记录，请刷新历史记录后重新选择',
  };

  const results = new Array(queue.length);
  const workerCount = Math.max(1, Math.min(Number(concurrency) || 2, 2, queue.length));
  const batchId = `batch-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  historyBatchSyncJob = {
    id: batchId,
    ids: queue.map(record => record.id),
    weeks: queue.map(record => record.weekAnchor),
    concurrency: workerCount,
    startedAt: new Date().toISOString(),
    status: 'syncing',
    cancelRequested: false,
    childProcesses: new Set(),
    preparedIds: new Set(),
    backups: new Map(),
    records: new Map(queue.map(record => [record.id, record])),
    preSyncRecords: new Map(queue.map(record => [record.id, rawHistoryRecordById(record.id)])),
  };
  queue.forEach((record, index) => updateHistoryRecord(record.id, {
    feishuSync: {
      status: 'queued', progress: 0, message: '等待批量同步',
      startedAt: historyBatchSyncJob.startedAt, batchId, batchIndex: index + 1, batchTotal: queue.length,
    },
  }));
  broadcast();
  let next = 0;
  async function worker() {
    while (next < queue.length && !historyBatchSyncJob.cancelRequested) {
      const index = next++;
      const record = queue[index];
      results[index] = { id: record.id, weekAnchor: record.weekAnchor, ...(await syncHistoryToFeishu(record.id, { batchId })) };
    }
  }
  await Promise.all(Array.from({ length: workerCount }, worker));
  const stopped = !!historyBatchSyncJob.cancelRequested;
  let rollbackErrors = [];
  let cleanupErrors = [];
  let temporaryCleanupError = '';
  if (stopped) {
    historyBatchSyncJob.status = 'rolling_back';
    historyBatchSyncJob.message = '正在恢复同步前的工作表和本地状态';
    broadcast();
    rollbackErrors = await rollbackBatchSync(historyBatchSyncJob);
  } else {
    for (const id of historyBatchSyncJob.preparedIds) {
      const record = historyBatchSyncJob.records.get(id);
      const backup = historyBatchSyncJob.backups.get(id);
      if (!record || !backup || !backup.prepared) continue;
      try {
        await runHistoryTransaction(record, 'cleanup', backup, historyBatchSyncJob);
        backup.cleaned = true;
      } catch (error) {
        cleanupErrors.push(`${record.weekAnchor || id}：${error && error.message ? error.message : String(error)}`);
      }
    }
  }
  try {
    const temporaryCleanup = await cleanupHistoryTemporarySheets(historyBatchSyncJob);
    historyBatchSyncJob.temporarySheetsRemoved = Number(temporaryCleanup.removedCount) || 0;
  } catch (error) {
    temporaryCleanupError = error && error.message ? error.message : String(error);
  }
  const failed = results.filter(result => !result.ok);
  const cleanupIssues = [
    ...cleanupErrors.map(error => `备份清理失败：${error}`),
    ...(temporaryCleanupError ? [`临时表格清理失败：${temporaryCleanupError}`] : []),
  ];
  const finalBatchSync = {
    ...(historyBatchSyncSnapshot() || {}),
    status: stopped
      ? (rollbackErrors.length || cleanupIssues.length ? 'failed' : 'stopped')
      : (failed.length || cleanupIssues.length ? 'failed' : 'done'),
    progress: 100,
    completed: stopped ? results.filter(Boolean).length : results.length,
    failed: failed.length,
    temporarySheetsRemoved: historyBatchSyncJob.temporarySheetsRemoved || 0,
    message: stopped
      ? (rollbackErrors.length || cleanupIssues.length
        ? `已停止，但存在问题：${[...rollbackErrors.map(error => `回滚失败：${error}`), ...cleanupIssues].join('；')}`
        : '已停止，已恢复到同步前状态并确认无临时表格')
      : (failed.length || cleanupIssues.length
        ? `批量同步完成但存在问题：${[failed.length ? `失败 ${failed.length} 条` : '', ...cleanupIssues].filter(Boolean).join('；')}`
        : `批量同步完成：共 ${results.length} 条，已确认无临时表格`),
    finishedAt: new Date().toISOString(),
  };
  historyBatchSyncJob = null;
  broadcast();
  return {
    ok: failed.length === 0 && rollbackErrors.length === 0 && cleanupIssues.length === 0,
    requested: requested.length,
    synced: results.length - failed.length,
    failed: failed.length,
    concurrency: workerCount,
    results,
    batchSync: finalBatchSync,
    error: failed.length
      ? `${failed.length} 条记录同步失败`
      : (rollbackErrors.length || cleanupIssues.length ? [...rollbackErrors, ...cleanupIssues].join('；') : ''),
  };
}

function isFreshProgressActive() {
  const runDir = latestRunDir();
  const progress = readProgress(runDir);
  if (!progress || !progress.updatedAt) return false;
  const updatedAt = new Date(progress.updatedAt).getTime();
  if (!Number.isFinite(updatedAt)) return false;
  const fresh = (Date.now() - updatedAt) < 90 * 1000;
  const stage = String(progress.currentStage || '');
  const terminal = stage === 'done' || stage === 'stopped' || stage === 'failed' || stage === 'error';
  if (!fresh || terminal) return false;
  return (progress.activeCats || 0) > 0 || !!stage;
}

function latestPersistedBatchJob() {
  const records = historyRecords()
    .filter(record => record && record.startedAt)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  const latest = records[0];
  if (!latest || !latest.batchId) return null;
  const persistedState = readJsonSafe(path.join(HISTORY_DIR, 'batch-state', `${latest.batchId}.json`)) || {};
  const latestStartedAt = new Date(latest.startedAt || '').getTime();
  if (Number.isFinite(latestStartedAt) && latestStartedAt <= dashboardClearAt()) return null;

  const children = records
    .filter(record => record.batchId === latest.batchId)
    .sort((a, b) => String(b.weekAnchor || '').localeCompare(String(a.weekAnchor || '')))
    .map(record => ({
      historyId: record.id,
      weekAnchor: record.weekAnchor,
      state: record.status,
      detail: record.detail || (record.status === 'failed' ? '采集失败' : ''),
      exitCode: record.exitCode,
    }));
  const failed = children.some(child => child.state === 'failed');
  const stopped = children.some(child => child.state === 'stopped');
  const running = children.some(child => child.state === 'starting' || child.state === 'running' || child.state === 'queued');
  const finishedAt = records
    .filter(record => record.batchId === latest.batchId && record.finishedAt)
    .map(record => record.finishedAt)
    .sort()
    .pop() || '';

  return {
    batchId: latest.batchId,
    state: running ? 'running' : (failed ? 'failed' : (stopped ? 'stopped' : 'done')),
    startedAt: persistedState.startedAt || latest.startedAt,
    // 旧版取消竞态可能让 Worker 在历史记录停止后继续把批次状态写成 done。
    // 已停止批次必须以历史停止时间为准，不能把稍后的伪完成时间带回看板。
    finishedAt: stopped ? finishedAt : (persistedState.finishedAt || finishedAt),
    exitCode: failed ? 1 : 0,
    detail: running ? '批量采集中' : (failed ? '批量采集存在失败日期' : (stopped ? '批量采集已停止' : '批量采集完成')),
    persisted: true,
    children,
  };
}

function runSummary() {
  syncUnifiedBatchState();
  return {
    job: runJob || latestPersistedBatchJob(),
    active: !!activeRunJob() || isFreshProgressActive(),
    progressActive: isFreshProgressActive(),
  };
}

function readBatchEventFile(file) {
  if (!file) return [];
  try {
    return fs.readFileSync(file, 'utf-8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function syncUnifiedBatchState() {
  if (!runJob || !runJob.unified || !runJob.batchStateFile) return;
  const state = readJsonSafe(runJob.batchStateFile);
  if (!state || state.batchId !== runJob.batchId) return;
  const terminalStates = new Set(['stopped', 'failed', 'done']);
  const previousById = new Map((runJob.children || []).map(child => [child.historyId, child]));
  const children = (state.children || []).map(child => {
    const previous = previousById.get(child.historyId);
    // 停止时先由看板将子周置为终态；Worker 可能已被 taskkill，
    // 批次状态文件来不及落盘，不能再用其中的 running/queued 覆盖停止结果。
    if (runJob.stopRequested && previous && terminalStates.has(previous.state)) return previous;
    return { ...(previous || {}), ...child };
  });
  // 停止收尾或正常完成后，保留看板已经确定的终态；否则旧的 running
  // 批次状态文件会在轮询/SSE 时把 stopped 再次覆盖成 stopping。
  const syncedState = terminalStates.has(runJob.state)
    ? runJob.state
    : (terminalStates.has(state.state)
      ? state.state
      : (runJob.stopRequested ? 'stopping' : (state.state || runJob.state)));
  runJob = {
    ...runJob,
    state: syncedState,
    phase: state.phase || runJob.phase,
    applicationStartedAt: state.applicationStartedAt || runJob.applicationStartedAt || '',
    finishedAt: state.finishedAt || runJob.finishedAt || '',
    exitCode: state.exitCode == null ? runJob.exitCode : state.exitCode,
    detail: state.detail || runJob.detail,
    children,
  };
  for (const child of children) {
    const history = historyRecordById(child.historyId);
    if (!history) continue;
    const status = child.state === 'leaderboard_done' ? 'queued' : child.state;
    const patch = {
      status,
      detail: child.detail || history.detail,
      retryAttempt: child.attempts || history.retryAttempt || 1,
    };
    if (child.startedAt) patch.startedAt = child.startedAt;
    if (child.leaderboardConfirmedAt) patch.leaderboardConfirmedAt = child.leaderboardConfirmedAt;
    if (child.finishedAt) patch.finishedAt = child.finishedAt;
    if (child.exitCode != null) patch.exitCode = child.exitCode;
    if (child.state === 'done') patch.resultSummary = historyResultSummary(historyDirForId(child.historyId));
    updateHistoryRecord(child.historyId, patch);
    if (child.state === 'done') finalizeReplacedHistory(history);
    if (child.state === 'done' && runJob.options && runJob.options.notifyStages) {
      const latest = historyRecordById(child.historyId);
      if (!latest || !(latest.notifications && latest.notifications.week_complete)) {
        void emitRunNotification(child.historyId, 'week_complete', stageDurationMs(child.startedAt));
      }
    }
  }
  // 统一批次由 Worker 写入状态文件；自动飞书同步必须从这里接续，
  // 不能依赖仅用于本地子进程调度的 finishBatchIfComplete 回调。
  if (runJob.state === 'done' && runJob.options && runJob.options.autoSync && !runJob.autoFinalizeStarted && !runJob.autoFinalizeRetryScheduled && !runJob.autoFinalizeRetryExhausted) {
    void finishAutomatedCollection(runJob.batchId).catch(error => {
      if (runJob && runJob.batchId === state.batchId) {
        runJob = { ...runJob, autoFinalizeInFlight: false, detail: `自动飞书同步异常：${error && error.message ? error.message : String(error)}` };
        broadcast();
      }
    });
  }
}

function validateRunAccounts(profiles) {
  const rows = accountRows();
  const byProfile = new Map(rows.map(row => [row.profile, row]));
  const invalid = [];
  for (const profile of profiles) {
    const row = byProfile.get(profile);
    if (!row || !row.exists) {
      invalid.push({ profile, state: 'missing' });
    } else if (row.state !== 'ok') {
      invalid.push({ profile, label: row.label, state: row.state || 'unknown' });
    }
  }
  return { ok: invalid.length === 0, rows, invalid };
}

function collectionPowerShellArgs(opts) {
  const psCommand = powershellCommand();
  const psScript = pathForPowerShell(psCommand, path.join(__dirname, 'run_amdc_weekly.ps1'));
  const psProjectDir = pathForPowerShell(psCommand, PROJECT_DIR);
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psScript, '-ProjectDir', psProjectDir];
  if (opts.weekAnchor) args.push('-WeekAnchor', opts.weekAnchor);
  if (opts.fresh) args.push('-Fresh');
  if (opts.listOnly) args.push('-ListOnly');
  if (opts.missingCountriesOnly) args.push('-MissingCountriesOnly');
  if (opts.skipExcel) args.push('-SkipExcel');
  args.push('-SkipFeishuSync', '-SkipNotifications');
  return { psCommand, args };
}

function spawnCollectionProcess(opts, history, profiles, primaryProfile) {
  const command = collectionPowerShellArgs(opts);
  const env = {
    ...process.env,
    AMDC_PROJECT_DIR: PROJECT_DIR,
    AMDC_RUN_DIR: history.outputDir,
    AMDC_RUN_ID: history.id,
    AMDC_PORT: String(PORT),
    AMDC_NO_OPEN: '1',
    AMDC_SKIP_AUTH_CHECK: '1',
    AMDC_ACCOUNTS: profiles.join(','),
    AMDC_MAX_WORKERS: String(Math.max(1, Math.min(MAX_ACCOUNT_PROFILES, profiles.length))),
    TOP_DEPTH: String(opts.topDepth),
    AMDC_CATEGORIES: JSON.stringify(opts.categories),
    MISSING_COUNTRY_ONLY: opts.missingCountriesOnly ? '1' : '',
  };
  if (history.batchId) {
    env.AMDC_BATCH_CHILD = '1';
    env.AMDC_BATCH_ID = history.batchId;
    env.AMDC_BATCH_PHASE = opts.listOnly ? 'leaderboard' : 'application';
    env.AMDC_BATCH_PREFLIGHT_FILE = path.join(HISTORY_DIR, 'batch-preflight', `${history.batchId}.json`);
  }
  if (opts.batchManifest) {
    env.AMDC_BATCH_MANIFEST = JSON.stringify(opts.batchManifest);
    env.AMDC_BATCH_STATE_FILE = opts.batchStateFile;
    env.AMDC_BATCH_EVENT_FILE = opts.batchEventFile;
    env.AMDC_BATCH_STARTED_AT = opts.batchStartedAt || '';
  }
  if (primaryProfile) env.AMDC_USERDATA_DIR = primaryProfile;
  const logFile = path.join(history.outputDir, 'collection.log');
  const logFd = fs.openSync(logFile, 'a');
  const child = cp.spawn(command.psCommand, command.args, { cwd: PROJECT_DIR, env, windowsHide: true, stdio: ['ignore', logFd, logFd] });
  child.amdcLogFd = logFd;
  child.amdcLogFile = logFile;
  return child;
}

function closeCollectionLog(child) {
  if (!child || child.amdcLogFd == null) return;
  try { fs.closeSync(child.amdcLogFd); } catch {}
  child.amdcLogFd = null;
}

function collectionFailureDetail(child, fallback = '采集失败') {
  try {
    const text = fs.readFileSync(child && child.amdcLogFile || '', 'utf-8').replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (!text) return fallback;
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const meaningful = lines.filter(line => {
      if (/^at\s|CategoryInfo|FullyQualifiedErrorId|\+\s|~~~~|所在位置|����λ��/i.test(line)) return false;
      if (/^(if|throw|const|let|var)\b/i.test(line)) return false;
      if (/^AMDC scrape failed$/i.test(line)) return false;
      return /Fatal:|Error:|失败|错误|invalid|must\s|unavailable|No valid|登录态|榜单|品类/i.test(line);
    });
    const selected = meaningful.length ? meaningful.slice(-2) : lines.slice(-4);
    const detail = selected.join(' | ').slice(-600) || fallback;
    if (/AMDC_CATEGORIES must select at least one category/i.test(detail)) return '采集品类配置传递失败';
    if (/No valid account token/i.test(detail)) return '没有可用的 AMDC 登录账号，请在设置中重新登录';
    return detail;
  } catch {
    return fallback;
  }
}

function missingCountryApps(historyId) {
  const dir = historyDirForId(historyId);
  if (!dir) return [];
  const apps = [];
  try {
    for (const file of fs.readdirSync(dir)) {
      if (!/^amdc-.+-weekly\.json$/i.test(file)) continue;
      const data = readJsonSafe(path.join(dir, file));
      const category = data && data.category && data.category.label || file;
      for (const app of (data && data.focus) || []) {
        if (app && !app.country) apps.push({ category, rank: app.rank, name: app.name || '' });
      }
    }
  } catch {}
  return apps.sort((a, b) => String(a.category).localeCompare(String(b.category)) || (Number(a.rank) || 0) - (Number(b.rank) || 0));
}

function retryExhaustedDetail(detail, attempts) {
  const retries = Math.max(0, attempts - 1);
  return `${detail}；自动重试耗尽（已重试 ${retries} 次，共 ${attempts}/${BATCH_MAX_ATTEMPTS} 次执行），请手工处理`;
}

function batchExecutionLabel(label, attempts) {
  const retryNumber = Math.max(0, Number(attempts) - 1);
  const retryLimit = Math.max(0, BATCH_MAX_ATTEMPTS - 1);
  return retryNumber > 0 ? `${label}（第 ${retryNumber}/${retryLimit} 次重试）` : label;
}

function scheduleBatchRetry(batchId, index, childInfo, history, detail, retryKind = '') {
  if (!runJob || runJob.batchId !== batchId || runJob.stopRequested) return false;
  const attempts = Math.max(1, Number(childInfo.attempts) || 1);
  if (attempts >= BATCH_MAX_ATTEMPTS) return false;
  const nextAttempt = attempts + 1;
  const delayMs = Math.min(10 * 60_000, BATCH_RETRY_DELAY_MS * (2 ** (attempts - 1)));
  const retryAt = new Date(Date.now() + delayMs).toISOString();
  const retryLabel = retryKind === 'missing-country' ? '自动补采缺失国别数据' : '自动重试';
  const retryNumber = nextAttempt - 1;
  const retryLimit = Math.max(0, BATCH_MAX_ATTEMPTS - 1);
  const retryDetail = `${detail}；将在 ${Math.ceil(delayMs / 1000)} 秒后${retryLabel}（第 ${retryNumber}/${retryLimit} 次重试）`;
  const queuedChild = {
    ...childInfo,
    state: 'queued',
    retryAt,
    lastError: detail,
    retryKind,
    finishedAt: '',
    exitCode: null,
    detail: retryDetail,
  };
  runJob.children[index] = queuedChild;
  appendBatchEvent(batchId, 'warn', retryDetail, {
    weekAnchor: childInfo.weekAnchor,
    attempts: nextAttempt,
    retryKind: retryKind || 'run',
  });
  updateHistoryRecord(history.id, {
    status: 'queued',
    finishedAt: '',
    exitCode: null,
    detail: retryDetail,
    retryAttempt: nextAttempt,
    retryAt,
  });
  setTimeout(() => {
    if (!runJob || runJob.batchId !== batchId || runJob.stopRequested) return;
    const current = runJob.children[index];
    if (!current || current.historyId !== history.id || current.state !== 'queued' || current.retryAt !== retryAt) return;
    const startLabel = retryKind === 'missing-country' ? '开始补采缺失国别数据' : '开始自动重试';
    const retryStartDetail = `${startLabel}（第 ${retryNumber}/${retryLimit} 次重试）`;
    runJob.children[index] = { ...current, retryAt: '', detail: retryStartDetail };
    appendBatchEvent(batchId, 'info', retryStartDetail, {
      weekAnchor: current.weekAnchor,
      attempts: nextAttempt,
      retryKind: retryKind || 'run',
    });
    updateHistoryRecord(history.id, { status: 'queued', retryAt: '', detail: retryStartDetail });
    launchNextBatchChild(batchId);
  }, delayMs);
  broadcast();
  return true;
}

function finishBatchIfComplete(batchId) {
  if (!runJob || runJob.batchId !== batchId) return;
  const children = runJob.children || [];
  const active = children.some(child => child.state === 'starting' || child.state === 'running');
  const queued = children.some(child => child.state === 'queued');
  if (active || queued) return;
  const stopped = !!runJob.stopRequested;
  // 即使采集子进程异常地以 0 退出，也必须以国别完成度作为应用阶段的最终门槛。
  // 缺国别现在已经在采集端核验商店链接；若仍未形成可判定状态，直接失败并交由人工处理，
  // 不再自动重试该周。
  if (!stopped && runJob.phase === 'application') {
    for (let index = 0; index < children.length; index++) {
      const childInfo = runJob.children[index];
      if (!childInfo || childInfo.state !== 'done') continue;
      const progress = readProgress(historyDirForId(childInfo.historyId));
      const countryTotal = Math.max(0, Number(progress && progress.countryTotal) || 0);
      const countryDone = Math.max(0, Number(progress && progress.countryDone) || 0);
      const countryRemaining = Math.max(0, countryTotal - countryDone);
      if (!countryRemaining) continue;
      const detail = `国别数据采集未完成：${countryDone}/${countryTotal}，缺少 ${countryRemaining} 个重点应用`;
      const incompleteChild = {
        ...childInfo,
        state: 'failed',
        finishedAt: new Date().toISOString(),
        exitCode: 1,
        detail: `${detail}；商店链接核验未完成，未自动重试，请手工处理`,
        missingApps: missingCountryApps(childInfo.historyId),
      };
      runJob.children[index] = incompleteChild;
      updateHistoryRecord(childInfo.historyId, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        exitCode: 1,
        detail: incompleteChild.detail,
      });
    }
  }
  const failed = (runJob.children || []).some(child => child.state === 'failed');
  runJob = {
    ...runJob,
    state: stopped ? 'stopped' : (failed ? 'failed' : 'done'),
    finishedAt: new Date().toISOString(),
    exitCode: failed ? 1 : 0,
    detail: stopped ? '批量采集已停止' : (failed ? '批量采集失败，自动重试耗尽，请手工处理' : '总任务完成'),
  };
  if (!stopped && !failed && runJob.options && runJob.options.autoSync) {
    void finishAutomatedCollection(batchId).catch(error => {
      if (runJob && runJob.batchId === batchId) {
        runJob = { ...runJob, autoFinalizeInFlight: false, detail: `自动飞书同步异常：${error && error.message ? error.message : String(error)}` };
        broadcast();
      }
    });
  }
  broadcast();
}

function launchNextBatchChild(batchId) {
  if (!runJob || runJob.batchId !== batchId || runJob.stopRequested) return;
  const phase = runJob.phase || 'leaderboard';
  const phaseConcurrency = phase === 'leaderboard'
    ? runJob.plan.leaderboardConcurrency
    : runJob.plan.applicationConcurrency;
  const active = (runJob.children || []).filter(child => child.state === 'starting' || child.state === 'running').length;
  let available = Math.max(0, phaseConcurrency - active);
  while (available-- > 0) {
    const index = runJob.children.findIndex(child => child.state === 'queued' && (!child.retryAt || new Date(child.retryAt).getTime() <= Date.now()));
    if (index < 0) break;
    const childInfo = runJob.children[index];
    const history = historyRecordById(childInfo.historyId);
    if (!history) {
      runJob.children[index] = { ...childInfo, state: 'failed', detail: '历史记录不存在', finishedAt: new Date().toISOString() };
      continue;
    }
    const leaderboardPhase = phase === 'leaderboard';
    if (!leaderboardPhase && childInfo.retryKind === 'missing-country') {
      const detail = `${childInfo.lastError || childInfo.detail || '国别数据采集未完成'}；商店链接核验未完成，未自动重试，请手工处理`;
      runJob.children[index] = {
        ...childInfo,
        state: 'failed',
        finishedAt: new Date().toISOString(),
        exitCode: 1,
        detail,
      };
      updateHistoryRecord(history.id, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        exitCode: 1,
        detail,
      });
      continue;
    }
    const childOpts = {
      ...runJob.options,
      weekAnchor: childInfo.weekAnchor,
      weekAnchors: [childInfo.weekAnchor],
      // 榜单阶段强制全新确认；应用数据阶段只复用刚确认的榜单缓存。
      fresh: leaderboardPhase ? !!runJob.options.fresh : false,
      listOnly: leaderboardPhase,
      skipExcel: leaderboardPhase || !!runJob.options.skipExcel,
      missingCountriesOnly: !leaderboardPhase && childInfo.retryKind === 'missing-country',
    };
    // 周之间仍严格串行；进入应用数据阶段后，本周由完整账号池并行处理应用队列。
    const profiles = runJob.options.accounts.slice();
    let child;
    try {
      child = spawnCollectionProcess(childOpts, history, profiles, profiles[0] || '');
    } catch (error) {
      const detail = error && error.message ? error.message : String(error);
      const failedChild = { ...childInfo, attempts: Math.max(1, Number(childInfo.attempts) || 1), state: 'failed', detail, finishedAt: new Date().toISOString() };
      if (!scheduleBatchRetry(batchId, index, failedChild, history, detail)) {
        runJob.children[index] = { ...failedChild, detail: retryExhaustedDetail(detail, failedChild.attempts) };
        updateHistoryRecord(history.id, { status: 'failed', finishedAt: new Date().toISOString(), exitCode: -1, detail: runJob.children[index].detail });
      }
      continue;
    }
    const startedAt = new Date().toISOString();
    const phaseName = leaderboardPhase ? '榜单确认' : (childInfo.retryKind === 'missing-country' ? '补采缺失国别数据' : '应用数据采集');
    const attempts = Math.max(0, Number(childInfo.attempts) || 0) + 1;
    const executionDetail = batchExecutionLabel(phaseName, attempts);
    runJob.children[index] = { ...childInfo, attempts, retryAt: '', state: 'starting', phase, profiles, pid: child.pid, startedAt, detail: `正在启动${executionDetail}` };
    appendBatchEvent(batchId, 'info', `开始${executionDetail}`, {
      weekAnchor: childInfo.weekAnchor,
      attempts,
      phase,
    });
    updateHistoryRecord(history.id, { status: 'starting', startedAt, detail: `${executionDetail}（${profiles.length} 个账号）`, retryAttempt: attempts, retryAt: '' });
    batchChildProcesses.set(history.id, child);
    setTimeout(() => {
      if (!runJob || runJob.batchId !== batchId || runJob.phase !== phase) return;
      const current = runJob.children[index];
      if (current && current.historyId === history.id && current.state === 'starting') {
        runJob.children[index] = { ...current, state: 'running', detail: `${phaseName}中` };
        updateHistoryRecord(history.id, { status: 'running', detail: `${phaseName}中（${profiles.length} 个账号）` });
        broadcast();
      }
    }, 3000);
    const complete = (code, launchError) => {
      batchChildProcesses.delete(history.id);
      closeCollectionLog(child);
      if (!runJob || runJob.batchId !== batchId || runJob.phase !== phase) return;
      const current = runJob.children[index];
      if (!current || current.historyId !== history.id || (current.state !== 'starting' && current.state !== 'running')) return;
      const stopped = !!runJob.stopRequested;
      const ok = code === 0 && !launchError;
      const detail = stopped ? '批量采集已停止' : (ok ? (leaderboardPhase ? '榜单已确认，等待全部周完成' : '周任务完成') : ((launchError && launchError.message) || collectionFailureDetail(child)));
      const state = stopped ? 'stopped' : (ok ? (leaderboardPhase ? 'leaderboard_done' : 'done') : 'failed');
      const failedChild = {
        ...current,
        state,
        finishedAt: new Date().toISOString(),
        exitCode: code == null ? -1 : code,
        detail,
        missingApps: !ok && !leaderboardPhase ? missingCountryApps(history.id) : [],
      };
      appendBatchEvent(batchId, ok ? 'info' : 'error', detail, {
        weekAnchor: current.weekAnchor,
        attempts: current.attempts,
        phase,
      });
      const retryKind = !leaderboardPhase && /国别数据采集未完成/.test(detail) ? 'missing-country' : '';
      if (!stopped && !ok && !retryKind && scheduleBatchRetry(batchId, index, failedChild, history, detail, retryKind)) {
        // 失败周等待重试期间，必须立即继续启动后续已就绪周，不能被 retryAt 阻塞整批。
        launchNextBatchChild(batchId);
        return;
      }
      const finalDetail = !stopped && !ok
        ? (retryKind
          ? `${detail}；商店链接核验未完成，未自动重试，请手工处理`
          : retryExhaustedDetail(detail, failedChild.attempts))
        : detail;
      runJob.children[index] = { ...failedChild, detail: finalDetail };
      const restored = stopped && restoreReplacedHistory(history.id);
      if (restored) {
        // 取消新采集时恢复该周原有历史记录
      } else if (leaderboardPhase && ok) {
        updateHistoryRecord(history.id, { status: 'queued', detail, leaderboardConfirmedAt: new Date().toISOString() });
      } else {
        finishHistoryRecord({ historyId: history.id }, state, code == null ? -1 : code, finalDetail);
        if (ok && !leaderboardPhase) finalizeReplacedHistory(history);
        if (ok && !leaderboardPhase && runJob.options && runJob.options.notifyStages) {
          void emitRunNotification(history.id, 'week_complete', stageDurationMs(current.startedAt));
        }
      }
      if (!runJob.stopRequested) launchNextBatchChild(batchId);
      finishBatchIfComplete(batchId);
      broadcast();
    };
    child.once('close', code => complete(code, null));
    child.once('error', error => complete(-1, error));
  }

  const hasActive = runJob.children.some(child => child.state === 'starting' || child.state === 'running');
  const hasQueued = runJob.children.some(child => child.state === 'queued');
  if (hasActive || hasQueued || runJob.stopRequested) {
    broadcast();
    return;
  }
  if (phase === 'leaderboard') {
    const failed = runJob.children.some(child => child.state === 'failed' || child.state === 'stopped');
    if (failed) {
      for (const childInfo of runJob.children) {
        if (childInfo.state === 'failed' || childInfo.state === 'stopped') continue;
        updateHistoryRecord(childInfo.historyId, {
          status: 'failed',
          finishedAt: new Date().toISOString(),
          exitCode: -1,
          detail: '榜单已确认，但其他周榜单确认失败，未开始应用数据采集',
        });
      }
      runJob = { ...runJob, state: 'failed', finishedAt: new Date().toISOString(), exitCode: 1, detail: '榜单确认阶段存在失败，未开始应用数据采集' };
      broadcast();
      return;
    }
    const allLeaderboardsConfirmed = runJob.children.length > 0
      && runJob.children.every(child => child.state === 'leaderboard_done');
    if (!allLeaderboardsConfirmed) {
      runJob = {
        ...runJob,
        state: 'failed',
        finishedAt: new Date().toISOString(),
        exitCode: 1,
        detail: '榜单确认状态不完整，未开始应用数据采集',
      };
      broadcast();
      return;
    }
    appendBatchEvent(batchId, 'info', `全部 ${runJob.children.length} 个周榜单已确认，进入应用数据采集`, {
      phase: 'application',
      weekAnchor: runJob.children.map(child => child.weekAnchor).join('、'),
    });
    runJob = {
      ...runJob,
      phase: 'application',
      state: 'running',
      applicationStartedAt: new Date().toISOString(),
      detail: `全部 ${runJob.children.length} 个周榜单已确认，开始采集应用数据`,
      // 榜单确认和应用数据采集是两个独立阶段；应用阶段必须拥有完整的三次自动重试额度。
      children: runJob.children.map(child => ({
        ...child,
        state: 'queued',
        phase: 'application',
        attempts: 0,
        retryAt: '',
        lastError: '',
        retryKind: '',
        pid: null,
        startedAt: '',
        finishedAt: '',
        exitCode: null,
        detail: '榜单已确认，等待应用数据采集',
      })),
    };
    for (const childInfo of runJob.children) updateHistoryRecord(childInfo.historyId, {
      status: 'queued',
      exitCode: null,
      retryAttempt: 0,
      retryAt: '',
      detail: '榜单已确认，等待应用数据采集',
    });
    launchNextBatchChild(batchId);
    return;
  }
  finishBatchIfComplete(batchId);
  broadcast();
}

async function startBatchCollectionRun(opts, requestedAt) {
  const batchId = historyId();
  const plan = buildTwoPhaseWeekPlan(opts.weekAnchors, opts.accounts);
  const weeks = plan.weeks;
  const histories = weeks.map(weekAnchor => createHistoryRecord({
    ...opts,
    weekAnchor,
    batchId,
    batchWeeks: weeks,
    replacedHistoryIds: replacedHistoryIdsForWeek(weekAnchor),
  }));
  if (opts.notifyStages && histories.length) {
    await emitRunNotification(histories[0].id, 'auth_checked', opts.authDurationMs || 0);
    await emitRunNotification(histories[0].id, 'collection_started', 0);
  }
  const batchStateFile = path.join(HISTORY_DIR, 'batch-state', `${batchId}.json`);
  const batchEventFile = path.join(HISTORY_DIR, 'batch-events', `${batchId}.ndjson`);
  fs.mkdirSync(path.dirname(batchStateFile), { recursive: true });
  fs.mkdirSync(path.dirname(batchEventFile), { recursive: true });
  runJob = {
    batchId,
    unified: true,
    batchStateFile,
    batchEventFile,
    state: 'starting',
    startedAt: requestedAt || new Date().toISOString(),
    finishedAt: '',
    exitCode: null,
    phase: 'leaderboard',
    plan,
    detail: `两阶段采集：先按时间从近到远确认 ${weeks.length} 个周的榜单，再按相同顺序用 ${plan.accounts.length} 个账号采集应用数据`,
    options: opts,
    events: [{
      at: new Date().toISOString(),
      level: 'info',
      message: '任务初始化',
      batch: true,
      weekAnchor: weeks[0] || '',
    }],
    children: histories.map((history, index) => ({
      historyId: history.id,
      weekAnchor: weeks[index],
      state: 'queued',
      phase: 'leaderboard',
      detail: '等待榜单确认',
    })),
  };
  const manifest = {
    version: 1,
    batchId,
    skipExcel: !!opts.skipExcel,
    items: histories.map(history => ({
      historyId: history.id,
      weekAnchor: history.weekAnchor,
      outputDir: history.outputDir,
    })),
  };
  let child;
  try {
    child = spawnCollectionProcess({
      ...opts,
      weekAnchor: weeks[0],
      weekAnchors: weeks,
      listOnly: false,
      // Excel 由统一批次进程在每个周完成后分别导出。
      skipExcel: true,
      batchManifest: manifest,
      batchStateFile,
      batchEventFile,
      batchStartedAt: runJob.startedAt,
    }, histories[0], opts.accounts.slice(), opts.accounts[0] || '');
  } catch (error) {
    const detail = error && error.message ? error.message : String(error);
    runJob = { ...runJob, state: 'failed', finishedAt: new Date().toISOString(), exitCode: -1, detail };
    for (const history of histories) finishHistoryRecord({ historyId: history.id }, 'failed', -1, detail);
    return { ok: false, error: detail, run: runSummary(), accounts: accountRows() };
  }
  runChild = child;
  runJob = { ...runJob, pid: child.pid, state: 'starting', detail: '统一批次进程启动中' };
  for (const history of histories) batchChildProcesses.set(history.id, child);
  const monitor = setInterval(() => {
    if (!runJob || runJob.batchId !== batchId) {
      clearInterval(monitor);
      return;
    }
    syncUnifiedBatchState();
    broadcast();
    if (!activeRunJob()) clearInterval(monitor);
  }, 500);
  if (monitor.unref) monitor.unref();
  const complete = (code, launchError) => {
    clearInterval(monitor);
    closeCollectionLog(child);
    for (const history of histories) batchChildProcesses.delete(history.id);
    if (runChild && runChild.pid === child.pid) runChild = null;
    if (!runJob || runJob.batchId !== batchId) return;
    syncUnifiedBatchState();
    const stopped = !!runJob.stopRequested;
    if (stopped) {
      const stoppedAt = runJob.finishedAt || new Date().toISOString();
      runJob = { ...runJob, state: 'stopped', stopRequested: true, finishedAt: stoppedAt, exitCode: -1, detail: '批量采集已停止' };
      writeJsonAtomic(runJob.batchStateFile, stoppedBatchState({
        ...(readJsonSafe(runJob.batchStateFile) || {}),
        batchId,
        children: runJob.children || [],
      }, stoppedAt));
      for (const history of histories) {
        if (!restoreReplacedHistory(history.id)) finishHistoryRecord({ historyId: history.id }, 'stopped', -1, '批量采集已停止');
      }
    } else if (launchError || code !== 0 || runJob.state !== 'done') {
      const detail = (launchError && launchError.message) || runJob.detail || collectionFailureDetail(child, '统一批次采集失败');
      runJob = { ...runJob, state: 'failed', finishedAt: runJob.finishedAt || new Date().toISOString(), exitCode: code == null ? -1 : code, detail };
      for (const history of histories) {
        const current = historyRecordById(history.id);
        if (current && current.status !== 'done' && current.status !== 'failed') {
          finishHistoryRecord({ historyId: history.id }, 'failed', runJob.exitCode, detail);
        }
      }
    }
    broadcast();
  };
  child.once('close', code => complete(code, null));
  child.once('error', error => complete(-1, error));
  return { ok: true, run: runSummary(), accounts: accountRows() };
}

async function startCollectionRun(options = {}) {
  const requestedAt = new Date().toISOString();
  const current = activeRunJob();
  if (current) {
    return { ok: false, error: 'collection already running', run: runSummary() };
  }
  if (isFreshProgressActive()) {
    return { ok: false, error: 'progress indicates an active run', run: runSummary() };
  }
  if (options.weekAnchorsConfirmed !== true) {
    return { ok: false, error: '请先在采集周起始日日历中选择周一并点击确定', run: runSummary(), accounts: accountRows() };
  }

  const requestedWeeks = Array.isArray(options.weekAnchors) && options.weekAnchors.length
    ? [...new Set(options.weekAnchors.map(value => String(value || '').trim()))]
    : [String(options.weekAnchor || '').trim()];
  if (!requestedWeeks.length || requestedWeeks.some(value => !value)) {
    return { ok: false, error: '请先在日历中选择并确定至少一个采集周', run: runSummary(), accounts: accountRows() };
  }
  const validatedWeeks = [];
  for (const value of requestedWeeks) {
    const week = validateWeekAnchor(value);
    if (!week.ok) return { ok: false, error: week.error, run: runSummary(), accounts: accountRows() };
    validatedWeeks.push(week.value);
  }
  validatedWeeks.sort((a, b) => b.localeCompare(a));
  const topDepth = validateTopDepth(options.topDepth || process.env.TOP_DEPTH || '100');
  if (!topDepth.ok) return { ok: false, error: topDepth.error, run: runSummary(), accounts: accountRows() };
  const categories = validateCategories(options.categories);
  if (!categories.ok) return { ok: false, error: categories.error, run: runSummary(), accounts: accountRows() };
  const requestedAccounts = Array.isArray(options.accounts) ? [...new Set(options.accounts)] : [];
  const invalidProfiles = requestedAccounts.filter(profile => !isManagedProfile(profile));
  if (invalidProfiles.length) {
    return {
      ok: false,
      error: `不支持的账号目录：${invalidProfiles.join(', ')}`,
      run: runSummary(),
      accounts: accountRows(),
    };
  }

  const opts = {
    fresh: !!options.fresh,
    weekAnchor: validatedWeeks[0],
    weekAnchors: validatedWeeks,
    accounts: requestedAccounts.filter(profileExists).slice(0, MAX_ACCOUNT_PROFILES),
    listOnly: !!options.listOnly,
    skipExcel: !!options.skipExcel,
    topDepth: topDepth.value,
    categories: categories.value,
    source: options.source === 'scheduled' ? 'scheduled' : (options.source || 'manual'),
    triggeredAt: options.triggeredAt || requestedAt,
    autoSync: !!options.autoSync,
    notifyStages: !!options.notifyStages,
  };
  if (!opts.accounts.length) {
    return { ok: false, error: '至少需要一个已存在的账号目录', run: runSummary() };
  }

  // 页面刷新触发的全量后台检测若仍在运行，复用它，避免点击采集时重复启动探针。
  // 没有后台任务时允许复用冷却期内的结果；正式采集进程仍会校验实际使用的 token。
  const authStartedAt = new Date().toISOString();
  if (authCheckAll) await authCheckAll;
  else await runAuthCheck(opts.accounts, { force: false });
  opts.authDurationMs = stageDurationMs(authStartedAt);
  const auth = validateRunAccounts(opts.accounts);
  if (!auth.ok) {
    const names = auth.invalid.map(x => x.label || x.profile).join(', ');
    return {
      ok: false,
      error: `登录态检查未通过，未启动采集。请到设置里重新登录失效账号：${names || 'unknown'}`,
      accounts: auth.rows,
      invalidAccounts: auth.invalid,
      run: runSummary(),
    };
  }

  const afterAuthCurrent = activeRunJob();
  if (afterAuthCurrent) {
    return { ok: false, error: 'collection already running', run: runSummary() };
  }
  if (isFreshProgressActive()) {
    return { ok: false, error: 'progress indicates an active run', run: runSummary() };
  }

  // 正常采集无论单周还是多周都进入统一批次运行时，保证账号池、浏览器和 tags
  // 只初始化一次。显式“仅榜单”保留轻量单阶段入口。
  if (!opts.listOnly) return startBatchCollectionRun(opts, requestedAt);
  const history = createHistoryRecord(opts);
  runJob = {
    historyId: history.id,
    outputDir: history.outputDir,
    state: 'starting',
    pid: null,
    startedAt: requestedAt,
    finishedAt: '',
    exitCode: null,
    attempts: 0,
    retryAt: '',
    detail: '准备启动采集',
    options: opts,
  };

  function scheduleSingleRetry(detail, attempts) {
    if (!runJob || runJob.historyId !== history.id || runJob.stopRequested || attempts >= BATCH_MAX_ATTEMPTS) return false;
    const nextAttempt = attempts + 1;
    const delayMs = Math.min(10 * 60_000, BATCH_RETRY_DELAY_MS * (2 ** (attempts - 1)));
    const retryAt = new Date(Date.now() + delayMs).toISOString();
    const retryDetail = `${detail}；将在 ${Math.ceil(delayMs / 1000)} 秒后自动重试（第 ${nextAttempt}/${BATCH_MAX_ATTEMPTS} 次）`;
    runJob = {
      ...runJob,
      pid: null,
      state: 'queued',
      retryAt,
      lastError: detail,
      detail: retryDetail,
    };
    updateHistoryRecord(history.id, { status: 'queued', exitCode: null, retryAttempt: nextAttempt, retryAt, detail: retryDetail });
    setTimeout(() => {
      if (!runJob || runJob.historyId !== history.id || runJob.stopRequested || runJob.state !== 'queued' || runJob.retryAt !== retryAt) return;
      launchSingleAttempt();
    }, delayMs);
    broadcast();
    return true;
  }

  function finishSingleAttempt(child, code, launchError, attempts) {
    if (child) closeCollectionLog(child);
    if (!runJob || runJob.historyId !== history.id || (child && runJob.pid !== child.pid)) return;
    const stopped = !!runJob.stopRequested;
    const ok = code === 0 && !launchError;
    const failedDetail = launchError && launchError.message ? launchError.message : collectionFailureDetail(child);
    if (!stopped && !ok && scheduleSingleRetry(failedDetail, attempts)) {
      if (child && runChild && runChild.pid === child.pid) runChild = null;
      return;
    }
    const detail = stopped ? '采集已停止'
      : (ok ? '周任务完成' : `${failedDetail}；自动重试耗尽（已重试 ${Math.max(0, attempts - 1)} 次，共 ${attempts}/${BATCH_MAX_ATTEMPTS} 次执行）`);
    const state = stopped ? 'stopped' : (ok ? 'done' : 'failed');
    runJob = {
      ...runJob,
      pid: null,
      state,
      finishedAt: new Date().toISOString(),
      exitCode: code == null ? -1 : code,
      detail,
    };
    if (stopped && restoreReplacedHistory(runJob.historyId)) {
      // 取消新采集时删除临时记录，保留该周原有记录
    } else {
      finishHistoryRecord(runJob, state, code == null ? -1 : code, detail);
      if (stopped) markLatestProgressStopped();
      else if (ok) finalizeReplacedHistory(history);
    }
    if (child && runChild && runChild.pid === child.pid) runChild = null;
    broadcast();
  }

  function launchSingleAttempt() {
    if (!runJob || runJob.historyId !== history.id || runJob.stopRequested) return;
    const attempts = Math.max(0, Number(runJob.attempts) || 0) + 1;
    const startedAt = new Date().toISOString();
    runJob = { ...runJob, pid: null, attempts, retryAt: '', state: 'starting', startedAt, detail: `正在启动采集（第 ${attempts}/${BATCH_MAX_ATTEMPTS} 次）` };
    let child;
    try {
      child = spawnCollectionProcess(opts, history, opts.accounts);
    } catch (error) {
      finishSingleAttempt(null, -1, error, attempts);
      return;
    }
    runJob = { ...runJob, pid: child.pid };
    updateHistoryRecord(history.id, { status: 'starting', startedAt, detail: `采集（第 ${attempts}/${BATCH_MAX_ATTEMPTS} 次）`, retryAttempt: attempts, retryAt: '' });
    setTimeout(() => {
      if (runJob && runJob.pid === child.pid && runJob.state === 'starting') {
        runJob = { ...runJob, state: 'running', detail: `采集中（第 ${attempts}/${BATCH_MAX_ATTEMPTS} 次）` };
        updateHistoryRecord(history.id, { status: 'running', detail: `采集中（第 ${attempts}/${BATCH_MAX_ATTEMPTS} 次）` });
        broadcast();
      }
    }, 3000);
    let childLaunchError = null;
    child.once('error', error => {
      childLaunchError = error;
      finishSingleAttempt(child, -1, error, attempts);
    });
    child.once('close', code => finishSingleAttempt(child, code, childLaunchError, attempts));
    runChild = child;
    broadcast();
  }

  launchSingleAttempt();
  return { ok: true, run: runSummary(), accounts: accountRows() };
}

function markLatestProgressStopped() {
  const runDir = latestRunDir();
  const progress = readProgress(runDir);
  if (!runDir || !progress) return;
  try {
    fs.writeFileSync(path.join(runDir, 'amdc-progress.json'), JSON.stringify({
      ...progress,
      activeCats: 0,
      currentStage: 'stopped',
      stageLabel: '已停止',
      updatedAt: new Date().toISOString(),
    }, null, 2), 'utf-8');
  } catch {}
  broadcast();
}

function forceFinishStoppingRun(pid, detail = 'collection stopped') {
  if (!runJob || runJob.pid !== pid || runJob.state !== 'stopping') return;
  runJob = {
    ...runJob,
    state: 'stopped',
    finishedAt: new Date().toISOString(),
    exitCode: runJob.exitCode == null ? -1 : runJob.exitCode,
    detail,
  };
  const restored = restoreReplacedHistory(runJob.historyId);
  if (!restored) finishHistoryRecord(runJob, 'stopped', runJob.exitCode, detail);
  if (runChild && runChild.pid === pid) runChild = null;
  if (!restored) markLatestProgressStopped();
  broadcast();
}

function stopCollectionRun() {
  const current = activeRunJob();
  if (!current) {
    if (isFreshProgressActive()) {
      markLatestProgressStopped();
      return { ok: true, run: runSummary() };
    }
    return { ok: false, error: 'no active collection', run: runSummary() };
  }
  runJob = {
    ...runJob,
    state: 'stopping',
    stopRequested: true,
    detail: 'stopping collection',
  };
  if (current.unified) {
    const stoppedAt = new Date().toISOString();
    const stoppedEvent = {
      at: stoppedAt,
      level: 'warn',
      message: '批量采集已停止',
      batch: true,
      weekAnchor: (runJob.children || []).map(child => child.weekAnchor).filter(Boolean).join('、'),
    };
    const persisted = readJsonSafe(current.batchStateFile) || {
      version: 1,
      batchId: current.batchId,
      pid: current.pid,
      phase: current.phase,
      startedAt: current.startedAt,
      children: current.children || [],
    };
    const stoppedState = stoppedBatchState(persisted, stoppedAt);
    writeJsonAtomic(current.batchStateFile, stoppedState);
    appendPersistedBatchEvent(current.batchEventFile, stoppedEvent);
    appendBatchEvent(current.batchId, 'warn', '批量采集已停止', { weekAnchor: stoppedEvent.weekAnchor });
    runJob = {
      ...runJob,
      ...stoppedState,
      unified: true,
      batchStateFile: current.batchStateFile,
      batchEventFile: current.batchEventFile,
      options: current.options,
      plan: current.plan,
    };
    for (const childInfo of runJob.children || []) {
      if (childInfo.state === 'done') {
        const completed = rawHistoryRecordById(childInfo.historyId);
        if (completed) finalizeReplacedHistory(completed);
        continue;
      }
      if (childInfo.state === 'failed') continue;
      if (!restoreReplacedHistory(childInfo.historyId)) {
        finishHistoryRecord({ historyId: childInfo.historyId }, 'stopped', -1, '批量采集已停止');
      }
    }
    terminateProcessTree(runChild && runChild.pid === current.pid ? runChild : { pid: current.pid, kill() {} });
    setTimeout(() => {
      if (runChild && runChild.pid === current.pid) terminateProcessTree(runChild);
    }, 1000);
    broadcast();
    return { ok: true, run: runSummary() };
  }
  if (current.batchId) {
    for (let index = 0; index < runJob.children.length; index++) {
      const childInfo = runJob.children[index];
      if (childInfo.state === 'queued') {
        runJob.children[index] = { ...childInfo, state: 'stopped', finishedAt: new Date().toISOString(), detail: '批量采集已停止' };
        if (!restoreReplacedHistory(childInfo.historyId)) finishHistoryRecord({ historyId: childInfo.historyId }, 'stopped', -1, '批量采集已停止');
        continue;
      }
      if (childInfo.state !== 'starting' && childInfo.state !== 'running') continue;
      const child = batchChildProcesses.get(childInfo.historyId);
      try {
        if (child && process.platform === 'win32') cp.execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
        else if (child) child.kill('SIGTERM');
      } catch {}
    }
    setTimeout(() => {
      if (!runJob || runJob.batchId !== current.batchId || runJob.state !== 'stopping') return;
      runJob.children = runJob.children.map(childInfo => {
        if (childInfo.state !== 'starting' && childInfo.state !== 'running') return childInfo;
        if (!restoreReplacedHistory(childInfo.historyId)) finishHistoryRecord({ historyId: childInfo.historyId }, 'stopped', -1, '批量采集已停止');
        return { ...childInfo, state: 'stopped', finishedAt: new Date().toISOString(), detail: '批量采集已停止' };
      });
      finishBatchIfComplete(current.batchId);
    }, 8000);
    broadcast();
    return { ok: true, run: runSummary() };
  }
  const pid = current.pid;
  markLatestProgressStopped();
  if (runChild && runChild.pid === pid) {
    try {
      if (process.platform === 'win32') {
        cp.execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
      } else {
        runChild.kill('SIGTERM');
        setTimeout(() => {
          try { if (runChild && runChild.pid === pid) runChild.kill('SIGKILL'); } catch {}
        }, 5000);
      }
    } catch (error) {
      runJob = { ...runJob, state: 'failed', finishedAt: new Date().toISOString(), detail: error.message || 'failed to stop collection' };
      return { ok: false, error: runJob.detail, run: runSummary() };
    }
  } else {
    forceFinishStoppingRun(pid, 'collection stopped');
  }
  setTimeout(() => forceFinishStoppingRun(pid, 'collection stop forced'), 8000);
  broadcast();
  return { ok: true, run: runSummary() };
}

const PAGE = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="font-attribution" content="MiSans © Xiaomi Inc.; used under the MiSans Font License Agreement">
<title>AMTools 实时看板</title>
<link rel="license" href="/assets/fonts/MiSans-License.pdf">
<script>
  if (/\bEdg\//.test(navigator.userAgent)) document.documentElement.classList.add('edge-browser');
</script>
<style>
  @font-face {
    font-family: "MiSans";
    src: url("/assets/fonts/MiSans-Regular.woff2") format("woff2");
    font-style: normal;
    font-weight: 400;
    font-display: swap;
  }
  @font-face {
    font-family: "MiSans";
    src: url("/assets/fonts/MiSans-Medium.woff2") format("woff2");
    font-style: normal;
    font-weight: 500;
    font-display: swap;
  }
  @font-face {
    font-family: "MiSans";
    src: url("/assets/fonts/MiSans-Demibold.woff2") format("woff2");
    font-style: normal;
    font-weight: 600;
    font-display: swap;
  }
  @font-face {
    font-family: "MiSans";
    src: url("/assets/fonts/MiSans-Bold.woff2") format("woff2");
    font-style: normal;
    font-weight: 700;
    font-display: swap;
  }
  :root {
    --bg: #0b1020;
    --panel: rgba(14, 27, 44, 0.94);
    --panel-2: #122338;
    --line: rgba(129, 156, 190, 0.16);
    --line-2: rgba(142, 171, 207, 0.28);
    --text: #f1f5f9;
    --muted: #94a3b8;
    --blue: #4f8cff;
    --blue-t: #71a7ff;
    --cyan: #22d3ee;
    --violet: #53658d;
    --green: #34d399;
    --yellow: #fbbf24;
    --red: #fb7185;
    --glow-cyan: 0 0 8px rgba(34, 211, 238, 0.18);
    --shadow: 0 8px 24px rgba(0, 0, 0, 0.22);
    --font: "MiSans", "Microsoft YaHei UI", "Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI", "Microsoft YaHei", sans-serif;
    color-scheme: dark;
  }
  html[data-theme="light"] {
    color-scheme: light;
    --bg: #eef3f8;
    --panel: #ffffff;
    --panel-2: #f4f7fb;
    --line: rgba(50, 72, 100, 0.14);
    --line-2: rgba(50, 72, 100, 0.24);
    --text: #152033;
    --muted: #5f6f86;
    --blue: #2563eb;
    --blue-t: #3b82f6;
    --cyan: #0891b2;
    --violet: #68799a;
    --green: #15835d;
    --yellow: #a56c00;
    --red: #c2415a;
    --glow-cyan: 0 0 6px rgba(8, 145, 178, 0.14);
    --shadow: 0 4px 18px rgba(30, 50, 80, 0.08);
  }
  html[data-theme="light"] body {
    background:
      linear-gradient(180deg, #f2f6fa 0%, #e7edf4 100%);
  }
  html[data-theme="light"] .overlay { background: rgba(30,47,78,0.28); }
  html[data-theme="light"] #settingsPanel.modal-panel, html[data-theme="light"] .login-panel { background: #f8fafc; }
  html[data-theme="light"] select option { background: #fff; color: #17233b; }
  html[data-theme="light"] .chip { color: #244269; background: rgba(36,107,206,0.1); border-color: rgba(36,107,206,0.28); }
  html[data-theme="light"] .chip.ok { color: #14663d; background: rgba(21,153,87,0.1); border-color: rgba(21,153,87,0.28); }
  html[data-theme="light"] .chip.warn { color: #795500; background: rgba(178,122,0,0.1); border-color: rgba(178,122,0,0.28); }
  html[data-theme="light"] .chip.ghost { color: var(--muted); background: rgba(46,72,112,0.06); border-color: var(--line-2); }
  html[data-theme="light"] .chip.ghost b { color: var(--text); }
  html[data-theme="light"] .api-link, html[data-theme="light"] .tab { color: #31517d; background: rgba(36,107,206,0.08); border-color: rgba(36,107,206,0.24); }
  html[data-theme="light"] .tab.on { color: #173c70; background: linear-gradient(90deg, rgba(36,107,206,0.18), rgba(0,140,168,0.12)); border-color: rgba(36,107,206,0.42); }
  html[data-theme="light"] button.tool { color: #263b5e; background: rgba(46,72,112,0.07); border-color: var(--line-2); }
  html[data-theme="light"] button.tool.primary { color: #174984; background: rgba(36,107,206,0.14); border-color: rgba(36,107,206,0.36); }
  html[data-theme="light"] button.tool.danger { color: #9b3342; background: rgba(197,61,77,0.08); border-color: rgba(197,61,77,0.28); }
  html[data-theme="light"] .badge.done { color: #14663d; }
  html[data-theme="light"] .badge.run { color: #244f8b; }
  html[data-theme="light"] .badge.err { color: #9b3342; }
  html[data-theme="light"] .badge.warn { color: #795500; }
  html[data-theme="light"] .cat-chip { color: #354e76; }
  html[data-theme="light"] a, html[data-theme="light"] a.cat-link { color: #245caa; }
  html[data-theme="light"] .event .d { color: #64748b; }
  html[data-theme="light"] .event .kv-mini span { background: rgba(46,72,112,0.05); border-color: rgba(46,72,112,0.14); }
  html[data-theme="light"] tbody tr:hover td { background: rgba(36,107,206,0.07); }
  html[data-theme="light"] .account-name { color: #00758d; }
  html[data-theme="light"] .kv { background: #f0f5fa; border-color: rgba(40,58,82,0.18); }
  html[data-theme="light"] thead th { color: #34465f; }
  html[data-theme="light"] .empty-hero .t1 { color: #263952; }
  html[data-theme="light"] .panel, html[data-theme="light"] .kpis, html[data-theme="light"] .topbar { backdrop-filter: none; }
  html[data-theme="light"] th, html[data-theme="light"] td { border-bottom-color: rgba(43,91,139,0.12); }
  html[data-theme="light"] input, html[data-theme="light"] select { background: #f7f9fc; }
  @media (prefers-color-scheme: light) {
    html:not([data-theme="dark"]) {
      color-scheme: light;
      --bg: #eef3f8;
      --panel: #ffffff;
      --panel-2: #f4f7fb;
      --line: rgba(50, 72, 100, 0.14);
      --line-2: rgba(50, 72, 100, 0.24);
      --text: #152033;
      --muted: #5f6f86;
      --blue: #2563eb;
      --blue-t: #3b82f6;
      --cyan: #0891b2;
      --green: #15835d;
      --yellow: #a56c00;
      --red: #c2415a;
      --shadow: 0 4px 18px rgba(30, 50, 80, 0.08);
    }
    html:not([data-theme="dark"]) body {
      background: linear-gradient(180deg, #f2f6fa 0%, #e7edf4 100%);
    }
    html:not([data-theme="dark"]) .overlay { background: rgba(30,47,78,0.28); }
    html:not([data-theme="dark"]) #settingsPanel.modal-panel, html:not([data-theme="dark"]) .login-panel { background: #f7fafc; }
    html:not([data-theme="dark"]) select option { background: #fff; color: #17233b; }
    html:not([data-theme="dark"]) .chip { color: #244269; background: rgba(36,107,206,0.1); border-color: rgba(36,107,206,0.28); }
    html:not([data-theme="dark"]) .chip.ok { color: #14663d; }
    html:not([data-theme="dark"]) .chip.warn { color: #795500; }
    html:not([data-theme="dark"]) .chip.ghost { color: var(--muted); background: rgba(46,72,112,0.06); }
    html:not([data-theme="dark"]) .chip.ghost b { color: var(--text); }
    html:not([data-theme="dark"]) button.tool { color: #263b5e; background: rgba(46,72,112,0.07); border-color: var(--line-2); }
    html:not([data-theme="dark"]) button.tool.danger { color: #9b3342; }
    html:not([data-theme="dark"]) .kv { background: #f0f5fa; border-color: rgba(40,58,82,0.18); }
    html:not([data-theme="dark"]) thead th { color: #34465f; }
    html:not([data-theme="dark"]) .empty-hero .t1 { color: #263952; }
    html:not([data-theme="dark"]) .panel, html:not([data-theme="dark"]) .kpis, html:not([data-theme="dark"]) .topbar { backdrop-filter: none; }
    html:not([data-theme="dark"]) th, html:not([data-theme="dark"]) td { border-bottom-color: rgba(43,91,139,0.12); }
    html:not([data-theme="dark"]) input, html:not([data-theme="dark"]) select { background: #f7f9fc; }
  }
  * { box-sizing: border-box; }
  /* 全局缩放锚点：rem 随视口宽度缩放，2K/4K 自动放大 */
  html { font-size: clamp(13px, 0.75vw, 26px); }
  html, body { margin: 0; height: 100%; }
  body {
    font-family: var(--font);
    color: var(--text);
    background:
      radial-gradient(70rem 32rem at 8% -12%, rgba(0, 102, 255, 0.2), transparent 62%),
      radial-gradient(56rem 28rem at 94% -8%, rgba(74, 78, 143, 0.33), transparent 58%),
      radial-gradient(44rem 26rem at 55% 115%, rgba(0, 229, 255, 0.07), transparent 55%),
      linear-gradient(158deg, #10142a 0%, #171231 42%, #0b0d18 78%, #07080f 100%);
    overflow: hidden;
  }
  .app { display: flex; flex-direction: column; height: 100dvh; padding: 0.9rem 1.1rem 0.7rem; gap: 0.7rem; }

  /* ── 顶部标题区 ─────────────────────────── */
  .topbar {
    display: grid; grid-template-columns: max-content minmax(0, 1fr) max-content;
    align-items: center; gap: 0.75rem;
  }
  .brand { display: flex; align-items: center; gap: 0.54rem; transform: translateY(0.12rem); }
  .brand-wordmark { display: inline-flex; align-items: center; min-width: 0; margin: 0; line-height: 1; }
  .brand-wordmark img {
    display: block;
    width: auto;
    height: 2.5rem;
    max-width: 20rem;
    object-fit: contain;
    filter: drop-shadow(0 0 0.16rem rgba(255,255,255,0.52)) drop-shadow(0 0 0.52rem rgba(0,166,255,0.42));
  }
  .app-version { color: var(--muted); font-size: 0.68rem; font-weight: 500; line-height: 1; white-space: nowrap; letter-spacing: 0.01em; }
  .theme-toggle { width: 2.35rem; height: 2.35rem; padding: 0; display: inline-flex; align-items: center; justify-content: center; border-radius: 0.62rem; }
  .theme-toggle svg { width: 1.3rem; height: 1.3rem; }
  .topbar .grow { display: none; }
  .week-anchor-control { display: grid; gap: 0.25rem; width: 21rem; min-width: 18rem; }
  .week-anchor-control > label { color: var(--muted); font-size: 0.68rem; padding-left: 0.15rem; }
  .week-anchor-control .date-input-shell { height: 1.8rem; }
  .week-anchor-control .date-input-shell input { border-radius: 0.5rem; }
  .week-anchor-control .date-input-shell #weekAnchorPickerButton { color: var(--text); background: rgba(0,140,168,0.1); }
  .week-anchor-control .date-input-shell #weekAnchorPickerButton:hover { color: var(--cyan); background: rgba(0,140,168,0.16); }

  /* 胶囊状态栏 */
  .chips { display: inline-flex; align-items: center; gap: 0.45rem; flex-wrap: wrap; }
  .chip {
    display: inline-flex; align-items: center; gap: 0.45rem; border-radius: 999px;
    padding: 0.3rem 0.78rem; font-size: 0.8rem; font-weight: 700;
    background: rgba(0,102,255,0.12); border: 1px solid rgba(77,148,255,0.3); color: #cfe2ff;
    backdrop-filter: blur(8px);
  }
  .chip.ok { background: rgba(56,217,128,0.1); border-color: rgba(56,217,128,0.28); color: #d8ffea; }
  .chip.warn { background: rgba(245,197,66,0.1); border-color: rgba(245,197,66,0.26); color: #ffefc4; }
  .chip.ghost { background: rgba(148,165,210,0.07); border-color: var(--line-2); color: var(--muted); font-weight: 400; }
  .chip.ghost b { color: var(--text); font-weight: 700; }
  .chip.ghost b.cyan { color: var(--cyan); text-shadow: 0 0 10px rgba(0,229,255,0.35); }
  .dot { width: 0.46rem; height: 0.46rem; border-radius: 999px; background: currentColor; box-shadow: 0 0 8px currentColor; }
  .dot.pulse { animation: pulse 1.6s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }

  /* ── 总进度条 ─────────────────────────── */
  .overall { display: flex; align-items: center; gap: 0.8rem; }
  .overall .bar { flex: 1; height: 0.5rem; border-radius: 999px; background: rgba(148,165,210,0.1); overflow: hidden; }
  .overall .bar > span { display: block; height: 100%; width: 0%; border-radius: inherit;
    background: linear-gradient(90deg, var(--blue), var(--cyan)); transition: width .4s ease;
    box-shadow: var(--glow-cyan); }
  .overall .bar.ok > span { background: linear-gradient(90deg, var(--cyan), var(--green)); box-shadow: 0 0 12px rgba(56,217,128,0.45); }
  .overall .pct { font-size: 0.95rem; min-width: 3rem; text-align: right; font-weight: 700; }

  /* ── KPI 指标条：弹性换行，末行自动填满，避免固定栅格留下空白 ── */
  .kpis {
    display: flex; flex-wrap: wrap; gap: 1px;
    background: var(--line); border: 1px solid var(--line); border-radius: 0.85rem;
    box-shadow: var(--shadow); backdrop-filter: blur(14px) saturate(1.25);
    overflow: hidden;
  }
  /* 标题区占 30%，数值区占 70%，两区各自垂直居中。 */
  .kpi { display: grid; grid-template-rows: minmax(0, 0.6fr) minmax(0, 1.4fr); flex: 1 1 8rem; min-width: 0; min-height: 4.75rem; padding: 0; text-align: center; background: var(--panel); }
  .kpi-content { display: contents; }
  .kpi .k, .kpi .v { display: flex; align-items: center; justify-content: center; min-width: 0; }
  .kpi .k { color: #9fb0c5; font-size: 0.86rem; font-weight: 600; letter-spacing: 0.04em; line-height: 1.2; }
  .kpi .v { font-size: 1.55rem; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.2; white-space: nowrap;
    text-shadow: 0 0 16px rgba(120, 170, 255, 0.22); }
  .kpi .s { display: none; }
  .kpi .v.green { color: var(--green); text-shadow: 0 0 14px rgba(56,217,128,0.3); }
  .kpi .v.cyan { color: var(--cyan); text-shadow: 0 0 14px rgba(0,229,255,0.35); }
  .kpi .v.yellow { color: var(--yellow); text-shadow: 0 0 14px rgba(245,197,66,0.3); }
  .kpi .v.red { color: var(--red); text-shadow: 0 0 14px rgba(255,107,107,0.3); }
  .kpi .v.rate-limit-accounts { letter-spacing: -0.045em; }

  /* ── 主区 ─────────────────────────── */
  .main { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 4fr) minmax(19rem, 1fr); gap: 0.7rem; position: relative; }
  .col { display: flex; flex-direction: column; gap: 0.7rem; min-height: 0; min-width: 0; position: relative; }
  .panel {
    background: var(--panel); border: 1px solid var(--line); border-radius: 0.85rem;
    box-shadow: var(--shadow); backdrop-filter: blur(14px) saturate(1.25);
    display: flex; flex-direction: column; min-height: 0; overflow: hidden;
  }
  .panel > .head { display: flex; align-items: center; gap: 0.7rem; padding: 0.65rem 0.95rem 0.5rem; flex-wrap: wrap; }
  .panel > .head h2 { margin: 0; font-size: 1.1rem; font-weight: 700; line-height: 1.2; letter-spacing: 0.02em; display: flex; align-items: center; gap: 0.5rem; }
  .panel > .head h2::before { content: ""; width: 0.26rem; height: 1rem; border-radius: 2px;
    background: linear-gradient(180deg, var(--blue-t), var(--cyan)); box-shadow: 0 0 8px rgba(0,229,255,0.4); }
  .panel > .head .hint { color: var(--muted); font-size: 0.86rem; }
  .panel > .head .grow { flex: 1; }
  .panel > .body { flex: 1; min-height: 0; overflow: auto; padding: 0 0.5rem 0.5rem; scrollbar-width: thin; scrollbar-color: rgba(148,165,210,0.3) transparent; }
  .panel > .body::-webkit-scrollbar { width: 8px; height: 8px; }
  .panel > .body::-webkit-scrollbar-thumb { background: rgba(148,165,210,0.22); border-radius: 8px; }
  /* 批次周总览使用独立命名空间，避免与历史表格、焦点应用和事件流样式互相污染。 */
  .batch-weeks-body {
    display: grid; grid-template-columns: minmax(0, 1fr); gap: 0.4rem;
    padding: 0.2rem 0.55rem 0.5rem !important; align-content: start; overflow: auto;
  }
  .batch-weeks-body.is-collapsed { grid-template-columns: minmax(0, 1fr); }
  .batch-week-list { display: grid; grid-auto-rows: max-content; gap: 0.35rem; align-content: start; min-width: 0; }
  .batch-week-card {
    border: 1px solid var(--line-2); border-radius: 0.72rem; background: rgba(12,24,44,0.46);
    overflow: hidden; flex: 0 0 auto;
  }
  .batch-week-card[data-state="done"] { border-color: rgba(56,217,128,0.38); }
  .batch-week-card[data-state="running"], .batch-week-card[data-state="starting"] { border-color: rgba(0,229,255,0.62); box-shadow: inset 0 0 0 1px rgba(0,229,255,0.08); }
  .batch-week-card[data-state="failed"] { border-color: rgba(255,107,107,0.58); }
  .batch-week-card[data-state="queued"], .batch-week-card[data-state="leaderboard_done"] { background: rgba(20,33,55,0.34); }
  .batch-week-summary {
    width: 100%; min-width: 0; display: grid;
    grid-template-columns: minmax(9rem,1.25fr) minmax(4.5rem,0.55fr) minmax(8rem,1fr) minmax(5.5rem,0.65fr) minmax(6rem,0.65fr) minmax(6rem,0.65fr) minmax(7rem,0.75fr) 1.4rem;
    align-items: center; gap: 0.42rem; border: 0; padding: 0.48rem 0.62rem;
    color: var(--text); background: transparent; font: inherit; text-align: center; cursor: pointer;
  }
  .batch-week-summary:hover { background: rgba(0,140,255,0.06); }
  .batch-week-summary:focus-visible { outline: 2px solid var(--cyan); outline-offset: -2px; }
  .batch-week-primary { display: flex; align-items: center; gap: 0.65rem; min-width: 0; text-align: left; }
  .batch-week-icon {
    width: 1.75rem; height: 1.75rem; border-radius: 999px; display: inline-flex; align-items: center; justify-content: center;
    flex: 0 0 auto; border: 1px solid currentColor; color: var(--muted); font-weight: 800;
  }
  .batch-week-card[data-state="done"] .batch-week-icon { color: var(--green); }
  .batch-week-card[data-state="running"] .batch-week-icon, .batch-week-card[data-state="starting"] .batch-week-icon { color: var(--cyan); }
  .batch-week-card[data-state="failed"] .batch-week-icon { color: var(--red); }
  .batch-week-date { font-size: 1rem; font-weight: 750; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .batch-week-state { display: flex; justify-content: flex-start; }
  .batch-week-metric { display: grid; gap: 0.18rem; min-width: 0; }
  .batch-week-metric .label { color: var(--muted); font-size: 0.68rem; }
  .batch-week-metric .value { font-size: 0.92rem; font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .batch-week-progress { display: flex; align-items: center; gap: 0.45rem; }
  .batch-week-progress .mini { flex: 1; min-width: 3rem; }
  .batch-week-progress .mini > span { background: linear-gradient(90deg,var(--blue-t),var(--cyan)); }
  .batch-week-card[data-state="done"] .batch-week-progress .mini > span { background: linear-gradient(90deg,var(--cyan),var(--green)); }
  .batch-week-list .batch-week-metric { display: flex; align-items: baseline; justify-content: center; gap: 0.2rem; }
  .batch-week-list .batch-week-metric .label { flex: 0 0 auto; white-space: nowrap; font-size: 0.66rem; }
  .batch-week-list .batch-week-metric .value { min-width: 0; }
  .batch-week-toggle { color: var(--muted); font-size: 1rem; transition: transform 0.16s ease; }
  .batch-week-card.is-expanded .batch-week-toggle { transform: rotate(180deg); color: var(--cyan); }
  .batch-week-detail { min-width: 0; border-top: 1px solid var(--line); padding: 0.1rem 0.35rem 0.35rem; background: rgba(7,17,34,0.28); overflow: auto; }
  .batch-week-detail table { table-layout: fixed; min-width: 44rem; }
  .batch-week-detail th:nth-child(1) { width: 18%; }
  .batch-week-detail th:nth-child(2) { width: 12%; }
  .batch-week-detail th:nth-child(3) { width: 20%; }
  .batch-week-detail th:nth-child(4) { width: 13%; }
  .batch-week-detail th:nth-child(5) { width: 13%; }
  .batch-week-detail th:nth-child(6) { width: 24%; }
  .batch-week-detail .current-app-cell { max-width: 0; }
  .batch-week-detail .week-progress-cell {
    display: grid; grid-template-columns: 5.5rem 3.2rem; align-items: center; justify-content: center; gap: 0.28rem;
  }
  .batch-week-detail .week-progress-cell .mini { width: 5.5rem; }
  .batch-week-detail .week-progress-count { width: 3.2rem; text-align: center; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .batch-week-empty { padding: 1.4rem 1rem; color: var(--muted); text-align: center; }
  .batch-alert-value { color: var(--yellow); font-weight: 800; white-space: nowrap; }
  html[data-theme="light"] .batch-week-card { background: #f7faff; border-color: #cbd8e8; }
  html[data-theme="light"] .batch-week-card[data-state="done"] { background: #f1fbf7; border-color: #78c6a4; }
  html[data-theme="light"] .batch-week-card[data-state="running"],
  html[data-theme="light"] .batch-week-card[data-state="starting"] { background: #eefaff; border-color: #35a9c5; }
  html[data-theme="light"] .batch-week-card[data-state="failed"] { background: #fff5f5; border-color: #e58b8b; }
  html[data-theme="light"] .batch-week-card[data-state="queued"],
  html[data-theme="light"] .batch-week-card[data-state="leaderboard_done"] { background: #f6f8fc; }
  html[data-theme="light"] .batch-week-summary:hover { background: rgba(24,119,242,0.07); }
  html[data-theme="light"] .batch-week-detail { background: #fbfdff; }
  /* 看板内的卡片与表格默认居中；事件流、运行上下文和应用名称保留左对齐。 */
  .panel:not(.modal-panel) > .body:not(.timeline), .panel:not(.modal-panel) > .split-legend { text-align: center; }
  .panel:not(.modal-panel) .kv { text-align: center; }
  .panel:not(.modal-panel) .kv .v { text-align: center; }
  [data-panel="events"] .timeline, [data-panel="events"] .event,
  .focus-app-cell, .riser-app, .current-app-cell { text-align: left; }
  .panel[data-panel="context"] .kv,
  .panel[data-panel="context"] .kv .k,
  .panel[data-panel="context"] .kv .v { text-align: left !important; }
  #search, #weekAnchorInput { text-align: center; }
  .api-links { display: inline-flex; gap: 0.35rem; align-items: center; flex-wrap: wrap; }
  .api-link {
    border: 1px solid rgba(77,148,255,0.3); border-radius: 999px; padding: 0.12rem 0.46rem;
    background: rgba(0,102,255,0.1); color: #cfe2ff; font: inherit; font-size: 0.72rem; cursor: pointer;
  }
  .api-link:hover { border-color: rgba(0,229,255,0.5); color: var(--cyan); }
  .api-link.on { border-color: rgba(0,229,255,0.65); background: rgba(0,229,255,0.12); color: var(--cyan); }

  /* ── 数据表格：表头弱化，行 hover 高亮 ── */
  table { width: 100%; border-collapse: collapse; font-size: 0.86rem; }
  th, td { padding: 0.42rem 0.6rem; border-bottom: 1px solid rgba(148,165,210,0.07); text-align: center; white-space: nowrap; vertical-align: middle !important; }
  thead th { position: sticky; top: 0; z-index: 1; background: var(--panel-2);
    color: rgba(141,154,184,0.75); font-size: 0.86rem; font-weight: 600; letter-spacing: 0.04em; }
  table tbody,
  table tbody * { font-weight: 400 !important; }
  tbody tr { transition: background 0.15s ease; }
  tbody tr:hover td { background: rgba(0,140,255,0.07); }
  td.num, th.num { text-align: center; font-variant-numeric: tabular-nums; }
  .muted { color: var(--muted); }
  .sub { color: var(--muted); font-size: 0.86rem; }
  .category-table td:first-child { white-space: nowrap; }
  .ellip { display: inline-block; max-width: 15rem; overflow: hidden; text-overflow: ellipsis; vertical-align: top; }
  /* 长文本列自动换行：内容完整显示，杜绝横向滚动 */
  td.wrap { white-space: normal; word-break: break-word; min-width: 6rem; }
  table.category-table { table-layout: fixed; }
  table.category-table th:nth-child(1) { width: 15%; }
  table.category-table th:nth-child(2) { width: 9%; }
  table.category-table th:nth-child(3) { width: 8%; }
  table.category-table th:nth-child(4) { width: 7%; }
  table.category-table th:nth-child(5) { width: 18%; }
  table.category-table th:nth-child(6) { width: 33%; }
  table.category-table th:nth-child(7) { width: 10%; }
  .current-app-cell { text-align: left; min-width: 0; }
  .current-app-cell .ellip { display: block; max-width: 100%; }
  table.riser-table { table-layout: fixed; }
  table.riser-table th:nth-child(1) { width: 5%; }
  table.riser-table th:nth-child(2) { width: 38%; }
  table.riser-table th:nth-child(3) { width: 24%; }
  table.riser-table th:nth-child(4) { width: 12%; }
  table.riser-table th:nth-child(5) { width: 11%; }
  table.riser-table th:nth-child(6) { width: 10%; }
  .riser-table th,
  .riser-table td { min-width: 0; padding-inline: 0.28rem; }
  .riser-table th {
    white-space: normal;
    word-break: keep-all;
    line-height: 1.15;
    letter-spacing: 0.02em;
  }
  .riser-app { min-width: 0; white-space: normal; overflow-wrap: anywhere; text-align: left; line-height: 1.35; }
  .riser-app a { display: block; max-width: 100%; white-space: normal; overflow-wrap: anywhere; }
  .riser-table td:nth-child(3) { white-space: nowrap; }
  .riser-table td:nth-child(3) .cat-chip { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .badge { display: inline-flex; align-items: center; gap: 0.35rem; border-radius: 999px; padding: 0.1rem 0.58rem;
    font-size: 0.74rem; font-weight: 700; border: 1px solid transparent; }
  .badge.done { color: #d7ffe7; background: rgba(56,217,128,0.12); border-color: rgba(56,217,128,0.25); }
  .badge.run  { color: #cfe2ff; background: rgba(0,102,255,0.16); border-color: rgba(77,148,255,0.35); }
  .badge.wait { color: var(--muted); background: rgba(148,165,210,0.08); border-color: var(--line-2); }
  .badge.err  { color: #ffdcdc; background: rgba(255,107,107,0.12); border-color: rgba(255,107,107,0.3); }
  .badge.warn { color: #fff1c4; background: rgba(245,197,66,0.12); border-color: rgba(245,197,66,0.28); }

  button.tool {
    border: 1px solid var(--line-2); border-radius: 0.5rem; color: var(--text);
    background: rgba(148,165,210,0.08); padding: 0.25rem 0.62rem; font-family: var(--font);
    font-size: 0.78rem; cursor: pointer; transition: all 0.15s ease;
  }
  button.tool:hover:not(:disabled) { border-color: rgba(0,229,255,0.45); color: var(--cyan); }
  button.tool.primary { background: rgba(0,102,255,0.18); border-color: rgba(77,148,255,0.38); }
  button.tool.danger { background: rgba(255,107,107,0.11); border-color: rgba(255,107,107,0.32); color: #ffdcdc; }
  button.tool.danger:hover:not(:disabled) { border-color: rgba(255,107,107,0.55); color: #fff; }
  button.tool:disabled { opacity: 0.48; cursor: not-allowed; }
.account-table td { vertical-align: middle; }
.account-table { table-layout: fixed; min-width: 58rem; }
.account-table th:nth-child(1) { width: 6%; }
.account-table th:nth-child(2) { width: 7%; }
.account-table th:nth-child(3) { width: 21%; }
.account-table th:nth-child(4) { width: 22%; }
.account-table th:nth-child(5) { width: 27%; }
.account-table th:nth-child(6) { width: 17%; }
.account-table th:last-child, .account-table td:last-child { text-align: center; }
.account-name { font-size: 1rem; font-weight: 700; color: var(--cyan); }
.account-name.add { color: var(--muted); font-size: 0.9rem; }
.account-actions { display: inline-flex; gap: 0.35rem; }
.account-detail { display: block; max-width: min(28rem, 34vw); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 0.15rem; }
.account-toggle { display: inline-flex; align-items: center; justify-content: center; width: 100%; }
.account-toggle input { width: 1rem; height: 1rem; accent-color: var(--blue); }
.account-row-add td { background: rgba(148,165,210,0.025); }
.settings-grid { display: grid; grid-template-columns: repeat(4, 12.75rem); justify-content: center; align-items: end; gap: 0.7rem; padding: 0.3rem 0.3rem 0.8rem; max-width: 100%; }
.field { display: grid; gap: 0.3rem; min-width: 0; }
  .field label { color: var(--muted); font-size: 0.74rem; }
  .date-input-row { min-width: 0; position: relative; }
  .date-input-shell { display: flex; align-items: center; min-width: 0; width: 100%; position: relative; }
  .date-input-shell #weekAnchorInput { flex: 1 1 auto; min-width: 0; padding-right: 2.1rem; }
  .date-input-shell #weekAnchorPickerButton { position: absolute; right: 0; top: 0; transform: none; width: 2rem; height: 100%; padding: 0; display: inline-flex; align-items: center; justify-content: center; border: 0; border-left: 1px solid var(--line-2); border-radius: 0 0.5rem 0.5rem 0; background: rgba(148,165,210,0.07); }
  .date-input-shell #weekAnchorPickerButton svg { width: 0.9rem; height: 0.9rem; }
  .date-input-row #weekAnchorPicker {
    position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; pointer-events: none;
    border: 0; padding: 0; margin: 0;
  }
  input[type="date"], input[type="text"], input[type="number"], input[type="url"], select {
  background: rgba(148,165,210,0.07); border: 1px solid var(--line-2); color: var(--text);
  border-radius: 0.5rem; padding: 0.32rem 0.6rem; font-size: 0.82rem; outline: none; font-family: var(--font);
}
.field input[type="date"], .field select { width: 100%; min-width: 0; }
.field .sort-menu, .field .sort-trigger { width: 100%; min-width: 0; }
.checks { display: flex; gap: 0.7rem; flex-wrap: wrap; align-items: center; }
.checks label { display: inline-flex; gap: 0.35rem; align-items: center; color: var(--text); font-size: 0.8rem; }
.account-bulk { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
.category-field { min-width: 0; grid-column: span 2; }
.category-field > label { display: flex; justify-content: space-between; gap: 0.5rem; align-items: center; }
.category-select-hint { color: var(--cyan); font-size: 0.72rem; font-weight: 600; white-space: nowrap; }
.category-toolbar { display: flex; gap: 0.35rem; align-items: center; }
.category-toolbar .tool { min-height: 1.65rem; padding-inline: 0.5rem; font-size: 0.72rem; }
.category-options { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); gap: 0.32rem; }
.category-option:nth-child(-n+4) { grid-column: span 3; }
.category-option:nth-child(n+5) { grid-column: span 4; }
.category-option { display: flex; align-items: center; gap: 0.32rem; min-width: 0; padding: 0.25rem 0.4rem; border: 1px solid var(--line); border-radius: 0.45rem; background: rgba(148,165,210,0.035); color: var(--muted); font-size: 0.73rem; line-height: 1.2; cursor: pointer; }
.category-option:has(input:checked) { color: var(--text); border-color: rgba(0,229,255,0.38); background: rgba(0,229,255,0.08); }
.category-option input { margin: 0; width: 0.85rem; height: 0.85rem; accent-color: var(--blue); flex: 0 0 auto; }
.category-option span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.overlay {
  position: fixed; inset: 0; background: rgba(5, 7, 15, 0.62); backdrop-filter: blur(8px);
  display: none; align-items: center; justify-content: center; z-index: 30; padding: 1.2rem;
}
.overlay.open { display: flex; }
.login-overlay { z-index: 45; background: rgba(5, 7, 15, 0.72); }
.login-panel { width: min(38rem, calc(100vw - 2rem)); display: flex; flex-direction: column; background: rgba(16, 20, 34, 0.98); }
.login-panel .body { display: grid; gap: 0.8rem; padding: 0.9rem; overflow: visible; }
.system-dialog-overlay { z-index: 60; background: rgba(5, 7, 15, 0.72); }
.system-dialog-panel { width: min(34rem, calc(100vw - 2rem)); display: flex; flex-direction: column; background: rgba(16, 20, 34, 0.98); }
.system-dialog-panel .body { padding: 0.9rem; overflow: visible; }
.system-dialog-message { max-height: min(52vh, 28rem); overflow: auto; white-space: pre-wrap; color: var(--text); font-size: 0.86rem; line-height: 1.65; text-align: center; }
.system-dialog-message.is-multiline { text-align: left; text-indent: 0; }
.system-dialog-actions { display: flex; justify-content: flex-end; gap: 0.45rem; flex-wrap: wrap; margin-top: 1rem; }
.system-dialog-panel[data-tone="danger"] .head { border-bottom-color: rgba(255, 91, 108, 0.42); }
.system-dialog-panel[data-tone="danger"] h2 { color: #ff98a4; }
.login-profile-card { display: flex; align-items: center; justify-content: space-between; gap: 0.8rem; padding: 0.65rem 0.75rem; border: 1px solid var(--line); border-radius: 0.65rem; background: rgba(148,165,210,0.04); }
.login-profile-card .profile-name { color: var(--muted); font-size: 0.76rem; overflow-wrap: anywhere; }
.login-form { display: grid; gap: 0.45rem; }
.login-form label { color: var(--muted); font-size: 0.74rem; font-weight: 700; }
.login-form input { width: 100%; min-width: 0; min-height: 2.4rem; box-sizing: border-box; }
.login-dialog-message { min-height: 1.2rem; color: var(--muted); font-size: 0.76rem; line-height: 1.45; overflow-wrap: anywhere; }
.login-dialog-message.success, .login-state-detail.success, .account-detail.success { color: var(--green); }
.login-dialog-message.error, .login-state-detail.error, .account-detail.error { color: var(--red); }
.login-dialog-actions { display: flex; justify-content: flex-end; gap: 0.45rem; flex-wrap: wrap; }
.login-site-button { display: inline-flex; align-items: center; justify-content: center; width: fit-content; min-height: 2rem; padding: 0 0.8rem; border: 1px solid rgba(77,148,255,0.38); border-radius: 0.58rem; color: var(--text); background: rgba(0,102,255,0.18); font-size: 0.78rem; }
.login-site-button:hover { color: var(--cyan); border-color: rgba(0,229,255,0.45); text-decoration: none; }
#settingsPanel.modal-panel {
  width: min(94rem, calc(100vw - 2.4rem)); max-height: calc(100vh - 2.4rem); display: flex;
  flex-direction: column; background: rgba(16, 20, 34, 0.96);
}
.history-panel.modal-panel {
  width: min(88rem, calc(100vw - 2.4rem)); max-height: calc(100vh - 2.4rem); display: flex;
  flex-direction: column; background: rgba(16, 20, 34, 0.96);
}
.history-body { display: grid; grid-template-columns: minmax(0, 1.9fr) minmax(18rem, 0.9fr); gap: 0; min-height: 0; }
.history-list-wrap { min-width: 0; overflow: auto; padding-right: 0.8rem; border-right: 1px solid var(--line); display: flex; justify-content: center; }
.history-table { min-width: 38rem; width: 100%; margin-inline: auto; }
.history-table td, .history-table th { white-space: nowrap; }
.history-table input[type=checkbox] { width: 0.9rem; height: 0.9rem; margin: 0; accent-color: var(--blue); vertical-align: middle; }
.history-table .history-select-col, .history-table th:first-child, .history-table td:first-child { width: 2.6rem; min-width: 2.6rem; max-width: 2.6rem; }
.history-table .history-action-col, .history-table th:last-child, .history-table td:last-child { width: 13.5rem; min-width: 13.5rem; max-width: 13.5rem; }
.history-table td:last-child { text-align: center; }
.history-table td.empty { text-align: center !important; }
.history-detail { min-width: 0; overflow: auto; margin-left: 0.8rem; border: 1px solid var(--line); border-radius: 0.65rem; padding: 0.7rem; background: rgba(148,165,210,0.035); display: flex; justify-content: center; }
.history-detail-content { width: min(100%, 27rem); }
.history-detail > .empty { min-height: 100%; width: 100%; display: grid; place-items: center; text-align: center; }
.history-detail h3 { margin: 0 0 0.6rem; font-size: 0.95rem; }
.history-detail .kv-list { padding: 0; }
.history-detail .kv { grid-template-columns: 7.6rem minmax(0, 1fr); gap: 0; }
.history-detail .kv .k { min-width: 0; padding-right: 0.65rem; border-right: 1px solid var(--line); white-space: nowrap; display: flex; align-items: center; }
.history-detail .kv .v { padding-left: 0.7rem; }
.history-detail .history-failure-reason { border-color: rgba(255, 107, 107, 0.35); background: rgba(255, 107, 107, 0.06); }
.history-detail .history-failure-reason .v { color: var(--red); line-height: 1.45; }
.history-status { display: inline-flex; align-items: center; gap: 0.3rem; border-radius: 999px; padding: 0.12rem 0.5rem; font-size: 0.7rem; border: 1px solid var(--line-2); }
.history-status.done { color: var(--green); border-color: rgba(72, 218, 154, 0.35); }
.history-status.failed { color: var(--red); border-color: rgba(255, 107, 107, 0.35); }
.history-status.running, .history-status.starting { color: var(--cyan); border-color: rgba(0, 229, 255, 0.35); }
.history-status.stopped, .history-status.interrupted { color: var(--yellow); border-color: rgba(245, 197, 66, 0.35); }
.history-status.unsynced { color: var(--muted); border-color: var(--line-2); }
.history-status.syncing { color: var(--cyan); border-color: rgba(0, 229, 255, 0.35); }
.history-actions { display: inline-flex; gap: 0.35rem; }
.history-actions .tool { min-height: 1.8rem; padding-inline: 0.5rem; }
.history-action-cell { text-align: right; }
.history-sync-module { margin-top: 1rem; padding: 0.8rem; border: 1px solid rgba(0, 229, 255, 0.3); border-radius: 0.65rem; background: rgba(0, 229, 255, 0.055); }
.history-sync-module-head { display: flex; align-items: baseline; justify-content: space-between; gap: 0.6rem; color: var(--text); font-size: 0.82rem; font-weight: 700; }
.history-sync-module-head strong { color: var(--cyan); font-size: 0.9rem; }
.history-sync-module-message { margin: 0.45rem 0 0; color: var(--muted); font-size: 0.74rem; }
.history-sync-track { height: 0.38rem; margin-top: 0.65rem; overflow: hidden; border-radius: 999px; background: rgba(148, 165, 210, 0.2); }
.history-sync-track > span { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--blue), var(--cyan)); transition: width 0.35s ease; }
.history-empty { min-height: 8rem; }
@media (max-width: 900px) { .history-body { grid-template-columns: 1fr; gap: 0.55rem; } .history-list-wrap { padding-right: 0; padding-bottom: 0.55rem; border-right: 0; border-bottom: 1px solid var(--line); } .history-detail { min-height: 12rem; margin-left: 0; } }
.panel { min-height: 4rem; min-width: 18rem; }

  /* 品类进度条：青绿渐变 */
  .mini { height: 0.38rem; width: 6.5rem; border-radius: 999px; background: rgba(148,165,210,0.12); overflow: hidden; display: inline-block; vertical-align: middle; }
  .mini > span { display: block; height: 100%; background: linear-gradient(90deg, var(--cyan), var(--green));
    box-shadow: 0 0 8px rgba(0,229,255,0.35); }
  .category-table td:nth-child(5) .mini { width: min(5rem, calc(100% - 3.2rem)); }
  .category-table td:nth-child(5) > .muted { margin-left: 0.22rem; }

  .chg-up { color: var(--green); font-weight: 700; }
  .chg-dn { color: var(--red); font-weight: 700; }
  .chg-0 { color: var(--muted); }
  .new-tag { display: inline-block; color: var(--cyan); font-size: 0.68rem; font-weight: 700; border: 1px solid rgba(0,229,255,0.4);
    border-radius: 0.35rem; padding: 0 0.3rem; margin-left: 0.4rem; white-space: nowrap; word-break: keep-all; }
  .suspected-delisted-tag { background: rgba(245, 158, 11, 0.16); border-color: rgba(245, 158, 11, 0.72); color: #fbbf24; }
  .focus-app-cell, .focus-app-cell a { white-space: normal; word-break: normal; overflow-wrap: normal; }
  .cat-chip { display: inline-block; max-width: 100%; box-sizing: border-box; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; vertical-align: middle; border-radius: 0.35rem; padding: 0.05rem 0.45rem; font-size: 0.74rem;
    background: rgba(74,78,143,0.28); border: 1px solid rgba(120,126,200,0.32); color: #d6dcff; }
  a.cat-link { color: var(--text); font-weight: 700; border-bottom: 1px dashed rgba(0,229,255,0.45); }
  a.cat-link:hover { color: var(--cyan); text-decoration: none; }

  .tabs { display: flex; gap: 0.4rem; flex-wrap: wrap; }
  .tab { border-radius: 999px; padding: 0.26rem 0.85rem; font-size: 0.82rem; cursor: pointer; user-select: none;
    background: rgba(148,165,210,0.07); border: 1px solid var(--line-2); color: var(--muted);
    display: inline-flex; align-items: center; gap: 0.35rem; transition: all 0.15s ease; }
  .tab:hover { border-color: rgba(0,229,255,0.4); color: var(--text); }
  .tab.on { background: linear-gradient(90deg, rgba(0,102,255,0.32), rgba(0,229,255,0.16));
    border-color: rgba(0,180,255,0.55); color: #eaf4ff; font-weight: 700; box-shadow: 0 0 12px rgba(0,140,255,0.25); }
  .tab .n { font-size: 0.72rem; opacity: 0.85; }
  .tab .live-dot { width: 0.4rem; height: 0.4rem; border-radius: 999px; background: var(--cyan);
    box-shadow: 0 0 6px var(--cyan); animation: pulse 1.4s infinite; }
  select, input[type="search"] {
    background: rgba(148,165,210,0.07); border: 1px solid var(--line-2); color: var(--text);
    border-radius: 0.5rem; padding: 0.26rem 0.6rem; font-size: 0.82rem; outline: none; font-family: var(--font);
  }
  select:focus, input[type="search"]:focus { border-color: rgba(0,229,255,0.5); }
  select option { background: #171d33; }
  .sort-menu { position: relative; flex: 0 0 auto; }
  .sort-trigger {
    width: 100%; min-height: 2rem; display: inline-flex; align-items: center; justify-content: space-between; gap: 0.45rem;
    border: 1px solid var(--line-2); border-radius: 0.58rem; padding: 0.26rem 0.6rem; color: var(--text);
    background: rgba(148,165,210,0.07); font: inherit; font-size: 0.82rem; cursor: pointer;
  }
  .sort-trigger:hover, .sort-menu.open .sort-trigger { border-color: rgba(0,229,255,0.5); }
  .sort-trigger svg { width: 0.8rem; height: 0.8rem; flex: 0 0 auto; transition: transform 0.15s ease; }
  .sort-menu.open .sort-trigger svg { transform: rotate(180deg); }
  .sort-options {
    position: absolute; z-index: 30; right: 0; top: calc(100% + 0.35rem); min-width: 100%; overflow: hidden;
    padding: 0.25rem; border: 1px solid var(--line-2); border-radius: 0.58rem; background: var(--panel-2); box-shadow: var(--shadow);
  }
  .sort-options[hidden] { display: none; }
  .sort-option { display: block; width: 100%; border: 0; border-radius: 0.38rem; padding: 0.42rem 0.5rem; color: var(--text); background: transparent; font: inherit; font-size: 0.82rem; text-align: left; white-space: nowrap; cursor: pointer; }
  .sort-option:hover { color: var(--text); background: rgba(148,165,210,0.09); }
  .sort-option[aria-selected="true"] { color: var(--cyan); background: rgba(0,229,255,0.1); }
  .sort-option[aria-selected="true"]:hover { color: var(--cyan); background: rgba(0,229,255,0.06); }
  input[type="search"] { width: 10rem; }
  a { color: #bfe0ff; text-decoration: none; }
  a:hover { color: var(--cyan); text-decoration: underline; }

  .spark { width: 6rem; height: 1.4rem; vertical-align: middle; }
  .spark polyline { fill: none; stroke: var(--cyan); stroke-width: 1.6; }
  .spark circle { fill: var(--cyan); }

  /* ── 右侧信息面板 ─────────────────────── */
  .kv-list { display: grid; gap: 0.35rem; padding: 0.25rem 0.45rem 0.45rem; overflow: auto; }
  .kv { display: grid; grid-template-columns: 4.5rem minmax(0, 1fr); align-items: center; gap: 0.7rem; font-size: 0.8rem;
    padding: 0.4rem 0.6rem; border: 1px solid var(--line); border-radius: 0.55rem; background: rgba(24,29,50,0.4); }
  .kv .k { color: var(--muted); flex: 0 0 auto; }
  .kv .v { min-width: 0; font-size: 0.78rem; text-align: left; word-break: break-word; overflow-wrap: anywhere; }
  .kv .v.path-value a { display: block; max-width: 100%; overflow-x: auto; white-space: nowrap; word-break: normal; overflow-wrap: normal; scrollbar-width: thin; }
  /* 事件流时间线：左侧圆点 + 竖线，最新事件突出 */
  .timeline { padding: 0.3rem 0.6rem 0.4rem 0.65rem; }
  .event { position: relative; display: grid; gap: 0.18rem; padding: 0.1rem 0.3rem 0.55rem 1.15rem; font-size: 0.8rem; }
  .event::before { content: ""; position: absolute; left: 0; top: 0.32rem;
    width: 0.44rem; height: 0.44rem; border-radius: 999px;
    background: var(--blue-t); box-shadow: 0 0 6px rgba(77,148,255,0.6); }
  .event::after { content: ""; position: absolute; left: 0.19rem; top: 1rem; bottom: -0.15rem;
    width: 1px; background: rgba(148,165,210,0.16); }
  .event:last-child::after { display: none; }
  .event[data-l="warn"]::before { background: var(--yellow); box-shadow: 0 0 6px rgba(245,197,66,0.6); }
  .event[data-l="error"]::before { background: var(--red); box-shadow: 0 0 8px rgba(255,107,107,0.7); }
  .event .t, .event .m, .event .d { font-size: 0.8rem; line-height: 1.35; }
  .event .t { color: var(--muted); }
  .event .m { color: var(--muted); }
  .event .d { color: var(--muted); white-space: normal; word-break: break-word; }
  .event.newest .m { color: var(--text); font-weight: 700; }
  .event.newest::before { background: var(--cyan); box-shadow: 0 0 10px rgba(0,229,255,0.8); animation: none; }
  .event .kv-mini { display: flex; gap: 0.55rem; flex-wrap: wrap; margin-top: 0.18rem; color: var(--muted); font-size: 0.72rem; }
  .event .kv-mini span { border: 1px solid rgba(148,165,210,0.12); border-radius: 999px; padding: 0.04rem 0.42rem; background: rgba(148,165,210,0.04); }

  .split { display: flex; height: 0.55rem; min-height: 0.55rem; border-radius: 999px; overflow: hidden; margin: 0.4rem 0.7rem 0.15rem; background: rgba(148,165,210,0.12); }
  .split > div { height: 100%; flex: 0 0 auto; }
  .split .m { background: linear-gradient(90deg, var(--blue), var(--cyan)); }
  .split .e { background: linear-gradient(90deg, #e8963f, var(--yellow)); }
  .split .d { background: #f97316; }
  .split .n { background: #a78bfa; }
  .split .u { background: rgba(148,165,210,0.22); }
  .panel[data-panel="market-split"] { padding-bottom: 0.25rem; }
  .panel[data-panel="market-split"] > .head { padding-bottom: 0.65rem; }
  .split-legend { display: flex; align-items: center; min-height: 2rem; gap: 0.9rem; color: var(--muted); font-size: 0.75rem; padding: 0.35rem 0.95rem 0.7rem; flex-wrap: wrap; }
  .lg { display: inline-flex; align-items: center; gap: 0.3rem; }
  .sw { width: 0.6rem; height: 0.6rem; border-radius: 0.2rem; display: inline-block; }

  /* 空态占位 */
  .empty { padding: 1.4rem; text-align: center; color: var(--muted); font-size: 0.82rem; }
  .empty-hero { padding: 2.2rem 1.4rem; text-align: center; color: var(--muted); }
  .empty-hero svg { width: 3.4rem; height: 3.4rem; opacity: 0.4; margin-bottom: 0.6rem; }
  .empty-hero .t1 { font-size: 0.92rem; color: rgba(238,242,252,0.75); margin-bottom: 0.25rem; }
  .empty-hero .t2 { font-size: 0.78rem; }

  /* ── 自适应 ─────────────────────────── */
  @media (max-width: 1450px) {
    .topbar { grid-template-columns: max-content minmax(0, 1fr); }
    .topbar .top-context { width: 100%; min-width: 0; justify-content: space-between; flex-wrap: nowrap; }
    .topbar .top-actions { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); width: 100%; }
    .topbar .top-actions .tool { min-width: 0; width: 100%; }
  }
  /* 半屏窗口也优先使用单列，避免右侧榜单在双列布局中被压缩。 */
  @media (max-width: 1400px) {
    body { overflow: auto; }
    .app { height: auto; min-height: 100dvh; }
    .main { grid-template-columns: 1fr; }
    .panel > .body { max-height: 46vh; }
    .settings-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .category-field { grid-column: 1 / -1; }
  }
  @media (max-width: 640px) {
    .app { padding: 0.7rem; }
    .kpi { flex-basis: 8.5rem; }
    input[type="search"] { width: 7rem; }
    .ellip { max-width: 9rem; }
    .settings-grid { grid-template-columns: 1fr; }
    .category-field { grid-column: auto; }
    .category-options { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .category-option:nth-child(n) { grid-column: auto; }
  }
  /* 全局控件规范：统一高度、圆角、间距与焦点状态 */
  button.tool, .api-link, .tab, select, input[type="search"], input[type="text"], input[type="number"], input[type="date"], input[type="url"] {
    min-height: 2rem;
    border-radius: 0.58rem;
    transition: color .15s ease, background .15s ease, border-color .15s ease, box-shadow .15s ease, transform .15s ease;
  }
  /* 组件样式显式设置 display 时，仍须尊重原生 hidden 属性。 */
  [hidden] { display: none !important; }
  button.tool { display: inline-flex; align-items: center; justify-content: center; gap: 0.35rem; line-height: 1; white-space: nowrap; }
  button.tool:focus-visible, .api-link:focus-visible, .tab:focus-visible, select:focus-visible, input:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--cyan) 70%, transparent);
    outline-offset: 2px;
  }
  button.tool:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 0.25rem 0.8rem rgba(0,0,0,0.14); }
  .topbar { gap: 0.75rem; }
  .topbar > .chips { gap: 0.5rem; }
  .topbar > .chips:last-child { padding-left: 0.15rem; }
  .topbar .week-anchor-control { margin-right: 0.1rem; }
  .settings-grid { align-items: stretch; }
  .settings-grid .field { padding: 0.55rem 0.65rem; border: 1px solid var(--line); border-radius: 0.68rem; background: rgba(148,165,210,0.035); }
  .settings-grid .field > label { font-weight: 700; letter-spacing: 0.02em; }
  .account-bulk, .account-actions { gap: 0.45rem; }
  .account-actions { display: inline-flex; flex-wrap: nowrap; align-items: center; justify-content: center; }
  .login-help { margin: 0.55rem 0; color: var(--muted); font-size: 0.76rem; line-height: 1.5; }
  .account-table button.tool { min-height: 1.85rem; padding-inline: 0.58rem; }
  .panel > .head .tool, .panel > .head .api-link { min-height: 1.85rem; }
  .modal-panel > .head { min-height: 3.15rem; border-bottom: 1px solid var(--line); }
  .modal-panel > .body { padding: 0.65rem 0.7rem 0.8rem; }
  .modal-panel .account-table th { background: var(--panel-2); }
  .topbar {
    min-height: 3.7rem;
    padding: 0.55rem 0.8rem;
    border: 1px solid var(--line);
    border-radius: 0.82rem;
    background: var(--panel);
    box-shadow: var(--shadow);
    backdrop-filter: blur(14px) saturate(1.2);
  }
  .topbar .brand { flex: 0 0 auto; padding-right: 0.2rem; }
  .topbar .top-context, .topbar .top-status, .topbar .top-actions {
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
  }
  .topbar .top-context { gap: 0.55rem; }
  .topbar .top-status { gap: 0.4rem; }
  .topbar .top-actions { gap: 0.38rem; background: transparent; }
  .topbar .week-anchor-control { display: flex; align-items: center; gap: 0.6rem; width: clamp(22rem, 33vw, 33rem); min-width: 0; }
  .topbar .week-anchor-control > label { flex: 0 0 auto; padding: 0; font-size: 0.74rem; white-space: nowrap; }
  .topbar .week-anchor-control .date-input-row { flex: 1 1 14rem; min-width: 0; }
  .topbar .week-anchor-control .date-input-shell,
  .topbar .week-anchor-control #weekAnchorInput,
  .topbar .chip,
  .topbar .top-actions .tool { min-height: 2.35rem; height: 2.35rem; }
  .topbar .chip { border-radius: 0.58rem; padding: 0 0.72rem; }
  .topbar .top-actions .tool { min-width: 4.2rem; }
  .topbar .top-actions #runStop { min-width: 4.2rem; }
  .topbar .top-actions #pageRefresh { min-width: 4.4rem; }
  .topbar .top-actions #runStartFresh { min-width: 4.5rem; }
  @media (max-width: 1180px) {
    .topbar .top-status, .topbar .top-actions { padding-inline: 0; }
    .topbar .week-anchor-control { width: auto; min-width: 0; }
  }
  .panel > .body > table.is-empty { height: 100%; }
  table.is-empty tbody.empty-state { height: 100%; }
  table.is-empty tbody.empty-state tr { height: 100%; }
  table.is-empty tbody.empty-state td { height: 100%; padding: 0; white-space: normal; vertical-align: middle; }
  table.is-empty tbody.empty-state .empty,
  table.is-empty tbody.empty-state .empty-hero {
    min-height: 100%; height: 100%; padding: 1.4rem;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
  }
  .topbar { position: relative; z-index: 20; overflow: visible; }
  .calendar-popup {
    position: absolute; top: calc(100% + 0.42rem); left: 0; width: 100%; min-width: 0; box-sizing: border-box; z-index: 70;
    padding: 0.72rem; border: 1px solid var(--line-2); border-radius: 0.7rem;
    color: var(--text); background: var(--panel-2); box-shadow: 0 0.7rem 1.8rem rgba(0,0,0,0.26);
  }
  .calendar-popup[hidden] { display: none; }
  .calendar-head { display: grid; grid-template-columns: 2rem 1fr 2rem; align-items: center; gap: 0.35rem; margin-bottom: 0.45rem; }
  .calendar-title { display: flex; align-items: center; justify-content: center; gap: 0.18rem; text-align: center; font-size: 0.82rem; font-weight: 700; }
  .calendar-title button { padding: 0.16rem 0.28rem; border: 0; border-radius: 0.35rem; color: var(--text); background: transparent; font: 700 0.82rem var(--font); cursor: pointer; }
  .calendar-title button:hover { color: var(--cyan); background: rgba(0,140,255,0.1); }
  .calendar-nav {
    width: 2rem; height: 2rem; padding: 0; border: 1px solid var(--line); border-radius: 0.48rem;
    color: var(--text); background: rgba(148,165,210,0.07); cursor: pointer;
  }
  .calendar-nav:hover { color: var(--cyan); border-color: var(--cyan); }
  .calendar-weekdays, .calendar-days { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 0.18rem; }
  .calendar-options { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.35rem; padding: 0.15rem 0; }
  .calendar-option { min-height: 2.35rem; border: 1px solid var(--line); border-radius: 0.48rem; color: var(--text); background: rgba(148,165,210,0.06); font: 700 0.74rem var(--font); cursor: pointer; }
  .calendar-option:hover { color: var(--cyan); border-color: var(--cyan); background: rgba(0,140,255,0.12); }
  .calendar-option.selected { color: #fff; border-color: var(--blue-t); background: var(--blue); }
  .calendar-weekdays { margin-bottom: 0.2rem; }
  .calendar-weekdays span { text-align: center; color: var(--muted); font-size: 0.66rem; font-weight: 700; }
  .calendar-day {
    aspect-ratio: 1; min-width: 0; padding: 0; border: 1px solid transparent; border-radius: 0.42rem;
    color: var(--muted); background: transparent; font: 700 0.72rem var(--font); cursor: default;
  }
  .calendar-day.other { opacity: 0.42; }
  .calendar-day.monday { color: var(--text); background: rgba(0,102,255,0.09); border-color: rgba(77,148,255,0.2); cursor: pointer; }
  .calendar-day.monday:hover { color: var(--cyan); border-color: var(--cyan); background: rgba(0,140,255,0.15); }
  .calendar-day.unavailable { opacity: 0.28; cursor: not-allowed; }
  .calendar-day.selected { color: #fff; background: var(--blue); border-color: var(--blue-t); }
  .calendar-day.history-collected { color: #67e8f9; background: rgba(34,211,238,0.16); box-shadow: none; }
  .calendar-day.history-failed { color: #ffb347; background: rgba(245,158,11,0.2); box-shadow: none; }
  .calendar-day.selected.history-collected { color: #fff; background: #0891b2; border-color: #67e8f9; box-shadow: none; }
  .calendar-day.selected.history-failed { color: #fff; background: #d97706; border-color: #fbbf24; box-shadow: none; }
  .calendar-day.selected:hover { color: #fff; background: #6aa4ff; border-color: var(--blue-t); box-shadow: none; }
  .calendar-day.selected.history-collected:hover { color: #fff; background: #0ea5c6; border-color: #67e8f9; box-shadow: none; }
  .calendar-day.selected.history-failed:hover { color: #fff; background: #ea8a00; border-color: #fbbf24; box-shadow: none; }
  .calendar-day.today { box-shadow: inset 0 0 0 1px var(--cyan); }
  .calendar-footer { display: flex; align-items: center; justify-content: space-between; gap: 0.45rem; margin-top: 0.55rem; padding-top: 0.5rem; border-top: 1px solid var(--line); color: var(--muted); font-size: 0.7rem; }
  .calendar-history-legend { display: inline-flex; align-items: center; gap: 0.42rem; flex-wrap: wrap; }
  .calendar-history-legend span { display: inline-flex; align-items: center; gap: 0.16rem; }
  .calendar-history-legend i { display: inline-block; width: 0.48rem; height: 0.48rem; border-radius: 50%; }
  .calendar-history-legend i.collected { background: var(--cyan); }
  .calendar-history-legend i.failed { background: #f59e0b; }
  .calendar-footer > div { display: inline-flex; gap: 0.35rem; }
  .calendar-footer .tool { min-height: 1.7rem; padding-inline: 0.55rem; }
  html[data-theme="light"] .calendar-popup { background: #fff; box-shadow: 0 0.65rem 1.6rem rgba(28,45,68,0.18); }
  html[data-theme="light"] .calendar-day.monday { color: #173d70; background: #e7f1fb; border-color: #bdd3e9; }
  html[data-theme="light"] .calendar-day.monday:hover { color: #075a91; background: #d7eafb; border-color: #247fc4; }
  html[data-theme="light"] .calendar-day.history-collected { color: #007f9b; background: rgba(8,145,178,0.15); box-shadow: none; }
  html[data-theme="light"] .calendar-day.history-failed { color: #c26400; background: rgba(245,158,11,0.18); box-shadow: none; }
  html[data-theme="light"] .calendar-day.selected.history-collected { color: #fff; background: #0891b2; border-color: #0e7490; box-shadow: none; }
  html[data-theme="light"] .calendar-day.selected.history-failed { color: #fff; background: #d97706; border-color: #b45309; box-shadow: none; }
  html[data-theme="light"] .calendar-day.selected:hover { color: #fff; background: #3b82f6; border-color: var(--blue-t); box-shadow: none; }
  html[data-theme="light"] .calendar-day.selected.history-collected:hover { color: #fff; background: #0ea5c6; border-color: #0e7490; box-shadow: none; }
  html[data-theme="light"] .calendar-day.selected.history-failed:hover { color: #fff; background: #ea8a00; border-color: #b45309; box-shadow: none; }
  html[data-theme="light"] .calendar-day.selected,
  html[data-theme="light"] .calendar-option.selected { color: #fff; background: var(--blue); border-color: var(--blue-t); }
  html[data-theme="light"] .calendar-title button:hover { color: #075a91; background: #e6f1fb; }
  html[data-theme="light"] .calendar-option { background: #f4f7fb; }
  html[data-theme="light"] .calendar-option:hover { color: #075a91; background: #e6f1fb; border-color: #247fc4; }

  @media (max-width: 1320px) {
    .batch-week-summary { grid-template-columns: minmax(8rem,1.15fr) minmax(4rem,0.5fr) minmax(7rem,0.9fr) minmax(5rem,0.6fr) minmax(5.5rem,0.6fr) minmax(5.5rem,0.6fr) minmax(6rem,0.68fr) 1.4rem; }
  }

  /* ── 窄屏 / 移动端视觉优化 ─────────────────── */
  @media (max-width: 900px) {
    body { overflow-x: hidden; }
    .app {
      width: 100%;
      padding: max(0.65rem, env(safe-area-inset-top)) max(0.7rem, env(safe-area-inset-right)) max(0.8rem, env(safe-area-inset-bottom)) max(0.7rem, env(safe-area-inset-left));
      gap: 0.55rem;
    }
    .topbar {
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 0.5rem;
      padding: 0.6rem;
    }
    .topbar .brand { min-width: 0; }
    .brand-wordmark img { height: 2rem; max-width: 15rem; }
    .topbar > .grow { display: none; }
    .topbar .top-context {
      grid-column: 1 / -1;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      width: 100%;
      min-width: 0;
      gap: 0.45rem;
    }
    .topbar .week-anchor-control {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: center;
      width: 100%;
      min-width: 0;
      gap: 0.45rem;
    }
    .topbar .week-anchor-control > label { font-size: 0.7rem; }
    .topbar .top-context .chip { min-width: 0; }
    .topbar .top-actions {
      grid-column: 1 / -1;
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      width: 100%;
      min-width: 0;
      gap: 0.35rem;
    }
    .topbar .top-actions .tool,
    .topbar .top-actions #runStop,
    .topbar .top-actions #pageRefresh,
    .topbar .top-actions #runStartFresh {
      width: 100%;
      min-width: 0;
      padding-inline: 0.35rem;
      font-size: 0.72rem;
    }
    .overall { gap: 0.5rem; }
    .overall .pct { min-width: 2.6rem; font-size: 0.82rem; }
    .kpi .k { font-size: 0.86rem; letter-spacing: 0.04em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .kpi .v { font-size: 1.3rem; }
    .kpi .s { min-height: 1.05em; font-size: 0.66rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .panel { min-width: 0; }
    .panel > .head { gap: 0.45rem; padding: 0.58rem 0.7rem 0.45rem; }
    .panel > .head h2 { font-size: 1rem; }
    .panel > .body { padding-inline: 0.35rem; overscroll-behavior-inline: contain; -webkit-overflow-scrolling: touch; }
    .batch-weeks-body, .batch-weeks-body.is-collapsed { grid-template-columns: 1fr; }
    .batch-week-summary { grid-template-columns: minmax(7rem,1fr) minmax(3.8rem,0.62fr) minmax(5.8rem,0.9fr) 1.4rem; }
    .batch-week-list .metric-categories,
    .batch-week-list .metric-focus,
    .batch-week-list .metric-alert,
    .batch-week-list .metric-duration { display: none; }
    .panel > .body > table { min-width: max-content; }
    .category-table { min-width: 40rem !important; }
    .category-table td:nth-child(5) { white-space: normal; text-align: center; vertical-align: middle; }
    .category-table td:nth-child(5) .mini {
      display: block;
      width: min(5rem, 100%);
      height: 0.32rem;
      margin-bottom: 0.16rem;
      margin-inline: auto;
    }
    .category-table td:nth-child(5) > .muted { display: block; line-height: 1.1; text-align: center; }
    .category-table th:nth-child(1) { width: 22%; }
    .category-table th:nth-child(2) { width: 12%; }
    .category-table th:nth-child(3) { width: 8%; }
    .category-table th:nth-child(4) { width: 8%; }
    .category-table th:nth-child(5) { width: 18%; }
    .category-table th:nth-child(6) { width: 22%; }
    .category-table th:nth-child(7) { width: 10%; }
    .category-table td:first-child { padding-inline: 0.48rem; }
    .category-table td:nth-child(2) { padding-inline: 0.3rem; }
    .category-table td:nth-child(2) .badge { padding-inline: 0.42rem; font-size: 0.68rem; }
    .category-table td:first-child { padding-inline: 0.34rem; }
    .riser-table { min-width: 38rem !important; }
    .panel[data-panel="focus-apps"] > .head #search { flex: 1 1 9rem; width: auto; min-width: 0; }
    .panel[data-panel="focus-apps"] > .head #sortMenu { flex: 0 0 auto; max-width: 8.2rem; }
    .tabs { max-width: 100%; overflow-x: auto; flex-wrap: nowrap; padding-bottom: 0.12rem; scrollbar-width: thin; }
    .tab { flex: 0 0 auto; padding-inline: 0.65rem; }
    .history-panel.modal-panel, #settingsPanel.modal-panel { width: calc(100vw - 1rem); max-height: calc(100dvh - 1rem); }
    .modal-panel > .head { padding-inline: 0.7rem; }
    .modal-panel > .body { padding: 0.45rem; }
    .history-body { gap: 0.55rem; }
    .history-detail { padding: 0.55rem; }
  }
  @media (max-width: 640px) {
    .app { padding-inline: 0.55rem; }
    .topbar { grid-template-columns: minmax(0, 1fr) auto; padding: 0.5rem; }
    .brand-wordmark img { height: 1.75rem; max-width: 13rem; }
    .theme-toggle { width: 2.1rem; height: 2.1rem; }
    .topbar .top-context { grid-template-columns: 1fr; }
    .topbar .week-anchor-control { grid-template-columns: 1fr; align-items: stretch; gap: 0.25rem; }
    .topbar .week-anchor-control > label { padding-left: 0.1rem; }
    .topbar .week-anchor-control .calendar-popup { left: 0; transform: none; }
    .topbar .top-context .chip { justify-content: center; }
    .topbar .top-actions { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .topbar .top-actions .tool { min-height: 2.15rem; }
    .overall .bar { height: 0.42rem; }
    .kpis { gap: 1px; border-radius: 0.7rem; }
    .kpi .v { font-size: 1.16rem; }
    .panel > .head { padding-inline: 0.6rem; }
    .panel > .head .grow { display: none; }
    .panel[data-panel="focus-apps"] > .head #search { flex: 1 1 100%; order: 3; width: 100%; }
    .panel[data-panel="focus-apps"] > .head #sortMenu { flex: 1 1 auto; max-width: none; }
    .panel > .body { max-height: 52vh; }
    .kv-list { padding-inline: 0.25rem; }
    .kv { grid-template-columns: 4rem minmax(0, 1fr); gap: 0.45rem; padding-inline: 0.5rem; }
    .settings-grid { gap: 0.5rem; padding: 0.2rem 0.15rem 0.6rem; }
    .modal-panel .account-table { min-width: 39rem; }
  }
  @media (max-width: 380px) {
    .brand-wordmark img { height: 1.42rem; max-width: 10.5rem; }
    .topbar .top-actions .tool { font-size: 0.68rem; }
    .kpi .k { font-size: 0.86rem; }
    .kpi .v { font-size: 1.05rem; }
  }

  /* Quiet data cockpit: visual-only refresh. Layout rules above stay unchanged. */
  body {
    font-feature-settings: "kern" 1, "tnum" 1;
    font-variant-numeric: tabular-nums;
    text-rendering: geometricPrecision;
    -webkit-font-smoothing: antialiased;
    background:
      radial-gradient(70rem 30rem at 12% -12%, rgba(79, 140, 255, 0.11), transparent 60%),
      linear-gradient(180deg, #0b1020 0%, #08101b 100%);
  }
  .topbar, .kpis, .panel {
    background: var(--panel);
    border-color: var(--line);
    box-shadow: var(--shadow);
    backdrop-filter: blur(8px) saturate(1.05);
  }
  .chip {
    color: #d7e3f2;
    background: rgba(79, 140, 255, 0.08);
    border-color: rgba(113, 167, 255, 0.24);
    backdrop-filter: none;
  }
  .chip.ok {
    color: #bdf5dd;
    background: rgba(52, 211, 153, 0.1);
    border-color: rgba(52, 211, 153, 0.24);
  }
  .chip.warn {
    color: #fde7aa;
    background: rgba(251, 191, 36, 0.1);
    border-color: rgba(251, 191, 36, 0.24);
  }
  .chip.ghost {
    color: var(--muted);
    background: rgba(148, 163, 184, 0.055);
    border-color: var(--line-2);
  }
  .chip.ghost b.cyan { color: var(--cyan); text-shadow: none; }
  .dot { box-shadow: none; }
  .dot.pulse { box-shadow: 0 0 7px rgba(34, 211, 238, 0.3); }
  .overall .bar { background: rgba(148, 163, 184, 0.12); }
  .overall .bar > span,
  .overall .bar.ok > span {
    background: linear-gradient(90deg, var(--cyan), var(--green));
    box-shadow: none;
  }
  .kpi .k { letter-spacing: 0.04em; }
  .kpi .v,
  .kpi .v.green,
  .kpi .v.cyan,
  .kpi .v.yellow,
  .kpi .v.red { text-shadow: none; }
  .panel > .head h2 { font-weight: 650; }
  .panel > .head h2::before {
    background: var(--cyan);
    box-shadow: 0 0 6px rgba(34, 211, 238, 0.2);
  }
  thead th {
    color: #9fb0c5;
    background: var(--panel-2);
    font-weight: 600;
    letter-spacing: 0.035em;
  }
  th, td { border-bottom-color: rgba(129, 156, 190, 0.12); }
  table th:not(:last-child),
  table td:not(:last-child) {
    border-right: 1px solid rgba(129, 156, 190, 0.16);
  }
  table thead th:not(:last-child) {
    border-right-color: rgba(129, 156, 190, 0.16);
  }
  tbody tr:hover td { background: rgba(79, 140, 255, 0.075); }
  .badge.done {
    color: #bdf5dd;
    background: rgba(52, 211, 153, 0.1);
    border-color: rgba(52, 211, 153, 0.24);
  }
  .badge.run {
    color: #dbeafe;
    background: rgba(79, 140, 255, 0.12);
    border-color: rgba(113, 167, 255, 0.32);
  }
  .badge.wait {
    color: var(--muted);
    background: rgba(148, 163, 184, 0.06);
    border-color: var(--line-2);
  }
  .badge.warn {
    color: #fde7aa;
    background: rgba(251, 191, 36, 0.1);
    border-color: rgba(251, 191, 36, 0.24);
  }
  .badge.err {
    color: #fecdd3;
    background: rgba(251, 113, 133, 0.1);
    border-color: rgba(251, 113, 133, 0.28);
  }
  button.tool {
    color: #d7e0eb;
    background: rgba(79, 140, 255, 0.055);
    border-color: var(--line-2);
    font-weight: 600;
  }
  button.tool:hover:not(:disabled) {
    color: #ffffff;
    background: rgba(79, 140, 255, 0.12);
    border-color: rgba(113, 167, 255, 0.48);
    box-shadow: 0 0.25rem 0.8rem rgba(0, 0, 0, 0.12);
  }
  button.tool.primary {
    color: #ffffff;
    background: rgba(37, 99, 235, 0.5);
    border-color: rgba(113, 167, 255, 0.62);
  }
  button.tool.danger {
    color: var(--red);
    background: rgba(251, 113, 133, 0.04);
    border-color: rgba(251, 113, 133, 0.58);
  }
  button.tool.danger:hover:not(:disabled) {
    color: #ffe4e8;
    background: rgba(251, 113, 133, 0.12);
    border-color: rgba(251, 113, 133, 0.78);
  }
  button.tool:disabled { opacity: 0.34; }
  input, select {
    color: var(--text);
    background: rgba(12, 25, 42, 0.72);
    border-color: var(--line-2);
  }
  input:focus, select:focus {
    border-color: rgba(79, 140, 255, 0.58);
    box-shadow: 0 0 0 2px rgba(79, 140, 255, 0.12);
  }
  .tab {
    color: var(--muted);
    background: rgba(148, 163, 184, 0.055);
    border-color: var(--line-2);
  }
  .tab.on {
    color: #eff6ff;
    background: rgba(37, 99, 235, 0.44);
    border-color: rgba(113, 167, 255, 0.58);
    box-shadow: none;
  }
  .tab .live-dot { box-shadow: 0 0 6px rgba(34, 211, 238, 0.28); }
  .mini > span { box-shadow: none; }
  .cat-chip {
    color: #cad6e7;
    background: rgba(83, 101, 141, 0.2);
    border-color: rgba(130, 150, 191, 0.24);
  }
  .kv { background: rgba(18, 35, 56, 0.72); border-color: var(--line); }
  .event::before { box-shadow: none; }
  .event.newest::before { box-shadow: 0 0 7px rgba(34, 211, 238, 0.3); }

  html[data-theme="light"] body {
    background: linear-gradient(180deg, #f7f9fc 0%, #edf2f7 100%);
  }
  html[data-theme="light"] .brand-wordmark img {
    filter: drop-shadow(0 0 0.18rem rgba(0,120,210,0.34));
  }
  html[data-theme="light"] .topbar,
  html[data-theme="light"] .kpis,
  html[data-theme="light"] .panel { background: var(--panel); border-color: var(--line); box-shadow: var(--shadow); }
  html[data-theme="light"] .chip { color: #29466d; background: rgba(37, 99, 235, 0.07); border-color: rgba(37, 99, 235, 0.2); }
  html[data-theme="light"] .chip.ok { color: #126344; background: rgba(21, 131, 93, 0.08); border-color: rgba(21, 131, 93, 0.2); }
  html[data-theme="light"] button.tool { color: #263b5e; background: #f7f9fc; border-color: var(--line-2); }
  html[data-theme="light"] button.tool:hover:not(:disabled) { color: #174984; background: #eef4ff; border-color: rgba(37, 99, 235, 0.4); }
  html[data-theme="light"] button.tool.primary { color: #ffffff; background: #2563eb; border-color: #2563eb; }
  html[data-theme="light"] button.tool.danger { color: #b8324b; background: #fff8f9; border-color: rgba(194, 65, 90, 0.45); }
  html[data-theme="light"] input,
  html[data-theme="light"] select { color: var(--text); background: #f8fafc; border-color: var(--line-2); }
  html[data-theme="light"] .tab { color: #455a75; background: #f7f9fc; border-color: var(--line-2); }
  html[data-theme="light"] .tab.on { color: #ffffff; background: #2563eb; border-color: #2563eb; box-shadow: none; }
  html[data-theme="light"] .cat-chip { color: #354e76; background: #eef2f8; border-color: rgba(75, 97, 130, 0.2); }
  html[data-theme="light"] .kv { background: #f6f8fb; border-color: var(--line); }
  html[data-theme="light"] thead th { color: #4f6178; background: var(--panel-2); }
  html[data-theme="light"] table th:not(:last-child),
  html[data-theme="light"] table td:not(:last-child) { border-right-color: rgba(50, 72, 100, 0.16); }
  html[data-theme="light"] table thead th:not(:last-child) { border-right-color: rgba(50, 72, 100, 0.16); }

  @media (prefers-color-scheme: light) {
    html:not([data-theme="dark"]) body { background: linear-gradient(180deg, #f7f9fc 0%, #edf2f7 100%); }
    html:not([data-theme="dark"]) .brand-wordmark img {
      filter: drop-shadow(0 0 0.18rem rgba(0,120,210,0.34));
    }
    html:not([data-theme="dark"]) .topbar,
    html:not([data-theme="dark"]) .kpis,
    html:not([data-theme="dark"]) .panel { background: var(--panel); border-color: var(--line); box-shadow: var(--shadow); }
    html:not([data-theme="dark"]) button.tool { color: #263b5e; background: #f7f9fc; border-color: var(--line-2); }
    html:not([data-theme="dark"]) button.tool.primary { color: #ffffff; background: #2563eb; border-color: #2563eb; }
    html:not([data-theme="dark"]) input,
    html:not([data-theme="dark"]) select { color: var(--text); background: #f8fafc; border-color: var(--line-2); }
    html:not([data-theme="dark"]) .tab.on { color: #ffffff; background: #2563eb; border-color: #2563eb; box-shadow: none; }
    html:not([data-theme="dark"]) table th:not(:last-child),
    html:not([data-theme="dark"]) table td:not(:last-child) { border-right-color: rgba(50, 72, 100, 0.16); }
    html:not([data-theme="dark"]) table thead th:not(:last-child) { border-right-color: rgba(50, 72, 100, 0.16); }
  }

  /* Edge can promote each blurred dashboard surface to an expensive compositing layer. */
  html.edge-browser {
    --shadow: 0 3px 12px rgba(0, 0, 0, 0.16);
  }
  html.edge-browser body {
    background: linear-gradient(180deg, #0b1020 0%, #08101b 100%);
  }
  html.edge-browser .topbar,
  html.edge-browser .kpis,
  html.edge-browser .panel,
  html.edge-browser .chip,
  html.edge-browser .overlay {
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
  html.edge-browser .brand-wordmark img { filter: none; }
  html.edge-browser tbody tr,
  html.edge-browser button.tool,
  html.edge-browser .tab,
  html.edge-browser .sort-trigger svg {
    transition: none;
  }
  html.edge-browser .panel > .head h2::before,
  html.edge-browser .tab .live-dot,
  html.edge-browser .event.newest::before,
  html.edge-browser .dot.pulse {
    box-shadow: none;
  }
  html.edge-browser[data-theme="light"] body {
    background: linear-gradient(180deg, #f7f9fc 0%, #edf2f7 100%);
  }
</style>
</head>
<body>
<div class="app">
  <div class="topbar">
    <div class="brand">
      <h1 class="brand-wordmark"><img src="/brand-wordmark.png" alt="AMTools 实时看板" decoding="async"></h1>
      <span class="app-version" title="AMTools v${AMTOOLS_VERSION}">v${AMTOOLS_VERSION}</span>
      <button class="tool theme-toggle" id="themeToggle" type="button" title="切换主题" aria-label="切换主题"></button>
    </div>
    <div class="chips top-context">
      <div class="week-anchor-control">
        <label for="weekAnchorInput">采集周起始日（可多选）</label>
        <div class="date-input-row">
          <div class="date-input-shell">
            <input id="weekAnchorInput" type="text" autocomplete="off" placeholder="请选择周一" readonly aria-haspopup="dialog">
            <button class="tool" id="weekAnchorPickerButton" type="button" title="打开日历选择" aria-label="打开日历选择">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01"/></svg>
            </button>
          </div>
          <div class="calendar-popup" id="weekAnchorCalendar" hidden></div>
        </div>
      </div>
      <span class="chip ghost">阶段 <b id="stage">--</b></span>
    </div>
    <div class="grow"></div>
    <div class="chips top-actions">
      <button class="tool" id="historyOpen" type="button">历史记录</button>
      <button class="tool" id="settingsOpen" type="button">设置</button>
      <button class="tool danger" id="runStop" type="button">停止</button>
      <button class="tool" id="pageRefresh" type="button">刷新看板</button>
      <button class="tool" id="runStart" type="button">开始采集</button>
      <button class="tool primary" id="runStartFresh" type="button">全新采集</button>
    </div>
  </div>

  <div class="overall">
    <div class="bar" id="overallBar"><span></span></div>
    <span class="pct" id="overallPct">--%</span>
  </div>

  <div class="kpis" id="kpis"></div>

  <div class="main">
    <div class="col">
      <section class="panel" data-panel="weekly-overview" style="flex:0 0 auto">
        <div class="head">
          <h2>全部采集周</h2>
          <span class="hint" id="weeksHint">批次内所有日期同时展示</span>
          <div class="grow"></div>
          <span class="hint" id="weeksQueueHint"></span>
        </div>
        <div class="body batch-weeks-body" id="batchWeeks"></div>
      </section>

      <section class="panel" data-panel="focus-apps" style="flex:1" id="focusPanel">
        <div class="head">
          <h2>焦点应用</h2>
          <div class="tabs" id="tabs"></div>
          <div class="grow"></div>
          <input type="search" id="search" placeholder="搜索名称 / 发行商">
          <div class="sort-menu" id="sortMenu">
            <button class="sort-trigger" id="sortBy" type="button" aria-haspopup="listbox" aria-expanded="false">按本周排名
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>
            </button>
            <div class="sort-options" id="sortOptions" role="listbox" aria-label="焦点应用排序方式" hidden>
              <button class="sort-option" type="button" role="option" data-sort="rank" aria-selected="true">按本周排名</button>
              <button class="sort-option" type="button" role="option" data-sort="change" aria-selected="false">按上升幅度</button>
            </div>
          </div>
        </div>
        <div class="body">
          <table>
            <thead><tr>
              <th class="num">排名</th><th>应用</th><th>品类</th><th>6周轨迹</th>
              <th>下载前三国家</th><th>总部</th><th>上线日期</th><th>排名概述</th>
            </tr></thead>
            <tbody id="focusRows"></tbody>
          </table>
        </div>
      </section>
    </div>

    <div class="col">
      <section class="panel" data-panel="market-split" style="flex:0 0 auto">
        <div class="head"><h2>焦点市场分布</h2></div>
        <div class="split" id="splitBar"></div>
        <div class="split-legend" id="splitLegend"></div>
      </section>

      <section class="panel" data-panel="events" style="flex:1">
        <div class="head"><h2>事件流</h2><div class="grow"></div>
          <span class="hint api-links">
            <button class="api-link" type="button" data-event-filter="all">全部周</button>
            <button class="api-link" type="button" data-event-filter="current">当前运行周</button>
            <button class="api-link" type="button" data-event-filter="errors">仅异常</button>
          </span>
        </div>
        <div class="body timeline" id="events"></div>
      </section>

      <section class="panel" data-panel="context" style="flex:0 0 auto">
        <div class="head"><h2>运行上下文</h2></div>
        <div class="kv-list" id="ctx"></div>
      </section>
    </div>
  </div>
</div>
<div class="overlay" id="historyOverlay">
  <section class="panel modal-panel history-panel" id="historyPanel">
    <div class="head">
      <h2>历史记录</h2>
      <span class="hint" id="historyHint">每次采集独立保存</span>
      <div class="grow"></div>
      <button class="tool" id="historyRefresh" type="button">刷新</button>
      <button class="tool danger" id="historyBatchSyncStop" type="button" hidden>停止同步</button>
      <button class="tool primary" id="historyBatchSync" type="button" disabled>批量同步到飞书</button>
      <button class="tool" id="historyClose" type="button">关闭</button>
    </div>
    <div class="body history-body">
      <div class="history-list-wrap">
        <table class="history-table">
          <colgroup><col class="history-select-col"><col><col><col><col><col><col class="history-action-col"></colgroup>
          <thead><tr><th><input type="checkbox" id="historySelectAll" aria-label="批量选择：选择未同步和同步失败记录"></th><th>采集周</th><th>采集时间</th><th>采集状态</th><th>同步状态</th><th>结果</th><th>操作</th></tr></thead>
          <tbody id="historyRows"></tbody>
        </table>
      </div>
      <section class="history-detail" id="historyDetail">
        <div class="empty">选择一条记录查看详情</div>
      </section>
    </div>
  </section>
</div>
<div class="overlay" id="settingsOverlay">
  <section class="panel modal-panel" id="settingsPanel">
    <div class="head">
      <h2>设置</h2>
      <span class="hint" id="accountsHint">本机账号目录</span>
      <div class="grow"></div>
      <button class="tool" id="accountRefresh" type="button">检测登录态</button>
      <button class="tool" id="settingsClose" type="button">关闭</button>
    </div>
    <div class="body">
      <div class="settings-grid">
        <div class="field">
          <label>账号池</label>
          <div class="account-bulk">
            <button class="tool primary" id="accountsEnableAll" type="button">全部启用</button>
            <button class="tool" id="accountsDisableAll" type="button">全部停用</button>
          </div>
        </div>
        <div class="field">
          <label for="topDepthTrigger">榜单深度</label>
          <input id="topDepthInput" type="hidden" value="100">
          <div class="sort-menu" id="topDepthMenu">
            <button class="sort-trigger" id="topDepthTrigger" type="button" aria-haspopup="listbox" aria-expanded="false">Top 100
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>
            </button>
            <div class="sort-options" id="topDepthOptions" role="listbox" aria-label="榜单深度" hidden>
              <button class="sort-option" type="button" role="option" data-top-depth="100" aria-selected="true">Top 100</button>
              <button class="sort-option" type="button" role="option" data-top-depth="1000" aria-selected="false">Top 1000</button>
            </div>
          </div>
        </div>
        <div class="field category-field">
          <label>采集品类 <span class="category-select-hint" id="categorySelectHint">7 / 7 已选择</span></label>
          <div class="category-toolbar">
            <button class="tool primary" id="categoriesSelectAll" type="button">全选</button>
            <button class="tool" id="categoriesClear" type="button">清空</button>
          </div>
          <div class="category-options" id="categoryOptions">
            <label class="category-option"><input type="checkbox" data-category value="超休闲"><span>超休闲</span></label>
            <label class="category-option"><input type="checkbox" data-category value="休闲"><span>休闲</span></label>
            <label class="category-option"><input type="checkbox" data-category value="壁纸"><span>壁纸</span></label>
            <label class="category-option"><input type="checkbox" data-category value="Launcher"><span>Launcher</span></label>
            <label class="category-option"><input type="checkbox" data-category value="杀毒软件、清理"><span>杀毒软件、清理</span></label>
            <label class="category-option"><input type="checkbox" data-category value="文件恢复"><span>文件恢复</span></label>
            <label class="category-option"><input type="checkbox" data-category value="PDF阅读器"><span>PDF阅读器</span></label>
          </div>
        </div>
      </div>
      <div class="login-help">未登录或登录失效时，点击账号行的“登录”，再在弹框中粘贴邮件登录链接。</div>
      <table class="account-table">
        <thead><tr><th>账号</th><th>启用</th><th>账号目录</th><th>邮箱</th><th>登录态</th><th>操作</th></tr></thead>
        <tbody id="accountRows"></tbody>
      </table>
    </div>
  </section>
</div>
<div class="overlay login-overlay" id="accountLoginOverlay">
  <section class="panel login-panel" id="accountLoginPanel">
    <div class="head">
      <h2 id="accountLoginTitle">登录账号</h2>
      <div class="grow"></div>
      <a class="login-site-button" id="amdcLoginSite" href="https://appmagic.rocks/top-charts/apps" target="_blank" rel="noreferrer">打开登录网站</a>
      <button class="tool" id="accountLoginClose" type="button">关闭</button>
    </div>
    <div class="body">
      <div class="login-profile-card">
        <div>
          <div id="accountLoginLabel">账号</div>
          <div class="profile-name" id="accountLoginProfile">--</div>
        </div>
        <div id="accountLoginState"><span class="badge wait">未创建</span></div>
      </div>
      <form class="login-form" id="accountLoginForm">
        <label for="accountLoginUrl">邮件登录链接</label>
        <input type="url" id="accountLoginUrl" placeholder="粘贴 https://appmagic.rocks/login?code=..." autocomplete="off" spellcheck="false">
        <div class="login-dialog-message" id="accountLoginMessage"></div>
        <div class="login-dialog-actions">
          <button class="tool primary" id="accountLoginSubmit" type="submit">登录</button>
        </div>
      </form>
    </div>
  </section>
</div>
<div class="overlay system-dialog-overlay" id="systemDialogOverlay" aria-hidden="true">
  <section class="panel system-dialog-panel" id="systemDialogPanel" role="dialog" aria-modal="true" aria-labelledby="systemDialogTitle" tabindex="-1">
    <div class="head">
      <h2 id="systemDialogTitle">提示</h2>
      <div class="grow"></div>
      <button class="tool" id="systemDialogClose" type="button">关闭</button>
    </div>
    <div class="body">
      <div class="system-dialog-message" id="systemDialogMessage"></div>
      <div class="system-dialog-actions">
        <button class="tool" id="systemDialogCancel" type="button" hidden>取消</button>
        <button class="tool primary" id="systemDialogAccept" type="button">确定</button>
      </div>
    </div>
  </section>
</div>

<script>
(function () {
  var ALL = '__all__';
  var S = {
    data: null,
    tab: ALL,
    sortBy: 'rank',
    search: '',
    eventFilter: 'all',
    expandedWeekId: null,
    expandedWeekBatchId: '',
    health: null,
    healthLoading: false,
    es: null,
    pollTimer: null,
    accounts: { accounts: [], loading: true, loaded: false, error: '' },
    loginDialog: { open: false, profile: '', loading: false, error: '', success: false, message: '' },
    history: { records: [], loading: false, error: '', selected: null, detail: null, viewingId: '', syncingId: '', selectedSyncIds: [], batchSelectMode: '', syncProgressTimer: 0, batchSync: null, batchRequestPending: false, batchRequestStartedAt: 0 },
    run: { active: false, loading: false, stopping: false, job: null },
    failedChildAlertKeys: {},
    selectedRunId: '',
    selectedWeekAnchor: '',
    snapshotRequestSeq: 0,
    freshHistoryCheckLoading: false
  };
  var pageHistoryClearedAt = 0;
  var SETTINGS_KEY = 'amdc_dashboard_settings_v1';
  var API_HEADERS = { 'X-AMDC-Token': '${DASHBOARD_TOKEN}' };
  var CATEGORY_OPTIONS = ['超休闲', '休闲', '壁纸', 'Launcher', '杀毒软件、清理', '文件恢复', 'PDF阅读器'];
  // AMDC 品类页链接：必须保留 domain → 父标签 → 末级标签的完整层级，与采集器 CATS 一致。
  var CAT_TAG = {
    '超休闲': '3,126',
    '休闲': '3,243572',
    'Launcher': '9,76,243528',
    '杀毒软件、清理': '9,115,119',
    '文件恢复': '9,115,243477',
    'PDF阅读器': '9,243756,244699',
    '壁纸': '9,76,77'
  };
  function catUrl(label) {
    var id = CAT_TAG[label];
    return id ? 'https://appmagic.rocks/top-charts/apps?tag=' + id : '';
  }

  var systemDialogQueue = [];
  var activeSystemDialog = null;

  function layoutSystemDialogMessage(message, item) {
    message.classList.remove('is-multiline');
    window.requestAnimationFrame(function () {
      if (activeSystemDialog !== item) return;
      var lineHeight = parseFloat(window.getComputedStyle(message).lineHeight) || 0;
      var height = message.getBoundingClientRect().height;
      message.classList.toggle('is-multiline', lineHeight > 0 && height > lineHeight * 1.5);
    });
  }

  function renderSystemDialog() {
    var overlay = document.getElementById('systemDialogOverlay');
    var panel = document.getElementById('systemDialogPanel');
    var title = document.getElementById('systemDialogTitle');
    var message = document.getElementById('systemDialogMessage');
    var close = document.getElementById('systemDialogClose');
    var cancel = document.getElementById('systemDialogCancel');
    var accept = document.getElementById('systemDialogAccept');
    if (!overlay || !panel || !title || !message || !close || !cancel || !accept) return;
    var item = activeSystemDialog;
    overlay.classList.toggle('open', !!item);
    overlay.setAttribute('aria-hidden', item ? 'false' : 'true');
    if (!item) return;
    panel.dataset.tone = item.tone || 'info';
    title.textContent = item.title || (item.kind === 'confirm' ? '请确认' : '提示');
    message.textContent = item.message || '';
    layoutSystemDialogMessage(message, item);
    cancel.hidden = item.kind !== 'confirm';
    accept.textContent = item.confirmText || '确定';
    close.textContent = item.kind === 'confirm' ? '取消' : '关闭';
    window.setTimeout(function () { accept.focus(); }, 0);
  }

  function showNextSystemDialog() {
    if (activeSystemDialog || !systemDialogQueue.length) return;
    activeSystemDialog = systemDialogQueue.shift();
    renderSystemDialog();
  }

  function settleSystemDialog(accepted) {
    var item = activeSystemDialog;
    if (!item) return;
    activeSystemDialog = null;
    renderSystemDialog();
    item.resolve(!!accepted);
    window.setTimeout(showNextSystemDialog, 0);
  }

  function showSystemDialog(options) {
    return new Promise(function (resolve) {
      systemDialogQueue.push(Object.assign({ kind: 'alert', title: '提示', message: '', confirmText: '确定', tone: 'info', resolve: resolve }, options || {}));
      showNextSystemDialog();
    });
  }

  function showSystemAlert(message, title, tone) {
    return showSystemDialog({ kind: 'alert', title: title || '提示', message: String(message || ''), tone: tone || 'info' });
  }

  function showSystemConfirm(message, title, confirmText, tone) {
    return showSystemDialog({ kind: 'confirm', title: title || '请确认', message: String(message || ''), confirmText: confirmText || '确定', tone: tone || 'info' });
  }

  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function maskAccountEmail(email) {
    var value = String(email || '').trim();
    var at = value.indexOf('@');
    if (at <= 0) return value ? '***' : '';
    var local = value.slice(0, at);
    var visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
    return visible + '***' + value.slice(at);
  }
  function clip(v, n) {
    var s = String(v == null ? '' : v);
    return s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s;
  }
  function loadJson(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? Object.assign({}, fallback, JSON.parse(raw)) : Object.assign({}, fallback);
    } catch (e) {
      return Object.assign({}, fallback);
    }
  }
  function saveJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }
  function apiPost(url, options) {
    options = Object.assign({ method: 'POST', cache: 'no-store' }, options || {});
    options.headers = Object.assign({}, options.headers || {}, API_HEADERS);
    return fetch(url, options);
  }
  function historyStatusLabel(status) {
    return { done: '完成', failed: '失败', stopped: '已停止', starting: '启动中', running: '运行中', interrupted: '中断', legacy: '旧版数据' }[status] || status || '--';
  }
  function historySyncState(record) {
    var status = record && record.feishuSync && record.feishuSync.status;
    if (status === 'done') return { key: 'done', label: '完成' };
    if (status === 'syncing' || status === 'queued') return { key: 'syncing', label: '同步中' };
    if (status === 'failed') return { key: 'failed', label: '失败' };
    return { key: 'unsynced', label: '未同步' };
  }
  function historyTime(value) {
    if (!value) return '--';
    var date = new Date(value);
    return isNaN(date.getTime()) ? '--' : date.toLocaleString();
  }
  function historyDuration(record) {
    if (!record || !record.startedAt || !record.finishedAt) return '--';
    var ms = new Date(record.finishedAt).getTime() - new Date(record.startedAt).getTime();
    if (!isFinite(ms) || ms < 0) return '--';
    var total = Math.round(ms / 1000), h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    return (h ? h + '小时 ' : '') + (m ? m + '分 ' : '') + s + '秒';
  }
  function historyBatchSyncActive() {
    return !!(S.history.batchSync && ['syncing', 'stopping', 'rolling_back'].indexOf(S.history.batchSync.status) >= 0);
  }
  function selectableHistorySyncRecords() {
    if (historyBatchSyncActive()) return [];
    return S.history.records.filter(function (record) {
      var syncStatus = record.feishuSync && record.feishuSync.status;
      return record.status === 'done' && !record.legacy && syncStatus !== 'syncing' && syncStatus !== 'queued';
    });
  }
  function togglePendingHistorySyncSelection() {
    var selectableRecords = selectableHistorySyncRecords();
    var pendingIds = selectableRecords.filter(function (record) {
      var key = historySyncState(record).key;
      return key === 'unsynced' || key === 'failed';
    }).map(function (record) { return record.id; });
    var allPendingSelected = pendingIds.length > 0
      && pendingIds.length === S.history.selectedSyncIds.length
      && pendingIds.every(function (id) { return S.history.selectedSyncIds.indexOf(id) >= 0; });
    if (allPendingSelected) {
      S.history.selectedSyncIds = [];
      S.history.batchSelectMode = '';
    } else {
      S.history.selectedSyncIds = pendingIds;
      S.history.batchSelectMode = pendingIds.length ? 'pending' : '';
    }
    renderHistory();
  }
  function applyHistoryBatchSyncFromServer(batchSync) {
    if (batchSync) {
      S.history.batchSync = batchSync;
      return;
    }
    // 服务端返回 null 表示批次已经结束或进程已中断。仅在刚发起请求的
    // 5 秒竞态窗口内保留旧状态；没有有效开始时间时也必须立即清除，
    // 不能让旧的 rolling_back 状态永久卡住按钮。
    var requestAge = S.history.batchRequestStartedAt
      ? Date.now() - S.history.batchRequestStartedAt
      : Infinity;
    if (S.history.batchRequestPending && requestAge < 5000) return;
    S.history.batchSync = null;
    S.history.batchRequestPending = false;
    S.history.batchRequestStartedAt = 0;
    S.history.syncingId = '';
    stopHistorySyncPolling();
  }
  function renderHistory() {
    var rows = document.getElementById('historyRows');
    var hint = document.getElementById('historyHint');
    if (!rows) return;
    if (S.history.loading) {
          rows.innerHTML = '<tr><td colspan="7" class="empty">正在读取历史记录…</td></tr>';
    } else if (S.history.error) {
      rows.innerHTML = '<tr><td colspan="7" class="empty">' + esc(S.history.error) + '</td></tr>';
    } else if (!S.history.records.length) {
      rows.innerHTML = '<tr><td colspan="7" class="empty history-empty">暂无历史记录，完成一次采集后会自动保存。</td></tr>';
    } else {
      var batchActive = historyBatchSyncActive();
      var batchIds = batchActive && Array.isArray(S.history.batchSync.ids) ? S.history.batchSync.ids : [];
      rows.innerHTML = S.history.records.map(function (record) {
        var summary = record.resultSummary || {};
        var result = summary.categories != null ? (num(summary.categories) + ' 品类 / ' + num(summary.focusCount) + ' 焦点') : '--';
        var syncState = historySyncState(record);
        var recordSyncing = record.feishuSync && (record.feishuSync.status === 'syncing' || record.feishuSync.status === 'queued');
        var recordInBatch = batchActive && batchIds.indexOf(record.id) >= 0;
        var batchSyncLabel = recordInBatch && record.feishuSync && record.feishuSync.status === 'done'
          ? '已同步'
          : (recordInBatch && record.feishuSync && record.feishuSync.status === 'failed' ? '同步失败' : '批量同步中…');
        var selectable = !batchActive && record.status === 'done' && !record.legacy && !recordSyncing;
        var selected = S.history.selectedSyncIds.indexOf(record.id) >= 0;
        return '<tr>' +
          '<td><input type="checkbox" data-history-select="' + esc(record.id) + '"' + (selected ? ' checked' : '') + (selectable ? '' : ' disabled') + ' aria-label="选择 ' + esc(record.weekAnchor || '') + '"></td>' +
          '<td>' + esc(record.weekAnchor || '--') + '</td>' +
          '<td>' + esc(historyTime(record.startedAt)) + '</td>' +
          '<td><span class="history-status ' + esc(record.status || '') + '">' + esc(historyStatusLabel(record.status)) + '</span></td>' +
          '<td><span class="history-status ' + esc(syncState.key) + '">' + esc(syncState.label) + '</span></td>' +
          '<td>' + esc(result) + '</td>' +
          '<td class="history-action-cell"><span class="history-actions">' +
            (record.status === 'done' && !record.legacy
              ? '<button class="tool" type="button" data-history-sync="' + esc(record.id) + '"' + (batchActive || recordSyncing ? ' disabled' : '') + '>' + (recordInBatch ? batchSyncLabel : (recordSyncing ? '同步中…' : '同步到飞书')) + '</button>'
              : '') +
            '<button class="tool" type="button" data-history-view="' + esc(record.id) + '">查看</button>' +
            (record.legacy ? '' : '<button class="tool danger" type="button" data-history-delete="' + esc(record.id) + '">删除</button>') +
          '</span></td>' +
        '</tr>';
      }).join('');
    }
    if (hint) hint.textContent = S.history.error || ('共 ' + S.history.records.length + ' 条记录');
    var batchActive = historyBatchSyncActive();
    var selectableIds = selectableHistorySyncRecords().map(function (record) { return record.id; });
    S.history.selectedSyncIds = S.history.selectedSyncIds.filter(function (id) { return selectableIds.indexOf(id) >= 0; });
    var selectAll = document.getElementById('historySelectAll');
    if (selectAll) {
      var pendingIds = selectableHistorySyncRecords().filter(function (record) {
        var key = historySyncState(record).key;
        return key === 'unsynced' || key === 'failed';
      }).map(function (record) { return record.id; });
      selectAll.checked = pendingIds.length > 0
        && pendingIds.every(function (id) { return S.history.selectedSyncIds.indexOf(id) >= 0; });
      selectAll.indeterminate = false;
      selectAll.disabled = selectableIds.length === 0;
    }
    var batchButton = document.getElementById('historyBatchSync');
    var batchStopButton = document.getElementById('historyBatchSyncStop');
    if (batchStopButton) {
      batchStopButton.hidden = !batchActive;
      batchStopButton.disabled = !batchActive || !S.history.batchSync || S.history.batchSync.status !== 'syncing';
      batchStopButton.textContent = S.history.batchSync && S.history.batchSync.status === 'syncing' ? '停止同步' : '恢复中...';
    }
    if (batchButton) {
      batchButton.disabled = batchActive || S.history.selectedSyncIds.length === 0;
      batchButton.textContent = batchActive
        ? ('批量同步中（' + num(S.history.batchSync.completed || 0) + '/' + num(S.history.batchSync.total || 0) + '）')
        : (S.history.selectedSyncIds.length ? ('批量同步到飞书（' + S.history.selectedSyncIds.length + '）') : '批量同步到飞书');
    }
    renderHistoryDetail();
  }
  function renderHistoryDetail() {
    var body = document.getElementById('historyDetail');
    var record = S.history.selected;
    if (!body) return;
    var batchSync = S.history.batchSync || {};
    var batchActive = historyBatchSyncActive();
    var batchPercent = Math.max(0, Math.min(100, Number(batchSync.progress) || 0));
    var batchModule = batchActive
      ? '<section class="history-sync-module"><div class="history-sync-module-head"><span>批量同步整体进度</span><strong>' + num(batchPercent) + '%</strong></div><div class="history-sync-track"><span style="width:' + batchPercent + '%"></span></div><p class="history-sync-module-message">' + esc(batchSync.message || ('已完成 ' + num(batchSync.completed || 0) + '/' + num(batchSync.total || 0))) + '</p></section>'
      : '';
    if (!record) {
      body.innerHTML = batchModule || '<div class="empty">选择一条记录查看详情</div>';
      return;
    }
    var result = S.history.detail || {};
    var summary = record.resultSummary || {};
    var sync = record.feishuSync || {};
    var syncState = historySyncState(record);
    var syncPercent = Math.max(0, Math.min(100, Number(sync.progress) || 0));
    var syncInfo = record.feishuSync && sync.status !== 'syncing'
      ? '<div class="kv"><span class="k">' + (sync.status === 'done' ? '同步时间' : '飞书同步') + '</span><span class="v">' + esc(sync.status === 'done' ? historyTime(sync.syncedAt) : ('失败：' + (sync.error || '--'))) + '</span></div>'
      : '';
    var syncModule = batchActive ? batchModule : sync.status === 'syncing'
      ? '<section class="history-sync-module"><div class="history-sync-module-head"><span>飞书同步进度</span><strong>' + num(syncPercent) + '%</strong></div><div class="history-sync-track"><span style="width:' + syncPercent + '%"></span></div><p class="history-sync-module-message">' + esc(sync.message || '同步中') + '</p></section>'
      : '';
    var cats = (result.categories || []).map(function (cat) {
      return '<div class="kv"><span class="k">' + esc(cat.category || '--') + '</span><span class="v">榜单 ' + num(cat.records) + ' · 焦点 ' + num(cat.focusCount) + ' · 新入前百 ' + num(cat.newTop100) + '</span></div>';
    }).join('');
    var failureInfo = record.status === 'failed'
      ? '<div class="kv history-failure-reason"><span class="k">失败原因</span><span class="v">' + esc(record.detail || '采集失败，暂无详细原因') + '</span></div>'
      : '';
    body.innerHTML = '<div class="history-detail-content">' +
      '<div class="kv-list">' +
        '<div class="kv"><span class="k">采集周</span><span class="v">' + esc(record.weekAnchor || '--') + '</span></div>' +
        '<div class="kv"><span class="k">采集状态</span><span class="v"><span class="history-status ' + esc(record.status || '') + '">' + esc(historyStatusLabel(record.status)) + '</span></span></div>' +
        '<div class="kv"><span class="k">同步状态</span><span class="v"><span class="history-status ' + esc(syncState.key) + '">' + esc(syncState.label) + '</span></span></div>' +
        '<div class="kv"><span class="k">采集时间</span><span class="v">' + esc(historyTime(record.startedAt)) + '</span></div>' +
        '<div class="kv"><span class="k">耗时</span><span class="v">' + esc(historyDuration(record)) + '</span></div>' +
        '<div class="kv"><span class="k">结果</span><span class="v">品类 ' + num(summary.categories || (result.categories || []).length) + ' · 榜单 ' + num(summary.records) + ' · 焦点 ' + num(summary.focusCount) + '</span></div>' +
        failureInfo +
        syncInfo +
      '</div>' +
      (cats ? '<h3 style="margin-top:0.9rem">品类结果</h3><div class="kv-list">' + cats + '</div>' : (record.status === 'failed' ? '' : '<div class="empty">该记录暂无结果摘要</div>')) + syncModule + '</div>';
  }
  function loadHistory() {
    S.history.loading = true;
    S.history.error = '';
    renderHistory();
    return fetch('/api/history', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok) throw new Error(j.error || '历史记录读取失败');
        S.history.records = j.records || [];
        applyHistoryBatchSyncFromServer(j.batchSync || null);
        if (resumeSyncingHistoryRecord()) startHistorySyncPolling();
        else { S.history.syncingId = ''; stopHistorySyncPolling(); }
        S.history.loading = false;
        renderHistory();
        if (weekAnchorCalendar && !weekAnchorCalendar.hidden) renderWeekAnchorCalendar();
      })
      .catch(function (e) {
        S.history.loading = false;
        S.history.error = e && e.message ? e.message : '历史记录读取失败';
        renderHistory();
      });
  }
  function resumeSyncingHistoryRecord() {
    if (historyBatchSyncActive()) {
      var batchIds = Array.isArray(S.history.batchSync.ids) ? S.history.batchSync.ids : [];
      var selectedInBatch = S.history.selected && batchIds.indexOf(S.history.selected.id) >= 0;
      if (!selectedInBatch) {
        S.history.selected = S.history.records.filter(function (item) { return batchIds.indexOf(item.id) >= 0; })[0] || S.history.selected;
        S.history.detail = null;
      }
      S.history.syncingId = '';
      return true;
    }
    var syncingRecords = S.history.records.filter(function (item) { return item.feishuSync && item.feishuSync.status === 'syncing'; });
    if (!syncingRecords.length) return false;
    var syncing = syncingRecords.filter(function (item) { return S.history.selected && item.id === S.history.selected.id; })[0] || syncingRecords[0];
    if (!S.history.selected || S.history.selected.id !== syncing.id) S.history.detail = null;
    S.history.selected = syncing;
    S.history.syncingId = syncing.id;
    return true;
  }
  function stopHistorySyncPolling() {
    if (S.history.syncProgressTimer) window.clearInterval(S.history.syncProgressTimer);
    S.history.syncProgressTimer = 0;
  }
  function startHistorySyncPolling() {
    if (S.history.syncProgressTimer) return;
    S.history.syncProgressTimer = window.setInterval(function () { refreshHistoryProgress(); }, 800);
  }
  function refreshHistoryProgress() {
    return fetch('/api/history', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok) throw new Error(j.error || '历史记录读取失败');
        S.history.records = j.records || [];
        applyHistoryBatchSyncFromServer(j.batchSync || null);
        if (resumeSyncingHistoryRecord()) startHistorySyncPolling();
        else {
          S.history.syncingId = '';
          stopHistorySyncPolling();
        }
        if (S.history.selected && !S.history.syncingId) {
          S.history.selected = S.history.records.filter(function (item) { return item.id === S.history.selected.id; })[0] || S.history.selected;
        }
        renderHistory();
      })
      .catch(function () {});
  }
  function viewHistory(id) {
    var nextRecord = S.history.records.filter(function (x) { return x.id === id; })[0] || null;
    if (!nextRecord) return;
    S.history.viewingId = id;
    fetch('/api/history/' + encodeURIComponent(id) + '/results', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (S.history.viewingId !== id) return;
        if (!j.ok) throw new Error(j.error || '历史结果读取失败');
        S.history.selected = j.record || nextRecord;
        S.history.detail = j.results || {};
        S.history.viewingId = '';
        renderHistoryDetail();
      })
      .catch(function (e) {
        if (S.history.viewingId !== id) return;
        S.history.selected = nextRecord;
        S.history.detail = null;
        S.history.viewingId = '';
        S.history.error = e && e.message ? e.message : '历史结果读取失败';
        renderHistoryDetail();
      });
  }
  async function deleteHistory(id) {
    if (!(await showSystemConfirm('确认删除该采集周的全部历史记录及采集文件吗？', '删除采集周记录', '删除', 'danger'))) return;
    apiPost('/api/history/' + encodeURIComponent(id) + '/delete')
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok) { S.history.error = j.error || '历史记录删除失败'; renderHistory(); return; }
        if (S.history.selected && S.history.selected.id === id) { S.history.selected = null; S.history.detail = null; }
        loadHistory();
      })
      .catch(function () { S.history.error = '历史记录删除失败'; renderHistory(); });
  }
  function openHistory() {
    var overlay = document.getElementById('historyOverlay');
    if (overlay) overlay.classList.add('open');
    loadHistory();
  }
  function closeHistory() {
    var overlay = document.getElementById('historyOverlay');
    if (overlay) overlay.classList.remove('open');
  }
  function readSettings() {
    var settings = loadJson(SETTINGS_KEY, {
      weekAnchor: '',
      weekAnchors: [],
      weekAnchorsConfirmed: false,
      accounts: [],
      accountsTouched: false,
      accountSelectionVersion: 0,
      listOnly: false,
      skipExcel: false,
      topDepth: '100',
      categories: CATEGORY_OPTIONS.slice(),
      focusSort: 'rank',
      theme: systemDefaultTheme()
    });
    if (!settings.accountSelectionVersion) {
      var legacyDefault = ['.amdc-userdata', '.amdc-userdata-b', '.amdc-userdata-c'];
      var selected = Array.isArray(settings.accounts) ? settings.accounts : [];
      if (selected.length === legacyDefault.length && selected.every(function (profile, index) { return profile === legacyDefault[index]; })) {
        settings.accountsTouched = false;
      }
      settings.accountSelectionVersion = 1;
      saveJson(SETTINGS_KEY, settings);
    }
    return settings;
  }
  function normalizeTopDepth(value) {
    return String(value) === '1000' ? '1000' : '100';
  }
  async function syncHistory(id) {
    if (historyBatchSyncActive()) return;
    var record = S.history.records.filter(function (item) { return item.id === id; })[0];
    if (!record || record.status !== 'done' || (record.feishuSync && (record.feishuSync.status === 'syncing' || record.feishuSync.status === 'queued'))) return;
    var sheet = String(record.weekAnchor || '').replace(/-/g, '');
    var message = '确认同步到飞书？\n\n将重新生成该历史记录的 Excel，并完整覆盖飞书工作表「' + sheet + '」的内容和格式，只保留本次最新结果。\n\n本地历史记录不会删除。';
    if (!(await showSystemConfirm(message, '同步到飞书', '开始同步'))) return;
    var syncingRecord = Object.assign({}, record, { feishuSync: {
      status: 'syncing', progress: 3, message: '正在生成 Excel'
    }});
    S.history.records = S.history.records.map(function (item) { return item.id === id ? syncingRecord : item; });
    S.history.selected = syncingRecord;
    S.history.detail = null;
    S.history.syncingId = id;
    S.history.error = '';
    S.history.batchRequestPending = true;
    S.history.batchRequestStartedAt = Date.now();
    renderHistory();
    startHistorySyncPolling();
    apiPost('/api/history/' + encodeURIComponent(id) + '/sync-feishu')
      .then(function (r) { return r.json(); })
      .then(async function (j) {
        stopHistorySyncPolling();
        S.history.syncingId = '';
        if (j.record) {
          S.history.records = S.history.records.map(function (item) { return item.id === j.record.id ? j.record : item; });
          S.history.selected = j.record;
          renderHistory();
        }
        if (!j.ok) {
          var singleFailure = j.error || (j.record && j.record.feishuSync && j.record.feishuSync.error) || '未返回具体失败原因';
          S.history.error = singleFailure;
          await showSystemAlert('飞书同步失败：' + singleFailure, '飞书同步失败', 'danger');
        } else await showSystemAlert(j.record && j.record.feishuSync && j.record.feishuSync.skipped
          ? '标题和本周排名完全重复，已跳过同步。'
          : '飞书同步已完成。', '飞书同步完成');
        loadHistory();
      })
      .catch(function () {
        stopHistorySyncPolling();
        S.history.syncingId = '';
        S.history.error = '飞书同步失败';
        renderHistory();
      });
  }
  function batchSyncFailureDetails(result) {
    var failures = Array.isArray(result && result.results) ? result.results.filter(function (item) { return item && !item.ok; }) : [];
    return failures.map(function (item) {
      var record = item.record || {};
      var sync = record.feishuSync || {};
      var reason = item.error || sync.error || '未返回具体失败原因';
      return (item.weekAnchor || record.weekAnchor || '--') + '：' + reason;
    }).join('\n');
  }
  async function syncHistoryBatch() {
    if (historyBatchSyncActive()) return;
    var selected = S.history.records.filter(function (record) {
      return S.history.selectedSyncIds.indexOf(record.id) >= 0 && record.status === 'done' && !record.legacy;
    });
    if (!selected.length) return;
    var latestByWeek = {};
    selected.forEach(function (record) {
      var current = latestByWeek[record.weekAnchor];
      if (!current || String(record.startedAt || '') > String(current.startedAt || '')) latestByWeek[record.weekAnchor] = record;
    });
    var records = Object.keys(latestByWeek).sort().reverse().map(function (week) { return latestByWeek[week]; });
    var weeks = records.map(function (record) { return record.weekAnchor; }).join('、');
    var message = '确认批量同步到飞书？\n\n将以最多 2 个任务并行，同步 ' + records.length + ' 个采集周：\n' + weeks + '\n\n每个日期只同步所选记录中最新的一条，并完整覆盖对应日期工作表。';
    if (!(await showSystemConfirm(message, '批量同步到飞书', '开始同步'))) return;
    var ids = records.map(function (record) { return record.id; });
    S.history.batchSync = {
      status: 'syncing', ids: ids.slice(), weeks: records.map(function (record) { return record.weekAnchor; }),
      total: records.length, completed: 0, failed: 0, progress: 0, message: '正在准备批量同步'
    };
    S.history.records = S.history.records.map(function (record) {
      return ids.indexOf(record.id) >= 0
        ? Object.assign({}, record, { feishuSync: { status: 'queued', progress: 0, message: '等待批量同步' } })
        : record;
    });
    S.history.selectedSyncIds = [];
    S.history.batchSelectMode = '';
    S.history.selected = S.history.records.filter(function (record) { return record.id === ids[0]; })[0] || null;
    S.history.syncingId = ids[0] || '';
    S.history.batchRequestPending = true;
    S.history.batchRequestStartedAt = Date.now();
    S.history.error = '';
    renderHistory();
    startHistorySyncPolling();
    var query = ids.map(function (id) { return 'id=' + encodeURIComponent(id); }).join('&');
    apiPost('/api/history/batch-sync-feishu?' + query)
      .then(function (r) { return r.json(); })
      .then(async function (j) {
        stopHistorySyncPolling();
        S.history.syncingId = '';
        S.history.batchRequestPending = false;
        S.history.batchRequestStartedAt = 0;
        S.history.batchSync = j.batchSync || null;
        var failureDetails = batchSyncFailureDetails(j);
        if (!j.ok) S.history.error = j.error || '批量同步到飞书未全部完成';
        var batchMessage = j.ok
          ? '批量同步完成：成功 ' + num(j.synced || 0) + ' 条，失败 ' + num(j.failed || 0) + ' 条。' + (failureDetails ? '\n\n' + failureDetails : '')
          : '批量同步失败：' + (j.error || '服务端未返回有效同步结果') + (failureDetails ? '\n\n失败明细：\n' + failureDetails : '');
        await showSystemAlert(batchMessage, j.ok ? '批量同步完成' : '批量同步失败', j.ok ? 'info' : 'danger');
        S.history.batchSync = null;
        loadHistory();
      })
      .catch(async function (e) {
        stopHistorySyncPolling();
        S.history.syncingId = '';
        S.history.batchRequestPending = false;
        S.history.batchRequestStartedAt = 0;
        S.history.error = '批量同步到飞书失败';
        await showSystemAlert('批量同步失败：' + (e && e.message ? e.message : '请求未完成'), '批量同步失败', 'danger');
        loadHistory();
      });
  }
  function selectedCategories() {
    return Array.prototype.slice.call(document.querySelectorAll('[data-category]'))
      .filter(function (el) { return el.checked; })
      .map(function (el) { return el.value; });
  }
  function updateCategorySelectHint() {
    var hint = document.getElementById('categorySelectHint');
    if (!hint) return;
    var selected = selectedCategories().length;
    hint.textContent = selected ? (selected + ' / ' + CATEGORY_OPTIONS.length + ' 已选择') : '请选择至少一个';
  }
  function systemDefaultTheme() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  function normalizeTheme(value) {
    return value === 'light' || value === 'dark' ? value : systemDefaultTheme();
  }
  function previousWeekMondayValue() {
    var now = new Date();
    var monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7) - 7);
    return monday.getFullYear() + '-' + String(monday.getMonth() + 1).padStart(2, '0') + '-' + String(monday.getDate()).padStart(2, '0');
  }
  function resetWeekAnchorToPreviousMonday(settings) {
    settings = settings || readSettings();
    var weeks = Array.isArray(settings.weekAnchors) ? settings.weekAnchors.filter(isMondayValue) : [];
    if (!weeks.length) {
      weeks = [previousWeekMondayValue()];
      settings.weekAnchorsConfirmed = false;
    }
    weeks = Array.from(new Set(weeks)).sort();
    settings.weekAnchors = weeks;
    settings.weekAnchor = weeks[weeks.length - 1] || '';
    saveJson(SETTINGS_KEY, settings);
    var input = document.getElementById('weekAnchorInput');
    if (input) {
      input.value = weekAnchorDisplay(weeks, !!settings.weekAnchorsConfirmed);
      input.title = weeks.join('、');
      validateWeekAnchor();
    }
    return settings.weekAnchors;
  }
  function applyTheme(value) {
    var theme = normalizeTheme(value);
    document.documentElement.setAttribute('data-theme', theme);
    var toggle = document.getElementById('themeToggle');
    if (!toggle) return;
    var icons = {
      dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 15.4A8.5 8.5 0 0 1 8.6 3.5 8.5 8.5 0 1 0 20.5 15.4Z"/></svg>',
      light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="3.5"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42"/></svg>'
    };
    var labels = { dark: '深色主题', light: '浅色主题' };
    toggle.innerHTML = icons[theme];
    toggle.title = labels[theme] + '（点击切换）';
    toggle.setAttribute('aria-label', labels[theme] + '（点击切换）');
  }
  function isMondayValue(value) {
    var text = String(value || '').trim();
    if (!text) return true;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
    var date = new Date(text + 'T00:00:00Z');
    return !isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text && date.getUTCDay() === 1 && text <= previousWeekMondayValue();
  }
  function validateWeekAnchor() {
    var input = document.getElementById('weekAnchorInput');
    if (!input) return true;
    var settings = readSettings();
    var weeks = Array.isArray(settings.weekAnchors) ? settings.weekAnchors : [];
    var valid = !!settings.weekAnchorsConfirmed && weeks.length > 0 && weeks.every(isMondayValue);
    input.setCustomValidity(valid ? '' : '请在日历中选择周一并点击确定');
    return valid;
  }

  function selectedWeekAnchors() {
    var settings = readSettings();
    return Array.isArray(settings.weekAnchors) ? settings.weekAnchors.filter(isMondayValue).sort() : [];
  }

  function weekAnchorDisplay(weeks, confirmed) {
    if (!weeks || !weeks.length) return '请选择周一';
    if (weeks.length > 1) return (confirmed ? '已确定 ' : '待确定 ') + weeks.length + ' 个周';
    var text = weeks.join('、');
    return confirmed ? text : ('待确定：' + text);
  }
  function writeSettings(accountsTouched) {
    var current = readSettings();
    var accountInputs = Array.prototype.slice.call(document.querySelectorAll('[data-account-enable]'));
    var settings = {
      weekAnchor: (selectedWeekAnchors().slice(-1)[0] || current.weekAnchor),
      weekAnchors: selectedWeekAnchors(),
      weekAnchorsConfirmed: !!current.weekAnchorsConfirmed,
      accounts: accountInputs.length
        ? accountInputs.filter(function (el) { return el.checked; }).map(function (el) { return el.value; })
        : (current.accounts || []),
      accountsTouched: accountsTouched === true ? true : !!current.accountsTouched,
      accountSelectionVersion: 1,
      listOnly: false,
      skipExcel: false,
      topDepth: normalizeTopDepth(document.getElementById('topDepthInput') ? document.getElementById('topDepthInput').value : current.topDepth),
      categories: document.querySelectorAll('[data-category]').length ? selectedCategories() : (Array.isArray(current.categories) ? current.categories : CATEGORY_OPTIONS.slice()),
      focusSort: S.sortBy,
      theme: normalizeTheme(document.getElementById('themeModeInput') ? document.getElementById('themeModeInput').value : current.theme)
    };
    saveJson(SETTINGS_KEY, settings);
    return settings;
  }
  function applySettings() {
    var settings = readSettings();
    var resolvedTheme = normalizeTheme(settings.theme);
    settings.theme = resolvedTheme;
    resetWeekAnchorToPreviousMonday(settings);
    var date = document.getElementById('weekAnchorInput');
    if (date) {
      date.value = weekAnchorDisplay(settings.weekAnchors || [], !!settings.weekAnchorsConfirmed);
      date.title = (settings.weekAnchors || []).join('、');
    }
    var picker = document.getElementById('weekAnchorPicker');
    if (picker) picker.value = isMondayValue(settings.weekAnchor) ? (settings.weekAnchor || '') : '';
    Array.prototype.forEach.call(document.querySelectorAll('[data-account-enable]'), function (el) {
      el.checked = settings.accounts.indexOf(el.value) >= 0;
    });
    var selected = Array.isArray(settings.categories) ? settings.categories : CATEGORY_OPTIONS.slice();
    Array.prototype.forEach.call(document.querySelectorAll('[data-category]'), function (el) {
      el.checked = selected.indexOf(el.value) >= 0;
    });
    updateCategorySelectHint();
    setTopDepth(settings.topDepth, false);
    setFocusSort(settings.focusSort, false);
    if (document.getElementById('themeModeInput')) document.getElementById('themeModeInput').value = normalizeTheme(settings.theme);
    applyTheme(resolvedTheme);
  }
  function applyProfileMovesToSettings(deleted, moves, rows) {
    var settings = readSettings();
    var existing = {};
    (rows || []).forEach(function (row) { if (row.exists) existing[row.profile] = true; });
    var selected = [];
    (settings.accounts || []).forEach(function (profile) {
      if (profile === deleted) return;
      var next = moves && moves[profile] ? moves[profile] : profile;
      if (existing[next] && selected.indexOf(next) < 0) selected.push(next);
    });
    settings.accounts = selected;
    settings.accountsTouched = true;
    saveJson(SETTINGS_KEY, settings);
  }
  function renderAccountChecks(rows) {
    if (!rows || !rows.length) return;
    var settings = readSettings();
    var existing = {};
    (rows || []).forEach(function (row) { if (row.exists) existing[row.profile] = true; });
    var selected = (settings.accounts || []).filter(function (profile) { return existing[profile]; });
    if (!settings.accountsTouched) {
      selected = (rows || []).filter(function (row) {
        return row.exists && (row.state === 'ok' || row.state === 'cached');
      }).map(function (row) { return row.profile; });
    }
    if (selected.join(',') !== (settings.accounts || []).join(',')) {
      settings.accounts = selected;
      saveJson(SETTINGS_KEY, settings);
    }
  }
  function openSettings() {
    var overlay = document.getElementById('settingsOverlay');
    if (overlay) overlay.classList.add('open');
  }
  function closeSettings() {
    var overlay = document.getElementById('settingsOverlay');
    if (overlay) overlay.classList.remove('open');
    writeSettings();
    renderAccounts();
  }
  function num(v) { return (v == null || v === '') ? '--' : Number(v).toLocaleString('en-US'); }
  function pct(v) {
    if (v == null || !isFinite(Number(v))) return '--';
    return Math.round(Number(v) * 100) + '%';
  }
  function dur(ms) {
    if (ms == null || isNaN(ms)) return '--';
    var s = Math.max(0, Math.round(ms / 1000));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    if (h) return h + ' 时 ' + m + ' 分';
    if (m) return m + ' 分 ' + (s % 60) + ' 秒';
    return s + ' 秒';
  }
  function runElapsedText(batchProgress, p) {
    var source = batchProgress && batchProgress.startedAt
      ? batchProgress
      : (S.run && S.run.job && S.run.job.startedAt ? S.run.job : null);
    if (source) {
      var startedAt = new Date(source.startedAt || 0).getTime();
      var finishedAt = new Date(source.finishedAt || 0).getTime();
      var terminal = source.state === 'done' || source.state === 'failed' || source.state === 'stopped';
      if (isFinite(startedAt) && startedAt > 0) {
        var endAt = terminal && isFinite(finishedAt) && finishedAt >= startedAt ? finishedAt : Date.now();
        return dur(Math.max(0, endAt - startedAt));
      }
    }
    return p && Number(p.runElapsed) >= 0 ? dur(Number(p.runElapsed)) : '--';
  }
  function refreshRunElapsedKpi() {
    var el = document.getElementById('runElapsedKpi');
    if (!el) return;
    var data = S.data || {};
    el.textContent = runElapsedText(data.batchProgress || null, data.progress || null);
  }
  function ftime(v) {
    if (!v) return '--';
    var d = new Date(v);
    return isNaN(d.getTime()) ? String(v) : d.toLocaleTimeString('zh-CN', { hour12: false });
  }
  function chg(v) {
    if (v == null) return '<span class="chg-0">--</span>';
    if (v > 0) return '<span class="chg-up">▲' + v + '</span>';
    if (v < 0) return '<span class="chg-dn">▼' + (-v) + '</span>';
    return '<span class="chg-0">0</span>';
  }
  function isPotentialFocus(f) {
    return !!(f && f.potentialNew);
  }
  function isSuspectedDelisted(f) {
    return !!(f && f.suspectedDelisted);
  }
  function focusRisePct(f) {
    var rank = Number(f && f.rank);
    var change = Number(f && f.change);
    return rank > 0 && change > 0 ? change / rank : 0;
  }
  function failureDetail(e) {
    if (!e) return '';
    var parts = [];
    if (Array.isArray(e.failures) && e.failures.length) parts.push('失败明细：' + e.failures.join('；'));
    if (Array.isArray(e.emptyDates) && e.emptyDates.length) parts.push('空数据周：' + e.emptyDates.join('，'));
    if (Array.isArray(e.issues) && e.issues.length) parts.push('自检问题：' + e.issues.join('；'));
    if (e.status) parts.push('状态码：' + e.status);
    if (e.body) parts.push('响应：' + String(e.body).slice(0, 240));
    if (e.error) parts.push('错误：' + String(e.error).slice(0, 240));
    if (e.app) parts.push('应用：' + String(e.app) + (e.rank ? '（#' + e.rank + '）' : ''));
    if (e.storeUrl) parts.push('商店：' + String(e.storeUrl));
    return parts.join(' | ');
  }
  function eventItem(level, title, message, detail, kvs, newest) {
    var chips = (kvs || []).filter(Boolean).map(function (x) { return '<span>' + esc(x) + '</span>'; }).join('');
    return '<div class="event' + (newest ? ' newest' : '') + '" data-l="' + esc(level || 'info') + '">' +
      '<div class="t">' + esc(title || '') + '</div>' +
      '<div class="m">' + esc(message || '') + '</div>' +
      (detail ? '<div class="d">' + esc(detail) + '</div>' : '') +
      (chips ? '<div class="kv-mini">' + chips + '</div>' : '') +
    '</div>';
  }
  function renderResultEvents(r) {
    r = r || { categories: [], risers: [], marketSplit: null };
    var cats = r.categories || [];
    var rows = [];
    var totalRecords = cats.reduce(function (sum, c) { return sum + (c.records || 0); }, 0);
    var totalFocus = cats.reduce(function (sum, c) { return sum + (c.focusCount || 0); }, 0);
    rows.push(eventItem(
      'info',
      '结果汇总',
      cats.length ? ('结果汇总：' + cats.length + ' 个品类') : '暂无结果数据',
      '',
      ['榜单 ' + num(totalRecords), '焦点 ' + num(totalFocus), '飙升 ' + num((r.risers || []).length)],
      true
    ));
    cats.forEach(function (c) {
      rows.push(eventItem(
        c.live ? 'warn' : 'info',
        c.category || '--',
        c.live ? '实时缓存摘要' : '最终产物摘要',
        '',
        [
          '榜单 ' + num(c.records),
          '焦点 ' + num(c.focusCount),
          '新入前百 ' + num(c.newTop100),
          '已富化 ' + num(c.enriched)
        ],
        false
      ));
    });
    var split = r.marketSplit || { mature: 0, emerging: 0, suspectedDelisted: 0, unclassified: 0, pending: 0 };
    rows.push(eventItem('info', '市场分布', '焦点应用市场属性', '', [
      '偏成熟 ' + num(split.mature),
      '偏新兴 ' + num(split.emerging),
      '疑似下架 ' + num(split.suspectedDelisted),
      '无市场分类 ' + num(split.unclassified),
      '待采集 ' + num(split.pending)
    ], false));
    return rows.join('');
  }
  function renderHealthEvents(h, loading) {
    if (loading) return eventItem('info', '健康检查', '正在检查服务状态', '', [], true);
    h = h || {};
    return [
      eventItem(h.ok ? 'info' : 'error', '健康检查', h.ok ? '服务正常' : '服务异常', h.error || '', [
        '端口 ' + (h.port || '--'),
        '实时通道 ' + num(h.sseClients),
        h.hasProgress ? '有进度文件' : '无进度文件'
      ], true),
      eventItem('info', '项目目录', h.projectDir || '--', '', [], false),
      eventItem(h.runDir ? 'info' : 'warn', '运行目录', h.runDir || '未找到运行目录', '', [], false)
    ].join('');
  }
  function updateEventFilterButtons() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-event-filter]'), function (btn) {
      btn.classList.toggle('on', btn.getAttribute('data-event-filter') === S.eventFilter);
    });
  }
  async function stopHistoryBatchSync() {
    if (!historyBatchSyncActive()) return;
    if (!(await showSystemConfirm('确认停止批量同步吗？\n\n系统会停止未完成任务，并恢复所有已开始同步的工作表及本地同步状态。', '停止批量同步', '停止同步', 'danger'))) return;
    apiPost('/api/history/batch-sync-feishu/stop')
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok) throw new Error(j.error || '停止批量同步失败');
        applyHistoryBatchSyncFromServer(j.batchSync || null);
        renderHistory();
      })
      .catch(function (e) { showSystemAlert(e && e.message ? e.message : '停止批量同步失败', '停止批量同步失败', 'danger'); });
  }
  function spark(history) {
    var pts = (history || []).slice().reverse(); // 旧 -> 新
    var vals = pts.filter(function (x) { return x != null; });
    if (!vals.length) return '<span class="muted">--</span>';
    var w = 84, h = 20, pad = 2;
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    var span = (max - min) || 1;
    var coords = [];
    for (var i = 0; i < pts.length; i++) {
      if (pts[i] == null) continue;
      var x = pad + (w - 2 * pad) * (pts.length === 1 ? 0.5 : i / (pts.length - 1));
      var y = pad + (h - 2 * pad) * ((pts[i] - min) / span); // 排名小=靠上
      coords.push([x.toFixed(1), y.toFixed(1)]);
    }
    var line = coords.map(function (c) { return c.join(','); }).join(' ');
    var last = coords[coords.length - 1];
    return '<svg class="spark" viewBox="0 0 84 20" preserveAspectRatio="none">' +
      '<polyline points="' + line + '"/>' +
      '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="2"/></svg>';
  }
  function releaseDate(value) {
    var match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : '--';
  }
  function rankSummary(f) {
    var change = Number(f && f.change);
    var rank = Number(f && f.rank);
    var lastWeek = Number(f && f.lastWeek);
    if (Number.isFinite(change) && change > 0 && Number.isFinite(rank) && rank > 0 && Number.isFinite(lastWeek) && lastWeek > 0) {
      return '排名上升' + change + '名（上周' + lastWeek + '名，+' + ((change / rank) * 100).toFixed(0) + '%）';
    }
    var summary = ((f && f.reasons) || []).filter(function (reason) {
      return String(reason || '').indexOf('排名') === 0;
    });
    return summary.length ? summary.join('；') : '--';
  }
  function kpi(k, v, s, cls) {
    return '<div class="kpi"><div class="kpi-content"><div class="k">' + esc(k) + '</div><div class="v ' + (cls || '') + '">' + v + '</div></div></div>';
  }
  function weekStateMeta(week, batchPhase) {
    var state = String(week && week.state || 'queued');
    if (state === 'done') return { label: '已完成', badge: 'done', icon: '✓' };
    if (state === 'failed') return { label: '失败', badge: 'err', icon: '!' };
    if (state === 'stopped') return { label: '已停止', badge: 'warn', icon: '■' };
    if (state === 'starting') return { label: '启动中', badge: 'run', icon: '▶' };
    if (state === 'running') return { label: batchPhase === 'leaderboard' ? '榜单确认' : '国别采集', badge: 'run', icon: '▶' };
    if (week && week.retryAt) return { label: '等待重试', badge: 'warn', icon: '↻' };
    if (state === 'leaderboard_done' || (week && week.leaderboardConfirmed)) return { label: '榜单就绪', badge: 'wait', icon: '✓' };
    return { label: '排队', badge: 'wait', icon: '·' };
  }
  function fallbackWeekSummaries(batchProgress, p) {
    if (batchProgress && Array.isArray(batchProgress.weekSummaries) && batchProgress.weekSummaries.length) {
      return batchProgress.weekSummaries.slice();
    }
    var children = S.run && S.run.job && Array.isArray(S.run.job.children) ? S.run.job.children : [];
    if (children.length) {
      return children.map(function (child) {
        var isSelected = p && child.historyId && child.historyId === S.selectedRunId;
        return {
          historyId: child.historyId || '',
          weekAnchor: child.weekAnchor || '--',
          state: child.state || 'queued',
          phase: child.phase || (S.run.job.phase || ''),
          leaderboardConfirmed: !!child.leaderboardConfirmedAt || child.state === 'leaderboard_done' || child.state === 'done',
          retryAt: child.retryAt || '',
          overall: isSelected ? (Number(p.overall) || 0) : (child.state === 'done' ? 100 : 0),
          categoriesDone: isSelected ? (Number(p.doneCats) || 0) : (child.state === 'done' ? CATEGORY_OPTIONS.length : 0),
          categoriesTotal: isSelected ? (Number(p.total) || CATEGORY_OPTIONS.length) : CATEGORY_OPTIONS.length,
          focusCount: isSelected ? (Number(p.totalFocus) || 0) : 0,
          suspectedDelisted: 0,
          pendingCountry: isSelected ? (Number(p.countryRemaining) || 0) : 0,
          rateLimitedAccounts: isSelected ? (p.rateLimitedAccounts || []) : [],
          durationMs: isSelected ? (Number(p.runElapsed) || 0) : 0,
          categories: isSelected ? (p.cats || []) : [],
        };
      });
    }
    if (p) {
      return [{
        historyId: (S.data && S.data.historyId) || '',
        weekAnchor: (S.data && S.data.weekAnchor) || p.anchor || '--',
        state: p.currentStage === 'done' ? 'done' : (p.currentStage === 'failed' || p.currentStage === 'error' ? 'failed' : 'running'),
        phase: p.listOnly ? 'leaderboard' : 'application',
        overall: Number(p.overall) || 0,
        categoriesDone: Number(p.doneCats) || 0,
        categoriesTotal: Number(p.total) || 0,
        focusCount: Number(p.totalFocus) || 0,
        suspectedDelisted: 0,
        pendingCountry: Number(p.countryRemaining) || 0,
        rateLimitedAccounts: p.rateLimitedAccounts || [],
        durationMs: Number(p.runElapsed) || 0,
        categories: p.cats || [],
      }];
    }
    var settings = readSettings();
    return (settings.weekAnchorsConfirmed && Array.isArray(settings.weekAnchors) ? settings.weekAnchors : [])
      .slice().sort().reverse().map(function (week) {
        return { historyId: '', weekAnchor: week, state: 'queued', overall: 0, categoriesDone: 0, categoriesTotal: CATEGORY_OPTIONS.length, focusCount: 0, suspectedDelisted: 0, pendingCountry: 0, rateLimitedAccounts: [], durationMs: 0, categories: [] };
      });
  }
  function weekDetailRows(week, batchPhase) {
    var categories = Array.isArray(week.categories) ? week.categories : [];
    if (!categories.length) {
      return '<tr><td colspan="6"><div class="batch-week-empty">' +
        (week.state === 'queued' ? '该周尚未开始，完成榜单确认后显示品类明细' : '该周暂时没有可用的品类明细') +
        '</div></td></tr>';
    }
    return categories.map(function (category) {
      var queuedAfterLeaderboard = week.state === 'queued' && week.leaderboardConfirmed && batchPhase === 'application';
      var categoryState = queuedAfterLeaderboard
        ? { cls: 'wait', label: '榜单就绪' }
        : { cls: category.cls === 'done' ? 'done' : (category.cls === 'err' ? 'err' : (category.cls === 'wait' ? 'wait' : 'run')), label: zhLab(category) };
      var pctValue = queuedAfterLeaderboard ? 0 : Math.max(0, Math.min(100, Number(category.pct) || 0));
      var progressText = queuedAfterLeaderboard ? '等待应用采集' : (category.prog === 'done' ? '完成' : (category.prog || '--'));
      return '<tr>' +
        '<td>' + esc(category.label || '--') + '</td>' +
        '<td><span class="badge ' + categoryState.cls + '">' + esc(categoryState.label || '--') + '</span></td>' +
        '<td><span class="week-progress-cell"><span class="mini"><span style="width:' + pctValue + '%"></span></span><span class="muted week-progress-count">' + esc(progressText) + '</span></span></td>' +
        '<td class="num">' + num(category.focus) + '</td>' +
        '<td class="num">' + (Number(category.suspectedDelisted) ? '<span class="batch-alert-value">' + num(category.suspectedDelisted) + '</span>' : '0') + '</td>' +
        '<td class="current-app-cell"><span class="ellip muted" title="' + esc(category.cur ? zh(category.cur) : '--') + '">' + esc(category.cur ? zh(category.cur) : '--') + '</span></td>' +
      '</tr>';
    }).join('');
  }
  function renderBatchWeeks(batchProgress, p) {
    var holder = document.getElementById('batchWeeks');
    if (!holder) return;
    var weeks = fallbackWeekSummaries(batchProgress, p);
    var phase = batchProgress && batchProgress.phase || (p && p.listOnly ? 'leaderboard' : 'application');
    var batchKey = batchProgress && batchProgress.batchId || '';
    if (batchKey && S.expandedWeekBatchId !== batchKey) {
      S.expandedWeekBatchId = batchKey;
      S.expandedWeekId = null;
    }
    // null 仅表示尚未决定默认展开项；空字符串表示用户主动收起，不能在重绘时恢复第一周。
    if (S.expandedWeekId === null && weeks.length) {
      var active = weeks.filter(function (week) { return week.state === 'running' || week.state === 'starting'; })[0];
      S.expandedWeekId = (active || weeks[0]).historyId || (active || weeks[0]).weekAnchor;
    }
    if (S.expandedWeekId && !weeks.some(function (week) { return (week.historyId || week.weekAnchor) === S.expandedWeekId; })) {
      S.expandedWeekId = weeks.length ? (weeks[0].historyId || weeks[0].weekAnchor) : '';
    }
    var expandedWeek = weeks.filter(function (week) { return (week.historyId || week.weekAnchor) === S.expandedWeekId; })[0] || null;
    holder.classList.toggle('is-collapsed', !expandedWeek);
    var summaries = weeks.map(function (week) {
      var key = week.historyId || week.weekAnchor;
      var expanded = key === S.expandedWeekId;
      var stateMeta = weekStateMeta(week, phase);
      var rateAccounts = (week.rateLimitedAccounts || []).map(accShort).filter(Boolean);
      var limitText = rateAccounts.length ? rateAccounts.join(',') : '—';
      var overallValue = Math.max(0, Math.min(100, Number(week.overall) || 0));
      var waitingForApplication = week.state === 'queued' && week.leaderboardConfirmed && phase === 'application';
      var categoryText = num(waitingForApplication ? 0 : week.categoriesDone) + '/' + num(week.categoriesTotal);
      var aria = (expanded ? '收起' : '展开') + '采集周 ' + (week.weekAnchor || '--') + ' 详情';
      return '<article class="batch-week-card' + (expanded ? ' is-expanded' : '') + '" data-state="' + esc(week.state || 'queued') + '">' +
        '<button class="batch-week-summary" type="button" data-week-toggle="' + esc(key) + '" data-week-history-id="' + esc(week.historyId || '') + '" aria-expanded="' + (expanded ? 'true' : 'false') + '" aria-label="' + esc(aria) + '">' +
          '<span class="batch-week-primary"><span class="batch-week-icon">' + esc(stateMeta.icon) + '</span><span class="batch-week-date">' + esc(week.weekAnchor || '--') + '</span></span>' +
          '<span class="batch-week-state"><span class="badge ' + stateMeta.badge + '">' + esc(stateMeta.label) + '</span></span>' +
          '<span class="batch-week-metric metric-progress"><span class="label">进度</span><span class="value batch-week-progress"><span>' + overallValue + '%</span><span class="mini"><span style="width:' + overallValue + '%"></span></span></span></span>' +
          '<span class="batch-week-metric metric-categories"><span class="label">品类</span><span class="value">' + esc(categoryText) + '</span></span>' +
          '<span class="batch-week-metric metric-focus"><span class="label">焦点应用</span><span class="value">' + num(week.focusCount) + '</span></span>' +
          '<span class="batch-week-metric metric-alert"><span class="label">' + (Number(week.suspectedDelisted) ? '疑似下架' : '限流') + '</span><span class="value' + (Number(week.suspectedDelisted) ? ' batch-alert-value' : '') + '">' + (Number(week.suspectedDelisted) ? num(week.suspectedDelisted) : esc(limitText)) + '</span></span>' +
          '<span class="batch-week-metric metric-duration"><span class="label">耗时</span><span class="value">' + dur(Number(week.durationMs) || 0) + '</span></span>' +
          '<span class="batch-week-toggle" aria-hidden="true">⌄</span>' +
        '</button>' +
        (expanded
          ? '<div class="batch-week-detail" aria-label="' + esc(week.weekAnchor || '--') + ' 品类详情">' +
              '<table><thead><tr><th>品类</th><th>状态</th><th>进度</th><th>焦点应用</th><th>疑似下架</th><th>当前应用</th></tr></thead>' +
              '<tbody>' + weekDetailRows(week, phase) + '</tbody></table>' +
            '</div>'
          : '') +
      '</article>';
    }).join('');
    holder.innerHTML = summaries
      ? '<div class="batch-week-list">' + summaries + '</div>'
      : '<div class="batch-week-empty">请选择并确认采集周，任务启动后将在这里同时显示全部日期</div>';
    var completed = weeks.filter(function (week) { return week.state === 'done'; }).length;
    var running = weeks.filter(function (week) { return week.state === 'running' || week.state === 'starting'; }).length;
    var failed = weeks.filter(function (week) { return week.state === 'failed'; }).length;
    document.getElementById('weeksHint').textContent = weeks.length ? ('共 ' + weeks.length + ' 个采集周') : '批次内所有日期同时展示';
    document.getElementById('weeksQueueHint').textContent = weeks.length ? ('完成 ' + completed + ' · 运行 ' + running + ' · 异常 ' + failed) : '';
  }
  function runChildren() {
    return S.run && S.run.job && Array.isArray(S.run.job.children) ? S.run.job.children : [];
  }
  function syncSelectedRunId() {
    var children = runChildren().filter(function (child) { return child && child.historyId; });
    if (!children.length) {
      var singleId = S.run && S.run.job && S.run.job.historyId || '';
      if (singleId && S.run && S.run.active) S.selectedRunId = singleId;
      return;
    }
    if (!(S.run && S.run.active)) {
      var settings = readSettings();
      var configured = settings.weekAnchorsConfirmed && Array.isArray(settings.weekAnchors)
        ? settings.weekAnchors.filter(isMondayValue).slice().sort()
        : [];
      var childWeeks = children.map(function (child) { return child.weekAnchor; }).filter(Boolean).slice().sort();
      var sameWeeks = configured.length === childWeeks.length && configured.every(function (week, index) {
        return week === childWeeks[index];
      });
      if (!sameWeeks) { S.selectedRunId = ''; return; }
    }
    var exists = children.some(function (child) { return child.historyId === S.selectedRunId; });
    if (!exists) S.selectedRunId = children[0].historyId;
  }
  function accShort(a) {
    var s = String(a || '');
    if (s === '.amdc-userdata') return 'A';
    var m = /^\.amdc-userdata-([b-j])$/.exec(s);
    return m ? m[1].toUpperCase() : s;
  }

  // ---- 全中文化：翻译 scraper 产出的英文状态/事件/详情（兼容历史归档数据） ----
  var LAB_ZH = { queued: '排队', wait: '排队', leaderboard: '榜单', 'country enrich': '国别采集', running: '运行中', done: '完成', error: '错误', weekly: '榜单', enrich: '国别采集' };
  var ZH_RULES = [
    [/^Initializing$/, '初始化'],
    [/^Collecting weekly leaderboards$/, '采集周榜'],
    [/^Collecting leaderboard: (.+)$/, '采集榜单：$1'],
    [/^Enriching country data$/, '国别采集'],
    [/^Writing output files$/, '写出产物'],
    [/^Completed$/, '已完成'],
    [/^Run initialized$/, '运行初始化'],
    [/^Run completed$/, '运行完成'],
    [/^Account token pool ready$/, '账号池就绪'],
    [/^Account token rejected by API probe$/, '账号凭证探针失败'],
    [/^No usable account token found$/, '未找到可用账号凭证'],
    [/^No valid account token found$/, '未找到有效账号凭证'],
    [/^No valid account token survived API probe$/, '所有账号凭证探针失败'],
    [/^Tags dictionary not found$/, '未找到标签字典'],
    [/^Tags dictionary loaded$/, '标签字典已加载'],
    [/^Tags dictionary unreadable$/, '标签字典读取失败'],
    [/^Country enrichment queue ready$/, '国别采集队列就绪'],
    [/^Worker (\S+) picked (.+)$/, '账号 $1 领取品类：$2'],
    [/^Worker (\S+) finished (.+)$/, '账号 $1 完成品类：$2'],
    [/^429 cooldown on (\S+)$/, '账号 $1 触发限流冷却'],
    [/^Network retries exhausted on (\S+)$/, '账号 $1 网络重试耗尽'],
    [/^Leaderboard ready for (.+)$/, '榜单就绪：$1'],
    [/^Pulling weekly leaderboard snapshots$/, '拉取周榜快照'],
    [/^Rows (\d+), focus (\d+), cached enrich hits (\d+)$/, '榜单 $1 行 · 焦点 $2 · 缓存命中 $3'],
    [/^Country enrichment started \((\d+) focus apps\)$/, '国别采集开始（$1 个焦点应用）'],
    [/^Country enrichment (\d+)\/(\d+)$/, '国别采集 $1/$2'],
    [/^Country enrichment finished \((\d+) focus apps\)$/, '国别采集完成（$1 个焦点应用）'],
    [/^Output written \((\d+) rows, (\d+) focus, (\d+) missing country\)$/, '产物已写入（$1 行 · 焦点 $2 · 缺国别 $3）'],
    [/^Reused completed enrich cache$/, '复用已完成的采集缓存'],
    [/^Focus set already fully enriched$/, '焦点集已全部采集'],
  ];
  function zh(s) {
    if (!s) return s;
    s = String(s).replace(/\.amdc-userdata(-[bc])?/g, function (m) { return accShort(m); });
    for (var i = 0; i < ZH_RULES.length; i++) {
      if (ZH_RULES[i][0].test(s)) return s.replace(ZH_RULES[i][0], ZH_RULES[i][1]);
    }
    return s;
  }
  function zhLab(c) { return LAB_ZH[c.lab] || LAB_ZH[c.status] || c.lab || c.status || '--'; }

  function setHtmlIfChanged(element, html) {
    if (!element || element.innerHTML === html) return false;
    element.innerHTML = html;
    return true;
  }

  function currentResults() {
    var data = S.data || {};
    return data.results || { categories: [], risers: [], marketSplit: null };
  }

  function renderCurrentFocus() {
    renderFocus(currentResults());
  }

  function renderCurrentRight() {
    var data = S.data || {};
    var progress = data.progress || null;
    var batchProgress = data.batchProgress || null;
    var results = batchProgress && batchProgress.results ? batchProgress.results : currentResults();
    renderRight(progress, batchProgress, results);
  }

  function render() {
    var d = S.data || {};
    var p = d.progress || null;
    // 多周任务的总进度固定按整个批次累计；周详情展开只改变明细，不改变进度条。
    var batchProgress = d.batchProgress || null;
    var progressScope = batchProgress || p;
    var r = d.results || { categories: [], risers: [], marketSplit: null };
    var taskResults = batchProgress && batchProgress.results ? batchProgress.results : r;
    // 榜单阶段保留看板初始化外观，不提前展示部分榜单推导出的应用进度或市场分布。
    // 全部榜单确认后，phase 原子切换为 application，再启用完整批次口径。
    var applicationMetricsReady = !(batchProgress && batchProgress.phase === 'leaderboard');

    var taskStage = batchProgress
      ? (batchProgress.state === 'failed' ? '整体任务失败' : (batchProgress.state === 'done' ? '整体任务已完成' : (batchProgress.phase === 'leaderboard' ? '确认全部周榜单' : (batchProgress.phase === 'application' ? '逐周采集应用数据' : '--'))))
      : (p ? zh(p.stageLabel || p.currentStage || '--') : '尚无进度');
    document.getElementById('stage').textContent = taskStage;
    var overall = applicationMetricsReady && progressScope ? (progressScope.overall || 0) : 0;
    var bar = document.getElementById('overallBar');
    bar.className = 'bar' + (applicationMetricsReady && progressScope && overall >= 100 ? ' ok' : '');
    bar.firstElementChild.style.width = overall + '%';
    document.getElementById('overallPct').textContent = applicationMetricsReady ? (overall + '%') : '--%';

    var runElapsed = runElapsedText(batchProgress, p);
    var rlAccounts = progressScope && Array.isArray(progressScope.rateLimitedAccounts)
      ? progressScope.rateLimitedAccounts.map(accShort).filter(Boolean)
      : [];
    if (!rlAccounts.length && progressScope && Array.isArray(progressScope.events)) {
      var seenRl = {};
      progressScope.events.forEach(function (e) {
        if (!e || !e.account || !/429/.test(String(e.message || ''))) return;
        var shortName = accShort(e.account);
        if (shortName && !seenRl[shortName]) {
          seenRl[shortName] = 1;
          rlAccounts.push(shortName);
        }
      });
    }
    rlAccounts.sort();
    var rlAccountText = rlAccounts.length ? rlAccounts.join(',') : '0';
    var rlDetail = progressScope && progressScope.rateLimited ? (num(progressScope.rateLimited) + ' 次 429 冷却') : '无 429 冷却';
    syncSelectedRunId();
    setHtmlIfChanged(document.getElementById('kpis'), [
      kpi('批次进度', applicationMetricsReady ? (num(overall) + '%') : '--%', batchProgress ? '全部采集周汇总' : '', applicationMetricsReady && overall >= 100 ? 'green' : 'cyan'),
      kpi('周完成', batchProgress ? num(batchProgress.completedWeeks) + '<span class="muted">/' + num(batchProgress.weeks) + '</span>' : (p ? num(p.doneCats) + '<span class="muted">/' + num(p.total) + '</span>' : '--'), batchProgress && batchProgress.phase === 'leaderboard' ? ('榜单已确认 ' + num(batchProgress.leaderboardConfirmed) + '/' + num(batchProgress.weeks)) : '', 'green'),
      kpi('焦点应用', progressScope ? num(progressScope.totalFocus) : '--', batchProgress ? '全部采集周汇总' : ''),
      kpi('限流账号', progressScope ? esc(rlAccountText) : '--', rlDetail, rlAccounts.length ? 'red rate-limit-accounts' : 'rate-limit-accounts'),
      kpi('运行时间', '<span id="runElapsedKpi">' + esc(runElapsed) + '</span>', ''),
      kpi('采集账号', progressScope ? num(progressScope.poolSize) : '--', '启用账号池')
    ].join(''));

    renderBatchWeeks(batchProgress, p);
    renderTabs(r, p);
    renderFocus(r);
    renderSplit(applicationMetricsReady ? taskResults : { marketSplit: null });
    renderAccounts();
    renderRight(p, batchProgress, taskResults);
  }

  function catOrder(r, p) {
    var order = (p && p.cats || []).map(function (c) { return c.label; });
    var seen = {};
    var cats = [];
    order.forEach(function (c) { if (r.categories.some(function (x) { return x.category === c; })) { cats.push(c); seen[c] = 1; } });
    r.categories.forEach(function (c) { if (!seen[c.category]) cats.push(c.category); });
    return cats;
  }

  function renderTabs(r, p) {
    var cats = catOrder(r, p);
    if (S.tab !== ALL && cats.indexOf(S.tab) < 0) S.tab = ALL;
    var total = r.categories.reduce(function (sum, c) { return sum + c.focusCount; }, 0);
    var anyLive = r.categories.some(function (c) { return c.live; });
    var html = '<span class="tab' + (S.tab === ALL ? ' on' : '') + '" data-c="' + ALL + '">全部 <span class="n">' + total + '</span>' + (anyLive ? '<span class="live-dot"></span>' : '') + '</span>';
    html += cats.map(function (c) {
      var cat = r.categories.filter(function (x) { return x.category === c; })[0];
      return '<span class="tab' + (c === S.tab ? ' on' : '') + '" data-c="' + esc(c) + '">' + esc(c) +
        ' <span class="n">' + cat.focusCount + '</span>' + (cat.live ? '<span class="live-dot"></span>' : '') + '</span>';
    }).join('');
    setHtmlIfChanged(document.getElementById('tabs'), html);
  }

  function renderFocus(r) {
    var list = [];
    if (S.tab === ALL) {
      r.categories.forEach(function (c) {
        c.focus.forEach(function (f) { list.push(Object.assign({ category: c.category }, f)); });
      });
    } else {
      var cat = r.categories.filter(function (c) { return c.category === S.tab; })[0];
      if (cat) list = cat.focus.map(function (f) { return Object.assign({ category: cat.category }, f); });
    }
    if (S.search) {
      var q = S.search.toLowerCase();
      list = list.filter(function (f) {
        return (f.name || '').toLowerCase().indexOf(q) >= 0 || (f.publisher || '').toLowerCase().indexOf(q) >= 0;
      });
    }
    var key = S.sortBy;
    var baseCompare = function (a, b) {
      if (key === 'rank') return (a.rank || 9e9) - (b.rank || 9e9);
      if (key === 'change') return focusRisePct(b) - focusRisePct(a) || (b.change || 0) - (a.change || 0);
      return (b[key] || 0) - (a[key] || 0);
    };
    list.sort(function (a, b) {
      if (key === 'rank' || key === 'change') {
        var ap = isPotentialFocus(a) ? 1 : 0;
        var bp = isPotentialFocus(b) ? 1 : 0;
        if (ap !== bp) return bp - ap;
      }
      return baseCompare(a, b);
    });
    var html = list.map(function (f) {
      var name = f.url ? '<a href="' + esc(f.url) + '" target="_blank" rel="noreferrer">' + esc(f.name) + '</a>' : esc(f.name);
      if (isPotentialFocus(f)) name += '<span class="new-tag">潜力新品</span>';
      else if (f.firstInTop100) name += '<span class="new-tag">新入前百</span>';
      if (isSuspectedDelisted(f)) name += '<span class="new-tag suspected-delisted-tag">疑似下架</span>';
      return '<tr>' +
        '<td class="num">#' + f.rank + '</td>' +
        '<td class="wrap focus-app-cell">' + name + '</td>' +
        '<td><span class="cat-chip" title="' + esc(f.category) + '">' + esc(f.category) + '</span></td>' +
        '<td>' + spark(f.history) + '</td>' +
        '<td class="wrap muted">' + esc(f.dlTop || '--') + '</td>' +
        '<td title="' + esc(f.publisher || '') + '">' + (f.hq ? esc(f.hq) : '--') + '</td>' +
        '<td class="num muted">' + releaseDate(f.release) + '</td>' +
        '<td class="sub wrap">' + esc(rankSummary(f)) + '</td></tr>';
    }).join('');
    var focusRows = document.getElementById('focusRows');
    focusRows.className = html ? '' : 'empty-state';
    focusRows.closest('table').classList.toggle('is-empty', !html);
    setHtmlIfChanged(focusRows, html ||
      '<tr><td colspan="8"><div class="empty-hero">' +
      '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">' +
      '<circle cx="21" cy="21" r="12"/><line x1="30" y1="30" x2="40" y2="40"/>' +
      '<line x1="16" y1="24" x2="16" y2="19"/><line x1="21" y1="24" x2="21" y2="15"/><line x1="26" y1="24" x2="26" y2="21"/></svg>' +
      '<div class="t1">焦点应用扫描中</div>' +
      '<div class="t2">榜单采集完成后自动出现，无需等待国别采集</div>' +
      '</div></td></tr>');
  }

  function renderSplit(r) {
    var s = r.marketSplit || { mature: 0, emerging: 0, suspectedDelisted: 0, unclassified: 0, pending: 0 };
    var mature = Number(s.mature) || 0;
    var emerging = Number(s.emerging) || 0;
    var suspectedDelisted = Number(s.suspectedDelisted) || 0;
    var unclassified = Number(s.unclassified) || 0;
    var pending = Number(s.pending) || 0;
    var total = mature + emerging + suspectedDelisted + unclassified + pending;
    var bar = document.getElementById('splitBar');
    if (!total) { bar.innerHTML = '<div class="u" style="width:100%"></div>'; }
    else {
      bar.innerHTML =
        '<div class="m" style="width:' + (mature * 100 / total) + '%"></div>' +
        '<div class="e" style="width:' + (emerging * 100 / total) + '%"></div>' +
        '<div class="d" style="width:' + (suspectedDelisted * 100 / total) + '%"></div>' +
        '<div class="n" style="width:' + (unclassified * 100 / total) + '%"></div>' +
        '<div class="u" style="width:' + (pending * 100 / total) + '%"></div>';
    }
    bar.setAttribute('aria-label', '偏成熟 ' + mature + '，偏新兴 ' + emerging + '，疑似下架 ' + suspectedDelisted + '，无市场分类 ' + unclassified + '，待采集 ' + pending);
    document.getElementById('splitLegend').innerHTML =
      '<span class="lg"><span class="sw" style="background:#0066ff"></span>偏成熟 ' + mature + '</span>' +
      '<span class="lg"><span class="sw" style="background:#f5c542"></span>偏新兴 ' + emerging + '</span>' +
      '<span class="lg"><span class="sw" style="background:#f97316"></span>疑似下架 ' + suspectedDelisted + '</span>' +
      '<span class="lg"><span class="sw" style="background:#a78bfa"></span>无市场分类 ' + unclassified + '</span>' +
      '<span class="lg"><span class="sw" style="background:rgba(148,165,210,0.4)"></span>待采集 ' + pending + '</span>';
  }

  function accountState(row) {
    if (row.duplicate) return { cls: 'warn', text: '邮箱重复' };
    if (row.state === 'ok') return { cls: 'done', text: '有效' };
    if (row.state === 'fail') return { cls: 'err', text: '登录态失效' };
    if (row.state === 'login') return { cls: 'run', text: '登录中' };
    if (row.state === 'checking') return { cls: 'run', text: '正在检测登录态' };
    if (row.state === 'cached') return { cls: 'warn', text: '检测中' };
    if (row.state === 'missing') return { cls: 'wait', text: '未创建' };
    return { cls: 'wait', text: '检测中' };
  }
  function accountEmailStatus(status) {
    return { MISSING: '未填写', UNKNOWN: '未知状态' }[status] || status || '--';
  }
  function selectedAuthState(rows) {
    var checked = (readSettings().accounts || []).slice();
    var byProfile = {};
    (rows || []).forEach(function (row) { byProfile[row.profile] = row; });
    var selected = checked.filter(function (profile) { return byProfile[profile] && byProfile[profile].exists; });
    // cached 表示本地已有有效 token；真正启动采集前服务端仍会再次探测登录态。
    // 不能只允许 ok，否则看板刚打开或服务重启后按钮会被错误置灰，用户点击无反应。
    var invalid = selected.filter(function (profile) {
      return byProfile[profile].state !== 'ok' && byProfile[profile].state !== 'cached';
    });
    var invalidRows = invalid.map(function (profile) { return byProfile[profile] || {}; });
    var reason = '';
    var label = '开始采集';
    if (!selected.length) {
      reason = '至少选择一个已创建账号';
    } else if (invalidRows.some(function (row) { return row.state === 'checking'; })) {
      reason = '正在检测登录态';
      label = '正在检测登录态';
    } else if (invalidRows.some(function (row) { return row.state === 'login'; })) {
      reason = '正在登录';
      label = '正在登录';
    } else if (invalidRows.some(function (row) { return row.state === 'fail'; })) {
      reason = '登录态失效，请重新登录';
      label = '登录态失效';
    } else if (invalidRows.length) {
      reason = '正在检测登录态';
      label = '正在检测登录态';
    }
    return {
      ready: selected.length > 0 && invalid.length === 0,
      selected: selected,
      invalid: invalid,
      reason: reason,
      label: label
    };
  }

  function renderAccounts() {
    var box = S.accounts || { accounts: [], loading: false, error: '' };
    var rows = box.accounts || [];
    renderAccountChecks(rows);
    var authReady = selectedAuthState(rows);
    var weekAnchorReady = validateWeekAnchor();
    var hint = document.getElementById('accountsHint');
    if (hint) {
      var realRows = rows.filter(function (r) { return r.exists; });
      var ok = realRows.filter(function (r) { return r.state === 'ok'; }).length;
      hint.textContent = box.error ? box.error : (realRows.length ? ('有效 ' + ok + '/' + realRows.length) : '本机账号目录');
    }
    var btn = document.getElementById('accountRefresh');
    if (btn) {
      btn.disabled = !!box.loading || !!box.backgroundChecking;
      btn.textContent = box.loading ? '正在检测登录态' : (box.backgroundChecking ? '后台检测中' : '检测登录态');
    }
    var runBtn = document.getElementById('runStart');
    var freshBtn = document.getElementById('runStartFresh');
    var stopBtn = document.getElementById('runStop');
    var refreshBtn = document.getElementById('pageRefresh');
    var runningNow = !!(S.run && S.run.active);
    var stoppingNow = !!(S.run && (S.run.stopping || (S.run.job && S.run.job.state === 'stopping')));
    var refreshBlocked = runningNow || historyBatchSyncActive() || !!(S.history && (S.history.syncingId || S.history.batchRequestPending));
    if (refreshBtn) {
      refreshBtn.disabled = refreshBlocked;
      refreshBtn.title = refreshBlocked ? '任务运行中，完成后才能刷新看板' : '';
    }
    if (stopBtn) {
      stopBtn.disabled = !!box.loading || !!(S.run && S.run.loading) || !runningNow || stoppingNow;
      stopBtn.textContent = stoppingNow ? '停止中...' : '停止';
    }
    if (runBtn) {
      var run = S.run || {};
      var running = !!run.active;
      runBtn.disabled = !!box.loading || !!run.loading || running || !authReady.ready;
      runBtn.title = authReady.ready
        ? (!weekAnchorReady ? '请先确认采集日期（点击开始采集后可选择）' : '')
        : authReady.reason;
      runBtn.textContent = run.loading ? '启动中...' : (running ? '采集中' : (authReady.ready ? '开始采集' : authReady.label));
    }
    if (freshBtn) {
      var run2 = S.run || {};
      var running2 = !!run2.active;
      freshBtn.disabled = !!box.loading || !!run2.loading || S.freshHistoryCheckLoading || running2 || !authReady.ready;
      freshBtn.title = authReady.ready
        ? (!weekAnchorReady ? '请先确认采集日期（点击全新采集后可选择）' : '')
        : authReady.reason;
      freshBtn.textContent = S.freshHistoryCheckLoading ? '检查历史...' : (run2.loading ? '启动中...' : (running2 ? '采集中' : (authReady.ready ? '全新采集' : authReady.label)));
    }
    var settings = readSettings();
    var html = rows.map(function (row) {
      var st = accountState(row);
      var busy = row.state === 'login' || row.state === 'checking' || box.loading;
      var email = row.email ? esc(maskAccountEmail(row.email)) : '<span class="muted">' + esc(accountEmailStatus(row.emailStatus)) + '</span>';
      var token = row.tokenSavedAt ? '<div class="sub">token ' + esc(ftime(row.tokenSavedAt)) + '</div>' : '';
      var detailClass = row.state === 'ok' ? ' success' : (row.state === 'fail' ? ' error' : '');
      var detail = row.state === 'ok'
        ? ''
        : (row.detail ? '<div class="sub account-detail' + detailClass + '" title="' + esc(row.detail) + '">' + esc(clip(row.detail, 88)) + '</div>' : token);
      var checked = row.exists && (settings.accounts || []).indexOf(row.profile) >= 0;
      var enableCell = row.exists
        ? '<label class="account-toggle" title="启用账号 ' + esc(row.label) + '">' +
          '<input type="checkbox" data-account-enable="' + esc(row.profile) + '" value="' + esc(row.profile) + '"' +
          (checked ? ' checked' : '') + '></label>'
        : '<span class="muted">--</span>';
      var deleteButton = row.canDelete
        ? '<button class="tool danger" type="button" data-delete-profile="' + esc(row.profile) + '"' + (busy || runningNow ? ' disabled' : '') + '>删除</button>'
        : '';
      var labelText = row.addSlot ? '添加' : row.label;
      var labelCls = row.addSlot ? 'account-name add' : 'account-name';
      var needsLogin = row.addSlot || row.state === 'missing' || row.state === 'fail' || row.state === 'login' || (!row.tokenCached && row.state !== 'checking');
      var loginButton = needsLogin
        ? '<button class="tool primary" type="button" data-account-login="' + esc(row.profile) + '"' + (busy ? ' disabled' : '') + '>登录</button>'
        : '';
      return '<tr' + (row.addSlot ? ' class="account-row-add"' : '') + '>' +
        '<td><span class="' + labelCls + '">' + esc(labelText) + '</span></td>' +
        '<td>' + enableCell + '</td>' +
        '<td><span class="ellip">' + esc(row.profile) + '</span>' + (row.exists ? '' : '<div class="sub">点击添加可创建</div>') + '</td>' +
        '<td class="wrap">' + email + '</td>' +
        '<td><span class="badge ' + st.cls + '">' + st.text + '</span>' + detail + '</td>' +
        '<td><span class="account-actions">' +
          loginButton +
          deleteButton +
        '</span></td>' +
      '</tr>';
    }).join('');
    document.getElementById('accountRows').innerHTML = html || '<tr><td colspan="6"><div class="empty">' + (box.loading ? '正在读取账号目录…' : '未发现账号目录') + '</div></td></tr>';
    renderLoginDialog();
  }

  function accountRowByProfile(profile) {
    return ((S.accounts && S.accounts.accounts) || []).find(function (row) { return row.profile === profile; }) || null;
  }

  function renderLoginDialog() {
    var dialog = S.loginDialog || {};
    var overlay = document.getElementById('accountLoginOverlay');
    if (!overlay) return;
    overlay.classList.toggle('open', !!dialog.open);
    if (!dialog.open) return;
    var row = accountRowByProfile(dialog.profile) || { label: '?', profile: dialog.profile, state: 'missing', detail: '', exists: false };
    var st = accountState(row);
    document.getElementById('accountLoginTitle').textContent = '登录账号 ' + (row.label || '?');
    document.getElementById('accountLoginLabel').textContent = row.addSlot ? '新增账号 ' + (row.label || '') : '账号 ' + (row.label || '');
    document.getElementById('accountLoginProfile').textContent = row.profile || '--';
    var detailClass = row.state === 'ok' ? ' success' : (row.state === 'fail' ? ' error' : '');
    document.getElementById('accountLoginState').innerHTML = '<span class="badge ' + st.cls + '">' + esc(st.text) + '</span>' +
      (row.detail ? '<div class="sub login-state-detail' + detailClass + '">' + esc(clip(row.detail, 100)) + '</div>' : '');
    var input = document.getElementById('accountLoginUrl');
    var submit = document.getElementById('accountLoginSubmit');
    var close = document.getElementById('accountLoginClose');
    input.disabled = !!dialog.loading || !!dialog.success;
    submit.disabled = !!dialog.loading;
    submit.textContent = dialog.loading ? '正在登录...' : (dialog.success ? '确定' : '登录');
    close.disabled = !!dialog.loading;
    var message = document.getElementById('accountLoginMessage');
    message.className = 'login-dialog-message' + (dialog.success ? ' success' : (dialog.error ? ' error' : ''));
    message.textContent = dialog.success ? (dialog.message || '登录成功，登录态检测通过') : (dialog.error || '');
  }

  function openAccountLogin(profile) {
    var row = accountRowByProfile(profile);
    if (!row) return;
    S.loginDialog = { open: true, profile: profile, loading: false, error: '', success: false, message: '' };
    document.getElementById('accountLoginUrl').value = '';
    renderLoginDialog();
    setTimeout(function () { document.getElementById('accountLoginUrl').focus(); }, 0);
  }

  function closeAccountLogin() {
    if (S.loginDialog && S.loginDialog.loading) return;
    S.loginDialog = { open: false, profile: '', loading: false, error: '', success: false, message: '' };
    document.getElementById('accountLoginUrl').value = '';
    renderLoginDialog();
  }

  function setAllAccountsEnabled(enabled) {
    var rows = (S.accounts && S.accounts.accounts) || [];
    var settings = readSettings();
    settings.accounts = enabled
      ? rows.filter(function (row) { return row.exists; }).map(function (row) { return row.profile; })
      : [];
    settings.accountsTouched = true;
    saveJson(SETTINGS_KEY, settings);
    renderAccounts();
  }

  function failedChildAlertText(child) {
    var retries = Math.max(0, (Number(child && child.attempts) || 0) - 1);
    var apps = Array.isArray(child && child.missingApps) ? child.missingApps : [];
    var appLines = apps.length
      ? apps.map(function (app) { return '• ' + (app.category || '--') + '｜#' + (app.rank || '--') + '｜' + (app.name || '未命名应用'); }).join('\n')
      : '• 未能读取应用清单，请在事件流“进度”页查看失败详情';
    return '采集周 ' + (child && child.weekAnchor || '--') + ' 补采失败\n'
      + '已自动重试 ' + retries + ' 次仍未完成，请手工处理\n\n'
      + '未采集到国别的应用：\n' + appLines;
  }

  function loadRun() {
    return fetch('/api/run', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var wasActive = !!(S.run && S.run.active);
        S.run = Object.assign({ active: false, loading: false, stopping: false, job: null }, j);
        syncSelectedRunId();
        S.run.stopping = !!(S.run.job && S.run.job.state === 'stopping');
        renderAccounts();
        var currentData = S.data || {};
        var currentBatch = currentData.batchProgress || null;
        var currentResults = currentBatch && currentBatch.results
          ? currentBatch.results
          : (currentData.results || {});
        // /api/run 只负责刷新任务控制状态，事件区必须继续沿用当前完整快照。
        // 禁止在批次运行中临时降级为单周事件，否则会每 3 秒在初始化与周完成之间来回切换。
        renderRight(currentData.progress || null, currentBatch, currentResults);
        // 重启后先恢复批次选择，再拉取带 historyId 的快照，避免 SSE 的默认单周快照覆盖整体口径。
        if (S.selectedRunId) fetchOnce();
        if (S.run.active && S.run.job && S.run.job.batchId) {
          var failedChildrenNow = (S.run.job.children || []).filter(function (child) { return child.state === 'failed'; });
          failedChildrenNow.forEach(function (child) {
            var childAlertKey = [S.run.job.batchId, child.historyId || child.weekAnchor || '', child.attempts || 0, child.detail || ''].join('|');
            if (S.failedChildAlertKeys[childAlertKey]) return;
            S.failedChildAlertKeys[childAlertKey] = true;
            showSystemAlert(failedChildAlertText(child), '采集周补采失败', 'danger');
          });
        }
        if (wasActive && !S.run.active && S.run.job && S.run.job.state === 'failed') {
          var failedChildren = (S.run.job.children || []).filter(function (child) { return child.state === 'failed'; });
          var failedScope = S.run.job.batchId
            ? ('批量采集未完成：' + failedChildren.length + ' 个日期失败')
            : '采集未完成';
          showSystemAlert(failedScope + '\n\n' + failedChildren.map(failedChildAlertText).join('\n\n') + '\n\n详细失败原因已显示在事件流的“进度”页。', '采集失败', 'danger');
        }
        return j;
      })
      .catch(function () {});
  }

  function loadAccounts() {
    return fetch('/api/accounts', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) { S.accounts = Object.assign({ loading: false, loaded: true, error: '' }, j); renderAccounts(); return j; })
      .catch(function () { S.accounts.error = '账号池读取失败'; S.accounts.loading = false; S.accounts.loaded = false; renderAccounts(); });
  }

  function checkAccounts(silent, automatic) {
    var blocking = !automatic;
    if (blocking) S.accounts.loading = true;
    else S.accounts.backgroundChecking = true;
    if (!silent) S.accounts.error = '';
    renderAccounts();
    apiPost('/api/accounts/check' + (automatic ? '?automatic=1' : ''))
      .then(function (r) { return r.json(); })
      .then(function (j) { S.accounts = Object.assign({ loading: false, backgroundChecking: false, error: '' }, j); renderAccounts(); })
      .catch(function () {
        S.accounts.loading = false;
        S.accounts.backgroundChecking = false;
        if (!automatic) S.accounts.error = '登录态检测失败';
        renderAccounts();
      });
  }

  function submitAccountLoginLink(profile, loginUrl) {
    S.loginDialog.loading = true;
    S.loginDialog.error = '';
    S.loginDialog.success = false;
    S.loginDialog.message = '';
    renderLoginDialog();
    apiPost('/api/accounts/login-link?profile=' + encodeURIComponent(profile), {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: loginUrl })
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok) {
          S.loginDialog.loading = false;
          S.loginDialog.error = j.error || '登录链接提交失败';
        } else {
          S.loginDialog.loading = false;
          S.loginDialog.error = '';
          S.loginDialog.success = true;
          S.loginDialog.message = '登录成功，登录态检测通过';
        }
        if (j.accounts) S.accounts = Object.assign({}, S.accounts, j, { loading: false, error: '' });
        renderAccounts();
      })
      .catch(function () { S.loginDialog.loading = false; S.loginDialog.error = '登录链接提交失败'; renderLoginDialog(); });
  }

  function stopRun() {
    S.run.stopping = true;
    renderAccounts();
    apiPost('/api/run/stop')
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok) S.accounts.error = j.error || '停止采集失败';
        S.run = Object.assign({ loading: false, stopping: false }, j.run || {}, { loading: false });
        S.run.stopping = !!(S.run.job && S.run.job.state === 'stopping');
        renderAccounts();
        fetchOnce();
        loadRun();
        pollRunWhileBusy();
      })
      .catch(function () { S.run.stopping = false; S.accounts.error = '停止采集失败'; renderAccounts(); });
  }

  async function deleteAccountProfile(profile) {
    if (!(await showSystemConfirm('删除账号 ' + profile + ' 的登录态？后续账号会自动向前补位。', '删除账号登录态', '删除', 'danger'))) return;
    S.accounts.loading = true;
    S.accounts.error = '';
    renderAccounts();
    apiPost('/api/accounts/delete?profile=' + encodeURIComponent(profile))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok) {
          S.accounts.error = j.error || '删除账号失败';
        } else {
          applyProfileMovesToSettings(j.deleted, j.moves || {}, j.accounts || []);
          S.accounts.error = '';
        }
        S.accounts = Object.assign({ loading: false, error: S.accounts.error || '' }, j, { loading: false });
        renderAccounts();
      })
      .catch(function () { S.accounts.loading = false; S.accounts.error = '删除账号失败'; renderAccounts(); });
  }

  function pollAccountsWhileBusy() {
    setTimeout(function () {
      loadAccounts().then(function (j) {
        var busy = (j.accounts || []).some(function (row) { return row.state === 'login' || row.state === 'checking'; });
        if (busy) pollAccountsWhileBusy();
      });
    }, 3000);
  }

  function buildRunQuery(fresh) {
    if (!validateWeekAnchor()) return null;
    var settings = writeSettings();
    if (!(settings.categories || []).length) {
      S.accounts.error = '请在设置中至少选择一个采集品类';
      renderAccounts();
      return null;
    }
    var params = new URLSearchParams();
    if (fresh) params.set('fresh', '1');
    (settings.weekAnchors || []).forEach(function (week) { params.append('weekAnchor', week); });
    params.set('weekAnchorsConfirmed', settings.weekAnchorsConfirmed ? '1' : '0');
    if (settings.listOnly) params.set('listOnly', '1');
    if (settings.skipExcel) params.set('skipExcel', '1');
    params.set('topDepth', normalizeTopDepth(settings.topDepth));
    (settings.accounts || []).forEach(function (acc) { params.append('account', acc); });
    (settings.categories || []).forEach(function (category) { params.append('category', category); });
    return params.toString();
  }

  function requestWeekAnchorConfirmation() {
    if (validateWeekAnchor()) return true;
    showSystemAlert(
      '请先在“采集周起始日”日历中确认至少一个周一。已为你打开日期选择，点击“确定”后即可开始采集。',
      '请先确认采集日期'
    ).then(function () { window.setTimeout(openWeekAnchorCalendar, 0); });
    return false;
  }

  function startRun(fresh) {
    if (!requestWeekAnchorConfirmation()) return;
    var query = buildRunQuery(!!fresh);
    if (query == null) return;
    pageHistoryClearedAt = 0;
    S.run.loading = true;
    renderAccounts();
    apiPost('/api/run/start?' + query)
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok) S.accounts.error = j.error || '采集启动失败';
        else S.accounts.error = '';
        if (j.accounts) S.accounts = Object.assign({ loading: false, error: S.accounts.error || '' }, S.accounts, { accounts: j.accounts, error: S.accounts.error || '' });
        S.run = Object.assign({ loading: false }, j.run || {}, { loading: false });
        renderAccounts();
        fetchOnce();
        loadRun();
        pollRunWhileBusy();
      })
      .catch(function () {
        S.run.loading = false;
        renderAccounts();
      });
  }

  function confirmFreshRun(week) {
    return showSystemConfirm(
      '确认全新采集？\n\n' +
      '这会忽略采集周「' + week + '」的现有榜单和国别缓存，重新请求全部数据。\n\n' +
      '已有历史记录会保留；完成后会更新该周共享缓存和 Excel 文件。\n\n' +
      '是否继续？',
      '全新采集', '开始采集', 'danger'
    );
  }

  function historyExistsForWeeks(weeks) {
    return fetch('/api/history', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok) throw new Error(j.error || '历史记录读取失败');
        var selected = new Set(weeks || []);
        return (j.records || []).filter(function (record) { return selected.has(record.weekAnchor); }).map(function (record) { return record.weekAnchor; });
      });
  }

  function requestFreshRun() {
    if (!requestWeekAnchorConfirmation()) return;
    var weeks = selectedWeekAnchors();
    S.freshHistoryCheckLoading = true;
    renderAccounts();
    historyExistsForWeeks(weeks)
      .then(async function (historyWeeks) {
        S.freshHistoryCheckLoading = false;
        if (historyWeeks.length && !(await confirmFreshRun(historyWeeks.join('、')))) { renderAccounts(); return; }
        startRun(true);
      })
      .catch(function (e) {
        S.freshHistoryCheckLoading = false;
        S.accounts.error = e && e.message ? ('历史记录检查失败：' + e.message) : '历史记录检查失败，请稍后重试';
        renderAccounts();
      });
  }

  function pollRunWhileBusy() {
    setTimeout(function () {
      loadRun().then(function (j) {
        fetchOnce();
        if (j && j.active) pollRunWhileBusy();
      });
    }, 3000);
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function initFixedPanels() {
    var DEFAULT_LAYOUT = {
      // 固定为左栏可拖至的最大宽度，取消用户本地拖拽状态的影响。
      colSplit: 0.8,
      leftRows: [0.58, 0.42],
      rightRows: [0.14, 0.66, 0.20]
    };
    var main = document.querySelector('.main');
    var cols = document.querySelectorAll('.main > .col');
    var leftCol = cols[0];
    var rightCol = cols[1];
    var leftPanels = [
      document.querySelector('[data-panel="weekly-overview"]'),
      document.querySelector('[data-panel="focus-apps"]')
    ];
    var rightPanels = [
      document.querySelector('[data-panel="market-split"]'),
      document.querySelector('[data-panel="events"]'),
      document.querySelector('[data-panel="context"]')
    ];
    var state = sanitizeState(DEFAULT_LAYOUT);

    function finiteNumber(v) {
      return typeof v === 'number' && isFinite(v);
    }

    function cssPx(el, prop, fallback) {
      if (!el) return fallback;
      var n = parseFloat(window.getComputedStyle(el)[prop]);
      return isFinite(n) ? n : fallback;
    }

    function normalizeRatios(arr, count, fallback) {
      var source = Array.isArray(arr) && arr.length === count ? arr : fallback;
      var clean = source.map(function (v, i) {
        v = Number(v);
        return isFinite(v) && v > 0 ? v : fallback[i];
      });
      var sum = clean.reduce(function (a, b) { return a + b; }, 0) || 1;
      return clean.map(function (v) { return v / sum; });
    }

    function sanitizeState(raw) {
      var rightRows = normalizeRatios(raw && raw.rightRows, rightPanels.length, DEFAULT_LAYOUT.rightRows);
      return {
        colSplit: finiteNumber(raw && raw.colSplit) ? clamp(raw.colSplit, 0.2, 0.8) : DEFAULT_LAYOUT.colSplit,
        leftRows: normalizeRatios(raw && raw.leftRows, leftPanels.length, DEFAULT_LAYOUT.leftRows),
        rightRows: rightRows
      };
    }

    function mainGap() {
      return cssPx(main, 'columnGap', 11.2);
    }

    function rowGap(col) {
      return cssPx(col, 'rowGap', 11.2);
    }

    function isStackedLayout() {
      return window.matchMedia('(max-width: 1400px)').matches;
    }

    function minColumnWidths(total) {
      var rem = cssPx(document.documentElement, 'fontSize', 16);
      var left = Math.round(rem * 48);
      var right = Math.round(rem * 30);
      var available = Math.max(0, total - 2);
      if (left + right > available && available > 0) {
        var scale = available / Math.max(1, left + right);
        left = Math.floor(left * scale);
        right = Math.max(0, available - left);
      }
      return {
        left: Math.max(0, left),
        right: Math.max(0, right)
      };
    }

    function minPanelSize(total, count) {
      var cap = Math.max(24, Math.floor(total / Math.max(1, count)) - 2);
      return Math.min(64, cap);
    }

    function panelBorderY(panel) {
      return cssPx(panel, 'borderTopWidth', 0) + cssPx(panel, 'borderBottomWidth', 0);
    }

    function minVariablePanelSize(total) {
      return Math.min(120, Math.max(72, Math.floor(total / 4)));
    }

    function weeklyOverviewMaxHeight(total, fallback) {
      var panel = leftPanels[0];
      if (!panel) return fallback;
      var head = panel.querySelector('.head');
      var body = panel.querySelector('.batch-weeks-body');
      var list = body && body.querySelector('.batch-week-list');
      var bodyPadding = body ? cssPx(body, 'paddingTop', 0) + cssPx(body, 'paddingBottom', 0) : 0;
      // 周详情嵌在对应摘要下方，直接按整列完整高度计算，避免展开后被截断。
      var bodyContent = list ? list.scrollHeight : 0;
      var content = (head ? head.offsetHeight : 0) + bodyContent + bodyPadding + panelBorderY(panel) + 2;
      var hardCap = Math.min(Math.round(total * 0.66), 580);
      return clamp(Math.ceil(content || fallback), fallback, Math.max(fallback, hardCap));
    }

    function preferredLockedHeight(panel, fallback, min, max) {
      if (!panel) return clamp(Math.round(fallback), min, max);
      // 固定面板不能用自身 scrollHeight 反推高度：已分配的空白也会被算进内容高度。
      // 改为逐个子节点计算真实内容高度，让市场分布和运行上下文随内容收缩。
      var content = Array.prototype.reduce.call(panel.children, function (sum, child) {
        if (child.hidden || getComputedStyle(child).display === 'none') return sum;
        return sum + child.scrollHeight + cssPx(child, 'marginTop', 0) + cssPx(child, 'marginBottom', 0);
      }, panelBorderY(panel));
      var needed = content > 20 ? content : fallback;
      return clamp(Math.round(needed), min, max);
    }

    function clearLayoutStyles() {
      main.style.gridTemplateColumns = '';
      [leftCol, rightCol].forEach(function (col) {
        if (!col) return;
        col.style.flex = '';
        col.style.width = '';
      });
      leftPanels.concat(rightPanels).forEach(function (panel) {
        if (!panel) return;
        panel.style.flex = '';
        panel.style.height = '';
        panel.style.width = '';
      });
    }

    function applyColumnRows(col, panels, ratios) {
      if (!col) return;
      var gap = rowGap(col);
      var total = Math.max(0, col.clientHeight - gap * (panels.length - 1));
      var normalized = normalizeRatios(ratios, panels.length, panels === leftPanels ? DEFAULT_LAYOUT.leftRows : DEFAULT_LAYOUT.rightRows);
      if (panels === leftPanels && panels.length === 2) {
        var minTop = minPanelSize(total, 2);
        var minBottom = minPanelSize(total, 2);
        var maxTop = Math.max(minTop, total - minBottom);
        // 周总览按实际内容在上下方向伸缩：展开时容纳详情，收起后立即回落到摘要高度。
        var top = clamp(weeklyOverviewMaxHeight(total, minTop), minTop, maxTop);
        panels[0].style.flex = '0 0 auto';
        panels[0].style.height = top + 'px';
        panels[0].style.width = '';
        panels[1].style.flex = '0 0 auto';
        panels[1].style.height = Math.max(0, total - top) + 'px';
        panels[1].style.width = '';
        return;
      }
      panels.forEach(function (panel, i) {
        if (!panel) return;
        panel.style.flex = '0 0 auto';
        panel.style.height = Math.max(0, Math.round(total * normalized[i])) + 'px';
        panel.style.width = '';
      });
    }

    function fixedRightHeights(total) {
      var marketBase = clamp(Math.round(total * DEFAULT_LAYOUT.rightRows[1]), 72, 96);
      var contextBase = clamp(Math.round(total * 0.18), 112, 180);
      var market = preferredLockedHeight(rightPanels[0], marketBase, 64, 140);
      var context = preferredLockedHeight(rightPanels[2], contextBase, 96, 300);
      var minVariable = minVariablePanelSize(total);
      var maxFixed = Math.max(0, total - minVariable);
      if (market + context > maxFixed) {
        var scale = maxFixed / Math.max(1, market + context);
        market = Math.max(64, Math.floor(market * scale));
        context = Math.max(96, Math.floor(context * scale));
      }
      return { market: market, context: context };
    }

    function rightMetrics() {
      var gap = rowGap(rightCol);
      var visibleCount = rightPanels.filter(function (panel) { return panel && !panel.hidden; }).length;
      var total = Math.max(0, rightCol.clientHeight - gap * Math.max(0, visibleCount - 1));
      var fixed = fixedRightHeights(total);
      var variable = Math.max(0, total - fixed.market - fixed.context);
      return {
        total: total,
        gap: gap,
        fixed: fixed,
        variable: variable,
        sizes: [fixed.market, variable, fixed.context]
      };
    }

    function applyRightRows() {
      if (!rightCol) return;
      var metrics = rightMetrics();
      rightPanels.forEach(function (panel, i) {
        if (!panel) return;
        if (panel.hidden) {
          panel.style.flex = '0 0 0px';
          panel.style.height = '0px';
          panel.style.width = '';
          return;
        }
        panel.style.flex = '0 0 auto';
        panel.style.height = Math.max(0, Math.round(metrics.sizes[i])) + 'px';
        panel.style.width = '';
      });
      state.rightRows = metrics.total
        ? metrics.sizes.map(function (v) { return v / metrics.total; })
        : DEFAULT_LAYOUT.rightRows.slice();
    }

    function applyLayout() {
      if (!main || !leftCol || !rightCol) return;
      if (isStackedLayout()) {
        clearLayoutStyles();
        return;
      }
      var gap = mainGap();
      var totalW = Math.max(0, main.clientWidth - gap);
      var minWidths = minColumnWidths(totalW);
      var leftW = clamp(Math.round(totalW * DEFAULT_LAYOUT.colSplit), minWidths.left, totalW - minWidths.right);
      var rightW = totalW - leftW;
      main.style.gridTemplateColumns = leftW + 'px ' + rightW + 'px';
      leftCol.style.flex = '0 0 auto';
      rightCol.style.flex = '0 0 auto';
      leftCol.style.width = '';
      rightCol.style.width = '';
      applyColumnRows(leftCol, leftPanels, state.leftRows);
      applyRightRows();
    }

    var layoutPending = false;
    function scheduleLayout() {
      if (layoutPending) return;
      layoutPending = true;
      window.requestAnimationFrame(function () {
        layoutPending = false;
        applyLayout();
      });
    }

    applyLayout();
    window.addEventListener('resize', scheduleLayout);
    window.amdcRelayoutPanels = scheduleLayout;
    if (window.ResizeObserver) {
      var layoutObserver = new ResizeObserver(function () {
        scheduleLayout();
      });
      layoutObserver.observe(main);
    }
  }

  function setEventPanelHtml(eventBody, html) {
    if (eventBody.innerHTML !== html) eventBody.innerHTML = html;
  }

  function createProgressEventNode(item) {
    var holder = document.createElement('div');
    holder.innerHTML = item.html;
    var node = holder.firstElementChild;
    node.setAttribute('data-event-key', item.key);
    node.setAttribute('data-event-signature', item.signature);
    return node;
  }

  function renderProgressEventNodes(eventBody, items) {
    if (!items.length) {
      setEventPanelHtml(eventBody, '<div class="empty">暂无事件（运行开始后展示）</div>');
      return;
    }
    var existing = Object.create(null);
    Array.prototype.slice.call(eventBody.children).forEach(function (node) {
      var key = node.getAttribute && node.getAttribute('data-event-key');
      if (key) existing[key] = node;
    });
    var keep = Object.create(null);
    items.forEach(function (item, index) {
      keep[item.key] = true;
      var node = existing[item.key];
      if (!node || node.getAttribute('data-event-signature') !== item.signature) {
        node = createProgressEventNode(item);
      }
      node.classList.toggle('newest', index === 0);
      var current = eventBody.children[index] || null;
      if (current !== node) eventBody.insertBefore(node, current);
    });
    Array.prototype.slice.call(eventBody.children).forEach(function (node) {
      var key = node.getAttribute && node.getAttribute('data-event-key');
      if (!key || !keep[key]) node.remove();
    });
  }

  function renderRight(p, batchProgress, taskResults) {
    updateEventFilterButtons();
    var eventBody = document.getElementById('events');
    var progressEvents = (batchProgress && batchProgress.events || p && p.events || []).slice();
    if (!progressEvents.length && !batchProgress && S.run && S.run.job && S.run.job.batchId) {
      progressEvents = (S.run.job.children || []).map(function (child) {
        var labels = { queued: '等待', starting: '启动中', running: '采集中', done: '完成', failed: '失败', stopped: '已停止' };
        return {
          at: child.finishedAt || child.startedAt || S.run.job.startedAt,
          weekAnchor: child.weekAnchor || '',
          level: child.state === 'failed' ? 'error' : (child.state === 'done' ? 'info' : 'warn'),
          message: child.weekAnchor + '：' + (labels[child.state] || child.state || '--'),
          error: child.state === 'failed' ? (child.detail || '采集失败') : '',
          account: child.profile || '',
        };
      });
    }
    var currentWeek = '';
    if (batchProgress && Array.isArray(batchProgress.weekSummaries)) {
      var currentSummary = batchProgress.weekSummaries.filter(function (week) { return week.state === 'running' || week.state === 'starting'; })[0];
      if (!currentSummary && S.expandedWeekId) {
        currentSummary = batchProgress.weekSummaries.filter(function (week) { return (week.historyId || week.weekAnchor) === S.expandedWeekId; })[0];
      }
      currentWeek = currentSummary && currentSummary.weekAnchor || '';
    }
    if (S.eventFilter === 'current' && currentWeek) {
      progressEvents = progressEvents.filter(function (event) { return event && event.weekAnchor === currentWeek; });
    } else if (S.eventFilter === 'errors') {
      progressEvents = progressEvents.filter(function (event) {
        return event && (event.level === 'warn' || event.level === 'error' || /429|失败|疑似下架|未完成/.test(String(event.message || '')));
      });
    }
    var eventItems = progressEvents.slice().reverse().map(function (e, i) {
        var extra = [];
        if (e.account) extra.push(accShort(e.account));
        if (e.category) extra.push(e.category);
        var detail = failureDetail(e);
        if (e.durationMs != null && isFinite(Number(e.durationMs))) {
          detail = (detail ? detail + ' | ' : '') + '耗时：' + dur(Number(e.durationMs));
        }
        if (e.queueWaitMs != null && isFinite(Number(e.queueWaitMs)) && Number(e.queueWaitMs) > 0) {
          detail = (detail ? detail + ' | ' : '') + '排队：' + dur(Number(e.queueWaitMs));
        }
        var weekLabel = e.weekAnchor || '';
        var timeLabels = [weekLabel].concat(extra).filter(Boolean);
        var html = '<div class="event' + (i === 0 ? ' newest' : '') + '" data-l="' + esc(e.level || 'info') + '">' +
          '<div class="t">' + esc(ftime(e.at)) + (timeLabels.length ? ' · ' + esc(timeLabels.join(' · ')) : '') + '</div>' +
          '<div class="m">' + esc(zh(e.message)) + '</div>' +
          (detail ? '<div class="d">' + esc(zh(detail)) + '</div>' : '') +
        '</div>';
        return {
          key: eventKey(e),
          signature: [e.level || 'info', ftime(e.at), timeLabels.join(' · '), zh(e.message), zh(detail)].join('|'),
          html: html,
        };
    });
    renderProgressEventNodes(eventBody, eventItems);

    var projectDir = (S.data && S.data.projectDir) || '';
    var out = (S.data && S.data.outputDir) || (projectDir ? projectDir.replace(/[\\/]$/, '') + '\\output' : '');
    var configuredSettings = readSettings();
    var collectionWeeks = [];
    if (batchProgress && Array.isArray(batchProgress.weekSummaries) && batchProgress.weekSummaries.length) {
      collectionWeeks = batchProgress.weekSummaries.map(function (week) { return week.weekAnchor; });
    } else if (S.run && S.run.job && S.run.job.options && Array.isArray(S.run.job.options.weekAnchors)) {
      collectionWeeks = S.run.job.options.weekAnchors.slice();
    } else if (configuredSettings.weekAnchorsConfirmed && Array.isArray(configuredSettings.weekAnchors)) {
      collectionWeeks = configuredSettings.weekAnchors.slice();
    }
    collectionWeeks = collectionWeeks.filter(isMondayValue).sort().reverse();
    var contextStage = batchProgress
      ? (batchProgress.state === 'failed' ? '整体任务失败' : (batchProgress.state === 'done' ? '整体任务已完成' : (batchProgress.phase === 'leaderboard' ? '确认全部周榜单' : (batchProgress.phase === 'application' ? '逐周采集应用数据' : '--'))))
      : (p ? zh(p.stageLabel || p.currentStage || '--') : '--');
    var ctx = [
      ['阶段', esc(contextStage)],
      ['采集周', esc(collectionWeeks.length ? collectionWeeks.join('，') : '--')],
      ['运行目录', projectDir
        ? '<a href="#" id="openProjectDir" title="点击打开项目文件夹：' + esc(projectDir) + '">' + esc(projectDir) + '</a>'
        : '--', projectDir ? 'path-value' : ''],
      ['输出目录', out
        ? '<a href="#" id="openDir" title="点击打开本地文件夹：' + esc(out) + '">' + esc(out) + '</a>'
        : '--', out ? 'path-value' : ''],
    ];
    document.getElementById('ctx').innerHTML = ctx.map(function (kv) {
      return '<div class="kv"><span class="k">' + kv[0] + '</span><span class="v ' + (kv[2] || '') + '">' + kv[1] + '</span></div>';
    }).join('');
    var openDir = document.getElementById('openDir');
    if (openDir) {
      openDir.addEventListener('click', function (e) {
        e.preventDefault();
        apiPost('/api/open-output').catch(function () {});
      });
    }
    var openProjectDir = document.getElementById('openProjectDir');
    if (openProjectDir) {
      openProjectDir.addEventListener('click', function (e) {
        e.preventDefault();
        apiPost('/api/open-project').catch(function () {});
      });
    }
    if (window.amdcRelayoutPanels) window.amdcRelayoutPanels();
  }

  document.getElementById('tabs').addEventListener('click', function (e) {
    var t = e.target.closest('.tab');
    if (!t) return;
    S.tab = t.getAttribute('data-c');
    renderTabs(currentResults(), S.data && S.data.progress || null);
    renderCurrentFocus();
  });
  function setFocusSort(value, persist) {
    S.sortBy = value === 'change' ? 'change' : 'rank';
    var trigger = document.getElementById('sortBy');
    var options = document.querySelectorAll('#sortOptions [data-sort]');
    Array.prototype.forEach.call(options, function (option) {
      var selected = option.getAttribute('data-sort') === S.sortBy;
      option.setAttribute('aria-selected', selected ? 'true' : 'false');
      if (selected && trigger) trigger.firstChild.nodeValue = option.textContent;
    });
    if (persist) writeSettings();
    renderCurrentFocus();
  }
  function closeSortMenu() {
    var menu = document.getElementById('sortMenu');
    var trigger = document.getElementById('sortBy');
    document.getElementById('sortOptions').hidden = true;
    if (menu) menu.classList.remove('open');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  }
  function setTopDepth(value, persist) {
    var depth = normalizeTopDepth(value);
    var input = document.getElementById('topDepthInput');
    var trigger = document.getElementById('topDepthTrigger');
    var options = document.querySelectorAll('#topDepthOptions [data-top-depth]');
    if (input) input.value = depth;
    Array.prototype.forEach.call(options, function (option) {
      var selected = option.getAttribute('data-top-depth') === depth;
      option.setAttribute('aria-selected', selected ? 'true' : 'false');
      if (selected && trigger) trigger.firstChild.nodeValue = option.textContent;
    });
    if (persist) writeSettings();
  }
  function closeTopDepthMenu() {
    var menu = document.getElementById('topDepthMenu');
    var trigger = document.getElementById('topDepthTrigger');
    document.getElementById('topDepthOptions').hidden = true;
    if (menu) menu.classList.remove('open');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  }
  document.getElementById('sortBy').addEventListener('click', function () {
    var menu = document.getElementById('sortMenu');
    var open = menu.classList.toggle('open');
    document.getElementById('sortOptions').hidden = !open;
    this.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  document.getElementById('sortOptions').addEventListener('click', function (e) {
    var option = e.target.closest('[data-sort]');
    if (!option) return;
    setFocusSort(option.getAttribute('data-sort'), true);
    closeSortMenu();
  });
  document.addEventListener('click', function (e) {
    var menu = document.getElementById('sortMenu');
    if (menu && !menu.contains(e.target)) closeSortMenu();
  });
  document.getElementById('sortBy').addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeSortMenu(); this.focus(); }
  });
  document.getElementById('topDepthTrigger').addEventListener('click', function () {
    var menu = document.getElementById('topDepthMenu');
    var open = menu.classList.toggle('open');
    document.getElementById('topDepthOptions').hidden = !open;
    this.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  document.getElementById('topDepthOptions').addEventListener('click', function (e) {
    var option = e.target.closest('[data-top-depth]');
    if (!option) return;
    setTopDepth(option.getAttribute('data-top-depth'), true);
    closeTopDepthMenu();
  });
  document.addEventListener('click', function (e) {
    var menu = document.getElementById('topDepthMenu');
    if (menu && !menu.contains(e.target)) closeTopDepthMenu();
  });
  document.getElementById('topDepthTrigger').addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeTopDepthMenu(); this.focus(); }
  });
  var focusRenderFrame = 0;
  function scheduleFocusRender() {
    if (focusRenderFrame) window.cancelAnimationFrame(focusRenderFrame);
    focusRenderFrame = window.requestAnimationFrame(function () {
      focusRenderFrame = 0;
      renderCurrentFocus();
    });
  }
  document.getElementById('search').addEventListener('input', function (e) {
    S.search = e.target.value.trim();
    scheduleFocusRender();
  });
  document.getElementById('historyOpen').addEventListener('click', function () { openHistory(); });
  document.getElementById('historyClose').addEventListener('click', function () { closeHistory(); });
  document.getElementById('historyRefresh').addEventListener('click', function () { loadHistory(); });
  document.getElementById('historyBatchSyncStop').addEventListener('click', function () { stopHistoryBatchSync(); });
  document.getElementById('historyBatchSync').addEventListener('click', function () { syncHistoryBatch(); });
  document.getElementById('historySelectAll').addEventListener('change', function () {
    if (historyBatchSyncActive()) return;
    togglePendingHistorySyncSelection();
  });
  document.getElementById('historyOverlay').addEventListener('click', function (e) {
    if (e.target === document.getElementById('historyOverlay')) closeHistory();
  });
  document.getElementById('historyRows').addEventListener('click', function (e) {
    var select = e.target.closest('[data-history-select]');
    if (select) {
      if (historyBatchSyncActive()) return;
      var selectId = select.getAttribute('data-history-select');
      var selectedIndex = S.history.selectedSyncIds.indexOf(selectId);
      if (select.checked && selectedIndex < 0) S.history.selectedSyncIds.push(selectId);
      if (!select.checked && selectedIndex >= 0) S.history.selectedSyncIds.splice(selectedIndex, 1);
      S.history.batchSelectMode = '';
      renderHistory();
      return;
    }
    var sync = e.target.closest('[data-history-sync]');
    if (sync) { if (!sync.disabled) syncHistory(sync.getAttribute('data-history-sync')); return; }
    var view = e.target.closest('[data-history-view]');
    if (view) { viewHistory(view.getAttribute('data-history-view')); return; }
    var del = e.target.closest('[data-history-delete]');
    if (del) deleteHistory(del.getAttribute('data-history-delete'));
  });
  document.getElementById('settingsOpen').addEventListener('click', function () { openSettings(); });
  document.getElementById('settingsClose').addEventListener('click', function () { closeSettings(); });
  document.getElementById('settingsOverlay').addEventListener('click', function (e) {
    if (e.target === document.getElementById('settingsOverlay')) closeSettings();
  });
  document.getElementById('categoryOptions').addEventListener('change', function () {
    updateCategorySelectHint();
    writeSettings();
  });
  document.getElementById('categoriesSelectAll').addEventListener('click', function () {
    Array.prototype.forEach.call(document.querySelectorAll('[data-category]'), function (el) { el.checked = true; });
    updateCategorySelectHint();
    writeSettings();
  });
  document.getElementById('categoriesClear').addEventListener('click', function () {
    Array.prototype.forEach.call(document.querySelectorAll('[data-category]'), function (el) { el.checked = false; });
    updateCategorySelectHint();
    writeSettings();
  });
  document.getElementById('accountLoginClose').addEventListener('click', function () { closeAccountLogin(); });
  document.getElementById('accountLoginOverlay').addEventListener('click', function (e) {
    if (e.target === document.getElementById('accountLoginOverlay')) closeAccountLogin();
  });
  window.addEventListener('resize', function () {
    if (activeSystemDialog) layoutSystemDialogMessage(document.getElementById('systemDialogMessage'), activeSystemDialog);
  });
  document.getElementById('systemDialogAccept').addEventListener('click', function () { settleSystemDialog(true); });
  document.getElementById('systemDialogCancel').addEventListener('click', function () { settleSystemDialog(false); });
  document.getElementById('systemDialogClose').addEventListener('click', function () { settleSystemDialog(false); });
  document.getElementById('systemDialogOverlay').addEventListener('click', function (e) {
    if (e.target === document.getElementById('systemDialogOverlay')) settleSystemDialog(false);
  });
  document.getElementById('accountLoginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    if (S.loginDialog && S.loginDialog.success) {
      closeAccountLogin();
      return;
    }
    var profile = S.loginDialog && S.loginDialog.profile;
    var loginUrl = document.getElementById('accountLoginUrl').value.trim();
    if (!profile) return;
    if (!loginUrl) {
      S.loginDialog.error = '请先粘贴邮件中的 AMDC 登录链接';
      renderLoginDialog();
      return;
    }
    submitAccountLoginLink(profile, loginUrl);
  });
  document.getElementById('runStart').addEventListener('click', function () { startRun(false); });
  document.getElementById('runStartFresh').addEventListener('click', function () {
    requestFreshRun();
  });
  document.getElementById('runStop').addEventListener('click', async function () {
    if (!(await showSystemConfirm('确认停止当前采集吗？', '停止当前采集', '停止采集', 'danger'))) return;
    stopRun();
  });
  document.getElementById('pageRefresh').addEventListener('click', async function () {
    if ((S.run && S.run.active) || historyBatchSyncActive() || (S.history && (S.history.syncingId || S.history.batchRequestPending))) {
      await showSystemAlert('任务运行中，完成后才能刷新看板', '暂时无法刷新', 'danger');
      return;
    }
    apiPost('/api/dashboard/clear')
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok) throw new Error(j.error || '清空面板失败');
        pageHistoryClearedAt = new Date(j.clearedAt || '').getTime() || Date.now();
        S.selectedRunId = '';
        S.run.active = false;
        S.run.job = null;
        S.run.stopping = false;
        S.data = { at: '', projectDir: '', runDir: null, progress: null, results: { categories: [], risers: [], marketSplit: null } };
        S.health = null;
        S.healthLoading = false;
        S.eventFilter = 'all';
        S.expandedWeekId = null;
        S.expandedWeekBatchId = '';
        render();
        fetchOnce();
      })
      .catch(function (e) { showSystemAlert(e && e.message ? e.message : '清空面板失败', '清空面板失败', 'danger'); });
  });
  document.getElementById('accountRefresh').addEventListener('click', function () { checkAccounts(); });
  document.getElementById('themeToggle').addEventListener('click', function () {
    var settings = readSettings();
    var current = normalizeTheme(settings.theme);
    var next = current === 'dark' ? 'light' : 'dark';
    settings.theme = next;
    saveJson(SETTINGS_KEY, settings);
    var select = document.getElementById('themeModeInput');
    if (select) select.value = next;
    applyTheme(next);
  });
  document.getElementById('accountsEnableAll').addEventListener('click', function () { setAllAccountsEnabled(true); });
  document.getElementById('accountsDisableAll').addEventListener('click', function () { setAllAccountsEnabled(false); });
  document.getElementById('accountRows').addEventListener('change', function (e) {
    if (e.target.closest('[data-account-enable]')) {
      writeSettings(true);
      renderAccounts();
    }
  });
  document.getElementById('accountRows').addEventListener('click', function (e) {
    var d = e.target.closest('[data-delete-profile]');
    if (d) {
      deleteAccountProfile(d.getAttribute('data-delete-profile'));
      return;
    }
    var login = e.target.closest('[data-account-login]');
    if (login) openAccountLogin(login.getAttribute('data-account-login'));
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && activeSystemDialog) { settleSystemDialog(false); return; }
    if (e.key === 'Escape' && S.loginDialog && S.loginDialog.open) closeAccountLogin();
  });
  document.addEventListener('click', function (e) {
    var filter = e.target.closest('[data-event-filter]');
    if (!filter) return;
    e.preventDefault();
    S.eventFilter = filter.getAttribute('data-event-filter') || 'all';
    renderCurrentRight();
  });
  document.getElementById('batchWeeks').addEventListener('click', function (e) {
    var toggle = e.target.closest('[data-week-toggle]');
    if (!toggle) return;
    var key = toggle.getAttribute('data-week-toggle') || '';
    var historyId = toggle.getAttribute('data-week-history-id') || '';
    S.expandedWeekId = S.expandedWeekId === key ? '' : key;
    renderBatchWeeks(S.data && S.data.batchProgress || null, S.data && S.data.progress || null);
    if (window.amdcRelayoutPanels) window.amdcRelayoutPanels();
    if (historyId && historyId !== S.selectedRunId) {
      S.selectedRunId = historyId;
      fetchOnce();
    }
  });
  var weekAnchorInput = document.getElementById('weekAnchorInput');
  var weekAnchorPicker = null;
  var weekAnchorCalendar = document.getElementById('weekAnchorCalendar');
  var weekAnchorPickerButton = document.getElementById('weekAnchorPickerButton');
  var calendarCursor = null;
  var calendarView = 'days';
  var calendarYearStart = null;
  var calendarWheelAt = 0;
  var pendingWeekAnchors = [];
  function calendarDateText(date) {
    return date.getUTCFullYear() + '-' + String(date.getUTCMonth() + 1).padStart(2, '0') + '-' + String(date.getUTCDate()).padStart(2, '0');
  }
  function calendarBaseDate() {
    var value = (pendingWeekAnchors[0] || selectedWeekAnchors()[0] || '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      var selected = new Date(value + 'T00:00:00Z');
      if (!isNaN(selected.getTime())) return selected;
    }
    var now = new Date();
    return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  }
  function calendarHistoryState(weekAnchor) {
    var record = (S.history.records || []).filter(function (item) {
      return item && item.weekAnchor === weekAnchor;
    })[0];
    if (!record) return '';
    if (record.status === 'failed') return 'failed';
    if (record.status !== 'done' && record.status !== 'legacy') return '';
    var configuredCategories = Array.isArray(record.categories) ? record.categories : [];
    var allConfiguredCategories = !configuredCategories.length || CATEGORY_OPTIONS.every(function (category) {
      return configuredCategories.indexOf(category) >= 0;
    });
    var actualCategoryCount = Number(record.resultSummary && record.resultSummary.categories) || 0;
    return allConfiguredCategories && actualCategoryCount >= CATEGORY_OPTIONS.length ? 'collected' : '';
  }
  function renderWeekAnchorCalendar() {
    if (!weekAnchorCalendar) return;
    if (!calendarCursor) {
      var base = calendarBaseDate();
      calendarCursor = { year: base.getUTCFullYear(), month: base.getUTCMonth() };
    }
    var center = '';
    var content = '';
    var navLabel = calendarView === 'years' ? '年份范围' : (calendarView === 'months' ? '年份' : '月份');
    if (calendarView === 'years') {
      if (calendarYearStart == null) calendarYearStart = calendarCursor.year - 5;
      center = '<div class="calendar-title">' + calendarYearStart + ' - ' + (calendarYearStart + 14) + '</div>';
      var years = '';
      for (var y = calendarYearStart; y < calendarYearStart + 15; y++) {
        years += '<button type="button" class="calendar-option' + (y === calendarCursor.year ? ' selected' : '') + '" data-calendar-year="' + y + '">' + y + '年</button>';
      }
      content = '<div class="calendar-options">' + years + '</div>';
    } else if (calendarView === 'months') {
      center = '<div class="calendar-title"><button type="button" data-calendar-view="years">' + calendarCursor.year + '年</button></div>';
      var months = '';
      for (var m = 0; m < 12; m++) {
        months += '<button type="button" class="calendar-option' + (m === calendarCursor.month ? ' selected' : '') + '" data-calendar-month="' + m + '">' + (m + 1) + '月</button>';
      }
      content = '<div class="calendar-options">' + months + '</div>';
    } else {
      center = '<div class="calendar-title"><button type="button" data-calendar-view="years">' + calendarCursor.year + '年</button><button type="button" data-calendar-view="months">' + (calendarCursor.month + 1) + '月</button></div>';
      var first = new Date(Date.UTC(calendarCursor.year, calendarCursor.month, 1));
      var offset = (first.getUTCDay() + 6) % 7;
      var start = new Date(first.getTime() - offset * 86400000);
      var selectedTexts = new Set(pendingWeekAnchors);
      var latestSelectableText = previousWeekMondayValue();
      var today = new Date();
      var todayText = calendarDateText(new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())));
      var days = '';
      for (var i = 0; i < 42; i++) {
        var date = new Date(start.getTime() + i * 86400000);
        var textValue = calendarDateText(date);
        var monday = date.getUTCDay() === 1;
        var selectableMonday = monday && textValue <= latestSelectableText;
        var otherMonth = date.getUTCMonth() !== calendarCursor.month;
        var historyState = monday ? calendarHistoryState(textValue) : '';
        var classes = 'calendar-day' + (otherMonth ? ' other jump' : '') +
          (selectableMonday ? ' monday' : (monday ? ' unavailable' : '')) + (historyState ? ' history-' + historyState : '') +
          (selectedTexts.has(textValue) ? ' selected' : '') + (textValue === todayText ? ' today' : '');
        var action = otherMonth
          ? ' data-calendar-jump="' + date.getUTCFullYear() + '-' + date.getUTCMonth() + '"'
          : (selectableMonday ? ' data-calendar-date="' + textValue + '"' : ' disabled');
        days += '<button type="button" class="' + classes + '"' + action + '>' + date.getUTCDate() + '</button>';
      }
      content = '<div class="calendar-weekdays"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div><div class="calendar-days">' + days + '</div>';
    }
    var footer = calendarView === 'days'
      ? '<div class="calendar-footer"><span class="calendar-history-legend"><span><i class="collected"></i>有采集历史</span><span><i class="failed"></i>采集失败</span></span><span>' + pendingWeekAnchors.length + ' 个周已选择</span><div><button type="button" class="tool" data-calendar-clear>清空</button><button type="button" class="tool primary" data-calendar-confirm>确定</button></div></div>'
      : '';
    weekAnchorCalendar.innerHTML = '<div class="calendar-head">' +
      '<button type="button" class="calendar-nav" data-calendar-nav="-1" aria-label="上一个' + navLabel + '">‹</button>' + center +
      '<button type="button" class="calendar-nav" data-calendar-nav="1" aria-label="下一个' + navLabel + '">›</button></div>' + content + footer;
  }
  function openWeekAnchorCalendar() {
    if (!weekAnchorCalendar) return;
    pendingWeekAnchors = selectedWeekAnchors();
    var base = calendarBaseDate();
    calendarCursor = { year: base.getUTCFullYear(), month: base.getUTCMonth() };
    calendarView = 'days';
    calendarYearStart = null;
    renderWeekAnchorCalendar();
    weekAnchorCalendar.hidden = false;
    if (!S.history.records.length && !S.history.loading) loadHistory();
    if (weekAnchorPickerButton) weekAnchorPickerButton.setAttribute('aria-expanded', 'true');
  }
  function closeWeekAnchorCalendar() {
    if (!weekAnchorCalendar) return;
    weekAnchorCalendar.hidden = true;
    if (weekAnchorPickerButton) weekAnchorPickerButton.setAttribute('aria-expanded', 'false');
  }
  if (weekAnchorInput) {
    weekAnchorInput.addEventListener('click', function () { openWeekAnchorCalendar(); });
  }
  if (weekAnchorPickerButton && weekAnchorCalendar) {
    weekAnchorPickerButton.setAttribute('aria-haspopup', 'dialog');
    weekAnchorPickerButton.setAttribute('aria-expanded', 'false');
    weekAnchorPickerButton.addEventListener('click', function (e) {
      e.stopPropagation();
      if (weekAnchorCalendar.hidden) openWeekAnchorCalendar();
      else closeWeekAnchorCalendar();
    });
    weekAnchorCalendar.addEventListener('click', function (e) {
      e.stopPropagation();
      var nav = e.target.closest('[data-calendar-nav]');
      if (nav) {
        var direction = Number(nav.getAttribute('data-calendar-nav'));
        if (calendarView === 'years') {
          calendarYearStart += direction * 15;
        } else if (calendarView === 'months') {
          calendarCursor.year += direction;
        } else {
          var next = new Date(Date.UTC(calendarCursor.year, calendarCursor.month + direction, 1));
          calendarCursor = { year: next.getUTCFullYear(), month: next.getUTCMonth() };
        }
        renderWeekAnchorCalendar();
        return;
      }
      var view = e.target.closest('[data-calendar-view]');
      if (view) {
        calendarView = view.getAttribute('data-calendar-view');
        if (calendarView === 'years') calendarYearStart = calendarCursor.year - 5;
        renderWeekAnchorCalendar();
        return;
      }
      var year = e.target.closest('[data-calendar-year]');
      if (year) {
        calendarCursor.year = Number(year.getAttribute('data-calendar-year'));
        calendarView = 'months';
        renderWeekAnchorCalendar();
        return;
      }
      var month = e.target.closest('[data-calendar-month]');
      if (month) {
        calendarCursor.month = Number(month.getAttribute('data-calendar-month'));
        calendarView = 'days';
        renderWeekAnchorCalendar();
        return;
      }
      var jump = e.target.closest('[data-calendar-jump]');
      if (jump) {
        var parts = jump.getAttribute('data-calendar-jump').split('-');
        calendarCursor = { year: Number(parts[0]), month: Number(parts[1]) };
        calendarView = 'days';
        renderWeekAnchorCalendar();
        return;
      }
      if (e.target.closest('[data-calendar-clear]')) {
        pendingWeekAnchors = [];
        renderWeekAnchorCalendar();
        return;
      }
      if (e.target.closest('[data-calendar-confirm]')) {
        var settings = readSettings();
        settings.weekAnchors = Array.from(new Set(pendingWeekAnchors)).sort();
        settings.weekAnchor = settings.weekAnchors[settings.weekAnchors.length - 1] || '';
        settings.weekAnchorsConfirmed = settings.weekAnchors.length > 0;
        saveJson(SETTINGS_KEY, settings);
        S.selectedRunId = '';
        S.selectedWeekAnchor = settings.weekAnchor;
        if (weekAnchorInput) {
          weekAnchorInput.value = weekAnchorDisplay(settings.weekAnchors, settings.weekAnchorsConfirmed);
          weekAnchorInput.title = settings.weekAnchors.join('、');
        }
        validateWeekAnchor();
        renderAccounts();
        render();
        closeWeekAnchorCalendar();
        return;
      }
      var day = e.target.closest('[data-calendar-date]');
      if (day && weekAnchorInput) {
        var value = day.getAttribute('data-calendar-date');
        var pos = pendingWeekAnchors.indexOf(value);
        if (pos >= 0) pendingWeekAnchors.splice(pos, 1);
        else pendingWeekAnchors.push(value);
        pendingWeekAnchors.sort();
        renderWeekAnchorCalendar();
      }
    });
    weekAnchorCalendar.addEventListener('wheel', function (e) {
      if (calendarView !== 'days') return;
      e.preventDefault();
      var now = Date.now();
      if (now - calendarWheelAt < 140) return;
      calendarWheelAt = now;
      var direction = (e.deltaY || e.deltaX) > 0 ? 1 : -1;
      var next = new Date(Date.UTC(calendarCursor.year, calendarCursor.month + direction, 1));
      calendarCursor = { year: next.getUTCFullYear(), month: next.getUTCMonth() };
      renderWeekAnchorCalendar();
    }, { passive: false });
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.date-input-row')) closeWeekAnchorCalendar();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeWeekAnchorCalendar();
    });
  }
  function setConn(ok, text) {
    var chip = document.getElementById('connChip');
    if (!chip) return;
    chip.className = 'chip ' + (ok ? 'ok' : 'warn');
    var label = document.getElementById('connText');
    if (label) label.textContent = text;
  }
  function startSSE() {
    if (S.es) try { S.es.close(); } catch (e) {}
    var es = new EventSource('/api/stream');
    S.es = es;
    es.onopen = function () { setConn(true, '实时'); stopPoll(); };
    es.onmessage = function (ev) {
      try {
        if (S.selectedRunId) fetchOnce();
        else applySnapshot(JSON.parse(ev.data));
      } catch (e) {}
    };
    es.onerror = function () {
      setConn(false, '重连中');
      startPoll();
    };
  }
  function startPoll() {
    if (S.pollTimer) return;
    S.pollTimer = setInterval(fetchOnce, 3000);
  }
  function stopPoll() {
    if (S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; }
  }
  function fetchOnce() {
    var requestedHistoryId = S.selectedRunId || '';
    var requestSeq = ++S.snapshotRequestSeq;
    var query = requestedHistoryId ? ('?historyId=' + encodeURIComponent(requestedHistoryId)) : '';
    fetch('/api/snapshot' + query, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (requestSeq !== S.snapshotRequestSeq || requestedHistoryId !== (S.selectedRunId || '')) return;
        applySnapshot(j);
      })
      .catch(function () {});
  }
  function eventKey(e) {
    if (!e) return '';
    return [e.at || '', e.level || '', e.message || '', e.weekAnchor || '', e.category || '', e.account || ''].join('|');
  }
  function mergeEventStream(previous, incoming) {
    var merged = [];
    var seen = Object.create(null);
    (previous || []).concat(incoming || []).forEach(function (e) {
      var key = eventKey(e);
      if (!key || seen[key]) return;
      seen[key] = true;
      merged.push(e);
    });
    merged.sort(function (a, b) { return String(a.at || '').localeCompare(String(b.at || '')); });
    return merged.slice(-1000);
  }
  function applySnapshot(j) {
    if (pageHistoryClearedAt) {
      var updated = j && j.progress && new Date(j.progress.updatedAt || '').getTime();
      var started = j && j.run && j.run.job && new Date(j.run.job.startedAt || '').getTime();
      if (!(Math.max(updated || 0, started || 0) > pageHistoryClearedAt)) return;
      pageHistoryClearedAt = 0;
    }
    // SSE 与轮询可能交错返回；旧快照不能覆盖已经显示的新事件流。
    var incomingAt = j && new Date(j.at || '').getTime();
    var currentAt = S.data && new Date(S.data.at || '').getTime();
    if (isFinite(incomingAt) && isFinite(currentAt) && incomingAt < currentAt) return;
    // SSE 与轮询可能同时返回；事件流只增不减，同一批次合并两路快照，
    // 防止较慢的旧请求把“任务初始化”或最新周进度短暂闪回。
    var previousBatch = S.data && S.data.batchProgress;
    var incomingBatch = j && j.batchProgress;
    if (previousBatch && incomingBatch && previousBatch.batchId && previousBatch.batchId === incomingBatch.batchId) {
      j.batchProgress = Object.assign({}, incomingBatch, {
        events: mergeEventStream(previousBatch.events, incomingBatch.events),
      });
    }
    S.data = j;
    render();
  }

  applySettings();
  initFixedPanels();
  loadRun().then(function (run) {
    loadAccounts().then(function () {
      if (!(run && run.active)) checkAccounts(true, true);
    });
  });
  fetchOnce();
  startSSE();
  window.setInterval(refreshRunElapsedKpi, 1000);
})();
</script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const url = parsedUrl.pathname;
  const method = (req.method || 'GET').toUpperCase();

  if (method === 'POST' && url.startsWith('/api/')) {
    const token = String(req.headers['x-amdc-token'] || '');
    const cliRoute = url === '/api/run/start' || /^\/api\/history\/[^/]+\/sync-feishu$/.test(url);
    const cliAuthorized = token === CLI_TOKEN && cliRoute;
    if (token !== DASHBOARD_TOKEN && token !== SCHEDULE_TOKEN && !cliAuthorized) {
      return json(res, 403, { ok: false, error: 'invalid dashboard token' });
    }
  }

  if (url.startsWith('/api/stream')) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    res.write('data: ' + JSON.stringify(snapshot()) + '\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (url === '/api/health') return json(res, 200, { ok: true, projectDir: PROJECT_DIR, pid: process.pid });

  if (url.startsWith('/api/snapshot')) return json(res, 200, snapshot(parsedUrl.searchParams.get('historyId') || ''));

  if (url.startsWith('/api/progress')) {
    const p = readProgress(latestVisibleRunDir());
    return json(res, 200, p || {});
  }

  if (url.startsWith('/api/results')) return json(res, 200, readResults(latestVisibleRunDir()));

  if (url === '/api/dashboard/clear') {
    if (method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' });
    const result = clearDashboardView();
    return json(res, result.ok ? 200 : 409, result);
  }

  if (url === '/api/history') {
    return json(res, 200, { ok: true, records: historyRecords(), batchSync: historyBatchSyncSnapshot() });
  }

  if (url === '/api/history/batch-sync-feishu') {
    if (method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' });
    syncHistoriesToFeishu(parsedUrl.searchParams.getAll('id'), 2)
      .then(result => json(res, result.ok ? 200 : 409, result))
      .catch(error => json(res, 500, { ok: false, error: error && error.message ? error.message : String(error) }));
    return;
  }

  if (url === '/api/history/batch-sync-feishu/stop') {
    if (method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' });
    const result = requestBatchSyncStop();
    return json(res, result.ok ? 200 : 409, result);
  }

  if (url.startsWith('/api/history/')) {
    const parts = url.split('/').filter(Boolean).map(x => decodeURIComponent(x));
    const id = parts[2] || '';
    const record = historyRecordById(id);
    if (!record) return json(res, 404, { ok: false, error: 'history record not found' });
    if (parts[3] === 'results') {
      return json(res, 200, { ok: true, record, results: readResults(record.outputDir) });
    }
    if (parts[3] === 'sync-feishu') {
      if (method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' });
      syncHistoryToFeishu(id)
        .then(result => json(res, result.ok ? 200 : 409, result))
        .catch(error => json(res, 500, { ok: false, error: error && error.message ? error.message : String(error) }));
      return;
    }
    if (parts[3] === 'delete') {
      if (method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' });
      const result = deleteHistoryRecord(id);
      return json(res, result.ok ? 200 : 409, result);
    }
    return json(res, 200, { ok: true, record });
  }

  if (url.startsWith('/api/settings')) {
    return json(res, 200, {
      projectDir: PROJECT_DIR,
      port: PORT,
      host: HOST,
      pid: process.pid,
      maxAccountProfiles: MAX_ACCOUNT_PROFILES,
      runScript: path.join(__dirname, 'run_amdc_weekly.ps1'),
      env: {
        AMDC_ACCOUNTS: process.env.AMDC_ACCOUNTS || '',
        AMDC_MAX_WORKERS: process.env.AMDC_MAX_WORKERS || String(MAX_ACCOUNT_PROFILES),
        AUTH_CHECK_CONCURRENCY: process.env.AUTH_CHECK_CONCURRENCY || String(MAX_ACCOUNT_PROFILES),
        AUTH_PROBE_TIMEOUT_MS: process.env.AUTH_PROBE_TIMEOUT_MS || '8000',
        AUTH_CHECK_COOLDOWN_HOURS: String(AUTH_CHECK_COOLDOWN_HOURS),
        DC_GAP_MS: process.env.DC_GAP_MS || '500',
        DC_COOLDOWN_MS: process.env.DC_COOLDOWN_MS || '120000',
        LEADERBOARD_WEEK_CONCURRENCY: process.env.LEADERBOARD_WEEK_CONCURRENCY || '3',
        TOP_DEPTH: String(parseTopDepth(process.env.TOP_DEPTH || '100')),
      },
      topDepthOptions: [100, 1000],
      categoryOptions: CATEGORY_OPTIONS,
    });
  }

  if (url === '/api/accounts') {
    return json(res, 200, {
      ok: true,
      projectDir: PROJECT_DIR,
      accounts: accountRows(),
      checking: !!authCheckAll,
    });
  }

  if (url === '/api/accounts/check') {
    if ((req.method || 'GET').toUpperCase() !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' });
    const requestedProfile = parsedUrl.searchParams.get('profile') || '';
    if (requestedProfile && (!isSafeProfile(requestedProfile) || !isManagedProfile(requestedProfile))) {
      return json(res, 400, { ok: false, error: '账号目录无效', accounts: accountRows() });
    }
    const automatic = parsedUrl.searchParams.get('automatic') === '1';
    runAuthCheck(requestedProfile || undefined, { force: !automatic }).then(result => json(res, 200, {
      ok: true,
      accounts: accountRows(),
      output: result.output ? result.output.slice(-4000) : '',
    })).catch(error => json(res, 500, { ok: false, error: error.message || String(error), accounts: accountRows() }));
    return;
  }

  if (url === '/api/accounts/login-link') {
    if (method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' });
    const profile = parsedUrl.searchParams.get('profile') || '';
    readJsonBody(req).then(body => submitLoginLink(profile, body && body.url)).then(result => {
      json(res, result.ok ? 200 : 400, { ...result, accounts: accountRows() });
    }).catch(error => json(res, 400, { ok: false, error: error.message || String(error), accounts: accountRows() }));
    return;
  }

  if (url === '/api/accounts/delete') {
    if ((req.method || 'GET').toUpperCase() !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' });
    const profile = parsedUrl.searchParams.get('profile') || '';
    try {
      const result = deleteProfile(profile);
      return json(res, result.ok ? 200 : 409, result);
    } catch (error) {
      return json(res, 500, {
        ok: false,
        error: error && error.message ? error.message : String(error),
        accounts: accountRows(),
      });
    }
  }

  if (url === '/api/run') {
    return json(res, 200, runSummary());
  }

  if (url === '/api/batch-events') {
    const batchId = String(parsedUrl.searchParams.get('batchId') || '').trim();
    if (!HISTORY_ID_RE.test(batchId)) return json(res, 400, { ok: false, error: 'invalid batchId' });
    const offset = Math.max(0, parseInt(parsedUrl.searchParams.get('offset') || '0', 10) || 0);
    const limit = Math.max(1, Math.min(1000, parseInt(parsedUrl.searchParams.get('limit') || '200', 10) || 200));
    const events = readBatchEventFile(path.join(HISTORY_DIR, 'batch-events', `${batchId}.ndjson`));
    return json(res, 200, {
      ok: true,
      batchId,
      total: events.length,
      offset,
      limit,
      events: events.slice(offset, offset + limit),
    });
  }

  if (url === '/api/run/start') {
    if ((req.method || 'GET').toUpperCase() !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' });
    startCollectionRun({
      fresh: parsedUrl.searchParams.get('fresh') === '1',
      weekAnchor: parsedUrl.searchParams.get('weekAnchor') || '',
      weekAnchors: parsedUrl.searchParams.getAll('weekAnchor'),
      weekAnchorsConfirmed: parsedUrl.searchParams.get('weekAnchorsConfirmed') === '1',
      listOnly: parsedUrl.searchParams.get('listOnly') === '1',
      skipExcel: parsedUrl.searchParams.get('skipExcel') === '1',
      topDepth: parsedUrl.searchParams.get('topDepth') || '',
      accounts: parsedUrl.searchParams.getAll('account'),
      categories: parsedUrl.searchParams.getAll('category'),
      source: parsedUrl.searchParams.get('source') === 'ai' ? 'ai' : 'manual',
    })
      .then(result => json(res, result.ok ? 200 : 409, result))
      .catch(error => json(res, 500, {
        ok: false,
        error: error && error.message ? error.message : String(error),
        accounts: accountRows(),
        run: runSummary(),
      }));
    return;
  }

  if (url === '/api/run/scheduled') {
    if (method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' });
    if (String(req.headers['x-amdc-token'] || '') !== SCHEDULE_TOKEN) {
      return json(res, 403, { ok: false, error: 'invalid schedule token' });
    }
    const config = readJsonSafe(CONFIG_FILE) || {};
    const schedule = config && config.schedule && typeof config.schedule === 'object' ? config.schedule : {};
    const configuredAccounts = Array.isArray(schedule.accounts)
      ? schedule.accounts.filter(profile => isManagedProfile(profile) && profileExists(profile))
      : [];
    const accounts = configuredAccounts.length
      ? configuredAccounts
      : accountRows().filter(row => row.exists).map(row => row.profile);
    startCollectionRun({
      fresh: false,
      weekAnchor: previousWeekMondayValue(),
      weekAnchors: [previousWeekMondayValue()],
      weekAnchorsConfirmed: true,
      topDepth: schedule.topDepth || config.topDepth || 100,
      accounts,
      categories: CATEGORY_OPTIONS.slice(),
      source: 'scheduled',
      triggeredAt: new Date().toISOString(),
      autoSync: true,
      notifyStages: true,
    })
      .then(result => json(res, result.ok ? 202 : 409, result))
      .catch(error => json(res, 500, {
        ok: false,
        error: error && error.message ? error.message : String(error),
        accounts: accountRows(), run: runSummary(),
      }));
    return;
  }

  if (url === '/api/run/stop') {
    if ((req.method || 'GET').toUpperCase() !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' });
    const result = stopCollectionRun();
    return json(res, result.ok ? 200 : 409, result);
  }

  // 在本机文件管理器中打开当前运行的输出目录（目录由服务端自行解析，不接受任何外部路径）
  if (url.startsWith('/api/open-output')) {
    if (method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' });
    const outputDir = OUTPUT_DIR;
    if (!fs.existsSync(outputDir)) return json(res, 404, { ok: false, error: 'output directory not found' });
    const cp = require('child_process');
    try {
      if (process.platform === 'win32') openWindowsPath(outputDir);
      else if (process.platform === 'darwin') cp.exec('open "' + outputDir + '"');
      else cp.exec('xdg-open "' + outputDir + '"');
      return json(res, 200, { ok: true, dir: outputDir });
    } catch {
      return json(res, 500, { ok: false });
    }
  }

  // 在本机文件管理器中打开项目目录
  if (url.startsWith('/api/open-project')) {
    if (method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' });
    const cp = require('child_process');
    try {
      if (process.platform === 'win32') openWindowsPath(PROJECT_DIR);
      else if (process.platform === 'darwin') cp.exec('open "' + PROJECT_DIR + '"');
      else cp.exec('xdg-open "' + PROJECT_DIR + '"');
      return json(res, 200, { ok: true, dir: PROJECT_DIR });
    } catch {
      return json(res, 500, { ok: false });
    }
  }

  if (url.startsWith('/api/health')) {
    const runDir = latestRunDir();
    return json(res, 200, {
      ok: true,
      projectDir: PROJECT_DIR,
      port: PORT,
      host: HOST,
      pid: process.pid,
      runDir,
      hasProgress: !!readProgress(runDir),
      sseClients: clients.size,
    });
  }

  if (url.startsWith('/api/')) {
    return json(res, 404, { ok: false, error: 'api route not found' });
  }

  if (url === '/brand-wordmark.png') {
    const wordmarkPath = path.join(__dirname, 'assets', 'amtools-wordmark.png');
    try {
      const wordmark = fs.readFileSync(wordmarkPath);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'no-store');
      return res.end(wordmark);
    } catch {
      res.statusCode = 404;
      return res.end();
    }
  }

  if (url.startsWith('/assets/fonts/')) {
    const fontFiles = {
      'MiSans-Regular.woff2': 'font/woff2',
      'MiSans-Medium.woff2': 'font/woff2',
      'MiSans-Demibold.woff2': 'font/woff2',
      'MiSans-Bold.woff2': 'font/woff2',
      'MiSans-License.pdf': 'application/pdf',
    };
    const name = decodeURIComponent(url.slice('/assets/fonts/'.length));
    const contentType = fontFiles[name];
    if (!contentType) {
      res.statusCode = 404;
      return res.end();
    }
    const fontPath = path.join(__dirname, 'assets', 'fonts', name);
    try {
      const asset = fs.readFileSync(fontPath);
      res.statusCode = 200;
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.end(asset);
    } catch {
      res.statusCode = 404;
      return res.end();
    }
  }

  if (url.startsWith('/favicon')) { res.statusCode = 204; return res.end(); }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(PAGE);
});

const repairedIncompleteHistoryRecords = repairIncompleteHistoryRecords();
if (repairedIncompleteHistoryRecords) console.log(`AMDC restored ${repairedIncompleteHistoryRecords} incomplete history record(s) from batch state`);
const repairedHistoryMetadata = repairHistoryResultSummaries();
if (repairedHistoryMetadata) console.log(`AMDC restored ${repairedHistoryMetadata} completed history metadata record(s) from run state`);
repairDuplicateSkipSyncRecords();
if (recoverInterruptedHistorySyncs()) {
  historyTemporaryCleanupActive = true;
  cleanupHistoryTemporarySheets()
    .catch(error => {
      console.error(`AMDC Feishu temporary-sheet cleanup failed: ${error && error.message ? error.message : String(error)}`);
    })
    .finally(() => { historyTemporaryCleanupActive = false; });
}

server.listen(PORT, HOST, () => {
  console.log(`AMDC dashboard: http://${HOST}:${PORT}`);
  if (!AUTO_OPEN) return;
  const url = `http://${HOST}:${PORT}`;
  const cp = require('child_process');
  try {
    if (process.platform === 'win32') cp.execFile('cmd.exe', ['/d', '/c', 'start', '', url], { windowsHide: true }, () => {});
    else if (process.platform === 'darwin') cp.exec(`open "${url}"`);
    else cp.exec(`xdg-open "${url}"`);
  } catch {}
});
