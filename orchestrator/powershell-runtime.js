'use strict';

const path = require('path');
const { spawnSync: defaultSpawnSync } = require('child_process');

const VERSION_ARGS = [
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  '$PSVersionTable.PSVersion.ToString()',
];

function parseVersion(output) {
  const match = String(output || '').trim().match(/^(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    text: String(output || '').trim(),
  };
}

function candidateCommands(env = process.env, platform = process.platform) {
  return [
    env.AMTOOLS_POWERSHELL,
    env.AMDC_POWERSHELL,
    platform === 'win32' && env.LOCALAPPDATA
      ? path.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'pwsh.exe')
      : '',
    'pwsh',
    'pwsh.exe',
    platform === 'win32' && env.SystemRoot
      ? path.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : '',
    platform === 'win32' ? 'powershell.exe' : '',
  ].filter(Boolean);
}

function resolvePowerShell(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const spawnSync = options.spawnSync || defaultSpawnSync;
  const seen = new Set();

  for (const command of candidateCommands(env, platform)) {
    if (seen.has(command)) continue;
    seen.add(command);
    let probe;
    try {
      probe = spawnSync(command, VERSION_ARGS, {
        encoding: 'utf8',
        windowsHide: true,
        stdio: 'pipe',
        shell: false,
      });
    } catch {
      continue;
    }
    const version = parseVersion(probe && probe.stdout);
    if (probe && probe.status === 0 && version &&
        (version.major > 5 || (version.major === 5 && version.minor >= 1))) {
      return { command, version: version.text };
    }
  }
  return null;
}

module.exports = {
  candidateCommands,
  parseVersion,
  resolvePowerShell,
};
