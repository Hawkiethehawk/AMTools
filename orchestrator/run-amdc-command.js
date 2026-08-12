const path = require('path');
const { spawnSync } = require('child_process');

const script = process.argv[2];
const allowedScripts = new Set(['syntax', 'test:contract', 'test:feishu-order']);
if (!script) {
  console.error('Usage: node orchestrator/run-amdc-command.js <npm-script>');
  process.exit(2);
}
if (!allowedScripts.has(script)) {
  console.error(`Unsupported AMDC check: ${script}`);
  console.error(`Allowed checks: ${[...allowedScripts].join(', ')}`);
  process.exit(2);
}

const projectDir = path.resolve(__dirname, '..', 'apps', 'AMDC');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npmCommand, ['--prefix', projectDir, 'run', script], {
  cwd: projectDir,
  env: { ...process.env, AMDC_PROJECT_DIR: projectDir },
  stdio: 'inherit',
  // Windows exposes npm through npm.cmd, which requires the shell launcher.
  // The command is safe here because script is restricted by allowlist above.
  shell: process.platform === 'win32',
});

if (result.error) {
  console.error(`AMDC command failed to start: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status == null ? 1 : result.status);
