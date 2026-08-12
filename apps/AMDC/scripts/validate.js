#!/usr/bin/env node
// @ts-check
// AMDC 结果验证模块 — 采集完成后自动运行
// 用法: node scripts/validate.js <runDir>
// 退出码: 0=通过, 1=有warnings, 2=有errors

const fs = require('fs');
const path = require('path');

const RUN_DIR = process.argv[2] || '';
const QUIET = process.argv.includes('--quiet');

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

function log(level, msg) {
  if (QUIET && level === 'info') return;
  const prefix = { error: '❌', warn: '⚠️', info: '  ', ok: '✅' }[level] || '  ';
  console.log(`${prefix} ${msg}`);
}

function readJsonSafe(file) {
  try {
    const raw = fs.readFileSync(file, 'utf-8').replace(/^﻿/, '');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function validate(runDir) {
  if (!runDir || !fs.existsSync(runDir)) {
    log('error', `输出目录不存在: ${runDir}`);
    return { errors: 1, warnings: 0 };
  }

  let errors = 0;
  let warnings = 0;
  const weeks = [];
  const results = [];

  // 1. JSON 完整性 + 周锚点一致性
  log('info', `验证目录: ${path.basename(runDir)}`);
  log('info', '---');

  for (const cat of CATS) {
    const jsonFile = path.join(runDir, `amdc-${cat}-weekly.json`);
    const data = readJsonSafe(jsonFile);

    if (!data) {
      errors++;
      log('error', `${cat}: JSON 缺失`);
      results.push({ category: cat, rows: 0, focus: 0, valid: false });
      continue;
    }

    const records = data.records || [];
    const focus = data.focus || [];
    const w = (data.weeks || [])[0];
    if (w) weeks.push(w);

    // 检查 records 和 focus
    if (!records.length) {
      errors++;
      log('error', `${cat}: records 为空`);
    }

    if (!focus.length) {
      warnings++;
      log('warn', `${cat}: focus 为空（无焦点应用）`);
    }

    // 检查国别覆盖率
    const missingCountry = focus.filter(r => !r.country).length;
    if (missingCountry > 0) {
      warnings++;
      log('warn', `${cat}: ${missingCountry}/${focus.length} 焦点应用缺国别数据`);
    }

    results.push({
      category: cat,
      rows: records.length,
      focus: focus.length,
      missingCountry,
      valid: records.length > 0,
    });

    log(records.length > 0 ? 'ok' : 'error',
      `${cat}: ${records.length} 行, ${focus.length} 焦点${missingCountry > 0 ? `, ${missingCountry} 缺国别` : ''}`);
  }

  // 2. 周锚点一致性
  const uniqueWeeks = [...new Set(weeks)];
  if (uniqueWeeks.length > 1) {
    errors++;
    log('error', `周锚点不一致: ${uniqueWeeks.join(', ')}`);
  } else if (uniqueWeeks.length === 1) {
    log('ok', `周锚点一致: ${uniqueWeeks[0]}`);
  }

  // 3. 唯一交付 Excel 存在性
  log('info', '---');
  const mon = (uniqueWeeks[0] || '').replace(/-/g, '');
  const projectDir = path.resolve(process.env.AMDC_PROJECT_DIR || path.join(runDir, '..', '..'));
  const mergedXlsx = path.join(projectDir, 'output', `AMDC-${mon}.xlsx`);
  if (fs.existsSync(mergedXlsx)) {
    log('ok', `唯一 Excel: ${mergedXlsx}`);
  } else {
    warnings++;
    log('warn', `唯一 Excel 缺失: ${mergedXlsx}`);
  }

  // 4. 自检结果
  log('info', '---');
  const runState = readJsonSafe(path.join(runDir, 'amdc-run-state.json'));
  const selfCheck = runState && runState._meta && runState._meta.selfCheck;
  if (selfCheck) {
    for (const [cat, result] of Object.entries(selfCheck)) {
      if (!result || typeof result !== 'object') continue;
      if (!result.ok) {
        errors++;
        log('error', `${cat} 自检失败: ${(result.issues || []).join('; ')}`);
      }
      if (result.warnings && result.warnings.length) {
        for (const w of result.warnings) {
          warnings++;
          log('warn', `${cat}: ${w}`);
        }
      }
    }
  }

  // 5. 汇总
  log('info', '---');
  const validCount = results.filter(r => r.valid).length;
  log('info', `品类完成: ${validCount}/${CATS.length}`);
  if (errors > 0) {
    log('error', `${errors} 个错误, ${warnings} 个警告`);
  } else if (warnings > 0) {
    log('warn', `${warnings} 个警告`);
  } else {
    log('ok', '全部通过');
  }

  return { errors, warnings };
}

function main() {
  const runDir = path.resolve(RUN_DIR);
  const { errors, warnings } = validate(runDir);

  if (errors > 0) process.exit(2);
  if (warnings > 0) process.exit(1);
  process.exit(0);
}

if (require.main === module) {
  main();
}
