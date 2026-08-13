#!/usr/bin/env node
// @ts-check
// AMDC — 统一 CLI 入口
// 脱离 AI agent，可独立运行和定时调度
//
// 用法: amdc <command> [options]
//   amdc setup             安装依赖 + 生成配置
//   amdc status            先检查登录状态，再显示 profile + 邮箱
//   amdc login [profile]   浏览器登录
//   amdc check             仅 auth check
//   amdc export            仅 Excel 导出
//   amdc tags update       更新 tag 字典
//   amdc dashboard         启动看板
//   amdc schedule init     生成调度任务
//   amdc config show       显示配置
//   amdc update            从 gitee 拉取最新版本

const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync, execSync } = require('child_process');

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.code = 'USAGE';
  }
}

class CheckError extends Error {
  constructor(message, details) {
    super(message);
    this.code = 'CHECK';
    this.details = details;
  }
}

let CLI_JSON = false;
let CLI_PROJECT_DIR = '';

const MAX_ACCOUNT_PROFILES = 20;
const MANAGED_ACCOUNT_PROFILES = Object.freeze(['.amdc-userdata'].concat(
  Array.from({ length: MAX_ACCOUNT_PROFILES - 1 }, (_, index) => `.amdc-userdata-${String.fromCharCode(98 + index)}`),
));
const MANAGED_ACCOUNT_PROFILE_SET = new Set(MANAGED_ACCOUNT_PROFILES);

// ── 配置加载 ──

function resolveProjectDir() {
  if (CLI_PROJECT_DIR) return path.resolve(CLI_PROJECT_DIR);

  // A globally linked CLI must follow the code it was linked from. Environment
  // variables remain available to worker scripts, but a stale variable must not
  // redirect the public CLI to an old data-only directory.
  const appRoot = path.resolve(APP_ROOT);
  if (isAMDCCodeDir(appRoot)) return appRoot;

  if (process.env.AMDC_PROJECT_DIR) {
    const configured = path.resolve(process.env.AMDC_PROJECT_DIR);
    if (isAMDCCodeDir(configured)) return configured;
  }

  const currentDir = path.resolve(process.cwd());
  if (isAMDCCodeDir(currentDir)) return currentDir;

  return currentDir;
}

function loadConfig(projectDir) {
  const cfgPath = path.join(projectDir, 'amdc-config.json');
  if (!fs.existsSync(cfgPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  } catch {
    console.warn('⚠️  配置文件解析失败:', cfgPath);
    return {};
  }
}

function redactSecrets(value, key = '') {
  if (Array.isArray(value)) return value.map(item => redactSecrets(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      redactSecrets(childValue, childKey),
    ]));
  }
  if (/(token|password|secret|credential|authorization|api[-_]?key)/i.test(key)) return '********';
  return value;
}

function resolveLatestDataDir(projectDir, weekAnchor) {
  if (process.env.AMDC_RUN_DIR) return path.resolve(process.env.AMDC_RUN_DIR);
  const mon = String(weekAnchor || '').replace(/-/g, '');
  const legacyDir = path.join(projectDir, 'Cache', mon);
  const historyDir = path.join(projectDir, 'Cache', 'history');
  let candidates = [];
  try {
    candidates = fs.readdirSync(historyDir)
      .filter(name => /^\d{8}-\d{6}-[a-f0-9]{4}$/.test(name))
      .map(name => path.join(historyDir, name))
      .filter(dir => {
        try {
          const metadata = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf-8'));
          return !metadata.weekAnchor || metadata.weekAnchor === weekAnchor;
        } catch { return false; }
      })
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  } catch {}
  return candidates[0] || legacyDir;
}

function previousMonday() {
  const d = new Date();
  const day = d.getDay();
  const diff = (day + 6) % 7 + 7;
  d.setDate(d.getDate() - diff);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function requireMondayAnchor(value) {
  const text = String(value || '').trim();
  const date = new Date(`${text}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)
    || !Number.isFinite(date.getTime())
    || date.toISOString().slice(0, 10) !== text
    || date.getUTCDay() !== 1) {
    throw new UsageError(`采集日期只能选择周一（YYYY-MM-DD）：${text || '(空)'}`);
  }
  return text;
}

function u(...codes) { return String.fromCodePoint(...codes); }

const CATS = [
  u(0x8D85, 0x4F11, 0x95F2),
  u(0x4F11, 0x95F2),
  u(0x58C1, 0x7EB8),
  'Launcher',
  u(0x6740, 0x6BD2, 0x8F6F, 0x4EF6, 0x3001, 0x6E05, 0x7406),
  u(0x6587, 0x4EF6, 0x6062, 0x590D),
  'PDF' + u(0x9605, 0x8BFB, 0x5668),
];

const APP_ROOT = __dirname;
const SCRIPTS = path.join(APP_ROOT, 'scripts');

// ── 工具函数 ──

// WSL → 8788, Windows → 8787（可通过 AMDC_PORT 环境变量覆盖）
function isWSL() {
  if (process.platform !== 'linux') return false;
  try { return require('fs').readFileSync('/proc/version', 'utf-8').toLowerCase().includes('microsoft'); } catch { return false; }
}
const DASHBOARD_PORT = process.env.AMDC_PORT || (isWSL() ? '8788' : '8787');
const DASHBOARD_URL = `http://127.0.0.1:${DASHBOARD_PORT}`;

function httpGet(urlPath) {
  return new Promise((resolve, reject) => {
    const request = http.get(`${DASHBOARD_URL}${urlPath}`, { timeout: 5000 }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
    request.on('timeout', () => request.destroy(new Error(`dashboard request timed out: ${urlPath}`)));
    request.on('error', reject);
  });
}

function httpRequest(method, urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${DASHBOARD_URL}${urlPath}`, {
      method,
      headers: options.headers || {},
      timeout: options.timeout || 5000,
    }, response => {
      let data = '';
      response.on('data', chunk => { data += chunk.toString(); });
      response.on('end', () => {
        let body = data;
        try { body = data ? JSON.parse(data) : {}; } catch {}
        resolve({ status: response.statusCode || 0, body });
      });
    });
    request.on('timeout', () => request.destroy(new Error(`dashboard request timed out: ${urlPath}`)));
    request.on('error', reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

async function dashboardHealth() {
  try {
    const health = await httpGet('/api/health');
    return health && typeof health === 'object' && health.ok === true ? health : null;
  } catch {
    return null;
  }
}

async function dashboardRunning() {
  return !!(await dashboardHealth());
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function sameDir(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function isAMDCCodeDir(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
    if (pkg && pkg.name === 'amdc') return true;
  } catch {}
  return fs.existsSync(path.join(dir, 'am.js'))
    && fs.existsSync(path.join(dir, 'scripts', 'progress-server.js'));
}

function isAMDCProjectDir(dir) {
  return isAMDCCodeDir(dir);
}

async function requireOwnedDashboard(projectDir = resolveProjectDir()) {
  const health = await dashboardHealth();
  if (!health) throw new CheckError(`AMDC dashboard is not running at ${DASHBOARD_URL}. Run "amdc start" first.`);
  if (!health.projectDir || !sameDir(health.projectDir, projectDir)) {
    throw new CheckError(`Port ${DASHBOARD_PORT} belongs to another AMDC project: ${health.projectDir || 'unknown'}`);
  }
  return health;
}

function parseOptions(args, booleanNames = [], valueNames = []) {
  const booleans = new Set(booleanNames);
  const values = new Set(valueNames);
  const result = { _: [] };
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (!token.startsWith('--')) {
      result._.push(token);
      continue;
    }
    const name = token.slice(2);
    if (!booleans.has(name) && !values.has(name)) throw new UsageError(`unknown option: --${name}`);
    if (booleans.has(name)) {
      if (Object.prototype.hasOwnProperty.call(result, name)) throw new UsageError(`--${name} may only be specified once`);
      result[name] = true;
      continue;
    }
    const value = args[++index];
    if (value == null || value.startsWith('--')) throw new UsageError(`--${name} requires a value`);
    if (Object.prototype.hasOwnProperty.call(result, name)) {
      result[name] = Array.isArray(result[name]) ? result[name].concat(value) : [result[name], value];
    } else {
      result[name] = value;
    }
  }
  return result;
}

function optionValues(value) {
  if (value == null) return [];
  return (Array.isArray(value) ? value : [value]).map(item => String(item).trim()).filter(Boolean);
}

function outputJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function cliApiToken(projectDir) {
  const configPath = path.join(projectDir, 'amdc-config.json');
  const config = loadConfig(projectDir);
  if (!config.cli || typeof config.cli !== 'object' || Array.isArray(config.cli)) config.cli = {};
  let token = String(config.cli.apiToken || '').trim();
  if (token.length < 32) {
    token = crypto.randomBytes(24).toString('hex');
    config.cli.apiToken = token;
    try {
      fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
    } catch (error) {
      throw new CheckError(`cannot save the dashboard CLI token: ${error.message}`);
    }
  }
  return token;
}

function cliApiHeaders(projectDir) {
  return { 'X-AMDC-Token': cliApiToken(projectDir) };
}

function defaultAccounts(projectDir, config) {
  const configured = String(config.accounts || '').split(',').map(value => value.trim()).filter(Boolean);
  if (configured.length) return configured;
  try {
    return MANAGED_ACCOUNT_PROFILES
      .filter(name => fs.existsSync(path.join(projectDir, name)))
      .filter(name => fs.statSync(path.join(projectDir, name)).isDirectory());
  } catch {
    return [];
  }
}

function isManagedAccountProfile(account) {
  return typeof account === 'string' && MANAGED_ACCOUNT_PROFILE_SET.has(account);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function signCollectionPlan(plan, projectDir) {
  return crypto.createHmac('sha256', cliApiToken(projectDir)).update(JSON.stringify(plan)).digest('hex');
}

function readCollectionPlan(planPath) {
  const resolved = path.resolve(planPath);
  let plan;
  try { plan = JSON.parse(fs.readFileSync(resolved, 'utf-8')); }
  catch (error) { throw new UsageError(`cannot read collection plan: ${error.message}`); }
  const signature = plan.signature;
  const unsigned = { ...plan };
  delete unsigned.signature;
  if (!path.isAbsolute(String(unsigned.projectDir || ''))) throw new UsageError('collection plan projectDir must be absolute');
  const projectDir = resolveProjectDir();
  if (!sameDir(unsigned.projectDir, projectDir)) throw new CheckError(`plan belongs to another project: ${unsigned.projectDir}`);
  if (!signature || signature !== signCollectionPlan(unsigned, projectDir)) {
    throw new UsageError('collection plan signature is missing or invalid');
  }
  validateCollectionPlan(unsigned);
  return { path: resolved, plan };
}

function buildCollectionPlan(options) {
  const projectDir = resolveProjectDir();
  const config = loadConfig(projectDir);
  const weeks = optionValues(options.week);
  if (!weeks.length) throw new UsageError('collect plan requires at least one --week YYYY-MM-DD');
  const weekAnchors = [...new Set(weeks.map(requireMondayAnchor))].sort((a, b) => b.localeCompare(a));
  const accounts = optionValues(options.account);
  const categories = optionValues(options.category);
  const topDepth = Number(options['top-depth'] || config.topDepth || 100);
  if (![100, 1000].includes(topDepth)) throw new UsageError('--top-depth must be 100 or 1000');
  const invalidCategories = categories.filter(category => !CATS.includes(category));
  if (invalidCategories.length) throw new UsageError(`unsupported categories: ${invalidCategories.join(', ')}`);
  const selectedAccounts = accounts.length ? [...new Set(accounts)] : defaultAccounts(projectDir, config);
  if (!selectedAccounts.length) throw new CheckError('no AMDC account profiles were found');
  const unmanagedAccounts = selectedAccounts.filter(account => !isManagedAccountProfile(account));
  if (unmanagedAccounts.length) throw new UsageError(`account profiles are outside the managed A-T pool: ${unmanagedAccounts.join(', ')}`);
  const missingAccounts = selectedAccounts.filter(account => {
    try { return !fs.statSync(path.join(projectDir, account)).isDirectory(); } catch { return true; }
  });
  if (missingAccounts.length) throw new UsageError(`account profiles do not exist: ${missingAccounts.join(', ')}`);
  const planSeed = `${Date.now()}|${weekAnchors.join(',')}|${selectedAccounts.join(',')}|${categories.join(',')}|${options.fresh ? 'fresh' : 'normal'}`;
  const plan = {
    schemaVersion: 1,
    kind: 'amdc.collection-plan',
    planId: `${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-${sha256(planSeed).slice(0, 8)}`,
    projectDir,
    createdAt: new Date().toISOString(),
    mode: options.fresh ? 'fresh' : 'normal',
    weekAnchors,
    accounts: selectedAccounts,
    categories: categories.length ? [...new Set(categories)] : CATS.slice(),
    topDepth,
    listOnly: !!options['list-only'],
    skipExcel: !!options['skip-excel'],
    source: 'ai',
    requiresConfirmation: true,
  };
  return { ...plan, signature: signCollectionPlan(plan, projectDir) };
}

function validateCollectionPlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new UsageError('collection plan must be a JSON object');
  if (plan.schemaVersion !== 1 || plan.kind !== 'amdc.collection-plan') throw new UsageError('unsupported collection plan schema');
  if (plan.source !== 'ai' || plan.requiresConfirmation !== true) throw new UsageError('collection plan authorization metadata is invalid');
  if (!['normal', 'fresh'].includes(plan.mode)) throw new UsageError('collection plan mode must be normal or fresh');
  if (!path.isAbsolute(String(plan.projectDir || ''))) throw new UsageError('collection plan projectDir must be absolute');
  if (!Array.isArray(plan.weekAnchors) || !plan.weekAnchors.length) throw new UsageError('collection plan requires at least one weekAnchor');
  const weekAnchors = [...new Set(plan.weekAnchors.map(requireMondayAnchor))];
  if (weekAnchors.length !== plan.weekAnchors.length) throw new UsageError('collection plan contains duplicate weekAnchors');
  if (!Array.isArray(plan.accounts) || !plan.accounts.length || plan.accounts.some(account => !isManagedAccountProfile(account))) {
    throw new UsageError('collection plan contains invalid account profiles');
  }
  if (!Array.isArray(plan.categories) || !plan.categories.length || plan.categories.some(category => !CATS.includes(category))) {
    throw new UsageError('collection plan contains unsupported categories');
  }
  if (![100, 1000].includes(Number(plan.topDepth))) throw new UsageError('collection plan topDepth must be 100 or 1000');
  if (typeof plan.listOnly !== 'boolean' || typeof plan.skipExcel !== 'boolean') {
    throw new UsageError('collection plan listOnly and skipExcel must be booleans');
  }
}

function collectionPlanQuery(plan) {
  const params = new URLSearchParams();
  if (plan.mode === 'fresh') params.set('fresh', '1');
  for (const week of plan.weekAnchors) params.append('weekAnchor', week);
  params.set('weekAnchorsConfirmed', '1');
  if (plan.listOnly) params.set('listOnly', '1');
  if (plan.skipExcel) params.set('skipExcel', '1');
  params.set('topDepth', String(plan.topDepth));
  for (const account of plan.accounts) params.append('account', account);
  for (const category of plan.categories) params.append('category', category);
  params.set('source', 'ai');
  return params.toString();
}

function resolveDashboardProjectDir(projectDirArg) {
  if (projectDirArg) return path.resolve(projectDirArg);
  return resolveProjectDir();
}

function resolveRepositoryRoot(startDir) {
  try {
    return execSync('git rev-parse --show-toplevel', {
      cwd: startDir,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
  } catch {
    return '';
  }
}

function assertDashboardProjectDir(projectDir) {
  if (process.env.AMDC_PROJECT_DIR || isAMDCProjectDir(projectDir)) return;
  if (!sameDir(projectDir, os.homedir())) return;
  console.error('❌ 当前目录是用户主目录，不像 AMDC 项目目录：' + projectDir);
  console.error('   请先 cd 到 AMDC 项目目录后运行 amdc dashboard / amdc start');
  console.error('   或显式设置 AMDC_PROJECT_DIR 为项目目录。');
  process.exit(1);
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h${m % 60}m`;
  if (m > 0) return `${m}m${s % 60}s`;
  return `${s}s`;
}

function terminalWidth(value) {
  let width = 0;
  for (const char of String(value)) {
    const code = char.codePointAt(0);
    if (!code || code === 0xfe0e || code === 0xfe0f || /\p{Mark}/u.test(char)) continue;
    const wide = code >= 0x1100 && (
      code <= 0x115f || code === 0x2329 || code === 0x232a
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe10 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6)
      || (code >= 0x1f300 && code <= 0x1faff)
    );
    width += wide ? 2 : 1;
  }
  return width;
}

function padTableCell(value, width) {
  const text = String(value);
  const gap = Math.max(width - terminalWidth(text), 0);
  const left = Math.floor(gap / 2);
  return `${' '.repeat(left)}${text}${' '.repeat(gap - left)}`;
}

function maskEmail(email) {
  const value = String(email || '').trim();
  const at = value.indexOf('@');
  if (at <= 0) return value ? '***' : '';
  const local = value.slice(0, at);
  const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${visible}***${value.slice(at)}`;
}

function renderTableRow(values, widths) {
  return `│${values.map((value, i) => ` ${padTableCell(value, widths[i])} `).join('│')}│`;
}

function renderTableBorder(widths, left, join, right) {
  return `${left}${widths.map(width => '─'.repeat(width + 2)).join(join)}${right}`;
}

let detectedPowerShell = null;

function commandExists(command) {
  try {
    const probe = process.platform === 'win32' ? `where.exe ${command}` : `command -v ${command}`;
    execSync(probe, { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function powershellCommand() {
  const runtime = powershellRuntime();
  if (!runtime) throw new Error('PowerShell 7 or Windows PowerShell 5.1 is required');
  return runtime.command;
}

function powershellRuntime() {
  if (detectedPowerShell) return detectedPowerShell;
  const candidates = [
    process.env.AMDC_POWERSHELL,
    process.platform === 'win32' && process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'pwsh.exe')
      : '',
    'pwsh',
    'pwsh.exe',
    process.platform === 'win32' && process.env.SystemRoot
      ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : '',
    process.platform === 'win32' ? 'powershell.exe' : '',
  ].filter(Boolean);
  for (const candidate of [...new Set(candidates)]) {
    const probe = spawnSync(candidate, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
      encoding: 'utf-8',
      windowsHide: true,
    });
    const version = String(probe.stdout || '').trim();
    const [major, minor = 0] = version.split('.').map(Number);
    if (probe.status === 0 && (major > 5 || (major === 5 && minor >= 1))) {
      detectedPowerShell = { command: candidate, version };
      return detectedPowerShell;
    }
  }
  return null;
}

function readProfileEmail(projectDir, dir) {
  return new Promise(resolve => {
    const ps1Path = path.join(SCRIPTS, 'amdc_profile_emails.ps1');
    const command = `& '${ps1Path}' -ProjectDir '${projectDir}' -Accounts '${dir}' -AllowUnknown`;
    const child = spawn(powershellCommand(), ['-NoProfile', '-Command', command], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let out = '';
    let settled = false;
    const finish = email => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve([dir, email]);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish('');
    }, 30000);

    child.stdout.on('data', chunk => { out += chunk.toString(); });
    child.on('error', () => finish(''));
    child.on('close', () => {
      const escaped = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = out.match(new RegExp(`${escaped}[\\t ]+(\\S+@\\S+)`));
      finish(match ? match[1] : '');
    });
  });
}

async function readProfileEmails(projectDir, dirs) {
  const rows = await Promise.all(dirs.map(dir => readProfileEmail(projectDir, dir)));
  return new Map(rows.filter(([, email]) => email));
}

// ── 子命令 ──

async function cmdSetup() {
  console.log('🔧 AMDC 独立化安装\n');

  // 1. 运行 npm postinstall 同款环境检查：Node / Chromium / Python openpyxl
  const postinstallScript = path.join(SCRIPTS, 'postinstall.js');
  if (fs.existsSync(postinstallScript)) {
    try {
      execSync(`node "${postinstallScript}"`, { cwd: APP_ROOT, stdio: 'inherit' });
    } catch {
      console.log('  ⚠️  环境检查存在未完成项，请按上方提示处理');
    }
  } else {
    console.log(`  Node.js: ${process.version}`);
  }

  // 2. 额外提示 Python 状态，便于 setup 输出更直观
  try {
    const py = execSync('python3 --version 2>&1 || python --version 2>&1', { encoding: 'utf-8' }).trim();
    console.log(`  Python:  ${py}`);
  } catch {
    console.log('  ⚠️  Python 未检测到，Excel 导出功能需要 Python');
  }

  // 3. 生成配置文件
  const projectDir = resolveProjectDir();
  const cfgPath = path.join(projectDir, 'amdc-config.json');
  if (!fs.existsSync(cfgPath)) {
    const examplePath = path.join(APP_ROOT, 'references', 'amdc-config.example.json');
    if (fs.existsSync(examplePath)) {
      fs.copyFileSync(examplePath, cfgPath);
      console.log(`\n✅ 配置文件已生成: ${cfgPath}`);
    }
  } else {
    console.log(`\n  配置文件已存在: ${cfgPath}`);
  }

  console.log('\n✅ 安装完成。下一步: amdc login');
}

async function cmdStatus(options = {}) {
  const projectDir = resolveProjectDir();
  // status 先做一次实时认证探针，再展示本地缓存和账号信息。
  if (!options.json) console.log('正在查询账号状态...');
  const { statusByProfile } = await cmdCheck(projectDir, { silent: true });

  const cfg = loadConfig(projectDir);

  // 发现 profiles
  const dirs = cfg.accounts
    ? cfg.accounts.split(',').map(s => s.trim()).filter(Boolean)
    : (() => {
        try {
          return fs.readdirSync(projectDir)
            .filter(d => /^\.amdc-userdata(-.+)?$/.test(d))
            .sort();
        } catch { return []; }
      })();

  if (!dirs.length) {
    const result = { ok: false, projectDir, accounts: [], error: 'no account profiles found' };
    if (options.json) outputJson(result);
    else console.log('未发现 .amdc-userdata* profile。请先运行: amdc login');
    return result;
  }

  if (!options.json) console.log('');
  const emailByProfile = await readProfileEmails(projectDir, dirs);
  const rows = [];

  for (const dir of dirs) {
    const tokenPath = path.join(projectDir, dir, 'amdc-token.json');
    const hasToken = fs.existsSync(tokenPath);
    let cachedDate = '';
    if (hasToken) {
      try {
        const t = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
        const savedAt = t.savedAt ? new Date(t.savedAt) : null;
        cachedDate = savedAt && !Number.isNaN(savedAt.getTime())
          ? savedAt.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
          : '未知';
      } catch {}
    }

    const tokenStatus = hasToken ? `缓存 ${cachedDate || '?'}` : '无缓存';
    const authStatus = statusByProfile.get(dir) || 'UNKNOWN';
    const statusDisplay = {
      OK: '🟢 正常',
      UNKNOWN: '🟡 异常',
      FAIL: '🔴 失效',
    }[authStatus] || '🟡 异常';

    rows.push({
      profile: dir,
      token: tokenStatus,
      status: statusDisplay,
      authStatus,
      email: maskEmail(emailByProfile.get(dir)) || '-',
    });
  }

  const result = {
    ok: rows.every(row => row.authStatus === 'OK'),
    projectDir,
    accounts: rows,
    summary: {
      total: rows.length,
      ok: rows.filter(row => row.authStatus === 'OK').length,
      failed: rows.filter(row => row.authStatus === 'FAIL').length,
      unknown: rows.filter(row => row.authStatus === 'UNKNOWN').length,
    },
  };
  if (options.json) {
    outputJson(result);
    return result;
  }

  const widthFor = (title, values, minimum) => Math.max(
    minimum,
    terminalWidth(title),
    ...values.map(value => terminalWidth(value)),
  );
  const widths = [
    widthFor('Profile', rows.map(row => row.profile), 24),
    widthFor('Token', rows.map(row => row.token), 16),
    widthFor('状态', rows.map(row => row.status), 10),
    widthFor('邮箱', rows.map(row => row.email), 24),
  ];
  console.log(renderTableBorder(widths, '┌', '┬', '┐'));
  console.log(renderTableRow(['Profile', 'Token', '状态', '邮箱'], widths));
  console.log(renderTableBorder(widths, '├', '┼', '┤'));
  for (const row of rows) {
    console.log(renderTableRow([row.profile, row.token, row.status, row.email], widths));
  }
  console.log(renderTableBorder(widths, '└', '┴', '┘'));
  return result;
}

async function cmdLogin(profile) {
  const projectDir = resolveProjectDir();
  const dir = profile || '.amdc-userdata';
  const loginScript = path.join(SCRIPTS, 'amdc-login.js');

  console.log(`🔑 打开浏览器登录 AMDC — Profile: ${dir}`);
  console.log('   浏览器窗口将打开，请在窗口中完成登录。');
  console.log('   登录成功后脚本自动退出。\n');

  const env = {
    ...process.env,
    AMDC_PROJECT_DIR: projectDir,
    AMDC_USERDATA_DIR: dir,
    AMDC_LOGIN_WAIT_MIN: '10',
  };

  return new Promise((resolve) => {
    const child = spawn('node', [loginScript], { env, stdio: 'inherit' });
    child.on('exit', code => {
      if (code === 0) {
        console.log(`\n✅ ${dir} 登录成功`);
      } else {
        console.log(`\n❌ ${dir} 登录失败 (退出码 ${code})`);
      }
      resolve(code);
    });
  });
}

async function cmdCheck(projectDirArg, options = {}) {
  const projectDir = projectDirArg ? path.resolve(projectDirArg) : resolveProjectDir();
  const weeklyScript = path.join(SCRIPTS, 'amdc-weekly.js');
  const silent = options.silent === true;

  if (!silent) console.log('🔍 验证 AMDC 账号...\n');

  const env = {
    ...process.env,
    AMDC_PROJECT_DIR: projectDir,
    CHECK_AUTH: '1',
  };

  return new Promise((resolve, reject) => {
    const child = spawn('node', [weeklyScript], { env, stdio: 'pipe' });
    let out = '';
    child.stdout.on('data', c => {
      out += c.toString();
      if (!silent) process.stdout.write(c);
    });
    child.stderr.on('data', c => {
      out += c.toString();
      if (!silent) process.stderr.write(c);
    });

    child.once('error', reject);

    child.on('exit', code => {
      const oks = (out.match(/OK\s+(\S+)/g) || []).length;
      const fails = (out.match(/FAIL\s+(\S+)/g) || []).length;
      const unknowns = (out.match(/UNKNOWN\s+(\S+)/g) || []).length;
      const statusByProfile = new Map(
        [...out.matchAll(/^(OK|FAIL|UNKNOWN)[ \t]+(\S+)[ \t]*$/gm)]
          .map(match => [match[2], match[1]]),
      );
      if (!silent) {
        console.log(`\n结果: ${oks} OK, ${fails} FAIL, ${unknowns} UNKNOWN`);
        if (fails > 0) {
          console.log('💡 失败账号需要重新登录: amdc login <profile>');
        }
        if (unknowns > 0) {
          console.log('💡 UNKNOWN 表示网络暂时无法确认，已保留本地登录态');
        }
      }
      resolve({
        code,
        statusByProfile,
        accounts: [...statusByProfile].map(([profile, status]) => ({ profile, status })),
        summary: { ok: oks, failed: fails, unknown: unknowns },
      });
    });
  });
}

async function cmdExport() {
  const projectDir = resolveProjectDir();
  const weekAnchor = requireMondayAnchor(process.env.WEEK_ANCHOR || previousMonday());
  const mon = weekAnchor.replace(/-/g, '');
  const cacheDir = resolveLatestDataDir(projectDir, weekAnchor);

  console.log('📊 Excel 导出\n');

  if (!fs.existsSync(cacheDir)) {
    console.error(`  ❌ 缓存目录不存在: ${cacheDir}`);
    process.exit(1);
  }

  console.log('📑 生成唯一 Excel...');
  const mergedScript = path.join(SCRIPTS, 'amdc_xlsx_merged.py');
  try {
    execSync(`python "${mergedScript}"`, {
      env: { ...process.env, AMDC_PROJECT_DIR: projectDir, AMDC_RUN_DIR: cacheDir, WEEK_ANCHOR: weekAnchor },
      stdio: 'inherit',
    });
    console.log(`  ✅ ${path.join(projectDir, 'output', `AMDC-${mon}.xlsx`)}`);
  } catch {
    console.error('  ❌ 合并失败');
  }
}

async function cmdTagsUpdate() {
  const projectDir = resolveProjectDir();
  const tagsScript = path.join(SCRIPTS, 'amdc_tags_dict.js');
  console.log('🏷️  更新 Tag 字典...\n');

  try {
    execSync(`node "${tagsScript}"`, {
      env: { ...process.env, AMDC_PROJECT_DIR: projectDir },
      stdio: 'inherit',
    });
    console.log('✅ Tag 字典已更新');
  } catch {
    console.error('❌ Tag 字典更新失败');
    process.exit(1);
  }
}

async function cmdStart(projectDirArg) {
  const projectDir = resolveDashboardProjectDir(projectDirArg);
  assertDashboardProjectDir(projectDir);
  const cfg = loadConfig(projectDir);
  const authCheckConcurrency = cfg.authCheckConcurrency || cfg.maxAccounts || 20;
  const urls = getUrls();

  const currentHealth = await dashboardHealth();
  if (currentHealth) {
    if (!currentHealth.projectDir || !sameDir(currentHealth.projectDir, projectDir)) {
      throw new CheckError(`Port ${DASHBOARD_PORT} belongs to another AMDC project: ${currentHealth.projectDir || 'unknown'}`);
    }
    console.log('📡 看板已在运行');
    for (const u of urls) console.log(`   ${u}`);
    return;
  }

  console.log('📡 启动看板...');
  console.log(`   项目目录: ${projectDir}`);
  const serverScript = path.join(SCRIPTS, 'progress-server.js');
  // 采集历史会把 Cache/YYYYMMDD 识别为旧版结果目录；看板日志不能写进这类目录，
  // 否则仅启动看板也会被误展示成一条“旧版数据”历史。
  const dashboardLogDir = path.join(projectDir, 'Cache', 'logs');
  fs.mkdirSync(dashboardLogDir, { recursive: true });
  const out = fs.openSync(path.join(dashboardLogDir, 'amdc-dashboard.log'), 'a');
  const child = spawn(process.execPath, [serverScript], {
    cwd: projectDir,
    env: {
      ...process.env,
      AMDC_PROJECT_DIR: projectDir,
      AMDC_NO_OPEN: '1',
      AMDC_PORT: DASHBOARD_PORT,
      AUTH_CHECK_CONCURRENCY: process.env.AUTH_CHECK_CONCURRENCY || String(authCheckConcurrency),
      AUTH_PROBE_TIMEOUT_MS: process.env.AUTH_PROBE_TIMEOUT_MS || cfg.authProbeTimeoutMs || '8000',
      AUTH_CHECK_COOLDOWN_HOURS: process.env.AUTH_CHECK_COOLDOWN_HOURS || cfg.authCheckCooldownHours || '6',
    },
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.unref();
  try { fs.closeSync(out); } catch {}

  await sleep(10000);

  const startedHealth = await dashboardHealth();
  if (startedHealth && startedHealth.projectDir && sameDir(startedHealth.projectDir, projectDir)) {
    console.log('✅ 看板已启动');
    for (const u of urls) console.log(`   ${u}`);
  } else {
    console.error('❌ 看板启动失败：服务未响应');
    process.exit(1);
  }
}

async function cmdStop() {
  const health = await dashboardHealth();
  if (!health) {
    console.log('看板未在运行');
    return;
  }
  await requireOwnedDashboard();

  const port = DASHBOARD_PORT;
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf-8' });
      const pid = out.trim().split(/\s+/).pop();
      if (pid) execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
    } else {
      execSync(`fuser -k ${port}/tcp 2>/dev/null || ss -tlnp | grep :${port} | grep -oP 'pid=\\K\\d+' | xargs -r kill`, { stdio: 'ignore' });
    }
    await sleep(800);
    if (!(await dashboardRunning())) {
      console.log('✅ 看板已关闭');
    } else {
      console.log('⚠️  关闭失败，端口仍被占用');
    }
  } catch {
    console.log('⚠️  关闭失败');
  }
}

async function cmdRestart(projectDirArg) {
  await cmdStop();
  await sleep(1000);
  await cmdStart(projectDirArg);
}

async function cmdDoctor(options = {}) {
  const projectDir = resolveProjectDir();
  const config = loadConfig(projectDir);
  const checks = [];
  const add = (name, ok, detail, optional = false) => checks.push({ name, ok: !!ok, detail, optional });
  add('project', isAMDCCodeDir(projectDir), projectDir);
  add('node', Number(process.versions.node.split('.')[0]) >= 18, process.version);
  const ps = powershellRuntime();
  add('powershell', !!ps, ps ? `${ps.version} (${ps.command})` : 'PowerShell 7 / Windows PowerShell 5.1 not found');
  const py = spawnSync('python', ['--version'], { encoding: 'utf-8', windowsHide: true });
  add('python', py.status === 0, String(py.stdout || py.stderr || '').trim() || 'not found');
  add('config', fs.existsSync(path.join(projectDir, 'amdc-config.json')), path.join(projectDir, 'amdc-config.json'));
  const integrations = config.integrations && typeof config.integrations === 'object' ? config.integrations : {};
  const accounts = defaultAccounts(projectDir, config);
  add('accounts', accounts.length > 0, `${accounts.length} profile(s)`);
  add('feishuIntegration', !!(process.env.AMDC_FEISHU_SHEET_URL || integrations.feishuSheetUrl), 'configured in private local settings', true);
  add('accountBackupIntegration', !!(process.env.AMDC_ACCOUNT_REPOSITORY_URL || integrations.accountRepositoryUrl), 'configured in private local settings', true);
  const health = await dashboardHealth();
  add('dashboard', !!health && sameDir(health.projectDir || '', projectDir), health
    ? `${health.projectDir || 'unknown'} (pid ${health.pid || '?'})`
    : 'not running', true);
  const result = {
    ok: checks.filter(check => !check.optional).every(check => check.ok),
    projectDir,
    checks,
  };
  if (options.json) outputJson(result);
  else {
    console.log(`AMDC doctor: ${result.ok ? 'PASS' : 'FAIL'}`);
    for (const check of checks) console.log(`${check.ok ? '[ok]' : check.optional ? '[--]' : '[!!]'} ${check.name}: ${check.detail}`);
  }
  return result;
}

async function cmdCollect(args) {
  const subcommand = args.shift();
  if (subcommand === 'plan') {
    const options = parseOptions(args, ['fresh', 'list-only', 'skip-excel'], ['week', 'account', 'category', 'top-depth', 'output']);
    if (options._.length) throw new UsageError(`unexpected collect plan argument: ${options._[0]}`);
    if (Array.isArray(options.output)) throw new UsageError('--output may only be specified once');
    if (Array.isArray(options['top-depth'])) throw new UsageError('--top-depth may only be specified once');
    const requestedOutput = options.output ? path.resolve(String(options.output)) : '';
    const plan = buildCollectionPlan(options);
    const output = requestedOutput || path.join(plan.projectDir, 'Cache', 'plans', `${plan.planId}.json`);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(plan, null, 2)}\n`, 'utf-8');
    if (CLI_JSON) outputJson({ ok: true, planPath: output, plan });
    else {
      console.log(`Collection plan written: ${output}`);
      console.log(`Mode: ${plan.mode}; weeks: ${plan.weekAnchors.join(', ')}; accounts: ${plan.accounts.length}; categories: ${plan.categories.length}`);
      console.log(`Review the plan, then run: amdc collect run "${output}" --yes`);
    }
    return;
  }
  if (subcommand === 'run') {
    const options = parseOptions(args, ['yes']);
    if (options._.length !== 1) throw new UsageError('collect run requires exactly one plan path');
    if (!options.yes) throw new UsageError('collect run requires --yes because it starts a real collection');
    const { path: planPath, plan } = readCollectionPlan(options._[0]);
    const projectDir = resolveProjectDir();
    await requireOwnedDashboard(projectDir);
    const response = await httpRequest('POST', `/api/run/start?${collectionPlanQuery(plan)}`, {
      timeout: 180000,
      headers: cliApiHeaders(projectDir),
    });
    const result = { ...response.body, planPath, httpStatus: response.status };
    if (!result.ok) throw new CheckError(result.error || `dashboard returned HTTP ${response.status}`, result);
    if (CLI_JSON) outputJson(result);
    else console.log(`Collection submitted: ${result.run && result.run.job && (result.run.job.batchId || result.run.job.historyId) || 'accepted'}`);
    return;
  }
  throw new UsageError('amdc collect requires: plan or run');
}

async function cmdRun(args) {
  const subcommand = args.shift();
  if (subcommand === 'status') {
    if (args.length > 1) throw new UsageError('run status [batch-id]');
    if (args[0] && args[0].startsWith('--')) throw new UsageError(`unknown option: ${args[0]}`);
    await requireOwnedDashboard();
    const run = await httpGet('/api/run');
    if (args[0] && (!run.job || run.job.batchId !== args[0])) {
      throw new CheckError(`batch is not the current or latest dashboard batch: ${args[0]}`);
    }
    if (CLI_JSON) outputJson({ ok: true, run });
    else console.log(JSON.stringify(run, null, 2));
    return;
  }
  if (subcommand === 'wait') {
    const options = parseOptions(args, [], ['timeout-seconds']);
    if (options._.length !== 1) throw new UsageError('run wait <batch-id> [--timeout-seconds N]');
    const timeoutSeconds = Number(options['timeout-seconds'] || 43200);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1) throw new UsageError('--timeout-seconds must be a positive number');
    await requireOwnedDashboard();
    const deadline = Date.now() + timeoutSeconds * 1000;
    let run;
    while (Date.now() <= deadline) {
      run = await httpGet('/api/run');
      if (run.job && run.job.batchId === options._[0] && !run.active) break;
      await sleep(2000);
    }
    if (!run || !run.job || run.job.batchId !== options._[0] || run.active) throw new CheckError(`timed out waiting for batch ${options._[0]}`);
    const result = { ok: run.job.state === 'done', run };
    if (!result.ok) throw new CheckError(`batch finished with state ${run.job.state}`, result);
    if (CLI_JSON) outputJson(result);
    else console.log(JSON.stringify(run, null, 2));
    return;
  }
  throw new UsageError('amdc run requires: status or wait');
}

async function cmdHistory(args) {
  const subcommand = args.shift();
  if (subcommand !== 'list' || args.length) throw new UsageError('amdc history list [--json]');
  await requireOwnedDashboard();
  const history = await httpGet('/api/history');
  if (CLI_JSON) outputJson(history);
  else {
    for (const record of history.records || []) {
      console.log([record.id, record.weekAnchor || '-', record.status || '-', record.source || '-', record.feishuSync && record.feishuSync.status || 'unsynced'].join('\t'));
    }
  }
}

async function cmdSync(args) {
  const target = args.shift();
  if (target !== 'feishu') throw new UsageError('amdc sync feishu <history-id> --yes');
  const options = parseOptions(args, ['yes']);
  if (options._.length !== 1) throw new UsageError('sync feishu requires exactly one history id');
  if (!options.yes) throw new UsageError('sync feishu requires --yes because it writes to Feishu');
  await requireOwnedDashboard();
  const id = encodeURIComponent(options._[0]);
  const projectDir = resolveProjectDir();
  const response = await httpRequest('POST', `/api/history/${id}/sync-feishu`, {
    timeout: 900000,
    headers: cliApiHeaders(projectDir),
  });
  const result = { ...response.body, httpStatus: response.status };
  if (!result.ok) throw new CheckError(result.error || `dashboard returned HTTP ${response.status}`, result);
  if (CLI_JSON) outputJson(result);
  else console.log(`Feishu sync completed: ${options._[0]}`);
}

function getUrls() {
  const urls = [`http://127.0.0.1:${DASHBOARD_PORT}`];
  // WSL2 环境下额外返回 WSL IP
  try {
    if (!process.env.WSL_DISTRO_NAME && !fs.existsSync('/proc/sys/fs/binfmt_misc/WSL')) {
      // 检查 /proc/version 是否含 Microsoft/WSL
      const pv = fs.readFileSync('/proc/version', 'utf-8');
      if (!/(microsoft|wsl)/i.test(pv)) return urls;
    }
    const ip = execSync("hostname -I 2>/dev/null | awk '{print $1}'", { encoding: 'utf-8', timeout: 3000 }).trim();
    if (ip) urls.push(`http://${ip}:${DASHBOARD_PORT}`);
  } catch {}
  return urls;
}

async function cmdSchedule(sub, args = []) {
  const projectDir = resolveProjectDir();
  const scheduleDir = path.join(APP_ROOT, 'schedules');

  if (sub === 'doctor') {
    if (args.length) throw new UsageError(`unexpected schedule doctor argument: ${args[0]}`);
    if (process.platform !== 'win32') throw new CheckError('schedule doctor currently supports Windows Task Scheduler only');
    const script = path.join(scheduleDir, 'register-windows-tasks.ps1');
    const commandArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, '-ProjectDir', projectDir, '-CheckOnly'];
    if (CLI_JSON) commandArgs.push('-Json');
    const ps = powershellRuntime();
    if (!ps) throw new CheckError('PowerShell 7 or Windows PowerShell 5.1 is required for schedule doctor');
    const result = spawnSync(ps.command, commandArgs, { encoding: 'utf-8', windowsHide: true });
    if (CLI_JSON) {
      let report = null;
      try { report = JSON.parse(String(result.stdout || '').trim()); } catch {}
      if (result.status !== 0) throw new CheckError('schedule doctor found invalid task configuration or a failed last run', report || { stderr: String(result.stderr || '').trim() });
      outputJson(report);
    } else {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.status !== 0) throw new CheckError(`schedule doctor failed with exit code ${result.status == null ? 1 : result.status}`);
    }
  } else if (sub === 'install') {
    const options = parseOptions(args, ['yes']);
    if (options._.length) throw new UsageError(`unexpected schedule install argument: ${options._[0]}`);
    if (!options.yes) throw new UsageError('schedule install requires --yes because it changes Windows scheduled tasks');
    if (process.platform !== 'win32') throw new CheckError('schedule install currently supports Windows Task Scheduler only');
    const script = path.join(scheduleDir, 'register-windows-tasks.ps1');
    const commandArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, '-ProjectDir', projectDir];
    if (CLI_JSON) commandArgs.push('-Json');
    const ps = powershellRuntime();
    if (!ps) throw new CheckError('PowerShell 7 or Windows PowerShell 5.1 is required for schedule install');
    const result = spawnSync(ps.command, commandArgs, { encoding: 'utf-8', windowsHide: true, stdio: CLI_JSON ? 'pipe' : 'inherit' });
    if (CLI_JSON) {
      let report = null;
      try { report = JSON.parse(String(result.stdout || '').trim()); } catch {}
      if (result.status !== 0) throw new CheckError('schedule install failed; run PowerShell as administrator and retry', report || { stderr: String(result.stderr || '').trim() });
      outputJson(report);
    } else if (result.status !== 0) {
      throw new CheckError('schedule install failed; run PowerShell as administrator and retry');
    }
  } else if (sub === 'init') {
    if (args.length) throw new UsageError(`unexpected schedule init argument: ${args[0]}`);
    if (process.platform === 'win32') {
      const xmlPath = path.join(scheduleDir, 'weekly-run.xml');
      const installScript = path.join(scheduleDir, 'register-windows-tasks.ps1');
      const result = {
        ok: true,
        platform: 'windows',
        templates: [xmlPath, path.join(scheduleDir, 'account-sync.xml')],
        installScript,
        projectDir,
        requiresAdministrator: true,
        minimumPowerShellVersion: '5.1',
        prefersPowerShell7: true,
      };
      if (CLI_JSON) outputJson(result);
      else {
        console.log('Windows Task Scheduler templates:');
        for (const template of result.templates) console.log(`  ${template}`);
        console.log('Install both tasks from an elevated PowerShell 7 session:');
        console.log(`  & "${installScript}" -ProjectDir "${projectDir}"`);
      }
    } else {
      const shPath = path.join(scheduleDir, 'weekly-run.sh');
      const result = { ok: true, platform: 'linux', template: shPath, cron: `0 9 * * 1 ${shPath}` };
      if (CLI_JSON) outputJson(result);
      else {
        console.log('📅 Linux cron 模板:');
        console.log(`   ${shPath}`);
        console.log('\n   示例 crontab (每周一 09:00):');
        console.log(`   ${result.cron}`);
        console.log('\n   安装:');
        console.log(`   (crontab -l; echo "${result.cron}") | crontab -`);
      }
    }
  } else if (sub === 'remove') {
    if (args.length) throw new UsageError(`unexpected schedule remove argument: ${args[0]}`);
    const result = process.platform === 'win32'
      ? { ok: true, platform: 'windows', commands: ['schtasks /delete /tn "AMDC Account Sync" /f', 'schtasks /delete /tn "AMDC Weekly" /f'] }
      : { ok: true, platform: 'linux', command: 'crontab -l | grep -v amdc-weekly | crontab -' };
    if (CLI_JSON) {
      outputJson(result);
      return;
    }
    if (process.platform === 'win32') {
      for (const command of result.commands) console.log(`运行: ${command}`);
    } else {
      console.log(`运行: ${result.command}`);
    }
  } else {
    throw new UsageError('amdc schedule requires: doctor, install, init, or remove');
  }
}

async function cmdConfigShow(options = {}) {
  const projectDir = resolveProjectDir();
  const cfg = loadConfig(projectDir);
  const integrations = cfg.integrations && typeof cfg.integrations === 'object' ? cfg.integrations : {};
  const result = redactSecrets({
    projectDir,
    accounts: cfg.accounts || '(自动发现)',
    topDepth: process.env.TOP_DEPTH || cfg.topDepth || 100,
    maxWorkers: process.env.AMDC_MAX_WORKERS || cfg.maxWorkers || cfg.maxAccounts || 20,
    dcGapMs: process.env.DC_GAP_MS || cfg.dcGapMs || 500,
    dcCooldownMs: process.env.DC_COOLDOWN_MS || cfg.dcCooldownMs || 120000,
    leaderboardWeekConcurrency: process.env.LEADERBOARD_WEEK_CONCURRENCY || cfg.leaderboardWeekConcurrency || 3,
    authCheckConcurrency: process.env.AUTH_CHECK_CONCURRENCY || cfg.authCheckConcurrency || cfg.maxAccounts || 20,
    authProbeTimeoutMs: process.env.AUTH_PROBE_TIMEOUT_MS || cfg.authProbeTimeoutMs || 8000,
    authCheckCooldownHours: process.env.AUTH_CHECK_COOLDOWN_HOURS || cfg.authCheckCooldownHours || 6,
    skipExcel: cfg.skipExcel || false,
    integrations: {
      feishuSheetConfigured: !!(process.env.AMDC_FEISHU_SHEET_URL || integrations.feishuSheetUrl),
      accountRepositoryConfigured: !!(process.env.AMDC_ACCOUNT_REPOSITORY_URL || integrations.accountRepositoryUrl),
    },
    notifications: cfg.notifications || {},
    schedule: cfg.schedule || {},
  });
  if (!options.json) console.log('📋 当前配置合并 (env vars > config file > defaults):\n');
  outputJson(result);
  return result;
}

// ── 帮助 ──

async function cmdUpdate() {
  let projectDir = resolveProjectDir();

  // 如果当前目录没有 am.js，尝试通过 npm link 找到真正的项目目录
  if (!fs.existsSync(path.join(projectDir, 'am.js'))) {
    try {
      const amLink = fs.realpathSync('/proc/self/exe');
      // 从 npm global link 解析：~/.npm-global/lib/node_modules/amdc/am.js
      const npmGlobal = path.resolve(process.env.HOME || '~', '.npm-global/lib/node_modules/amdc');
      if (fs.existsSync(npmGlobal)) {
        projectDir = fs.realpathSync(npmGlobal);
        console.log('📍 自动定位 AMDC 项目:', projectDir, '\n');
      }
    } catch {}
    // Windows npm link fallback
    if (!fs.existsSync(path.join(projectDir, 'am.js'))) {
      try {
        const globalMod = execSync('npm root -g', { encoding: 'utf-8', timeout: 5000 }).trim();
        const candidate = path.join(globalMod, 'amdc');
        if (fs.existsSync(candidate)) {
          projectDir = fs.realpathSync(candidate);
          console.log('📍 自动定位 AMDC 项目:', projectDir, '\n');
        }
      } catch {}
    }
  }

  const repoRoot = resolveRepositoryRoot(projectDir);
  if (!repoRoot || !fs.existsSync(path.join(repoRoot, 'package.json'))) {
    console.error('❌ 无法找到 AMTools 独立仓库（当前:', resolveProjectDir(), '）');
    console.error('   请进入 AMTools 仓库后重试，或: git clone https://gitee.com/Hawkiethehawk/AMTools.git');
    process.exit(1);
  }

  console.log('🔄 从 AMTools 独立仓库拉取最新版本...\n');

  // 0. 暂存本地修改，避免冲突
  let stashed = false;
  try {
    const status = execSync('git status --porcelain', { cwd: repoRoot, encoding: 'utf-8', timeout: 10000 });
    if (status.trim()) {
      console.log('📋 暂存本地修改...');
      // Include untracked files as well. Otherwise git reports success while
      // creating no stash when the worktree only contains new files.
      const stashOutput = execSync('git stash push -u -m "amdc update auto stash"', { cwd: repoRoot, encoding: 'utf-8', timeout: 10000 });
      stashed = !/No local changes to save/i.test(stashOutput);
    }
  } catch (e) { /* 非致命 */ }

  // 1. git pull
  let pullOutput = '';
  try {
    pullOutput = execSync('git pull --rebase', { cwd: repoRoot, encoding: 'utf-8', timeout: 30000 }).trim();
    console.log(pullOutput);
  } catch (e) {
    console.error('❌ git pull 失败:', (e.stderr || e.message).replace(/\n/g, '\n   '));
    if (stashed) {
      console.log('📋 恢复本地修改...');
      try { execSync('git stash pop', { cwd: repoRoot, encoding: 'utf-8', timeout: 10000 }); } catch {}
    }
    console.error('   请检查网络或手动: cd', projectDir, '&& git pull');
    process.exit(1);
  }

  // 2. 恢复本地修改（可能有冲突，不强制）
  if (stashed) {
    try {
      execSync('git stash pop', { cwd: repoRoot, encoding: 'utf-8', timeout: 10000 });
      console.log('📋 本地修改已恢复（如有冲突请手动处理）');
    } catch {
      console.log('⚠️  本地修改恢复失败（可能有冲突），请手动: git stash pop');
      console.log('\n⚠️  更新完成但未自动重启，请先处理冲突。项目目录:', projectDir);
      return;
    }
  }

  // 3. Install dependencies only when the pulled revision changed manifests.
  let changedFiles = '';
  try {
    changedFiles = execSync('git diff --name-only HEAD@{1} HEAD', {
      cwd: repoRoot,
      encoding: 'utf-8',
      timeout: 10000,
    });
  } catch {}
  if (/package\.json|package-lock\.json/.test(changedFiles)) {
    console.log('📦 package.json 有变更，安装依赖...');
    try {
      execSync('npm install', { cwd: repoRoot, stdio: 'inherit', timeout: 60000 });
      execSync('npm install', { cwd: projectDir, stdio: 'inherit', timeout: 60000 });
    } catch (e) {
      console.error('⚠️  npm install 失败，请手动执行');
    }
  }

  console.log('\n✅ 更新完成！项目目录:', projectDir);
  console.log('🔁 正在重启看板以应用最新版本...');
  await cmdRestart(projectDir);
}

function showHelp() {
  console.log(`
AMDC - manual-first CLI with stable AI automation commands

用法: amdc <command> [options]

命令:
  setup             安装依赖 + 生成默认配置
  doctor [--json]   检查本机运行环境与项目归属
  status [--json]   先检查登录状态，再显示所有 profile + 邮箱
  login [profile]   打开浏览器登录指定 profile（默认 .amdc-userdata）
  check [--json]    仅运行 auth check，输出每账号 OK/FAIL
  start             启动本机网页看板；采集、账号选择、Fresh/ListOnly/TopDepth/WeekAnchor 均在看板操作
  export            仅导出 Excel（需已有 JSON 数据）
  tags update       更新 tag 字典
  stop              关闭进度看板
  restart           重启进度看板
  collect plan      生成需审查的采集计划，不启动采集
  collect run       使用已签名计划启动采集，必须显式传入 --yes
  run status        读取当前或最近批次状态
  run wait          等待指定批次结束
  history list      列出历史采集记录
  sync feishu       同步一条历史记录到飞书，必须显式传入 --yes
  schedule doctor   检查 Windows 任务、PS7 路径和最近执行结果
  schedule install  注册 Windows 任务，必须显式传入 --yes
  schedule init     显示调度任务模板与安装方法
  schedule remove   移除调度任务
  config show       显示当前合并后的配置
  update            从 gitee 拉取最新版本、安装依赖并重启看板

配置文件: <project-dir>/amdc-config.json
机器接口可把 --json 放在命令任意位置。真实采集和飞书同步需要 --yes。
`);
}

function helpResult() {
  return {
    ok: true,
    name: 'amdc',
    description: 'manual-first CLI with stable AI automation commands',
    commands: [
      'setup', 'doctor', 'status', 'login', 'check', 'start', 'dashboard', 'export',
      'tags update', 'stop', 'restart', 'collect plan', 'collect run', 'run status',
      'run wait', 'history list', 'sync feishu', 'schedule doctor', 'schedule install',
      'schedule init', 'schedule remove', 'config show', 'update',
    ],
    exitCodes: { ok: 0, runtime: 1, usage: 2, check: 3 },
  };
}

// ── 主入口 ──

async function main() {
  const rawArgs = process.argv.slice(2);
  CLI_JSON = rawArgs.includes('--json');
  const args = rawArgs.filter(value => value !== '--json');
  const projectIndexes = args.reduce((indexes, value, index) => value === '--project-dir' ? indexes.concat(index) : indexes, []);
  if (projectIndexes.length > 1) throw new UsageError('--project-dir may only be specified once');
  const projectIndex = projectIndexes.length ? projectIndexes[0] : -1;
  if (projectIndex >= 0) {
    if (!args[projectIndex + 1] || args[projectIndex + 1].startsWith('--')) throw new UsageError('--project-dir requires a value');
    CLI_PROJECT_DIR = args[projectIndex + 1];
    args.splice(projectIndex, 2);
  }
  const cmd = args[0];

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    if (args.length > 1) throw new UsageError('amdc help [--json]');
    if (CLI_JSON) outputJson(helpResult());
    else showHelp();
    return;
  }

  const jsonCommands = new Set(['doctor', 'status', 'check', 'collect', 'run', 'history', 'sync', 'schedule', 'config']);
  if (CLI_JSON && !jsonCommands.has(cmd)) throw new UsageError(`--json is not supported by ${cmd}`);

  switch (cmd) {
    case 'setup':
      if (args.length !== 1) throw new UsageError('amdc setup');
      await cmdSetup();
      break;
    case 'doctor': {
      if (args.length !== 1) throw new UsageError('amdc doctor [--json]');
      const result = await cmdDoctor({ json: CLI_JSON });
      if (!result.ok) process.exitCode = 3;
      break;
    }
    case 'status':
      if (args.length !== 1) throw new UsageError('amdc status [--json]');
      {
        const result = await cmdStatus({ json: CLI_JSON });
        if (!result.ok) process.exitCode = 3;
      }
      break;
    case 'login':
      if (args.length > 2) throw new UsageError('amdc login [profile]');
      await cmdLogin(args[1]);
      break;
    case 'check': {
      if (args.length !== 1) throw new UsageError('amdc check [--json]');
      const result = await cmdCheck(undefined, { silent: CLI_JSON });
      if (CLI_JSON) outputJson({ ok: result.code === 0, accounts: result.accounts, summary: result.summary });
      process.exitCode = result.code === 0 ? 0 : 3;
      break;
    }
    case 'export':
      if (args.length !== 1) throw new UsageError('amdc export');
      await cmdExport();
      break;
    case 'tags':
      if (args[1] === 'update' && args.length === 2) await cmdTagsUpdate();
      else throw new UsageError('amdc tags update');
      break;
    case 'start':
    case 'dashboard':
      if (args.length !== 1) throw new UsageError(`amdc ${cmd}`);
      await cmdStart();
      break;
    case 'stop':
      if (args.length !== 1) throw new UsageError('amdc stop');
      await cmdStop();
      break;
    case 'restart':
      if (args.length !== 1) throw new UsageError('amdc restart');
      await cmdRestart();
      break;
    case 'collect':
      await cmdCollect(args.slice(1));
      break;
    case 'run':
      await cmdRun(args.slice(1));
      break;
    case 'history':
      await cmdHistory(args.slice(1));
      break;
    case 'sync':
      await cmdSync(args.slice(1));
      break;
    case 'schedule':
      await cmdSchedule(args[1], args.slice(2));
      break;
    case 'config':
      if (args[1] === 'show' && args.length === 2) await cmdConfigShow({ json: CLI_JSON });
      else throw new UsageError('amdc config show [--json]');
      break;
    case 'update':
      if (args.length !== 1) throw new UsageError('amdc update');
      await cmdUpdate();
      break;
    default:
      throw new UsageError(`unknown command: ${cmd}`);
  }
}

main().catch(err => {
  if (CLI_JSON) {
    const code = err && err.code === 'USAGE' ? 'USAGE' : err && err.code === 'CHECK' ? 'CHECK' : 'RUNTIME';
    outputJson({
      ok: false,
      error: { code, message: err && err.message ? err.message : String(err) },
      ...(err && err.details !== undefined ? { details: err.details } : {}),
    });
    process.exitCode = code === 'USAGE' ? 2 : code === 'CHECK' ? 3 : 1;
    return;
  }
  if (err && err.code === 'USAGE') {
    console.error(`用法错误: ${err.message}`);
    process.exitCode = 2;
    return;
  }
  if (err && err.code === 'CHECK') {
    console.error(`检查失败: ${err.message}`);
    process.exitCode = 3;
    return;
  }
  console.error('Fatal:', err.message);
  process.exit(1);
});
