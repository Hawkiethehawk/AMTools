const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'amtools.js');

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });
}

let result = run(['--help']);
assert.strictEqual(result.status, 0);
assert.match(result.stdout, /\bdoctor\b/);

result = run(['--version']);
assert.strictEqual(result.status, 0);
assert.strictEqual(result.stdout.trim(), 'amtools 1.0.0');

result = run(['--json', 'version']);
assert.strictEqual(result.status, 0);
const version = JSON.parse(result.stdout);
assert.strictEqual(version.name, 'amtools');
assert.strictEqual(version.version, '1.0.0');
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

console.log('CLI contract tests passed');
