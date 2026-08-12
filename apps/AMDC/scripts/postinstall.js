#!/usr/bin/env node
// Post-install checks for the standalone AMDC CLI.
// Account login is intentionally excluded.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const STRICT = process.env.AMDC_STRICT_POSTINSTALL === '1';
const SKIP = process.env.AMDC_SKIP_POSTINSTALL === '1';

function log(msg) { console.log(`[amdc] ${msg}`); }
function warn(msg) { console.warn(`[amdc] WARN: ${msg}`); }

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    cwd: opts.cwd || path.resolve(__dirname, '..'),
    env: process.env,
    stdio: opts.stdio || 'pipe',
    encoding: 'utf-8',
    shell: false,
  });
}

function failOrWarn(msg) {
  if (STRICT) {
    console.error(`[amdc] ERROR: ${msg}`);
    process.exitCode = 1;
  } else {
    warn(msg);
  }
}

function nodeMajor() {
  const m = /^v(\d+)/.exec(process.version);
  return m ? Number(m[1]) : 0;
}

function findPython() {
  const candidates = process.platform === 'win32'
    ? [
        ['py', ['-3']],
        ['python', []],
        ['python3', []],
      ]
    : [
        ['python3', []],
        ['python', []],
      ];
  for (const [cmd, prefix] of candidates) {
    const r = run(cmd, [...prefix, '--version']);
    if (r.status === 0) return { cmd, prefix, version: (r.stdout || r.stderr || '').trim() };
  }
  return null;
}

function pythonRun(py, code, stdio = 'pipe') {
  return run(py.cmd, [...py.prefix, '-c', code], { stdio });
}

function pythonModule(py, moduleName) {
  return pythonRun(py, `import ${moduleName}`).status === 0;
}

function installOpenpyxl(py) {
  log('openpyxl not found; installing with Python pip...');
  const r = run(py.cmd, [...py.prefix, '-m', 'pip', 'install', 'openpyxl'], { stdio: 'inherit' });
  if (r.status !== 0) failOrWarn('openpyxl install failed. Run: python -m pip install openpyxl');
}

function installChromium() {
  let cli;
  try {
    cli = require.resolve('@playwright/test/cli');
  } catch {
    failOrWarn('@playwright/test is not installed. Run: npm install');
    return;
  }
  log('checking Playwright Chromium...');
  const r = run(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit' });
  if (r.status !== 0) failOrWarn('Playwright Chromium install failed. Run: npx playwright install chromium');
}

function verifyBundledFonts() {
  const fontDir = path.join(__dirname, 'assets', 'fonts');
  const assets = [
    ['MiSans-Regular.woff2', 4_000_000],
    ['MiSans-Medium.woff2', 4_000_000],
    ['MiSans-Demibold.woff2', 4_000_000],
    ['MiSans-Bold.woff2', 4_000_000],
    ['MiSans-License.pdf', 50_000],
  ];
  const invalid = assets.filter(([name, minBytes]) => {
    try {
      return fs.statSync(path.join(fontDir, name)).size < minBytes;
    } catch {
      return true;
    }
  });
  if (invalid.length) {
    failOrWarn(`bundled MiSans assets are missing or incomplete: ${invalid.map(([name]) => name).join(', ')}`);
    return;
  }
  log('bundled MiSans web font ok');
}

function main() {
  if (SKIP) {
    log('postinstall skipped by AMDC_SKIP_POSTINSTALL=1');
    return;
  }

  log('checking standalone runtime prerequisites...');

  if (nodeMajor() < 18) {
    failOrWarn(`Node.js >=18 is required; current ${process.version}`);
    return;
  }
  log(`Node.js ${process.version} ok`);

  verifyBundledFonts();
  installChromium();

  const py = findPython();
  if (!py) {
    failOrWarn('Python not found. Excel export needs Python + openpyxl.');
    return;
  }
  log(`${py.version || 'Python'} ok`);

  if (pythonModule(py, 'openpyxl')) {
    log('openpyxl ok');
  } else {
    installOpenpyxl(py);
  }

  if (!process.exitCode) log('runtime prerequisite check complete');
}

main();
