// @ts-check
const { chromium } = require('@playwright/test');
const { applyStoreCheck, storeCheckDue } = require('./store-availability');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { fetchTagsPayload, normalizeTags, validateTags, resolveEndpoint } = require('./amdc_tags_dict');
const { countryCollectionProgress, createLeaderboardAccountRotator } = require('./collection-plan');
const {
  compareLeaderboardSnapshots,
  preliminaryCacheRefreshReason,
  shouldBypassLeaderboardCache,
  shouldProbeLeaderboardCache,
} = require('./leaderboard-cache-policy');

const PROJECT_DIR = path.resolve(process.env.AMDC_PROJECT_DIR || process.cwd());
const USER_DATA_DIR = path.resolve(PROJECT_DIR, process.env.AMDC_USERDATA_DIR || '.amdc-userdata');
const APP_ROOT = path.resolve(__dirname, '..');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function rand(min, max) { return Math.random() * (max - min) + min; }
function sleepRandom(minMs, maxMs) { return sleep(rand(minMs, maxMs)); }
function backoffMs(attempt) { return Math.min(10000, 1500 + attempt * 1500); }
function clampInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
function parseTopDepth(value) {
  const n = parseInt(value, 10);
  return n === 1000 ? 1000 : 100;
}
function u(...codes) { return String.fromCodePoint(...codes); }
function isoDate(d) { return d.toISOString().slice(0, 10); }
function addDays(yyyyMmDd, days) {
  const d = new Date(`${yyyyMmDd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}
function previousMondayAnchor() {
  const d = new Date();
  const day = d.getDay();
  const diff = (day + 6) % 7 + 7;
  d.setDate(d.getDate() - diff);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
function buildWeekAnchors(anchor, count = 6) {
  return Array.from({ length: count }, (_, i) => addDays(anchor, -7 * i));
}
function requireMondayAnchor(value, label = 'WEEK_ANCHOR') {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`${label} must use YYYY-MM-DD format`);
  const date = new Date(`${text}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || isoDate(date) !== text) throw new Error(`${label} is not a valid date: ${text}`);
  if (date.getUTCDay() !== 1) throw new Error(`${label} must be a Monday: ${text}`);
  return text;
}
function isFirstInTop100Trajectory(rank, history) {
  return rank <= 100
    && Array.isArray(history)
    && history.length >= 4
    && history.slice(-3).every(h => h == null)
    && history.slice(1).every(h => h == null || h > 100);
}
function isReleasedWithinThreeMonths(release, weekAnchor) {
  const raw = String(release || '').trim();
  const anchor = new Date(`${weekAnchor}T00:00:00Z`);
  const released = new Date(raw);
  if (!raw || !Number.isFinite(anchor.getTime()) || !Number.isFinite(released.getTime())) return false;
  const cutoff = new Date(anchor.getTime());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 3);
  return released >= cutoff && released <= anchor;
}

const CAT_HYPERCASUAL = u(0x8D85, 0x4F11, 0x95F2);
const CAT_CASUAL = u(0x4F11, 0x95F2);
const CAT_ANTIVIRUS_CLEANER = u(0x6740, 0x6BD2, 0x8F6F, 0x4EF6, 0x3001, 0x6E05, 0x7406);
const CAT_FILE_RECOVERY = u(0x6587, 0x4EF6, 0x6062, 0x590D);
const CAT_PDF_READER = 'PDF' + u(0x9605, 0x8BFB, 0x5668);
const CAT_WALLPAPERS = u(0x58C1, 0x7EB8);

const CATS = {
  [CAT_HYPERCASUAL]: '3,126',
  [CAT_CASUAL]: '3,243572',
  [CAT_WALLPAPERS]: '9,76,77',
  Launcher: '9,76,243528',
  [CAT_ANTIVIRUS_CLEANER]: '9,115,119',
  [CAT_FILE_RECOVERY]: '9,115,243477',
  [CAT_PDF_READER]: '9,243756,244699',
};

function selectedCategories() {
  const fallback = Object.keys(CATS);
  const raw = String(process.env.AMDC_CATEGORIES || '').trim();
  if (!raw) return fallback;
  let requested;
  try { requested = JSON.parse(raw); } catch { throw new Error('AMDC_CATEGORIES must be a JSON array'); }
  if (!Array.isArray(requested) || !requested.length) throw new Error('AMDC_CATEGORIES must select at least one category');
  const unique = [...new Set(requested.map(value => String(value)))];
  const unknown = unique.filter(label => !Object.prototype.hasOwnProperty.call(CATS, label));
  if (unknown.length) throw new Error(`AMDC_CATEGORIES contains unsupported categories: ${unknown.join(', ')}`);
  return unique;
}

const CAT_ORDER = selectedCategories();

let WEEKS = (process.env.WEEKS
  ? process.env.WEEKS.split(',').map(s => s.trim()).filter(Boolean)
  : buildWeekAnchors(process.env.WEEK_ANCHOR || previousMondayAnchor()))
  .map((week, index) => requireMondayAnchor(week, process.env.WEEKS ? `WEEKS[${index}]` : 'WEEK_ANCHOR'));

let WEEK_MON = (WEEKS[0] || '').replace(/-/g, '');
// 每次看板采集可通过 AMDC_RUN_DIR 使用独立目录，避免同一周重复采集互相覆盖。
let OUT_BASE = path.resolve(process.env.AMDC_RUN_DIR || path.join(PROJECT_DIR, 'Cache', WEEK_MON));
fs.mkdirSync(OUT_BASE, { recursive: true });

const TOP_DEPTH = parseTopDepth(process.env.TOP_DEPTH || '100');
const PROBE_DEPTH = 10; // token 探针只验证鉴权，小 depth 不浪费配额/流量
const FORCE_REFRESH = process.env.FORCE_REFRESH === '1';
const RUN_STATE_WRITE_INTERVAL_MS = parseInt(process.env.RUN_STATE_WRITE_INTERVAL_MS || '750', 10);
const PROGRESS_WRITE_INTERVAL_MS = parseInt(process.env.PROGRESS_WRITE_INTERVAL_MS || '750', 10);
let LIST_ONLY = process.env.LIST_ONLY === '1';
const MISSING_COUNTRY_ONLY = process.env.MISSING_COUNTRY_ONLY === '1';
const BATCH_CHILD = process.env.AMDC_BATCH_CHILD === '1';
const BATCH_ID = String(process.env.AMDC_BATCH_ID || '').trim();
const RUN_ID = String(process.env.AMDC_RUN_ID || '').trim();
const CACHE_REFRESH_SCOPE = RUN_ID || BATCH_ID;
let BATCH_PHASE = String(process.env.AMDC_BATCH_PHASE || '').trim();
const BATCH_PREFLIGHT_FILE = String(process.env.AMDC_BATCH_PREFLIGHT_FILE || '').trim();
const BATCH_STATE_FILE = String(process.env.AMDC_BATCH_STATE_FILE || '').trim();
const BATCH_EVENT_FILE = String(process.env.AMDC_BATCH_EVENT_FILE || '').trim();
const BATCH_STARTED_AT = String(process.env.AMDC_BATCH_STARTED_AT || '').trim();
const MAX_ACCOUNT_PROFILES = 20;
const MAX_WORKERS = clampInt(process.env.AMDC_MAX_WORKERS || String(MAX_ACCOUNT_PROFILES), MAX_ACCOUNT_PROFILES, 1, MAX_ACCOUNT_PROFILES);
const DEFAULT_AUTH_CHECK_CONCURRENCY = MAX_ACCOUNT_PROFILES;
// 认证并发与账号上限共用 MAX_ACCOUNT_PROFILES；实际并发还会受本次账号数约束。
const AUTH_CHECK_CONCURRENCY = clampInt(
  process.env.AUTH_CHECK_CONCURRENCY || String(DEFAULT_AUTH_CHECK_CONCURRENCY),
  Math.min(DEFAULT_AUTH_CHECK_CONCURRENCY, MAX_ACCOUNT_PROFILES),
  1,
  MAX_ACCOUNT_PROFILES,
);
const AUTH_PROBE_TIMEOUT_MS = clampInt(process.env.AUTH_PROBE_TIMEOUT_MS || '8000', 8000, 3000, 60000);
const LEADERBOARD_WEEK_CONCURRENCY = clampInt(process.env.LEADERBOARD_WEEK_CONCURRENCY || '3', 3, 1, 6);
const LEADERBOARD_COOLDOWN = clampInt(process.env.LEADERBOARD_COOLDOWN_MS || process.env.DC_COOLDOWN_MS || '120000', 120000, 1000, 600000);
const DC_COOLDOWN = clampInt(process.env.DC_COOLDOWN_MS || '120000', 120000, 1000, 600000);
const DC_GAP = clampInt(process.env.DC_GAP_MS || '500', 500, 0, 30000);
const STORE_CHECK_TTL_MS = clampInt(process.env.STORE_CHECK_TTL_MS || String(24 * 60 * 60 * 1000), 24 * 60 * 60 * 1000, 60 * 1000, 30 * 24 * 60 * 60 * 1000);
const STORE_CHECK_RETRY_MS = clampInt(process.env.STORE_CHECK_RETRY_MS || String(60 * 60 * 1000), 60 * 60 * 1000, 60 * 1000, 24 * 60 * 60 * 1000);
const STORE_CHECK_CONCURRENCY = clampInt(process.env.STORE_CHECK_CONCURRENCY || '3', 3, 1, 6);

const OUT_JSON_OF = cat => path.resolve(OUT_BASE, `amdc-${cat}-weekly.json`);
const WEEKLY_CACHE_FILE_OF = cat => path.resolve(OUT_BASE, `amdc-weekly-cache-${cat}.json`);
const ENRICH_CACHE_OF = cat => path.resolve(OUT_BASE, `amdc-enrich-cache-${cat}.json`);
let SHARED_CACHE_DIR = path.resolve(PROJECT_DIR, 'Cache', WEEK_MON);
const SHARED_WEEKLY_CACHE_FILE_OF = cat => path.resolve(SHARED_CACHE_DIR, `amdc-weekly-cache-${cat}.json`);
const SHARED_ENRICH_CACHE_OF = cat => path.resolve(SHARED_CACHE_DIR, `amdc-enrich-cache-${cat}.json`);
let RUN_STATE_FILE = path.resolve(OUT_BASE, 'amdc-run-state.json');
let PROGRESS_JSON = path.resolve(OUT_BASE, 'amdc-progress.json');
// 运行目录可独立，但同一采集周共用一份已确认的 tags 字典，供下次执行继续校验。
let TAGS_SHARED_PATH = path.resolve(PROJECT_DIR, 'Cache', WEEK_MON, 'amdc-tags-full.json');
let TAGS_FULL_PATHS = [
  process.env.AMDC_TAGS_DICT ? path.resolve(PROJECT_DIR, process.env.AMDC_TAGS_DICT) : '',
  path.resolve(OUT_BASE, 'amdc-tags-full.json'),
  TAGS_SHARED_PATH,
  path.resolve(APP_ROOT, 'references', 'amdc-tags-full.json'),
].filter(Boolean);
const CATEGORY_TAG_IDS = [...new Set(CAT_ORDER.map(label => CATS[label])
  .flatMap(tagPath => tagPath.split(',').map(Number).filter(Number.isFinite)))];

const MATURE_LIST = ['US','JP','GB','DE','FR','KR','CA','AU','NL','SE','CH','NO','DK','FI','IE','AT','BE','SG','HK','TW','NZ','IL'];
const EMERGING_LIST = ['IN','BR','ID','PK','NG','MX','PH','VN','EG','BD','TR','TH','RU','UA','IR','ZA','CO','AR','MY','PE','KE','IQ','MA','DZ','UZ','MM'];
const MATURE = new Set(MATURE_LIST);
const EMERGING = new Set(EMERGING_LIST);

let RUN_T0 = Date.now();
let POOL_SIZE = 0;
let RL_COUNT = 0;
const RL_ACCOUNTS = new Set();
let RUN_STATE_CACHE = null;
let RUN_STATE_DIRTY = false;
let LAST_RUN_STATE_SAVE_AT = 0;
let LAST_PROGRESS_WRITE_AT = 0;
let TAGS_DICT_CACHE = null;
let TAGS_DICT_PATH = '';
let TAGS_DICT_LOGGED = false;

function configureRunScope(weekAnchor, outputDir, listOnly, phase) {
  const anchor = requireMondayAnchor(weekAnchor, 'batch weekAnchor');
  WEEKS = buildWeekAnchors(anchor);
  WEEK_MON = anchor.replace(/-/g, '');
  OUT_BASE = path.resolve(outputDir || path.join(PROJECT_DIR, 'Cache', WEEK_MON));
  SHARED_CACHE_DIR = path.resolve(PROJECT_DIR, 'Cache', WEEK_MON);
  RUN_STATE_FILE = path.resolve(OUT_BASE, 'amdc-run-state.json');
  PROGRESS_JSON = path.resolve(OUT_BASE, 'amdc-progress.json');
  TAGS_SHARED_PATH = path.resolve(PROJECT_DIR, 'Cache', WEEK_MON, 'amdc-tags-full.json');
  TAGS_FULL_PATHS = [
    process.env.AMDC_TAGS_DICT ? path.resolve(PROJECT_DIR, process.env.AMDC_TAGS_DICT) : '',
    path.resolve(OUT_BASE, 'amdc-tags-full.json'),
    TAGS_SHARED_PATH,
    path.resolve(APP_ROOT, 'references', 'amdc-tags-full.json'),
  ].filter(Boolean);
  LIST_ONLY = !!listOnly;
  BATCH_PHASE = phase || (LIST_ONLY ? 'leaderboard' : 'application');
  RUN_T0 = Date.now();
  POOL_SIZE = 0;
  RL_COUNT = 0;
  RL_ACCOUNTS.clear();
  RUN_STATE_CACHE = null;
  RUN_STATE_DIRTY = false;
  LAST_RUN_STATE_SAVE_AT = 0;
  LAST_PROGRESS_WRITE_AT = 0;
  fs.mkdirSync(OUT_BASE, { recursive: true });
}

function loadCatCache(cat) {
  if (FORCE_REFRESH) return { complete: false, apps: {} };
  for (const file of [ENRICH_CACHE_OF(cat), SHARED_ENRICH_CACHE_OF(cat)]) {
    try {
      const c = JSON.parse(fs.readFileSync(file, 'utf-8'));
      return { complete: !!c.complete, apps: c.apps || {} };
    } catch {}
  }
  return { complete: false, apps: {} };
}

function saveCatCache(cat, c) {
  for (const file of [ENRICH_CACHE_OF(cat), SHARED_ENRICH_CACHE_OF(cat)]) {
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(c), 'utf-8'); } catch {}
  }
}

function loadWeeklyCache(cat) {
  if (shouldBypassLeaderboardCache({ forceRefresh: FORCE_REFRESH, batchChild: BATCH_CHILD, batchPhase: BATCH_PHASE })) return null;
  for (const file of [WEEKLY_CACHE_FILE_OF(cat), SHARED_WEEKLY_CACHE_FILE_OF(cat)]) {
    try {
      const c = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (!c) continue;
      if (WEEKS.every(d => c[d] && c[d].rows && c[d].rows.length)) {
        const stat = fs.statSync(file);
        c._meta = c._meta && typeof c._meta === 'object' ? c._meta : {};
        if (!c._meta.fetchedAt) c._meta.fetchedAt = stat.mtime.toISOString();
        return c;
      }
    } catch {}
  }
  return null;
}

function saveWeeklyCache(cat, c, metadata = {}) {
  const saved = {
    ...c,
    _meta: {
      ...(c && c._meta && typeof c._meta === 'object' ? c._meta : {}),
      fetchedAt: new Date().toISOString(),
      weekAnchor: WEEKS[0],
      topDepth: TOP_DEPTH,
      refreshScope: CACHE_REFRESH_SCOPE,
      ...metadata,
    },
  };
  for (const file of [WEEKLY_CACHE_FILE_OF(cat), SHARED_WEEKLY_CACHE_FILE_OF(cat)]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(saved), 'utf-8');
  }
  return saved;
}

function carriedAutoFreshIssues(weekData) {
  const metadata = weekData && weekData._meta;
  if (!CACHE_REFRESH_SCOPE || !metadata || metadata.refreshScope !== CACHE_REFRESH_SCOPE || metadata.refreshKind !== 'auto') return [];
  return Array.isArray(metadata.autoFreshReasons) ? metadata.autoFreshReasons : [];
}

function loadRunState() {
  if (RUN_STATE_CACHE) return RUN_STATE_CACHE;
  try {
    RUN_STATE_CACHE = JSON.parse(fs.readFileSync(RUN_STATE_FILE, 'utf-8'));
  } catch {
    RUN_STATE_CACHE = {};
  }
  return RUN_STATE_CACHE;
}

function persistRunState(force = false) {
  if (!RUN_STATE_DIRTY && !force) return true;
  const now = Date.now();
  if (!force && now - LAST_RUN_STATE_SAVE_AT < RUN_STATE_WRITE_INTERVAL_MS) return false;
  try {
    fs.writeFileSync(RUN_STATE_FILE, JSON.stringify(loadRunState(), null, 2), 'utf-8');
    RUN_STATE_DIRTY = false;
    LAST_RUN_STATE_SAVE_AT = now;
    return true;
  } catch {
    return false;
  }
}

function saveRunState(state, force = false) {
  RUN_STATE_CACHE = state;
  RUN_STATE_DIRTY = true;
  persistRunState(force);
}

function readRunMeta(state) {
  return state && typeof state._meta === 'object' && state._meta ? state._meta : {};
}

function updateRunState(cat, patch, force = false) {
  const state = loadRunState();
  state[cat] = { ...(state[cat] || {}), ...patch, updatedAt: new Date().toISOString() };
  saveRunState(state, force);
}

function updateRunMeta(patch, force = false) {
  const state = loadRunState();
  state._meta = { ...readRunMeta(state), ...patch, updatedAt: new Date().toISOString() };
  saveRunState(state, force);
}

function appendRunEvent(level, message, extra = {}, force = false) {
  const event = {
    id: `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2, 8)}`,
    at: new Date().toISOString(),
    level,
    message,
    weekAnchor: WEEKS[0] || '',
    phase: BATCH_PHASE || (LIST_ONLY ? 'leaderboard' : 'application'),
    ...extra,
  };
  const state = loadRunState();
  const meta = readRunMeta(state);
  const events = Array.isArray(meta.events) ? meta.events.slice(-24) : [];
  events.push(event);
  state._meta = { ...meta, events: events.slice(-25), updatedAt: new Date().toISOString() };
  saveRunState(state, force);
  if (BATCH_EVENT_FILE) {
    try {
      fs.mkdirSync(path.dirname(BATCH_EVENT_FILE), { recursive: true });
      fs.appendFileSync(BATCH_EVENT_FILE, JSON.stringify(event) + '\n', 'utf-8');
    } catch {}
  }
  return event;
}

function readBatchRunnerState() {
  if (!BATCH_STATE_FILE) return null;
  try { return JSON.parse(fs.readFileSync(BATCH_STATE_FILE, 'utf-8')); } catch { return null; }
}

function writeBatchRunnerState(patch) {
  if (!BATCH_STATE_FILE) return;
  const current = readBatchRunnerState() || {};
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(BATCH_STATE_FILE), { recursive: true });
  const tmp = `${BATCH_STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf-8');
  try {
    fs.renameSync(tmp, BATCH_STATE_FILE);
  } catch {
    try { fs.unlinkSync(BATCH_STATE_FILE); } catch {}
    fs.renameSync(tmp, BATCH_STATE_FILE);
  }
}

function updateBatchRunnerChild(historyId, patch) {
  const state = readBatchRunnerState() || {};
  const children = Array.isArray(state.children) ? state.children.slice() : [];
  const index = children.findIndex(child => child.historyId === historyId);
  if (index < 0) return;
  children[index] = { ...children[index], ...patch, updatedAt: new Date().toISOString() };
  writeBatchRunnerState({ children });
}

function writeProgress(force = false) {
  const state = loadRunState();
  persistRunState(force);
  const now = Date.now();
  if (!force && now - LAST_PROGRESS_WRITE_AT < PROGRESS_WRITE_INTERVAL_MS) return;
  const meta = readRunMeta(state);
  let doneCats = 0;
  let totalFocus = 0;
  let totalFail = 0;
  let activeCats = 0;
  const labels = { wait: '排队', weekly: '拉榜单', enrich: '国别富化', running: '运行中', done: '完成', error: '出错' };
  const cats = CAT_ORDER.map(label => {
    const s = state[label] || {};
    const status = s.status || 'wait';
    if (status === 'done') doneCats++;
    if (status !== 'done' && status !== 'wait') activeCats++;
    totalFocus += s.focus_count || 0;
    totalFail += (s.enrich_pending ? s.enrich_pending.length : 0);
    let dur = s.durationMs;
    if (dur == null && s.startedMs) dur = now - s.startedMs;
    const pct = status === 'done'
      ? 100
      : (s.enrich_n ? Math.round((s.enrich_i || 0) * 100 / s.enrich_n) : (status === 'wait' ? 0 : 5));
    return {
      label,
      status,
      lab: labels[status] || status,
      cls: status === 'done' ? 'done' : (status === 'error' ? 'err' : (status === 'wait' ? 'wait' : 'run')),
      curRows: s.curRows,
      focus: s.focus_count,
      pct,
      prog: s.enrich_n ? `${s.enrich_i || 0}/${s.enrich_n}` : (status === 'done' ? 'done' : '--'),
      dur,
      cur: s.cur_app,
      account: s.account || '',
      cache: s.cache || '',
      pending: (s.enrich_pending || []).length,
      done: s.enrich_i || 0,
      todo: s.enrich_n || 0,
      countryDone: s.country_done || 0,
      countryTotal: s.country_total || 0,
      currentWeek: s.currentWeek || '',
      detail: s.detail || '',
      lastError: s.error || '',
      lastUpdate: s.updatedAt || '',
    };
  });
  const countryProgress = countryCollectionProgress(cats, doneCats === CAT_ORDER.length);
  const data = {
    anchor: WEEKS[0],
    weeks: WEEKS,
    updatedAt: new Date().toISOString(),
    overall: countryProgress.overall,
    doneCats,
    activeCats,
    total: CAT_ORDER.length,
    totalFocus,
    totalFail,
    countryDone: countryProgress.done,
    countryTotal: countryProgress.total,
    countryRemaining: countryProgress.remaining,
    totalRows: cats.reduce((sum, r) => sum + (r.curRows || 0), 0),
    poolSize: POOL_SIZE,
    rateLimited: RL_COUNT,
    rateLimitedAccounts: Array.from(RL_ACCOUNTS).sort((a, b) => (a === '.amdc-userdata' ? -1 : b === '.amdc-userdata' ? 1 : a.localeCompare(b))),
    runElapsed: Date.now() - RUN_T0,
    currentStage: meta.currentStage || 'init',
    stageLabel: meta.stageLabel || '',
    outputDir: OUT_BASE,
    projectDir: PROJECT_DIR,
    forceRefresh: FORCE_REFRESH,
    autoFresh: !!meta.autoFresh,
    autoFreshReasons: Array.isArray(meta.autoFreshReasons) ? meta.autoFreshReasons : [],
    listOnly: LIST_ONLY,
    topDepth: meta.topDepth || TOP_DEPTH,
    queueRemaining: meta.queueRemaining || 0,
    queueTotal: meta.queueTotal || 0,
    enrichStartedAt: meta.enrichStartedAt || '',
    enrichElapsed: meta.enrichStartedAt ? Math.max(0, Date.now() - new Date(meta.enrichStartedAt).getTime()) : 0,
    leaderboardAccount: meta.leaderboardAccount || '',
    workerAccounts: meta.workerAccounts || [],
    tokenDirs: meta.tokenDirs || [],
    workers: meta.workers || [],
    selfCheck: meta.selfCheck || {},
    events: meta.events || [],
    cats,
  };
  try {
    const tmp = `${PROGRESS_JSON}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, PROGRESS_JSON);
    LAST_PROGRESS_WRITE_AT = now;
  } catch {}
}

function resolveTagsDictPath() {
  if (TAGS_DICT_PATH) return TAGS_DICT_PATH;
  TAGS_DICT_PATH = TAGS_FULL_PATHS.find(p => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  }) || '';
  return TAGS_DICT_PATH;
}

function loadTagsDict(reportEvent = true) {
  if (TAGS_DICT_CACHE) return TAGS_DICT_CACHE;
  const dictPath = resolveTagsDictPath();
  if (!dictPath) {
    if (reportEvent && !TAGS_DICT_LOGGED) {
      TAGS_DICT_LOGGED = true;
      console.warn('[tags] optional taxonomy dictionary not found; run scripts/amdc_tags_dict.js to build it');
      appendRunEvent('info', '未配置可选 tags 字典，空 tag 产品的 Tag 路径将留空；可运行 scripts/amdc_tags_dict.js 生成', { candidates: TAGS_FULL_PATHS.slice() });
    }
    TAGS_DICT_CACHE = new Map();
    return TAGS_DICT_CACHE;
  }
  try {
    const all = JSON.parse(fs.readFileSync(dictPath, 'utf-8'));
    TAGS_DICT_CACHE = new Map(all.map(t => [t.id, t]));
    if (reportEvent && !TAGS_DICT_LOGGED) {
      TAGS_DICT_LOGGED = true;
      console.log(`[tags] loaded taxonomy dictionary: ${dictPath}`);
      appendRunEvent('info', 'tags 字典已加载', { file: dictPath, size: TAGS_DICT_CACHE.size });
    }
  } catch (error) {
    TAGS_DICT_CACHE = new Map();
    if (reportEvent && !TAGS_DICT_LOGGED) {
      TAGS_DICT_LOGGED = true;
      console.warn(`[tags] failed to read taxonomy dictionary: ${dictPath}`);
      appendRunEvent('warn', 'tags 字典读取失败', { file: dictPath, error: String(error) });
    }
  }
  return TAGS_DICT_CACHE;
}

function fallbackTags(tagStr) {
  const dict = loadTagsDict();
  const ids = tagStr.split(',').map(Number);
  return ids.map(id => {
    const t = dict.get(id);
    return t ? { id: t.id, name: t.name, type: t.type, parent_ids: t.parent_ids || [] } : null;
  }).filter(Boolean);
}

function sameTagDefinition(local, remote) {
  if (!local || !remote) return false;
  const localParents = [...new Set(local.parent_ids || [])].sort((a, b) => a - b);
  const remoteParents = [...new Set(remote.parent_ids || [])].sort((a, b) => a - b);
  return local.id === remote.id
    && local.name === remote.name
    && local.type === remote.type
    && localParents.length === remoteParents.length
    && localParents.every((id, index) => id === remoteParents[index]);
}

function writeTagsDictionary(file, tags) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(tags, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, file);
}

function batchPreflightSignature() {
  return [
    BATCH_ID,
    TOP_DEPTH,
    [...CAT_ORDER].sort((a, b) => a.localeCompare(b)).join('|'),
  ].join('::');
}

function readBatchPreflight() {
  if (!BATCH_CHILD || !BATCH_ID || !BATCH_PREFLIGHT_FILE) return null;
  try {
    const data = JSON.parse(fs.readFileSync(BATCH_PREFLIGHT_FILE, 'utf-8'));
    if (!data || data.signature !== batchPreflightSignature() || data.status !== 'ok') return null;
    const dictPath = String(data.tagsDictionaryPath || '').trim();
    if (!dictPath || !fs.statSync(dictPath).isFile()) return null;
    return data;
  } catch {
    return null;
  }
}

function writeBatchPreflight(accounts) {
  if (!BATCH_CHILD || !BATCH_ID || !BATCH_PREFLIGHT_FILE) return;
  const dictionaryPath = resolveTagsDictPath();
  if (!dictionaryPath) throw new Error('批次 tags 前置检查未生成可复用字典');
  const data = {
    version: 1,
    status: 'ok',
    batchId: BATCH_ID,
    signature: batchPreflightSignature(),
    checkedAt: new Date().toISOString(),
    topDepth: TOP_DEPTH,
    categories: CAT_ORDER.slice(),
    accounts: accounts.slice(),
    tagsDictionaryPath: dictionaryPath,
  };
  fs.mkdirSync(path.dirname(BATCH_PREFLIGHT_FILE), { recursive: true });
  const tmp = `${BATCH_PREFLIGHT_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  try {
    fs.renameSync(tmp, BATCH_PREFLIGHT_FILE);
  } catch {
    try { fs.unlinkSync(BATCH_PREFLIGHT_FILE); } catch {}
    fs.renameSync(tmp, BATCH_PREFLIGHT_FILE);
  }
}

async function syncCategoryTagsWithWebsite(token) {
  const localDict = loadTagsDict(false);
  const endpoint = resolveEndpoint(process.env.AMDC_TAGS_ENDPOINT || 'https://appmagic.rocks/api/v2/tags');
  const response = await fetchTagsPayload(endpoint, token, 30000);
  if (!response.ok) throw new Error(`tags 网站校验失败：HTTP ${response.status || 'network'} ${response.error || ''}`.trim());

  const websiteTags = normalizeTags(response.payload);
  validateTags(websiteTags);
  const websiteDict = new Map(websiteTags.map(tag => [tag.id, tag]));
  const mismatched = CATEGORY_TAG_IDS.filter(id => !sameTagDefinition(localDict.get(id), websiteDict.get(id)));
  if (!mismatched.length) {
    appendRunEvent('info', 'tags检查无误', { ids: CATEGORY_TAG_IDS.length, dictionarySize: localDict.size });
    return;
  }

  const runDictPath = path.resolve(OUT_BASE, 'amdc-tags-full.json');
  writeTagsDictionary(TAGS_SHARED_PATH, websiteTags);
  if (runDictPath !== TAGS_SHARED_PATH) writeTagsDictionary(runDictPath, websiteTags);
  TAGS_DICT_PATH = runDictPath;
  TAGS_DICT_CACHE = websiteDict;
  TAGS_DICT_LOGGED = true;
  appendRunEvent('warn', '目标品类 tags 与网站不一致，已重新拉取字典', {
    mismatchedIds: mismatched,
    size: websiteTags.length,
    file: runDictPath,
  }, true);
}

function pushLimited(list, value, limit = 12) {
  if (list.length < limit) list.push(value);
}

function updateSelfCheckMeta(cat, result, force = false) {
  const state = loadRunState();
  const meta = readRunMeta(state);
  const selfCheck = {
    ...(meta.selfCheck && typeof meta.selfCheck === 'object' ? meta.selfCheck : {}),
    [cat]: {
      at: new Date().toISOString(),
      ok: !!result.ok,
      rows: result.rows || 0,
      focus: result.focus || 0,
      weeks: result.weeks || 0,
      issues: result.issues || [],
      warnings: result.warnings || [],
    },
  };
  state._meta = { ...meta, selfCheck, updatedAt: new Date().toISOString() };
  saveRunState(state, force);
}

function selfCheckCategory(cat, tag, built) {
  const issues = [];
  const warnings = [];
  const weekData = built && built.weekData ? built.weekData : {};
  const expectedMin = TOP_DEPTH === 1000 ? 101 : 1;

  for (const d of WEEKS) {
    const rows = Array.isArray(weekData[d]?.rows) ? weekData[d].rows : [];
    if (!rows.length) {
      pushLimited(issues, `${d} 榜单为空`);
      continue;
    }
    if (TOP_DEPTH === 1000 && rows.length < expectedMin) {
      pushLimited(issues, `${d} Top1000 模式仅返回 ${rows.length} 行`);
    }
    const uidSet = new Set();
    let missingIdentity = 0;
    let badRank = 0;
    let missingTags = 0;
    for (const row of rows) {
      if (!row || !row.uid || !row.name) missingIdentity++;
      if (!row || !Number.isFinite(Number(row.rank)) || Number(row.rank) <= 0) badRank++;
      if (row && row.uid) uidSet.add(row.uid);
      if (!row || !Array.isArray(row.tags) || !row.tags.length) missingTags++;
    }
    const duplicateRows = rows.length - uidSet.size;
    if (missingIdentity) pushLimited(issues, `${d} ${missingIdentity} 行缺少 uid/name`);
    if (badRank) pushLimited(issues, `${d} ${badRank} 行排名无效`);
    if (duplicateRows) pushLimited(warnings, `${d} ${duplicateRows} 行 uid 重复`);
    if (missingTags) pushLimited(warnings, `${d} ${missingTags} 行无 tag 路径`);
  }

  const curRows = Array.isArray(built?.curRows) ? built.curRows : [];
  const records = Array.isArray(built?.records) ? built.records : [];
  const focus = Array.isArray(built?.focus) ? built.focus : [];
  if (!curRows.length) pushLimited(issues, `${WEEKS[0]} 当前榜单为空`);
  if (records.length !== curRows.length) {
    pushLimited(issues, `当前榜单行数 ${curRows.length} 与 records ${records.length} 不一致`);
  }
  if (!focus.length) pushLimited(warnings, '焦点应用为 0');

  const badHistory = records.filter(r => !Array.isArray(r.history) || r.history.length !== WEEKS.length).length;
  if (badHistory) pushLimited(issues, `${badHistory} 行 6 周轨迹缺失`);

  const tagIds = tag.split(',').map(Number).filter(Number.isFinite);
  const tagDict = loadTagsDict();
  const missingCategoryTags = tagIds.filter(id => !tagDict.has(id));
  if (tagDict.size && missingCategoryTags.length) {
    pushLimited(warnings, `品类 tag 字典缺失 ${missingCategoryTags.join(',')}`);
  } else if (!tagDict.size) {
    pushLimited(warnings, '未加载 tags 字典，空 tag 产品无法回填 Tag 路径');
  }

  return {
    ok: issues.length === 0,
    rows: curRows.length,
    focus: focus.length,
    weeks: WEEKS.length,
    issues,
    warnings,
  };
}

function assertCategorySelfCheck(cat, tag, built) {
  const result = selfCheckCategory(cat, tag, built);
  updateSelfCheckMeta(cat, result, true);
  if (!result.ok) {
    appendRunEvent('error', `品类自检失败：${cat}`, {
      category: cat,
      rows: result.rows,
      focus: result.focus,
      issues: result.issues,
      warnings: result.warnings,
    }, true);
    throw new Error(`${cat} 自检失败：${result.issues.join('; ')}`);
  }
  const level = result.warnings.length ? 'warn' : 'info';
  appendRunEvent(level, `品类自检通过：${cat}`, {
    category: cat,
    rows: result.rows,
    focus: result.focus,
    warnings: result.warnings,
  });
  return result;
}

async function fetchWeek(page, date, tag, token) {
  return await page.evaluate(async ({ date, tag, depth, token }) => {
    const url = `/api/v2/top/united-apps?aggregation=week&topDepth=${depth}&store=5&country=WW&date=${date}&tag=${tag}`;
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) {
      let body = '';
      try { body = (await r.text()).slice(0, 160); } catch {}
      return { err: r.status, body };
    }
    const j = await r.json();
    const rows = [];
    for (const e of (j.data || [])) {
      const f = e.top_free;
      if (!f || !f.application) continue;
      const a = f.application;
      rows.push({
        rank: f.top_free,
        diff: f.diff,
        uid: a.united_application_id,
        name: a.name,
        publisher: a.publisher?.name || '',
        hq: a.publisher?.headquarter || '',
        headcount: a.publisher?.linkedin_headcount,
        release: a.releaseDate || a.last_release_date || '',
        storeIds: a.store_ids || [],
        stores: a.stores || [],
        tags: (a.tags || []).map(t => ({ id: t.id, name: t.name, type: t.type, parent_ids: t.parent_ids })),
      });
    }
    return { date: j.date, rows };
  }, { date, tag, depth: TOP_DEPTH, token });
}

async function fetchWeeksLimited(page, dates, tag, token, concurrency) {
  return await page.evaluate(async ({ dates, tag, depth, token, concurrency }) => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const retryAfterMs = response => {
      const raw = String(response.headers.get('retry-after') || '').trim();
      if (!raw) return 0;
      const seconds = Number(raw);
      if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
      const timestamp = Date.parse(raw);
      return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : 0;
    };
    const fetchOne = async date => {
      const url = `/api/v2/top/united-apps?aggregation=week&topDepth=${depth}&store=5&country=WW&date=${date}&tag=${tag}`;
      const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
      if (!r.ok) {
        let body = '';
        try { body = (await r.text()).slice(0, 160); } catch {}
        return { err: r.status, body, retryAfterMs: retryAfterMs(r) };
      }
      const j = await r.json();
      const rows = [];
      for (const e of (j.data || [])) {
        const f = e.top_free;
        if (!f || !f.application) continue;
        const a = f.application;
        rows.push({
          rank: f.top_free,
          diff: f.diff,
          uid: a.united_application_id,
          name: a.name,
          publisher: a.publisher?.name || '',
          hq: a.publisher?.headquarter || '',
          headcount: a.publisher?.linkedin_headcount,
          release: a.releaseDate || a.last_release_date || '',
          storeIds: a.store_ids || [],
          stores: a.stores || [],
          tags: (a.tags || []).map(t => ({ id: t.id, name: t.name, type: t.type, parent_ids: t.parent_ids })),
        });
      }
      return { date: j.date, rows };
    };

    const results = {};
    let next = 0;
    async function worker() {
      while (next < dates.length) {
        const date = dates[next++];
        let result = await fetchOne(date);
        // 429 必须立即交给下一个账号，不能继续消耗当前账号的限流窗口。
        for (let att = 0; att < 2 && result.err && result.err !== 401 && result.err !== 403 && result.err !== 429; att++) {
          await sleep(2000);
          result = await fetchOne(date);
        }
        results[date] = result;
      }
    }
    const n = Math.max(1, Math.min(concurrency, dates.length));
    await Promise.all(Array.from({ length: n }, worker));
    return results;
  }, { dates, tag, depth: TOP_DEPTH, token, concurrency });
}

async function probeTopChartToken(page, date, tag, token, depth = PROBE_DEPTH) {
  return await page.evaluate(async ({ date, tag, token, depth }) => {
    try {
      const r = await fetch(`/api/v2/top/united-apps?aggregation=week&topDepth=${depth}&store=5&country=WW&date=${date}&tag=${tag}`, {
        headers: { Authorization: 'Bearer ' + token },
      });
      const retryAfter = String(r.headers.get('retry-after') || '').trim();
      const retrySeconds = Number(retryAfter);
      const retryTimestamp = Date.parse(retryAfter);
      const retryAfterMs = Number.isFinite(retrySeconds)
        ? Math.max(0, Math.round(retrySeconds * 1000))
        : (Number.isFinite(retryTimestamp) ? Math.max(0, retryTimestamp - Date.now()) : 0);
      let body = '';
      if (!r.ok) {
        try { body = (await r.text()).slice(0, 160); } catch {}
      }
      return { ok: r.ok, status: r.status, body, retryAfterMs };
    } catch (error) {
      return { ok: false, status: 0, body: String(error) };
    }
  }, { date, tag, token, depth });
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function probeTopChartTokenDirect(date, tag, token, depth = PROBE_DEPTH) {
  if (typeof fetch !== 'function') {
    return { ok: false, status: 0, body: 'node fetch unavailable' };
  }
  const url = `https://appmagic.rocks/api/v2/top/united-apps?aggregation=week&topDepth=${depth}&store=5&country=WW&date=${date}&tag=${tag}`;
  try {
    const r = await fetchWithTimeout(url, {
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/json',
        'User-Agent': UA,
      },
    }, AUTH_PROBE_TIMEOUT_MS);
    let body = '';
    if (!r.ok) {
      try { body = (await r.text()).slice(0, 160); } catch {}
    }
    const retryAfter = String(r.headers.get('retry-after') || '').trim();
    const retrySeconds = Number(retryAfter);
    const retryTimestamp = Date.parse(retryAfter);
    const retryAfterMs = Number.isFinite(retrySeconds)
      ? Math.max(0, Math.round(retrySeconds * 1000))
      : (Number.isFinite(retryTimestamp) ? Math.max(0, retryTimestamp - Date.now()) : 0);
    return { ok: r.ok, status: r.status, body, retryAfterMs };
  } catch (error) {
    return { ok: false, status: 0, body: String(error && error.message ? error.message : error).slice(0, 160) };
  }
}

// token 缓存：token 数天有效，落盘到各 profile 目录；命中且探针通过则免浏览器启动
const TOKEN_CACHE_NAME = 'amdc-token.json';

function tokenCachePath(dir) { return path.resolve(PROJECT_DIR, dir, TOKEN_CACHE_NAME); }

function readTokenCache(dir) {
  try {
    const c = JSON.parse(fs.readFileSync(tokenCachePath(dir), 'utf-8'));
    return c.token || '';
  } catch {
    return '';
  }
}

function writeTokenCache(dir, token) {
  try {
    // 相同 token 不重复落盘，避免仅因探针回退而让登录态指纹和状态缓存失效。
    if (readTokenCache(dir) === token) return;
    fs.writeFileSync(tokenCachePath(dir), JSON.stringify({ token, savedAt: new Date().toISOString() }), 'utf-8');
  } catch {}
}

function discoverProfileDirs() {
  let dirs;
  if (process.env.AMDC_ACCOUNTS) {
    dirs = process.env.AMDC_ACCOUNTS.split(',').map(s => s.trim()).filter(Boolean);
  } else {
    try {
      dirs = fs.readdirSync(PROJECT_DIR).filter(d => {
        if (!/^\.amdc-userdata(-.+)?$/.test(d)) return false;
        try { return fs.statSync(path.resolve(PROJECT_DIR, d)).isDirectory(); } catch { return false; }
      });
    } catch {
      dirs = [];
    }
  }
  dirs = [...new Set(dirs.filter(d => /^\.amdc-userdata(-.+)?$/.test(d)))];
  dirs.sort((a, b) => (a === '.amdc-userdata' ? -1 : b === '.amdc-userdata' ? 1 : a.localeCompare(b)));
  return dirs.slice(0, MAX_ACCOUNT_PROFILES);
}

async function readTokenFromPage(page) {
  return await page.evaluate(() => (localStorage.getItem('datamagic.token') || '').replace(/^"|"$/g, ''));
}

async function readTokenViaBrowser(dir) {
  const full = path.resolve(PROJECT_DIR, dir);
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(full, {
      headless: true,
      args: ['--disable-blink-features=AutomationControlled'],
      userAgent: UA,
      viewport: { width: 1920, height: 1080 },
    });
    const pg = ctx.pages()[0] || await ctx.newPage();
    // localStorage 在页面提交到 AMDC 域后即可读取，无需等待完整 DOM/资源和固定 2.5 秒。
    await pg.goto('https://appmagic.rocks/top-charts/apps', { waitUntil: 'commit', timeout: 15000 });
    let tok = '';
    const deadline = Date.now() + 1500;
    while (!tok && Date.now() < deadline) {
      try { tok = await readTokenFromPage(pg); } catch {}
      if (!tok) await sleep(100);
    }
    await ctx.close();
    return tok;
  } catch (error) {
    console.log(`  [auth] token read failed: ${dir} -> ${error.message}`);
    try { if (ctx) await ctx.close(); } catch {}
    return '';
  }
}

// 账号池构建：缓存 token 先探针；失效才起浏览器读 localStorage（leader 目录复用已开的 probePage）
async function buildTokenPool(probePage, leaderDir, dirs = discoverProfileDirs()) {
  const pool = [];
  for (const dir of dirs) {
    let token = readTokenCache(dir);
    let source = 'cache';
    let rateLimited = false;
    let initialCooldownMs = 0;
    if (token) {
      const probe = await probeTopChartToken(probePage, WEEKS[0], CATS[CAT_ORDER[0]], token);
      if (!probe.ok) {
        if (probe.status === 429) {
          rateLimited = true;
          initialCooldownMs = probe.retryAfterMs || LEADERBOARD_COOLDOWN;
          RL_COUNT++;
          RL_ACCOUNTS.add(dir);
          appendRunEvent('warn', `榜单账号 ${dir} 触发 429，暂时停用并顺延到队尾`, {
            account: dir,
            status: probe.status,
            body: probe.body || '',
            cooldownMs: initialCooldownMs,
          });
        } else {
          token = '';
        }
      }
    }
    if (!token && !rateLimited) {
      source = 'browser';
      token = dir === leaderDir ? await readTokenFromPage(probePage) : await readTokenViaBrowser(dir);
      if (token) {
        const probe = await probeTopChartToken(probePage, WEEKS[0], CATS[CAT_ORDER[0]], token);
        if (!probe.ok) {
          if (probe.status === 429) {
            rateLimited = true;
            initialCooldownMs = probe.retryAfterMs || LEADERBOARD_COOLDOWN;
            RL_COUNT++;
            RL_ACCOUNTS.add(dir);
            appendRunEvent('warn', `榜单账号 ${dir} 触发 429，暂时停用并顺延到队尾`, {
              account: dir,
              status: probe.status,
              body: probe.body || '',
              cooldownMs: initialCooldownMs,
            });
          } else {
            appendRunEvent('warn', `账号 ${dir} token 未通过 API 探针`, {
              account: dir,
              status: probe.status,
              body: probe.body || '',
            });
          }
          console.warn(`  [auth] account ${dir} probe failed (${probe.status || 'network'})`);
          if (!rateLimited) token = '';
        }
      }
    }
    if (token) {
      writeTokenCache(dir, token);
      pool.push({
        dir,
        token,
        availableAt: initialCooldownMs ? Date.now() + initialCooldownMs : 0,
      });
      console.log(`  [auth] token ready: ${dir} (${source}${rateLimited ? ', cooling down' : ''})`);
    } else {
      console.log(`  [auth] no valid token: ${dir}`);
    }
  }
  return pool;
}

async function checkAuthOne(dir) {
  let token = readTokenCache(dir);
  let source = 'cache';
  if (token) {
    const probe = await probeTopChartTokenDirectWithRetry(WEEKS[0], CATS[CAT_ORDER[0]], token);
    if (probe.ok) return { dir, ok: true, source };
    // 仅 401/403 说明 token 确实需要刷新。超时、限流和服务端错误无需启动浏览器。
    if (probe.status !== 401 && probe.status !== 403) {
      return { dir, ok: false, unknown: true, source, status: probe.status, body: probe.body || '' };
    }
  }

  source = 'browser';
  token = await readTokenViaBrowser(dir);
  if (!token) return { dir, ok: false, source };

  const probe = await probeTopChartTokenDirectWithRetry(WEEKS[0], CATS[CAT_ORDER[0]], token);
  if (!probe.ok) {
    console.warn(`  [auth] account ${dir} probe failed (${probe.status || 'network'})`);
    return {
      dir,
      ok: false,
      unknown: probe.status !== 401 && probe.status !== 403,
      source,
      status: probe.status,
      body: probe.body || '',
    };
  }

  writeTokenCache(dir, token);
  return { dir, ok: true, source };
}

function leaderboardHistoryMismatches(weekData) {
  const issues = [];
  for (const date of WEEKS) {
    const rows = weekData[date] && Array.isArray(weekData[date].rows) ? weekData[date].rows : [];
    const ids = new Set();
    const ranks = new Set();
    for (const row of rows) {
      if (!row || !row.uid || !Number.isFinite(Number(row.rank)) || Number(row.rank) < 1) {
        issues.push({ type: 'invalid_row', date, uid: row && row.uid ? row.uid : '' });
        continue;
      }
      if (ids.has(row.uid)) issues.push({ type: 'duplicate_app', date, uid: row.uid });
      if (ranks.has(Number(row.rank))) issues.push({ type: 'duplicate_rank', date, rank: Number(row.rank) });
      ids.add(row.uid);
      ranks.add(Number(row.rank));
    }
  }
  for (let index = 0; index < WEEKS.length - 1; index++) {
    const currentDate = WEEKS[index];
    const previousDate = WEEKS[index + 1];
    const previousRows = weekData[previousDate] && weekData[previousDate].rows || [];
    const previousRanks = new Map(previousRows.map(row => [row.uid, Number(row.rank)]));
    const currentRows = weekData[currentDate] && weekData[currentDate].rows || [];
    for (const row of currentRows) {
      if (!Number.isFinite(Number(row.diff)) || !previousRanks.has(row.uid)) continue;
      const expected = previousRanks.get(row.uid) - Number(row.rank);
      if (expected !== Number(row.diff)) {
        issues.push({ type: 'rank_history_mismatch', date: currentDate, previousDate, uid: row.uid, rank: Number(row.rank), previousRank: previousRanks.get(row.uid), diff: Number(row.diff), expected });
      }
    }
  }
  return issues;
}

async function fetchCategoryDates(page, dates, cat, tag, accountRotator) {
  const requestedDates = [...new Set((Array.isArray(dates) ? dates : []).filter(date => WEEKS.includes(date)))];
  if (!requestedDates.length) return {};
  const weekData = {};
  const failures = [];
  const emptyDates = [];
  if (!accountRotator || !accountRotator.selection().account) throw new Error(`${cat} 没有可用的榜单账号`);
  const fetched = {};
  let pendingDates = requestedDates.slice();
  while (pendingDates.length) {
    let selected = accountRotator.selection();
    if (selected.waitMs > 0) {
      const waitSeconds = Math.max(1, Math.ceil(selected.waitMs / 1000));
      appendRunEvent('warn', `全部榜单账号均限流，等待 ${waitSeconds} 秒后返回账号 ${selected.account.dir}`, {
        account: selected.account.dir,
        category: cat,
        cooldownMs: selected.waitMs,
        accounts: accountRotator.snapshot(),
      }, true);
      await sleep(selected.waitMs);
      selected = accountRotator.selection();
    }
    const currentAccount = selected.account;
    const attemptedDates = pendingDates.slice();
    const batch = await fetchWeeksLimited(page, attemptedDates, tag, currentAccount.token, LEADERBOARD_WEEK_CONCURRENCY);
    const limitedDates = [];
    let retryAfterMs = 0;
    for (const date of attemptedDates) {
      const result = batch[date] || { err: 'missing' };
      if (result.err === 429) {
        limitedDates.push(date);
        retryAfterMs = Math.max(retryAfterMs, Number(result.retryAfterMs) || 0);
      } else {
        fetched[date] = result;
      }
    }
    if (!limitedDates.length) {
      accountRotator.markSucceeded(currentAccount.dir);
      break;
    }
    RL_COUNT++;
    RL_ACCOUNTS.add(currentAccount.dir);
    const next = accountRotator.markRateLimited(currentAccount.dir, retryAfterMs || LEADERBOARD_COOLDOWN);
    const waitSeconds = Math.max(1, Math.ceil(next.waitMs / 1000));
    const message = next.waitMs > 0
      ? `榜单账号 ${currentAccount.dir} 触发 429，账号池全部限流，等待 ${waitSeconds} 秒后返回账号 ${next.account.dir}`
      : `榜单账号 ${currentAccount.dir} 触发 429，切换账号 ${next.account.dir}`;
    appendRunEvent('warn', message, {
      account: currentAccount.dir,
      nextAccount: next.account.dir,
      category: cat,
      dates: limitedDates,
      cooldownMs: retryAfterMs || LEADERBOARD_COOLDOWN,
      allLimited: next.waitMs > 0,
      accounts: accountRotator.snapshot(),
    }, true);
    console.log(`  [leaderboard] ${cat} 429 ${currentAccount.dir} -> ${next.account.dir}: ${limitedDates.join(', ')}`);
    if (next.waitMs > 0) await sleep(next.waitMs);
    pendingDates = limitedDates;
  }
  for (const d of requestedDates) {
    const w = fetched[d] || { err: 'missing' };
    if (w.err) {
      weekData[d] = { rows: [] };
      const detail = w.body ? `${w.err} ${String(w.body).slice(0, 120)}` : String(w.err);
      failures.push(`${d}:${detail}`);
      console.log(`  [leaderboard] ${cat} ${d} failed: ${detail}`);
    } else {
      weekData[d] = w;
      console.log(`  [leaderboard] ${cat} ${d}: ${w.rows.length} rows`);
      if (!w.rows.length) emptyDates.push(d);
    }
  }
  if (failures.length || emptyDates.length) {
    const reason = failures.length
      ? `榜单请求失败：${failures.join(', ')}`
      : `榜单返回空数据：${emptyDates.join(', ')}`;
    appendRunEvent('error', `榜单拉取失败：${cat}`, {
      category: cat,
      failures,
      emptyDates,
      currentRows: weekData[WEEKS[0]] && weekData[WEEKS[0]].rows ? weekData[WEEKS[0]].rows.length : null,
    }, true);
    throw new Error(`${cat} ${reason}`);
  }
  return weekData;
}

async function fetchCategoryWeeks(page, cat, tag, accountRotator, seed = {}) {
  const seeded = {};
  for (const date of WEEKS) {
    if (seed[date] && Array.isArray(seed[date].rows) && seed[date].rows.length) seeded[date] = seed[date];
  }
  const missingDates = WEEKS.filter(date => !seeded[date]);
  const fetched = await fetchCategoryDates(page, missingDates, cat, tag, accountRotator);
  return { ...seeded, ...fetched };
}

async function probeTopChartTokenDirectWithRetry(date, tag, token) {
  let result = await probeTopChartTokenDirect(date, tag, token);
  const transient = result.status === 0 || result.status === 429 || result.status >= 500;
  if (!result.ok && transient) {
    await sleep(250);
    result = await probeTopChartTokenDirect(date, tag, token);
  }
  return result;
}

async function checkAuthPool(dirs) {
  const results = new Array(dirs.length);
  let next = 0;
  async function worker() {
    while (next < dirs.length) {
      const idx = next++;
      results[idx] = await checkAuthOne(dirs[idx]);
    }
  }
  const n = Math.min(AUTH_CHECK_CONCURRENCY, MAX_ACCOUNT_PROFILES, dirs.length);
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

async function enrichApp(page, uid, storeIds, skipAppInfo, token) {
  const parse = storeIds.map(s => {
    const i = s.indexOf('_');
    return { store: +s.slice(0, i), appId: s.slice(i + 1) };
  });
  const pref = parse.find(x => x.store === 1) || parse.find(x => x.store === 2) || parse[0];
  return await page.evaluate(async ({ uid, store, appId, skipAppInfo, token }) => {
    const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    const sl = ms => new Promise(resolve => setTimeout(resolve, ms));
    const jsafe = async r => {
      const t = await r.text();
      try { return JSON.parse(t); } catch { return null; }
    };
    const getJSON = async (url, opt, valid, tries = 1) => {
      let transportError = false;
      let rateLimited = false;
      let status = 0;
      for (let i = 0; i < tries; i++) {
        try {
          const r = await fetch(url, opt);
          status = r.status;
          if (r.status === 429) {
            rateLimited = true;
            break;
          }
          const j = await jsafe(r);
          if (j != null && valid(j)) {
            return { data: j, rateLimited: false, transportError: false, status };
          }
        } catch {
          transportError = true;
        }
        if (i < tries - 1) await sl(1000 + i * 800);
      }
      return { data: null, rateLimited, transportError, status };
    };

    let rating = null;
    let reviews = null;
    let contentRating = '';
    let released = '';
    let rateLimited = false;
    let networkError = false;

    if (store && appId && !skipAppInfo) {
      const ai = await getJSON(
        '/api/v2/applications/app-info',
        { method: 'POST', headers: H, body: JSON.stringify({ store, storeApplicationID: appId, country: 'US' }) },
        j => (j.data || j)?.rating !== undefined || (j.data || j)?.name,
        2,
      );
      const d = ai.data?.data || ai.data;
      if (ai.rateLimited) rateLimited = true;
      if (ai.transportError) networkError = true;
      if (d && !d.message) {
        rating = d.rating;
        reviews = d.reviews;
        contentRating = d.content_rating;
        released = d.released;
      }
      await sl(400 + Math.random() * 800);
    }

    let countries = null;
    try {
      const r = await fetch(`/api/v2/united-applications/data-countries?united_application_id=${uid}`, { headers: H });
      if (r.status === 429) {
        rateLimited = true;
      } else {
        let dc = await jsafe(r);
        if (dc && !Array.isArray(dc) && Array.isArray(dc.data)) dc = dc.data;
        if (Array.isArray(dc)) {
          countries = dc
            .map(c => ({
              c: c.Country,
              dlp: c.Last30DaysDownloadsPercent,
              dl: c.Last30DaysDownloads,
              revp: c.Last30DaysRevenuePercent,
              rev: c.Last30DaysRevenue,
            }))
            .filter(c => c.dlp > 0 || c.revp > 0);
        }
      }
    } catch {
      networkError = true;
    }

    return { rating, reviews, contentRating, released, countries, rateLimited, networkError };
  }, { uid, store: pref?.store, appId: pref?.appId, skipAppInfo, token });
}

function storeUrl(storeIds) {
  for (const s of (storeIds || [])) {
    const i = s.indexOf('_');
    const store = +s.slice(0, i);
    const id = s.slice(i + 1);
    if (store === 1) return `https://play.google.com/store/apps/details?id=${id}`;
    if (store === 2 || store === 3) return `https://apps.apple.com/app/id${id}`;
  }
  return '';
}

function storeUrls(storeIds) {
  const urls = [];
  for (const s of (storeIds || [])) {
    const i = s.indexOf('_');
    const store = +s.slice(0, i);
    const id = s.slice(i + 1);
    if (!id) continue;
    if (store === 1) urls.push(`https://play.google.com/store/apps/details?id=${id}`);
    if (store === 2 || store === 3) urls.push(`https://apps.apple.com/app/id${id}`);
  }
  return [...new Set(urls)];
}

async function checkStoreLink(page, url) {
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const httpStatus = response ? response.status() : 0;
    const title = await page.title().catch(() => '');
    const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    const body = `${title}\n${bodyText}`.slice(0, 250000).toLowerCase();
    const notFound = httpStatus === 404
      || /page not found|item not found|app not found|requested url was not found|does not exist|找不到此页面|找不到此应用|应用不存在/.test(body);
    if (notFound) return { status: 'not_found', url, httpStatus };
    if (httpStatus >= 200 && httpStatus < 400) return { status: 'available', url, httpStatus };
    return { status: 'unknown', url, httpStatus };
  } catch (error) {
    return { status: 'unknown', url, error: String(error && error.message ? error.message : error).slice(0, 240) };
  }
}

async function checkStoreAvailability(page, storeIds) {
  const urls = storeUrls(storeIds);
  if (!urls.length) return { status: 'unknown', url: '' };
  let unknown = null;
  for (const url of urls) {
    const result = await checkStoreLink(page, url);
    if (result.status === 'available') return result;
    if (result.status === 'unknown') unknown = result;
  }
  return unknown || { status: 'not_found', url: urls[0] };
}

function summarizeCountries(countries) {
  if (!countries || !countries.length) return null;
  const clean = countries.filter(c => c.c && c.c !== 'WW' && /^[A-Z]{2}$/.test(c.c));
  if (!clean.length) return null;
  const byDl = [...clean].filter(c => c.dlp > 0).sort((a, b) => b.dlp - a.dlp);
  const byRev = [...clean].filter(c => c.revp > 0).sort((a, b) => b.revp - a.revp);
  const pct = n => (n ? n.toFixed(1) : '0') + '%';
  let mature = 0;
  let emerging = 0;
  let matureRev = 0;
  let emergingRev = 0;
  let usjpPct = 0;
  for (const c of clean) {
    if (MATURE.has(c.c)) {
      mature += c.dlp;
      matureRev += c.revp;
    } else if (EMERGING.has(c.c)) {
      emerging += c.dlp;
      emergingRev += c.revp;
    }
    if (c.c === 'US' || c.c === 'JP') usjpPct += c.dlp;
  }
  const dlList = byDl.map(c => `${c.c} ${pct(c.dlp)}`).join(' / ');
  const revList = byRev.map(c => `${c.c} ${pct(c.revp)}`).join(' / ');
  const market = mature >= emerging
    ? `偏成熟(成熟${pct(mature)}/新兴${pct(emerging)})`
    : `偏新兴(新兴${pct(emerging)}/成熟${pct(mature)})`;
  return { dlList, revList, dlCount: byDl.length, revCount: byRev.length, usjpPct, mature, emerging, matureRev, emergingRev, market };
}

function countryResolved(record) {
  return !!(record && (record.country
    || ['默认下架', '商店可用'].includes(record.countryStatus)));
}

function countryMissingAttempts(record) {
  const value = Number(record && record.countryMissingAttempts);
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function cacheEnrichmentRecord(catCache, record) {
  catCache.apps[record.uid] = {
    rating: record.rating,
    reviews: record.reviews,
    contentRating: record.contentRating,
    release: record.release,
    country: record.country,
    countryStatus: record.countryStatus || '',
    countryMissingAttempts: countryMissingAttempts(record),
    storeLink: record.storeLink || '',
    storeLinkStatus: record.storeLinkStatus || '',
    storeCheckedAt: record.storeCheckedAt || '',
    storeCheckAttemptAt: record.storeCheckAttemptAt || '',
    storeCheckError: record.storeCheckError || '',
  };
}

async function refreshStoreAvailability(ctx, perCat) {
  const groups = new Map();
  for (const [cat, built] of Object.entries(perCat)) {
    for (const record of built.focus) {
      const urls = storeUrls(record.storeIds);
      if (!urls.length) continue;
      const key = urls.slice().sort().join('|');
      if (!groups.has(key)) groups.set(key, { storeIds: record.storeIds, records: [] });
      groups.get(key).records.push({ cat, record });
    }
  }
  const queue = [...groups.values()].filter(group => storeCheckDue(group.records.map(item => item.record), {
    ttlMs: STORE_CHECK_TTL_MS,
    retryMs: STORE_CHECK_RETRY_MS,
  }));
  if (!queue.length) return { checked: 0, unavailable: 0, recovered: 0, unknown: 0 };

  updateRunMeta({ currentStage: 'store-check', stageLabel: '核验商店状态', queueTotal: queue.length, queueRemaining: queue.length }, true);
  appendRunEvent('info', '商店链接核验开始', { tasks: queue.length, ttlMs: STORE_CHECK_TTL_MS }, true);
  const stats = { checked: 0, unavailable: 0, recovered: 0, unknown: 0 };
  let next = 0;
  async function worker() {
    const page = await ctx.newPage();
    try {
      while (next < queue.length) {
        const group = queue[next++];
        const result = await checkStoreAvailability(page, group.storeIds);
        const checkedAt = new Date().toISOString();
        for (const item of group.records) {
          const outcome = applyStoreCheck(item.record, result, checkedAt, storeUrl(item.record.storeIds));
          if (outcome.recovered) stats.recovered++;
        }
        stats.checked++;
        if (result.status === 'not_found') stats.unavailable++;
        if (result.status === 'unknown') stats.unknown++;
        updateRunMeta({ queueRemaining: Math.max(0, queue.length - stats.checked) });
        writeProgress();
      }
    } finally {
      await page.close().catch(() => {});
    }
  }
  await Promise.all(Array.from({ length: Math.min(STORE_CHECK_CONCURRENCY, queue.length) }, worker));
  appendRunEvent(stats.unavailable ? 'warn' : 'info', '商店链接核验完成', stats, true);
  return stats;
}

async function buildCategory(page, cat, tag, leaderboardAccountRotator) {
  const fb = fallbackTags(tag);
  let weekData = loadWeeklyCache(cat);
  const usedCache = !!(weekData && Object.keys(weekData).length);
  let autoFreshIssues = carriedAutoFreshIssues(weekData);
  if (!usedCache) {
    if (MISSING_COUNTRY_ONLY) throw new Error(`${cat} 缺少已确认榜单缓存，无法只补采缺失国别数据`);
    weekData = await fetchCategoryWeeks(page, cat, tag, leaderboardAccountRotator);
    weekData = saveWeeklyCache(cat, weekData, { refreshKind: FORCE_REFRESH ? 'forced' : 'missing' });
  } else {
    console.log(`  [leaderboard] cache reused: ${cat}`);
    const shouldProbe = shouldProbeLeaderboardCache({
      missingCountriesOnly: MISSING_COUNTRY_ONLY,
      batchChild: BATCH_CHILD,
      batchPhase: BATCH_PHASE,
    });
    if (shouldProbe) {
      autoFreshIssues = leaderboardHistoryMismatches(weekData);
      if (!autoFreshIssues.length) {
        const preliminary = preliminaryCacheRefreshReason({
          weekAnchor: WEEKS[0],
          fetchedAt: weekData && weekData._meta && weekData._meta.fetchedAt,
        });
        if (preliminary.shouldRefresh) {
          autoFreshIssues = [{
            type: 'preliminary_cache_crossed_finalization',
            date: WEEKS[0],
            fetchedAt: preliminary.fetchedAt,
            boundary: preliminary.boundary,
          }];
        }
      }
      let liveSeed = {};
      if (!autoFreshIssues.length) {
        liveSeed = await fetchCategoryDates(page, [WEEKS[0]], cat, tag, leaderboardAccountRotator);
        const comparison = compareLeaderboardSnapshots(weekData[WEEKS[0]], liveSeed[WEEKS[0]]);
        if (!comparison.same) {
          autoFreshIssues = [{ type: 'live_snapshot_changed', date: WEEKS[0], ...comparison }];
          appendRunEvent('warn', `线上榜单与缓存不一致，自动全新采集：${cat}`, {
            category: cat,
            cachedRows: comparison.cachedRows,
            liveRows: comparison.liveRows,
            added: comparison.added.length,
            removed: comparison.removed.length,
            changed: comparison.changed,
            rankChanged: comparison.rankChanged,
            metadataChanged: comparison.metadataChanged,
          }, true);
        } else {
          appendRunEvent('info', `线上榜单与缓存一致，复用缓存：${cat}`, {
            category: cat,
            rows: comparison.liveRows,
            fingerprint: comparison.liveFingerprint.slice(0, 12),
          });
        }
      } else if (autoFreshIssues[0] && autoFreshIssues[0].type === 'preliminary_cache_crossed_finalization') {
        appendRunEvent('warn', `周一初步缓存已跨过周三定稿边界，自动全新采集：${cat}`, {
          category: cat,
          fetchedAt: autoFreshIssues[0].fetchedAt,
          boundary: autoFreshIssues[0].boundary,
        }, true);
      } else {
        appendRunEvent('warn', `历史排名不一致，自动全新采集：${cat}`, {
          category: cat,
          mismatchCount: autoFreshIssues.length,
          examples: autoFreshIssues.slice(0, 5),
        }, true);
      }
      if (autoFreshIssues.length) {
        weekData = await fetchCategoryWeeks(page, cat, tag, leaderboardAccountRotator, liveSeed);
        const remaining = leaderboardHistoryMismatches(weekData);
        if (remaining.length) throw new Error(`${cat} 全新重采后仍有 ${remaining.length} 条榜单历史排名不一致`);
        weekData = saveWeeklyCache(cat, weekData, {
          refreshKind: 'auto',
          autoFreshReasons: autoFreshIssues,
        });
      }
    } else {
      // Application collection and missing-country retries must use the leaderboard already confirmed in phase one.
      autoFreshIssues = carriedAutoFreshIssues(weekData);
    }
  }

  for (const d of WEEKS) {
    for (const row of (weekData[d]?.rows || [])) {
      if (!row.tags || row.tags.length === 0) row.tags = fb;
    }
  }

  const cur = WEEKS[0];
  const prev = WEEKS[1];
  const curRows = weekData[cur].rows;
  const rankMaps = {};
  for (const d of WEEKS) rankMaps[d] = new Map(weekData[d].rows.map(r => [r.uid, r.rank]));

  const records = curRows.map(r => {
    const prevRank = rankMaps[prev].get(r.uid) ?? null;
    const lastWeek = prevRank != null ? prevRank : (r.diff != null ? r.rank + r.diff : null);
    const change = lastWeek != null ? (lastWeek - r.rank) : null;
    const history = WEEKS.map(d => rankMaps[d].get(r.uid) ?? null);
    const inTop50 = history.map(h => h != null && h <= 50);
    let streak50 = 0;
    for (const b of inTop50) {
      if (!b) break;
      streak50++;
    }
    return {
      ...r,
      url: storeUrl(r.storeIds),
      lastWeek,
      isNew: lastWeek == null,
      change,
      relPct: change != null && lastWeek ? change / lastWeek : null,
      history,
      streak50,
      weeksOnBoard: history.filter(h => h != null).length,
    };
  });

  const BIG_PUBS = ['voodoo','saygames','supercent','azur','miniclip','rollic','kwalee','homa','habby','lion studios','crazylabs','good job games','bytedance','tencent','outfit7','zynga','playgendary','ketchapp','sybo','gameloft','tap2play','unico','poki','yso','abi global','mattel','popcore','geisha','bestplay','freeplay','aiby'];
  const isBig = p => BIG_PUBS.some(b => (p || '').toLowerCase().includes(b));
  const riseThreshold = rank => {
    if (rank <= 5) return 3;
    if (rank <= 10) return 5;
    if (rank <= 50) return 10;
    if (rank <= 100) return 20;
    if (rank <= 200) return 30;
    return Infinity;
  };

  const focus = [];
  for (const r of records) {
    const riser = r.change != null && r.change >= riseThreshold(r.rank);
    const firstInTop100 = isFirstInTop100Trajectory(r.rank, r.history);
    const limitedRankHistory = r.weeksOnBoard <= 3;
    if (!riser && !firstInTop100) continue;

    const reasons = [];
    if (firstInTop100) {
      reasons.push(u(0x9996, 0x6B21, 0x8FDB, 0x5165) + 'Top100');
      r._focus = true;
    }
    if (r.change != null && r.change > 0 && r.rank > 0) {
      reasons.push(
        u(0x6392, 0x540D, 0x4E0A, 0x5347)
        + `${r.change}`
        + u(0x540D, 0xFF08)
        + `+${((r.change / r.rank) * 100).toFixed(0)}%`
        + u(0xFF09)
      );
    }
    // _focus（Excel“重点关注”列）：头部大幅上升，或中腰部升幅超过当前名次的 50%
    if (r.rank <= 10 && r.change != null && r.change >= 5) {
      r._focus = true;
    } else if (r.rank > 10 && r.rank <= 200 && r.change != null && r.rank > 0 && r.change / r.rank > 0.5) {
      r._focus = true;
    }
    // 非大厂新进 Top100 且最多只有 3 周排名记录的，待国别与上线日期齐备后再判定是否“潜力新品”。
    if (firstInTop100 && limitedRankHistory && !isBig(r.publisher)) {
      r._pendingNotable = true;
    }
    r._firstInTop100 = firstInTop100;
    r._focusReasons = reasons;
    focus.push(r);
  }

  return { weekData, records, focus, curRows, usedCache, autoFreshIssues };
}

async function enrichOneCat(page, storeClient, r, acc, catCache, cooldown) {
  const MAX_ATTEMPTS = 6;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let e = null;
    try {
      e = await enrichApp(page, r.uid, r.storeIds, r.rating != null, acc.token);
    } catch {}

    if (!e || e.networkError) {
      if (attempt < MAX_ATTEMPTS - 1) {
        const retryMs = backoffMs(attempt);
        console.log(`  [${acc.dir}] network retry ${r.rank} ${r.name} -> ${Math.round(retryMs / 1000)}s`);
        await sleep(retryMs);
        continue;
      }
      appendRunEvent('warn', `账号 ${acc.dir} 网络重试耗尽`, { account: acc.dir, app: r.name, rank: r.rank });
      return;
    }

    if (e.rating != null) r.rating = e.rating;
    if (e.reviews != null) r.reviews = e.reviews;
    if (e.contentRating) r.contentRating = e.contentRating;
    if (e.released) r.release = e.released;

    if (e.rateLimited) {
      RL_COUNT++;
      RL_ACCOUNTS.add(acc.dir);
      appendRunEvent('warn', `账号 ${acc.dir} 触发 429 冷却`, { account: acc.dir, app: r.name, rank: r.rank, cooldownMs: cooldown });
      console.log(`  [${acc.dir}] 429 cooldown ${r.rank} ${r.name}`);
      // 任务回到共享队列，由未受限账号优先领取；当前账号仅在自己的冷却期后再继续工作。
      return { rateLimited: true };
    }

    const cs = summarizeCountries(e.countries);
    if (cs) {
      r.country = cs;
      r.countryStatus = '已采集';
      r.countryMissingAttempts = 0;
    } else {
      // 国别为空不再重复采集；直接核验对应商店链接，避免把“商店仍可打开”
      // 的应用误判成疑似下架。
      const storeCheck = await checkStoreAvailability(storeClient, r.storeIds);
      applyStoreCheck(r, storeCheck, new Date().toISOString(), storeUrl(r.storeIds));
      r.countryMissingAttempts = 0;
      if (storeCheck.status === 'not_found') {
        r.countryStatus = '默认下架';
        appendRunEvent('warn', '商店链接不存在，标记疑似下架', {
          app: r.name,
          rank: r.rank,
          storeUrl: r.storeLink,
        });
      } else if (storeCheck.status === 'available') {
        r.countryStatus = '商店可用';
        appendRunEvent('info', '国别为空但商店链接可打开，保留应用', {
          app: r.name,
          rank: r.rank,
          storeUrl: r.storeLink,
        });
      } else {
        appendRunEvent('warn', r.storeLinkStatus === 'not_found'
          ? '国别为空且商店链接本次未确认，沿用已确认下架状态'
          : '国别为空且商店链接未确认，保留应用不标记下架', {
          app: r.name,
          rank: r.rank,
          storeUrl: r.storeLink,
          error: storeCheck.error || '',
        });
      }
    }
    cacheEnrichmentRecord(catCache, r);
    return { rateLimited: false };
  }
  return { rateLimited: false };
}

async function enrichWorker(ctx, acc, queue, perCat, catCaches, enrichStats, cooldown, gap) {
  const page = await ctx.newPage();
  const storePage = await ctx.newPage();
  try {
    await page.goto('https://appmagic.rocks/top-charts/apps', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2000);
    const initialCooldownMs = Math.max(0, Number(acc.availableAt) - Date.now());
    if (initialCooldownMs > 0) {
      updateRunMeta({
        workers: readRunMeta(loadRunState()).workers.map(w => w.account === acc.dir
          ? { ...w, status: 'cooldown', category: '', current: '', updatedAt: new Date().toISOString() }
          : w),
      });
      writeProgress(true);
      await sleep(initialCooldownMs);
      acc.availableAt = 0;
    }
    while (queue.length) {
      const task = queue.shift();
      if (!task) break;
      const { cat, r } = task;
      const catCache = catCaches[cat];
      const stats = enrichStats[cat];
      if (!stats.processingStartedMs) {
        stats.processingStartedMs = Date.now();
        stats.queueWaitMs = Math.max(0, stats.processingStartedMs - stats.queuedAt);
      }
      updateRunMeta({
        queueRemaining: queue.length,
        workers: readRunMeta(loadRunState()).workers.map(w => w.account === acc.dir
          ? { ...w, status: 'running', category: cat, current: `#${r.rank} ${r.name}`, updatedAt: new Date().toISOString() }
          : w),
      });
      let outcome = null;
      try {
        outcome = await enrichOneCat(page, storePage, r, acc, catCache, cooldown);
      } catch (error) {
        appendRunEvent('warn', `账号 ${acc.dir} 单 app 采集异常`, {
          account: acc.dir,
          app: r.name,
          rank: r.rank,
          error: String(error && error.message ? error.message : error).slice(0, 240),
        });
      }
      if (outcome && outcome.rateLimited) {
        queue.push(task);
        updateRunMeta({
          queueRemaining: queue.length,
          workers: readRunMeta(loadRunState()).workers.map(w => w.account === acc.dir
            ? { ...w, status: 'cooldown', category: cat, current: `#${r.rank} ${r.name}`, updatedAt: new Date().toISOString() }
            : w),
        });
        writeProgress(true);
        await sleep(cooldown);
        continue;
      }
      saveCatCache(cat, catCache);
      stats.done++;
      stats.countryDone = perCat[cat].focus.filter(countryResolved).length;
      const pending = perCat[cat].focus.filter(x => !countryResolved(x)).map(x => `#${x.rank}`);
      const done = stats.done >= stats.total;
      const durationMs = Date.now() - stats.processingStartedMs;
      updateRunState(cat, {
        status: done ? 'done' : 'enrich',
        enrich_i: stats.done,
        enrich_n: stats.total,
        country_done: stats.countryDone,
        country_total: stats.countryTotal,
        enrich_pending: pending,
        cur_app: `#${r.rank} ${r.name} [${acc.dir}]`,
        account: acc.dir,
        durationMs: done ? durationMs : undefined,
        detail: done
          ? `国别采集完成（${stats.total} 个焦点应用，缺国别 ${pending.length}）`
          : `国别采集 ${stats.done}/${stats.total}`,
      });
      // 事件流仅记录阶段性进度，避免每个应用完成都刷屏。
      const progressStep = Math.max(1, Math.ceil(stats.total / 2));
      if (stats.done === stats.total || stats.done - (stats.lastProgressEvent || 0) >= progressStep) {
        stats.lastProgressEvent = stats.done;
        appendRunEvent('info', `国别采集进度：${stats.done}/${stats.total}`, {
          category: cat,
          countryDone: stats.countryDone,
          countryTotal: stats.countryTotal,
          pending: pending.length,
        });
      }
      if (done) {
        // “本轮队列已跑完”不等于“国别已齐全”。缺失项必须保留给下一次只补采任务。
        catCache.complete = pending.length === 0;
        saveCatCache(cat, catCache);
        appendRunEvent('info', `品类 ${cat} 国别采集完成`, {
          category: cat,
          remainingQueue: queue.length,
          durationMs,
          queueWaitMs: stats.queueWaitMs,
        });
      }
      writeProgress(done);
      await sleep(gap);
    }
    updateRunMeta({
      workers: readRunMeta(loadRunState()).workers.map(w => w.account === acc.dir
        ? { ...w, status: 'idle', category: '', current: '', updatedAt: new Date().toISOString() }
        : w),
    });
  } finally {
    await page.close().catch(() => {});
    await storePage.close().catch(() => {});
  }
}

async function createCollectorRuntime() {
  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
    userAgent: UA,
    viewport: { width: 1920, height: 1080 },
  });
  try {
    const leadPage = ctx.pages()[0] || await ctx.newPage();
    await leadPage.goto('https://appmagic.rocks/top-charts/apps', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleepRandom(3000, 6000);

    const leaderDir = path.basename(USER_DATA_DIR);
    const tokenPool = await buildTokenPool(leadPage, leaderDir);
    if (!tokenPool.length) {
      updateRunMeta({ currentStage: 'failed', stageLabel: '无可用账号 token', topDepth: TOP_DEPTH }, true);
      appendRunEvent('error', '无可用账号 token，请先登录', {}, true);
      throw new Error('No valid account token found. Please login first (scripts/amdc-login.js).');
    }

    const depthProbe = [];
    for (const acc of tokenPool) {
      if (acc.availableAt > Date.now()) {
        depthProbe.push({
          account: acc.dir,
          ok: true,
          status: 429,
          body: 'temporarily rate limited; depth probe deferred',
          transport: 'deferred',
        });
        continue;
      }
      let probe = await probeTopChartTokenDirect(WEEKS[0], CATS[CAT_ORDER[0]], acc.token, TOP_DEPTH);
      if (!probe.ok && probe.status === 0) {
        const browserProbe = await probeTopChartToken(leadPage, WEEKS[0], CATS[CAT_ORDER[0]], acc.token, TOP_DEPTH);
        probe = {
          ...browserProbe,
          body: browserProbe.ok ? '' : (browserProbe.body || probe.body || ''),
          transport: 'browser-fallback',
        };
      }
      depthProbe.push({
        account: acc.dir,
        ok: probe.ok,
        status: probe.status,
        body: probe.body || '',
        transport: probe.transport || 'direct',
      });
    }
    const depthOk = depthProbe.filter(probe => probe.ok).map(probe => probe.account);
    if (!depthOk.length) {
      const reason = depthProbe
        .map(probe => `${probe.account}:${probe.status || 'network'}${probe.body ? ` ${probe.body}` : ''}`)
        .join('; ');
      updateRunMeta({ currentStage: 'failed', stageLabel: `榜单深度 ${TOP_DEPTH} 不可用`, topDepth: TOP_DEPTH }, true);
      appendRunEvent('error', `榜单深度 ${TOP_DEPTH} 不可用`, { topDepth: TOP_DEPTH, probes: depthProbe }, true);
      throw new Error(`Leaderboard topDepth=${TOP_DEPTH} unavailable for selected accounts: ${reason}`);
    }

    const usablePool = tokenPool.filter(account => depthOk.includes(account.dir));
    const readyPool = usablePool.filter(account => !account.availableAt || account.availableAt <= Date.now());
    const coolingPool = usablePool.filter(account => account.availableAt > Date.now());
    const leaderAccount = readyPool.find(account => account.dir === leaderDir) || readyPool[0] || coolingPool[0];
    POOL_SIZE = usablePool.length;
    updateRunMeta({
      currentStage: 'leaderboard',
      stageLabel: '采集周度榜单',
      tokenDirs: usablePool.map(account => account.dir),
      leaderboardAccount: leaderAccount.dir,
      topDepth: TOP_DEPTH,
    }, true);
    appendRunEvent('info', '账号池就绪', { accounts: usablePool.map(account => account.dir) }, true);
    writeProgress(true);

    try {
      await syncCategoryTagsWithWebsite(leaderAccount.token);
      writeBatchPreflight(usablePool.map(account => account.dir));
    } catch (error) {
      const reason = error && error.message ? error.message : String(error);
      updateRunMeta({ currentStage: 'failed', stageLabel: 'tags 字典校验失败' }, true);
      appendRunEvent('error', '目标品类 tags 网站校验失败，已停止采集', { error: reason }, true);
      throw error;
    }

    const leaderboardAccounts = [
      leaderAccount,
      ...readyPool.filter(account => account.dir !== leaderAccount.dir),
      ...coolingPool.filter(account => account.dir !== leaderAccount.dir),
    ];
    return {
      ctx,
      leadPage,
      tokenPool: usablePool,
      leaderAccount,
      leaderboardAccounts,
      leaderboardAccountRotator: createLeaderboardAccountRotator(leaderboardAccounts, LEADERBOARD_COOLDOWN),
    };
  } catch (error) {
    await ctx.close().catch(() => {});
    throw error;
  }
}

function initializeRunState() {
  saveRunState({
    _meta: {
      startedAt: new Date().toISOString(),
      currentStage: 'init',
      stageLabel: '初始化',
      outputDir: OUT_BASE,
      projectDir: PROJECT_DIR,
      forceRefresh: FORCE_REFRESH,
      listOnly: LIST_ONLY,
      missingCountryOnly: MISSING_COUNTRY_ONLY,
      queueRemaining: 0,
      queueTotal: 0,
      enrichStartedAt: '',
      workerAccounts: [],
      tokenDirs: [],
      workers: [],
      selfCheck: {},
      events: [],
    },
  }, true);
  if (!BATCH_CHILD) {
    appendRunEvent('info', '任务初始化', { anchor: WEEKS[0], weeks: WEEKS.length }, true);
  }
  for (const cat of CAT_ORDER) updateRunState(cat, { status: 'wait' });
  writeProgress(true);
}

async function main(runtime = null) {
  const cats = CAT_ORDER;
  const ownsRuntime = !runtime;
  initializeRunState();
  if (!runtime) runtime = await createCollectorRuntime();
  const { ctx, leadPage, tokenPool, leaderboardAccountRotator } = runtime;
  POOL_SIZE = tokenPool.length;
  updateRunMeta({
    tokenDirs: tokenPool.map(account => account.dir),
    leaderboardAccount: runtime.leaderAccount.dir,
    topDepth: TOP_DEPTH,
  }, true);

  const completeCats = new Set();
  const merged = {};
  for (const cat of cats) {
    const cc = loadCatCache(cat);
    Object.assign(merged, cc.apps);
  }
  const perCat = {};

  for (const cat of cats) {
    updateRunMeta({ currentStage: 'leaderboard', stageLabel: `采集榜单：${cat}` });
    updateRunState(cat, {
      status: 'weekly',
      startedMs: Date.now(),
      account: 'leaderboard',
      currentWeek: WEEKS[0],
      detail: MISSING_COUNTRY_ONLY ? '复用已确认榜单，仅补采缺失国别数据' : '拉取 6 周榜单快照',
    });
    writeProgress(true);

    const built = await buildCategory(leadPage, cat, CATS[cat], leaderboardAccountRotator);
    perCat[cat] = built;
    if (built.autoFreshIssues && built.autoFreshIssues.length) {
      completeCats.delete(cat);
      saveCatCache(cat, { complete: false, apps: {} });
      updateRunMeta({
        autoFresh: true,
        autoFreshReasons: (readRunMeta(loadRunState()).autoFreshReasons || []).concat([{
          category: cat,
          mismatchCount: built.autoFreshIssues.length,
        }]),
      }, true);
    }
    let hits = 0;
    for (const r of (built.autoFreshIssues && built.autoFreshIssues.length ? [] : built.focus)) {
      const c = merged[r.uid];
      if (!c) continue;
      if (c.rating != null) r.rating = c.rating;
      if (c.reviews != null) r.reviews = c.reviews;
      if (c.contentRating) r.contentRating = c.contentRating;
      if (c.release) r.release = c.release;
      if (c.country) {
        r.country = c.country;
        hits++;
      }
      // 旧版本仅凭“连续三次无国别”写入默认下架，没有商店核验结果；
      // 这类缓存必须重新检查链接，不能继续沿用旧判定。
      if (c.countryStatus && (c.countryStatus !== '默认下架' || c.storeLinkStatus === 'not_found')) {
        r.countryStatus = c.countryStatus;
      }
      if (countryMissingAttempts(c)) r.countryMissingAttempts = countryMissingAttempts(c);
      if (c.storeLink) r.storeLink = c.storeLink;
      if (c.storeLinkStatus) r.storeLinkStatus = c.storeLinkStatus;
      if (c.storeCheckedAt) r.storeCheckedAt = c.storeCheckedAt;
      if (c.storeCheckAttemptAt) r.storeCheckAttemptAt = c.storeCheckAttemptAt;
      if (c.storeCheckError) r.storeCheckError = c.storeCheckError;
    }
    updateRunState(cat, {
      curRows: built.curRows.length,
      focus_count: built.focus.length,
      country_done: built.focus.filter(countryResolved).length,
      country_total: built.focus.length,
      cache: built.autoFreshIssues && built.autoFreshIssues.length ? '自动全新重采' : (built.usedCache ? '榜单缓存' : '全新拉取'),
      detail: `榜单 ${built.curRows.length} 行，焦点 ${built.focus.length}，富化缓存命中 ${hits}` + (built.autoFreshIssues && built.autoFreshIssues.length ? `，已自动全新重采 ${built.autoFreshIssues.length} 条不一致` : ''),
    });
    const selfCheck = assertCategorySelfCheck(cat, CATS[cat], built);
    const leaderboardEvent = BATCH_CHILD && BATCH_PHASE === 'application'
      ? `复用已确认榜单：${cat}`
      : `榜单就绪：${cat}`;
    appendRunEvent('info', leaderboardEvent, {
      category: cat,
      rows: built.curRows.length,
      focus: built.focus.length,
      usedCache: built.usedCache,
      selfCheck: selfCheck.ok ? 'ok' : 'failed',
    });
    // 缓存 complete 只能作为历史提示；必须按本轮焦点集重新判断，否则缺失国别会被补采跳过。
    if (built.focus.every(countryResolved)) completeCats.add(cat);
    else completeCats.delete(cat);
    if (completeCats.has(cat)) {
      updateRunState(cat, {
        status: 'done',
        enrich_pending: built.focus.filter(r => !countryResolved(r)).map(r => `#${r.rank}`),
        durationMs: Date.now() - (loadRunState()[cat]?.startedMs || RUN_T0),
        detail: '焦点集已全部富化',
      });
      if (!LIST_ONLY) {
        appendRunEvent('info', `复用完整国别缓存：${cat} ${built.focus.length}/${built.focus.length}`, {
          category: cat,
          countryDone: built.focus.length,
          countryTotal: built.focus.length,
        });
      }
    }
    writeProgress();
  }

  if (!LIST_ONLY) {
    const catCaches = {};
    const enrichStats = {};
    const queue = [];
    for (const cat of cats) {
      if (completeCats.has(cat)) continue;
      catCaches[cat] = loadCatCache(cat);
      const todo = perCat[cat].focus.filter(r => !countryResolved(r));
      if (!todo.length) continue;
      enrichStats[cat] = {
        total: todo.length,
        done: 0,
        countryTotal: perCat[cat].focus.length,
        countryDone: perCat[cat].focus.filter(countryResolved).length,
        queuedAt: Date.now(),
        processingStartedMs: 0,
        queueWaitMs: 0,
      };
      for (const r of todo) queue.push({ cat, r });
      updateRunState(cat, {
        status: 'enrich',
        enrich_i: 0,
        enrich_n: todo.length,
        country_done: enrichStats[cat].countryDone,
        country_total: enrichStats[cat].countryTotal,
        account: 'pool',
        detail: `国别采集排队（${todo.length} 个焦点应用）`,
      });
    }
    const workerAccs = tokenPool.slice(0, Math.min(MAX_WORKERS, tokenPool.length, Math.max(1, queue.length)));
    updateRunMeta({
      currentStage: 'enrich',
      stageLabel: '采集国别数据',
      enrichStartedAt: new Date().toISOString(),
      queueTotal: queue.length,
      queueRemaining: queue.length,
      workerAccounts: workerAccs.map(acc => acc.dir),
      workers: workerAccs.map(acc => ({ account: acc.dir, status: 'idle', category: '', current: '', updatedAt: new Date().toISOString() })),
    }, true);
    appendRunEvent('info', '国别 app 任务队列就绪', { tasks: queue.length, accounts: workerAccs.map(acc => acc.dir), gapMs: DC_GAP }, true);
    writeProgress(true);
    await Promise.all(workerAccs.map(acc => enrichWorker(ctx, acc, queue, perCat, catCaches, enrichStats, DC_COOLDOWN, DC_GAP)));
  }

  if (!LIST_ONLY) {
    await refreshStoreAvailability(ctx, perCat);
    for (const cat of cats) {
      const catCache = loadCatCache(cat);
      for (const record of perCat[cat].focus) cacheEnrichmentRecord(catCache, record);
      catCache.complete = perCat[cat].focus.every(countryResolved);
      saveCatCache(cat, catCache);
    }
  }

  updateRunMeta({ currentStage: 'export', stageLabel: '写出产物文件', queueRemaining: 0 }, true);
  for (const cat of cats) {
    const { records, focus } = perCat[cat];
    for (const r of focus) {
      if (r._pendingNotable
        && isReleasedWithinThreeMonths(r.release, WEEKS[0])
        && r.country
        && (r.country.mature >= 25 || r.country.matureRev >= 25)) {
        r._focus = true;
        r._focusReasons.push(u(0x6F5C, 0x529B, 0x65B0, 0x54C1));
      }
      delete r._pendingNotable;
    }
    fs.writeFileSync(OUT_JSON_OF(cat), JSON.stringify({
      category: { label: cat, tag: CATS[cat] },
      weeks: WEEKS,
      generatedAt: new Date().toISOString(),
      topDepth: TOP_DEPTH,
      marketDef: { mature: MATURE_LIST, emerging: EMERGING_LIST },
      records,
      focus,
    }, null, 2), 'utf-8');
    const pending = focus.filter(r => !countryResolved(r));
    const currentState = loadRunState()[cat] || {};
    const started = currentState.startedMs || RUN_T0;
    updateRunState(cat, {
      status: 'done',
      enrich_done: true,
      enrich_pending: pending.map(r => `#${r.rank}`),
      country_done: focus.filter(countryResolved).length,
      country_total: focus.length,
      durationMs: currentState.durationMs == null ? Date.now() - started : currentState.durationMs,
      detail: `产物已写出（${records.length} 行，焦点 ${focus.length}，缺国别 ${pending.length}）`,
    });
  }
  const countryTotal = cats.reduce((sum, cat) => sum + perCat[cat].focus.length, 0);
  const countryDone = cats.reduce((sum, cat) => sum + perCat[cat].focus.filter(countryResolved).length, 0);
  const countryRemaining = Math.max(0, countryTotal - countryDone);
  // 榜单确认阶段不采集国别，不能把缓存中的待补数据误判为失败。
  // 只有实际应用数据采集阶段才要求所有重点应用具备国别数据。
  if (!LIST_ONLY && countryRemaining > 0) {
    const detail = `国别数据采集未完成：${countryDone}/${countryTotal}，缺少 ${countryRemaining} 个重点应用`;
    updateRunMeta({ currentStage: 'failed', stageLabel: '国别数据采集未完成', workers: [] }, true);
    appendRunEvent('error', '国别数据采集未完成', {
      countryDone,
      countryTotal,
      countryRemaining,
      outputDir: OUT_BASE,
      durationMs: Date.now() - RUN_T0,
    }, true);
    writeProgress(true);
    console.error(`Fatal: ${detail}`);
    if (ownsRuntime) process.exitCode = 1;
    if (ownsRuntime) await ctx.close();
    return { ok: false, detail };
  }
  updateRunMeta({ currentStage: 'done', stageLabel: '已完成', workers: [] }, true);
  if (!BATCH_CHILD) {
    appendRunEvent('info', '周任务完成', { outputDir: OUT_BASE, durationMs: Date.now() - RUN_T0 }, true);
  }
  writeProgress(true);
  if (ownsRuntime) await ctx.close();
  return { ok: true, outputDir: OUT_BASE };
}

function parseBatchManifest() {
  const raw = String(process.env.AMDC_BATCH_MANIFEST || '').trim();
  if (!raw) return null;
  const manifest = JSON.parse(raw);
  if (!manifest || !Array.isArray(manifest.items) || !manifest.items.length) {
    throw new Error('AMDC_BATCH_MANIFEST must include at least one item');
  }
  manifest.items = manifest.items.map((item, index) => {
    const weekAnchor = requireMondayAnchor(item && item.weekAnchor, `batch.items[${index}].weekAnchor`);
    const historyId = String(item && item.historyId || '').trim();
    const outputDir = path.resolve(String(item && item.outputDir || '').trim());
    if (!historyId || !outputDir) throw new Error(`batch.items[${index}] is incomplete`);
    return { historyId, weekAnchor, outputDir };
  });
  return manifest;
}

function batchLifecycleEvent(level, message, extra = {}) {
  return appendRunEvent(level, message, { batch: true, ...extra }, true);
}

function exportWeekWorkbook(item) {
  const result = cp.spawnSync('python', [path.join(__dirname, 'amdc_xlsx_merged.py')], {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      AMDC_PROJECT_DIR: PROJECT_DIR,
      AMDC_RUN_DIR: item.outputDir,
      WEEK_ANCHOR: item.weekAnchor,
    },
    windowsHide: true,
    encoding: 'utf-8',
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Excel export failed for ${item.weekAnchor} (exit ${result.status})`);
}

async function runUnifiedBatch(manifest) {
  const items = manifest.items.slice().sort((a, b) => b.weekAnchor.localeCompare(a.weekAnchor));
  const first = items[0];
  configureRunScope(first.weekAnchor, first.outputDir, true, 'leaderboard');
  initializeRunState();
  const requestedStart = new Date(BATCH_STARTED_AT || 0);
  const startedAt = Number.isFinite(requestedStart.getTime()) && requestedStart.getTime() > 0
    ? requestedStart.toISOString()
    : new Date().toISOString();
  writeBatchRunnerState({
    version: 1,
    batchId: manifest.batchId || BATCH_ID,
    pid: process.pid,
    state: 'starting',
    phase: 'leaderboard',
    startedAt,
    finishedAt: '',
    exitCode: null,
    applicationStartedAt: '',
    children: items.map(item => ({
      historyId: item.historyId,
      weekAnchor: item.weekAnchor,
      state: 'queued',
      phase: 'leaderboard',
      detail: '等待榜单确认',
      attempts: 1,
    })),
  });
  batchLifecycleEvent('info', '任务初始化', {
    weekAnchor: items.map(item => item.weekAnchor).join('、'),
    weeks: items.length,
  });

  let runtime = null;
  const failures = [];
  try {
    runtime = await createCollectorRuntime();
    for (const item of items) {
      configureRunScope(item.weekAnchor, item.outputDir, true, 'leaderboard');
      initializeRunState();
      updateBatchRunnerChild(item.historyId, {
        state: 'running',
        phase: 'leaderboard',
        startedAt: new Date().toISOString(),
        detail: '榜单确认中',
      });
      batchLifecycleEvent('info', '开始榜单确认', { weekAnchor: item.weekAnchor });
      try {
        const outcome = await main(runtime);
        if (!outcome || !outcome.ok) throw new Error(outcome && outcome.detail || '榜单确认失败');
        const confirmedAt = new Date().toISOString();
        updateBatchRunnerChild(item.historyId, {
          state: 'leaderboard_done',
          phase: 'leaderboard',
          leaderboardConfirmedAt: confirmedAt,
          detail: '榜单已确认，等待全部周完成',
        });
        batchLifecycleEvent('info', '榜单已确认，等待全部周完成', { weekAnchor: item.weekAnchor });
      } catch (error) {
        const detail = error && error.message ? error.message : String(error);
        failures.push({ ...item, phase: 'leaderboard', detail });
        updateBatchRunnerChild(item.historyId, {
          state: 'failed',
          phase: 'leaderboard',
          finishedAt: new Date().toISOString(),
          exitCode: 1,
          detail,
        });
        batchLifecycleEvent('error', '榜单确认失败，后续周继续', { weekAnchor: item.weekAnchor, error: detail });
      }
    }

    const stateAfterLeaderboards = readBatchRunnerState();
    const confirmedItems = items.filter(item => {
      const child = stateAfterLeaderboards && stateAfterLeaderboards.children
        && stateAfterLeaderboards.children.find(row => row.historyId === item.historyId);
      return child && child.state === 'leaderboard_done';
    });
    if (!confirmedItems.length) throw new Error('所有周榜单确认均失败，无法进入应用数据采集');

    const applicationStartedAt = new Date().toISOString();
    writeBatchRunnerState({
      phase: 'application',
      state: 'running',
      applicationStartedAt,
      detail: `全部可用榜单已确认，开始采集 ${confirmedItems.length} 个周的应用数据`,
    });
    batchLifecycleEvent('info', `全部 ${confirmedItems.length} 个周榜单已确认，进入应用数据采集`, {
      weekAnchor: confirmedItems.map(item => item.weekAnchor).join('、'),
    });

    for (const item of confirmedItems) {
      configureRunScope(item.weekAnchor, item.outputDir, false, 'application');
      initializeRunState();
      updateBatchRunnerChild(item.historyId, {
        state: 'running',
        phase: 'application',
        startedAt: new Date().toISOString(),
        detail: '应用数据采集中',
      });
      batchLifecycleEvent('info', '开始应用数据采集', { weekAnchor: item.weekAnchor });
      try {
        const outcome = await main(runtime);
        if (!outcome || !outcome.ok) throw new Error(outcome && outcome.detail || '应用数据采集失败');
        if (!manifest.skipExcel) exportWeekWorkbook(item);
        const finishedAt = new Date().toISOString();
        updateBatchRunnerChild(item.historyId, {
          state: 'done',
          phase: 'application',
          finishedAt,
          exitCode: 0,
          detail: '周任务完成',
        });
        batchLifecycleEvent('info', '周任务完成', { weekAnchor: item.weekAnchor, durationMs: Date.now() - RUN_T0 });
      } catch (error) {
        const detail = error && error.message ? error.message : String(error);
        failures.push({ ...item, phase: 'application', detail });
        updateBatchRunnerChild(item.historyId, {
          state: 'failed',
          phase: 'application',
          finishedAt: new Date().toISOString(),
          exitCode: 1,
          detail,
        });
        batchLifecycleEvent('error', '周任务失败，后续周继续', { weekAnchor: item.weekAnchor, error: detail });
      }
    }
  } finally {
    if (runtime && runtime.ctx) await runtime.ctx.close().catch(() => {});
  }

  const finalState = readBatchRunnerState() || {};
  const children = Array.isArray(finalState.children) ? finalState.children : [];
  const failed = failures.length > 0 || children.some(child => child.state === 'failed');
  const finishedAt = new Date().toISOString();
  if (!failed) {
    configureRunScope(items[items.length - 1].weekAnchor, items[items.length - 1].outputDir, false, 'application');
    batchLifecycleEvent('info', '总任务完成', {
      weekAnchor: items.map(item => item.weekAnchor).join('、'),
    });
  }
  writeBatchRunnerState({
    state: failed ? 'failed' : 'done',
    phase: 'application',
    finishedAt,
    exitCode: failed ? 1 : 0,
    detail: failed ? `批次存在 ${failures.length} 个失败任务` : '总任务完成',
    failures,
  });
  if (failed) throw new Error(`Unified batch failed: ${failures.map(item => `${item.weekAnchor} ${item.phase}: ${item.detail}`).join(' | ')}`);
}

// CHECK_AUTH=1：一次进程自检全部账号（AMDC_USERDATA_DIR 显式指定时只查该账号）。
// 缓存 token 探针通过则免浏览器启动。输出每账号 `OK <dir>` / `FAIL <dir>`，全过 exit 0，否则 1。
async function checkAuth() {
  const single = process.env.AMDC_USERDATA_DIR;
  const dirs = single ? [single] : discoverProfileDirs();
  if (!dirs.length) {
    console.log('FAIL (no .amdc-userdata profile found)');
    process.exit(1);
  }
  try {
    const results = await checkAuthPool(dirs);
    const ok = new Set(results.filter(r => r && r.ok).map(r => r.dir));
    const unknown = new Set(results.filter(r => r && r.unknown).map(r => r.dir));
    for (const dir of dirs) console.log(ok.has(dir) ? `OK ${dir}` : (unknown.has(dir) ? `UNKNOWN ${dir}` : `FAIL ${dir}`));
    process.exit(ok.size === dirs.length ? 0 : (unknown.size ? 2 : 1));
  } catch (error) {
    console.error('checkAuth failed:', error.message);
    for (const dir of dirs) console.log(`FAIL ${dir}`);
    process.exit(1);
  }
}

if (process.env.CHECK_AUTH === '1') {
  checkAuth();
} else if (process.env.PROGRESS_ONLY === '1') {
  writeProgress(true);
  console.log('progress json refreshed:', PROGRESS_JSON);
} else if (process.env.AMDC_BATCH_MANIFEST) {
  runUnifiedBatch(parseBatchManifest()).catch(error => {
    try {
      writeBatchRunnerState({
        state: 'failed',
        finishedAt: new Date().toISOString(),
        exitCode: 1,
        detail: error && error.message ? error.message : String(error),
      });
    } catch {}
    console.error('Fatal:', error);
    process.exit(1);
  });
} else {
  main().catch(error => {
    try {
      for (const c of Object.keys(CATS)) updateRunState(c, { status: 'error', error: String(error) });
    } catch {}
    writeProgress(true);
    console.error('Fatal:', error);
    process.exit(1);
  });
}
