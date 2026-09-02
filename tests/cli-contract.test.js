const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'amtools.js');

function run(args, options = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    ...options,
    env: { ...process.env, ...(options.env || {}) },
  });
}

let result = run(['--help']);
assert.strictEqual(result.status, 0);
assert.match(result.stdout, /\bdoctor\b/);

result = run(['--version']);
assert.strictEqual(result.status, 0);
assert.strictEqual(result.stdout.trim(), 'amtools 1.0');

result = run(['--json', 'version']);
assert.strictEqual(result.status, 0);
const version = JSON.parse(result.stdout);
assert.strictEqual(version.name, 'amtools');
assert.strictEqual(version.version, '1.0');
assert.strictEqual(Object.hasOwn(version, 'amdcVersion'), false);

result = run(['unknown']);
assert.strictEqual(result.status, 2);

result = run(['amdc', 'help']);
assert.strictEqual(result.status, 0);
assert.match(result.stdout, /AMDC/);

result = run(['pipeline', 'validate', 'tests/fixtures/collection-manifest.example.json']);
assert.strictEqual(result.status, 0);

result = spawnSync(process.execPath, [path.join(root, 'orchestrator', 'run-amdc-command.js'), 'not-allowlisted'], {
  cwd: root,
  encoding: 'utf8',
});
assert.strictEqual(result.status, 2);

if (process.platform === 'win32') {
  const legacyPowerShell = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  if (fs.existsSync(legacyPowerShell)) {
    const legacyEnv = { AMTOOLS_POWERSHELL: legacyPowerShell, AMDC_POWERSHELL: legacyPowerShell };
    result = run(['pipeline', 'dry-run', 'tests/fixtures/collection-manifest.example.json'], { env: legacyEnv });
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /AMTools pipeline validated: mode=dry-run/);

    result = run(['doctor', '--json'], { env: legacyEnv });
    assert.strictEqual(result.status, 0);
    const doctor = JSON.parse(result.stdout);
    const powershellCheck = doctor.checks.find(item => item.name === 'powershell');
    assert.ok(powershellCheck && powershellCheck.ok);
  }
}

console.log('CLI contract tests passed');
