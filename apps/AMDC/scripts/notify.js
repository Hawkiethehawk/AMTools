#!/usr/bin/env node
// @ts-check
// AMDC 通知与报告模块：生成 SUMMARY.md + 可选 webhook 通知
// 用法: node scripts/notify.js <runDir> [--event success|failure|auth_expired] [--config <configFile>]

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const RUN_DIR = process.argv[2] || '';
const EVENT = (() => {
  const i = process.argv.indexOf('--event');
  return i >= 0 ? (process.argv[i + 1] || 'success') : 'success';
})();
const CONFIG_FILE = (() => {
  const i = process.argv.indexOf('--config');
  return i >= 0 ? process.argv[i + 1] : '';
})();
const DURATION_MS = (() => {
  const i = process.argv.indexOf('--duration-ms');
  if (i < 0) return null;
  const value = Number(process.argv[i + 1]);
  return Number.isFinite(value) && value >= 0 ? value : null;
})();

const EVENT_META = {
  auth_checked: { key: 'onAuthChecked', title: '登录态检查通过', message: '账号登录态检查已完成。' },
  collection_started: { key: 'onCollectionStarted', title: '开始采集', message: '开始采集上周七品类数据。' },
  week_complete: { key: 'onWeekComplete', title: '本周采集完成', message: '本采集周的七品类数据已完成。' },
  collection_complete: { key: 'onCollectionComplete', title: '全部采集完成', message: '全部采集周的数据已完成。' },
  feishu_sync_started: { key: 'onFeishuSyncStarted', title: '开始飞书同步', message: '开始同步到飞书电子表格。' },
  feishu_sync_complete: { key: 'onFeishuSyncComplete', title: '飞书同步完成', message: '飞书电子表格同步及回读校验已完成。' },
  amda_update_started: { key: 'onAmdaUpdateStarted', title: '更新开始', message: '定时 AMDC 批次已完成，开始生成 AMDA Demo 草稿。' },
  amda_update_pending: { key: 'onAmdaUpdatePending', title: '更新需处理', message: 'AMDA Demo 更新需要处理，请查看本机 AMDC 日志。' },
  amda_update_complete: { key: 'onAmdaUpdateComplete', title: '更新完成', message: '定时 AMDC 批次已完成，AMDA Demo 已更新并通过回读及渲染校验。' },
  amda_update_failed: { key: 'onAmdaUpdateFailed', title: '更新失败', message: 'AMDA Demo 更新未完成，请查看本机 AMDC 日志。' },
};

// ── 错误消息映射 ──
const ERROR_MAP = [
  { pattern: /FAIL\s+(\S+)/, cn: (m) => `账号 ${m[1]} 登录已过期，请运行 amdc login 重新登录` },
  { pattern: /榜单深度\s*(\d+)\s*不可用/, cn: (m) => `当前账号没有 Top${m[1]} 权限，请在配置中将 topDepth 改为 100，或更换有权限的账号` },
  { pattern: /No valid account token/, cn: () => '所有账号 token 均已失效，请至少登录一个账号' },
  { pattern: /429/, cn: () => 'API 请求被限流（429），已自动冷却等待。可增大 dcCooldownMs 或减少 maxWorkers' },
  { pattern: /榜单为空/, cn: () => '榜单返回空数据，可能是 tag 参数无效或该周无数据' },
  { pattern: /榜单请求失败/, cn: () => '榜单请求失败，请检查网络连接和 API 权限' },
  { pattern: /cannot find module|ENOENT/, cn: () => '缺少依赖，请运行 amdc setup' },
];

function translateError(text) {
  for (const entry of ERROR_MAP) {
    if (entry.pattern.test(text)) {
      return entry.cn(text.match(entry.pattern));
    }
  }
  return text;
}

// ── 辅助函数 ──
function readJsonSafe(file) {
  try {
    const raw = fs.readFileSync(file, 'utf-8').replace(/^﻿/, '');
    return JSON.parse(raw);
  } catch {
    return null;
  }
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

function formatDuration(ms) {
  if (ms === undefined || ms === null || ms < 0) return '--';
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h${m % 60}m${s % 60}s`;
  if (m > 0) return `${m}m${s % 60}s`;
  return `${s}s`;
}

// ── 收集数据 ──
function collectSummary(runDir) {
  if (!runDir || !fs.existsSync(runDir)) {
    return { error: `输出目录不存在: ${runDir}` };
  }

  const progress = readJsonSafe(path.join(runDir, 'amdc-progress.json'));
  const runState = readJsonSafe(path.join(runDir, 'amdc-run-state.json'));

  const categories = [];
  const outputFiles = [];
  let weekAnchor = '';
  let topDepth = 100;
  let generatedAt = '';
  let usedCacheCount = 0;
  let totalCacheCount = 0;
  let hasErrors = false;
  const errors = [];
  const risks = [];

  for (const cat of CATS) {
    const jsonFile = path.join(runDir, `amdc-${cat}-weekly.json`);
    const data = readJsonSafe(jsonFile);
    if (!data) {
      // 检查有没有 error 状态
      const st = runState && runState[cat];
      if (st && st.status === 'error') {
        hasErrors = true;
        errors.push({ category: cat, error: translateError(st.error || '未知错误') });
        categories.push({ category: cat, rows: 0, focus: 0, missingCountry: 0, error: st.error });
      }
      continue;
    }

    weekAnchor = weekAnchor || (data.weeks || [])[0] || '';
    topDepth = data.topDepth || topDepth;
    generatedAt = generatedAt || data.generatedAt || '';

    const records = data.records || [];
    const focus = data.focus || [];
    const missingCountry = focus.filter(r => !r.country).length;

    // 检查缓存使用
    const st = runState && runState[cat];
    if (st && st.cache && st.cache.includes('缓存')) totalCacheCount++;
    if (st && st.cache && st.cache.includes('榜单缓存')) usedCacheCount++;

    categories.push({
      category: cat,
      rows: records.length,
      focus: focus.length,
      missingCountry,
    });

  }

  // 唯一交付 Excel
  const mon = weekAnchor.replace(/-/g, '');
  const projectDir = path.resolve(process.env.AMDC_PROJECT_DIR || path.join(runDir, '..', '..'));
  const mergedXlsx = path.join(projectDir, 'output', `AMDC-${mon}.xlsx`);
  if (fs.existsSync(mergedXlsx)) {
    outputFiles.push(mergedXlsx);
  }

  // 自检结果
  const meta = runState && runState._meta;
  const selfCheck = meta && meta.selfCheck;
  if (selfCheck) {
    for (const [cat, result] of Object.entries(selfCheck)) {
      if (result && !result.ok) {
        risks.push(`${cat}: 自检失败 — ${(result.issues || []).join('; ')}`);
      }
      if (result && result.warnings && result.warnings.length) {
        for (const w of result.warnings) {
          risks.push(`${cat}: ${w}`);
        }
      }
    }
  }

  // 缺国别风险
  for (const c of categories) {
    if (c.missingCountry > 0) {
      risks.push(`${c.category}: ${c.missingCountry} 个焦点应用缺国别数据`);
    }
  }

  // 账号信息
  const tokenDirs = (meta && meta.tokenDirs) || [];
  const poolSize = (progress && progress.poolSize) || tokenDirs.length;

  return {
    weekAnchor,
    topDepth,
    generatedAt,
    categories,
    outputFiles,
    usedCacheCount,
    totalCacheCount,
    poolSize,
    tokenDirs,
    errors,
    risks,
    hasErrors,
    runElapsed: (progress && progress.runElapsed) || 0,
    events: (meta && meta.events) || [],
  };
}

// ── 生成 SUMMARY.md ──
function generateMarkdown(summary) {
  if (summary.error) return `# AMDC 周报 · 错误\n\n${summary.error}\n`;

  const lines = [
    `# AMDC 周报 · ${summary.weekAnchor || '未知'}`,
    '',
    '## 概览',
    `- **API 周锚点**: ${summary.weekAnchor || '未提供'}`,
    `- **API 结束日期**: 响应未提供`,
    `- **采集深度**: Top${summary.topDepth}`,
    `- **账号数**: ${summary.poolSize}`,
    `- **账号列表**: ${summary.tokenDirs.join(', ') || '未知'}`,
    `- **缓存**: ${summary.usedCacheCount > 0 ? `榜单缓存复用 ${summary.usedCacheCount}/${summary.totalCacheCount || 6} 品类` : '全新拉取（未复用缓存）'}`,
    `- **耗时**: ${formatDuration(summary.runElapsed)}`,
    '',
    '## 品类汇总',
    '',
    '| 品类 | 榜单行数 | 焦点应用 | 缺国别 |',
    '|------|---------|---------|--------|',
  ];

  for (const c of summary.categories) {
    const status = c.error ? `⚠️ ${c.error}` : (c.missingCountry > 0 ? '⚠️' : '✅');
    lines.push(`| ${c.category} | ${c.rows} | ${c.focus} | ${c.missingCountry || 0} ${status} |`);
  }

  lines.push('');
  lines.push('## 输出文件');
  lines.push('');
  for (const f of summary.outputFiles) {
    lines.push(`- \`${f}\``);
  }
  if (!summary.outputFiles.length) {
    lines.push('- (无)');
  }

  if (summary.errors.length) {
    lines.push('');
    lines.push('## 错误');
    for (const e of summary.errors) {
      lines.push(`- **${e.category}**: ${e.error}`);
    }
  }

  if (summary.risks.length) {
    lines.push('');
    lines.push('## 风险与警告');
    for (const r of summary.risks) {
      lines.push(`- ${r}`);
    }
  }

  if (!summary.errors.length && !summary.risks.length) {
    lines.push('');
    lines.push('## 风险');
    lines.push('');
    lines.push('- 无');
  }

  return lines.join('\n') + '\n';
}

// ── Webhook 通知 ──
async function sendWebhook(url, payload) {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return r.ok;
  } catch (error) {
    console.error(`[notify] webhook failed: ${error.message}`);
    return false;
  }
}

function buildWebhookPayload(event, summary, fullPath) {
  return {
    event,
    weekAnchor: summary.weekAnchor,
    totalFocus: summary.categories.reduce((s, c) => s + c.focus, 0),
    outputDir: path.basename(fullPath),
    outputPath: fullPath,
    duration: formatDuration(summary.runElapsed),
    hasErrors: summary.hasErrors,
    errors: summary.errors.map(e => `${e.category}: ${e.error}`),
    risks: summary.risks,
    timestamp: new Date().toISOString(),
  };
}

async function sendNtfy(config, event, summary, fullPath) {
  const baseUrl = String(config.url || '').replace(/\/+$/, '');
  const topic = String(config.topic || '');
  if (!baseUrl || !topic) return false;

  const outputFiles = Array.isArray(summary.outputFiles) ? summary.outputFiles : [];
  const stage = EVENT_META[event];
  const failed = event === 'failure' || event === 'auth_expired' || event === 'amda_update_failed' || (!stage && (summary.hasErrors || summary.error));
  const titlePrefix = event.startsWith('amda_') ? 'AMDA' : 'AMDC';
  const title = `${titlePrefix} ${stage ? stage.title : (failed ? '任务失败' : '任务完成')} · ${summary.weekAnchor || '未知采集周'}`;
  const lines = [
    stage ? stage.message : (failed ? '采集或飞书同步未完成。' : '七品类采集与飞书同步已完成。'),
  ];
  if (stage) {
    lines.push(`阶段耗时：${formatDuration(DURATION_MS === null ? 0 : DURATION_MS)}`);
  } else {
    lines.push(`耗时：${formatDuration(summary.runElapsed)}`);
  }
  if (outputFiles.length && (event === 'feishu_sync_complete' || event === 'success')) {
    lines.push(`文件：${outputFiles[0]}`);
  }

  const args = [
    '--silent', '--show-error', '--fail-with-body', '--output', 'NUL',
    '--header', 'Content-Type: text/plain; charset=utf-8',
    '--data-binary', lines.join('\n'),
  ];
  if (config.token) args.push('--header', `Authorization: Bearer ${config.token}`);
  if (!config.token && config.username && config.password) {
    args.push('--user', `${config.username}:${config.password}`);
  }
  args.push(`${baseUrl}/${encodeURIComponent(topic)}?title=${encodeURIComponent(title)}&priority=${failed ? 4 : 3}&tags=${failed ? 'warning' : 'chart_with_upwards_trend'}`);

  const result = cp.spawnSync('curl.exe', args, { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) {
    console.error(`[notify] ntfy failed: ${(result.error && result.error.message) || result.stderr || `curl exit ${result.status}`}`);
    return false;
  }
  return true;
}

// ── 主流程 ──
async function main() {
  const runDir = path.resolve(RUN_DIR);
  const summary = collectSummary(runDir);

  // 1. 总是生成 SUMMARY.md
  const summaryPath = path.join(runDir, 'SUMMARY.md');
  const md = generateMarkdown(summary);
  fs.writeFileSync(summaryPath, md, 'utf-8');
  console.log(`[notify] SUMMARY.md 已生成: ${summaryPath}`);

  // 2. 读取配置文件中的通知设置
  let notifications = {};
  if (CONFIG_FILE && fs.existsSync(CONFIG_FILE)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      notifications = cfg.notifications || {};
    } catch {}
  }

  // 3. 查找当前事件类型的通知配置
  const eventKey = EVENT_META[EVENT] ? EVENT_META[EVENT].key
    : (EVENT === 'auth_expired' ? 'onAuthExpired'
      : (EVENT === 'failure' || summary.hasErrors ? 'onFailure' : 'onComplete'));
  const notifyCfg = {
    ...(notifications.default || {}),
    ...(notifications[eventKey] || {}),
  };

  // 4. 发送通知（如配置）
  if (notifyCfg && notifyCfg.type === 'webhook' && notifyCfg.url) {
    const payload = buildWebhookPayload(EVENT, summary, runDir);
    const ok = await sendWebhook(notifyCfg.url, payload);
    if (ok) {
      console.log(`[notify] webhook 已发送: ${notifyCfg.url}`);
    } else {
      console.warn(`[notify] webhook 发送失败: ${notifyCfg.url}`);
    }
  }
  if (notifyCfg && notifyCfg.type === 'ntfy') {
    const ok = await sendNtfy(notifyCfg, EVENT, summary, runDir);
    if (ok) {
      console.log(`[notify] ntfy 已发送: ${notifyCfg.url}/${notifyCfg.topic}`);
    } else {
      console.warn(`[notify] ntfy 发送失败: ${notifyCfg.url}/${notifyCfg.topic || ''}`);
    }
  }

  // 5. 输出控制台摘要
  console.log('\n' + md);

  // 阶段通知可在采集尚未产生完整结果时发送，不能因中间状态导致投递进程报错。
  process.exit((!EVENT_META[EVENT] && summary.hasErrors) || EVENT === 'failure' || EVENT === 'auth_expired' ? 1 : 0);
}

main().catch(err => {
  console.error('[notify] fatal:', err.message);
  process.exit(1);
});
