#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const { resolvePowerShell } = require('./powershell-runtime');

const runtime = resolvePowerShell();
if (!runtime) {
  console.error('PowerShell 7 or Windows PowerShell 5.1 is required.');
  process.exit(3);
}

const result = spawnSync(runtime.command, process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  shell: false,
  stdio: 'inherit',
  windowsHide: true,
});

if (result.error) {
  console.error(`Failed to start ${runtime.command}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status == null ? 1 : result.status);
