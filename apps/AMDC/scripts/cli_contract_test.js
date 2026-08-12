#!/usr/bin/env node
// @ts-check
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amdc-cli-contract-'));
const cli = path.resolve(__dirname, '..', 'am.js');
const profile = '.amdc-userdata';
const planPath = path.join(projectDir, 'plans', 'collection.json');
const unusedPort = String(21000 + Math.floor(Math.random() * 1000));

function run(args) {
  return spawnSync(process.execPath, [cli, '--project-dir', projectDir, ...args], {
    cwd: projectDir,
    encoding: 'utf8',
    env: { ...process.env, AMDC_PORT: unusedPort },
    windowsHide: true,
  });
}

function parseJson(result) {
  assert.strictEqual(result.stderr, '');
  return JSON.parse(result.stdout);
}

try {
  fs.mkdirSync(path.join(projectDir, profile), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'amdc-config.json'), JSON.stringify({
    accounts: profile,
    topDepth: 100,
    cli: { apiToken: 'a'.repeat(48) },
    integrations: {
      feishuSheetUrl: 'https://example.invalid/private-sheet',
      accountRepositoryUrl: 'https://example.invalid/private-account-repository.git',
    },
  }, null, 2));

  let result = run(['--json', 'help']);
  assert.strictEqual(result.status, 0);
  const help = parseJson(result);
  assert.strictEqual(help.name, 'amdc');
  assert.strictEqual(help.exitCodes.check, 3);

  result = run([
    '--json',
    'collect', 'plan',
    '--week', '2026-07-27',
    '--account', profile,
    '--category', '休闲',
    '--top-depth', '100',
    '--output', planPath,
  ]);
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  const created = parseJson(result);
  assert.strictEqual(created.ok, true);
  assert.strictEqual(created.planPath, planPath);
  assert.strictEqual(created.plan.source, 'ai');
  assert.strictEqual(created.plan.requiresConfirmation, true);
  assert.strictEqual(created.plan.signature.length, 64);
  assert.deepStrictEqual(created.plan.weekAnchors, ['2026-07-27']);
  assert.deepStrictEqual(created.plan.categories, ['休闲']);

  result = run([
    '--json',
    'collect', 'plan',
    '--week', '2026-07-27',
    '--account', '.amdc-userdata-u',
  ]);
  assert.strictEqual(result.status, 2);
  let failure = parseJson(result);
  assert.strictEqual(failure.error.code, 'USAGE');
  assert.match(failure.error.message, /managed A-T pool/);

  result = run(['--json', 'collect', 'run', planPath]);
  assert.strictEqual(result.status, 2);
  failure = parseJson(result);
  assert.strictEqual(failure.error.code, 'USAGE');
  assert.match(failure.error.message, /--yes/);

  result = run(['--json', 'collect', 'run', planPath, '--yes']);
  assert.strictEqual(result.status, 3);
  failure = parseJson(result);
  assert.strictEqual(failure.error.code, 'CHECK');
  assert.match(failure.error.message, /dashboard is not running/);

  const tampered = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  tampered.topDepth = 1000;
  fs.writeFileSync(planPath, JSON.stringify(tampered, null, 2));
  result = run(['--json', 'collect', 'run', planPath, '--yes']);
  assert.strictEqual(result.status, 2);
  failure = parseJson(result);
  assert.strictEqual(failure.error.code, 'USAGE');
  assert.match(failure.error.message, /signature/);

  result = run(['--json', 'collect', 'plan', '--week', '2026-07-27', '--unexpected', 'value']);
  assert.strictEqual(result.status, 2);
  failure = parseJson(result);
  assert.match(failure.error.message, /unknown option/);

  result = run(['--json', 'check']);
  assert.strictEqual(result.status, 3, result.stderr || result.stdout);
  const check = parseJson(result);
  assert.strictEqual(check.ok, false);

  result = run(['--json', 'config', 'show']);
  assert.strictEqual(result.status, 0);
  const config = parseJson(result);
  assert.strictEqual(config.projectDir, projectDir);
  assert.strictEqual(config.schedule.apiToken, undefined);
  assert.deepStrictEqual(config.integrations, {
    feishuSheetConfigured: true,
    accountRepositoryConfigured: true,
  });
  assert.strictEqual(result.stdout.includes('example.invalid'), false);

  result = run(['--json', 'schedule', 'init']);
  assert.strictEqual(result.status, 0);
  const schedule = parseJson(result);
  assert.strictEqual(schedule.ok, true);
  assert.ok(schedule.platform);

  console.log('AMDC CLI contract ok');
} finally {
  fs.rmSync(projectDir, { recursive: true, force: true });
}
