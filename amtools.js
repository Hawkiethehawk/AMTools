#!/usr/bin/env node
// AMTools unified CLI. Keep module CLIs available through compatibility routes.

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const AMDC_ROOT = path.join(ROOT, 'apps', 'AMDC');
const AMDA_ROOT = path.join(ROOT, 'skills', 'AMDA');
const AMDC_CLI = path.join(AMDC_ROOT, 'am.js');
const MANIFEST_VALIDATOR = path.join(ROOT, 'tests', 'validate-manifest.js');
const PIPELINE_SCRIPT = path.join(ROOT, 'orchestrator', 'run-pipeline.ps1');
const LOCAL_LARK_CLI = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'lark-cli.cmd' : 'lark-cli');
const EXIT = { OK: 0, USAGE: 2, CHECK: 3, RUNTIME: 1 };

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function usage(message) {
  if (message) console.error(`Usage error: ${message}`);
  console.error('Run "amtools help" for available commands.');
  return EXIT.USAGE;
}

function runNode(script, args, cwd = ROOT, extraEnv = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env: { ...process.env, AMTOOLS_ROOT: ROOT, ...extraEnv },
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) {
    console.error(`Failed to start Node command: ${result.error.message}`);
    return EXIT.RUNTIME;
  }
  return result.status == null ? EXIT.RUNTIME : result.status;
}

function runExecutable(command, args, cwd = ROOT) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, AMTOOLS_ROOT: ROOT },
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) {
    console.error(`Failed to start ${command}: ${result.error.message}`);
    return EXIT.RUNTIME;
  }
  return result.status == null ? EXIT.RUNTIME : result.status;
}

function findExecutable(candidates, versionArgs = ['--version']) {
  for (const candidate of candidates) {
    const result = spawnSync(candidate, versionArgs, { encoding: 'utf8', stdio: 'pipe', shell: false });
    if (!result.error && result.status === 0) return candidate;
  }
  return null;
}

function resolveLarkCli() {
  if (fs.existsSync(LOCAL_LARK_CLI)) return LOCAL_LARK_CLI;
  return findExecutable(['lark-cli', 'lark-cli.cmd']);
}

function checkPort(port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = value => {
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => finish('listening'));
    socket.once('error', error => finish(error.code === 'ECONNREFUSED' ? 'free' : `error:${error.code || 'unknown'}`));
    socket.setTimeout(700, () => finish('timeout'));
  });
}

function versionInfo() {
  const rootPackage = readJson(path.join(ROOT, 'package.json'));
  return {
    name: rootPackage.name,
    version: fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim(),
    root: ROOT,
    paths: { amdc: AMDC_ROOT, amda: AMDA_ROOT },
  };
}

async function doctor(jsonOutput) {
  const pwsh = findExecutable(['pwsh', 'pwsh.exe']);
  const python = findExecutable(['python', 'python3', 'python.exe']);
  const lark = resolveLarkCli();
  const port = await checkPort(Number(process.env.AMDC_PORT || 8787));
  const checks = [
    { name: 'node', ok: true, detail: process.version },
    { name: 'pwsh7', ok: Boolean(pwsh), detail: pwsh || 'not found' },
    { name: 'python', ok: Boolean(python), detail: python || 'not found' },
    { name: 'amdc entry', ok: fs.existsSync(AMDC_CLI), detail: AMDC_CLI },
    { name: 'amda skill', ok: fs.existsSync(path.join(AMDA_ROOT, 'SKILL.md')), detail: AMDA_ROOT },
    { name: 'manifest validator', ok: fs.existsSync(MANIFEST_VALIDATOR), detail: MANIFEST_VALIDATOR },
    { name: 'dashboard port', ok: port === 'free' || port === 'listening', detail: port },
    { name: 'lark-cli', ok: true, optional: true, detail: lark || 'not found (Feishu sync unavailable)' },
  ];
  const result = { ok: checks.filter(item => !item.optional).every(item => item.ok), root: ROOT, checks };
  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`AMTools doctor: ${result.ok ? 'PASS' : 'FAIL'}`);
    for (const item of checks) console.log(`${item.ok ? '[ok]' : '[!!]'} ${item.name}: ${item.detail}`);
  }
  return result.ok ? EXIT.OK : EXIT.CHECK;
}

function runAMDC(args) {
  return runNode(AMDC_CLI, args.length ? args : ['help'], AMDC_ROOT, { AMDC_PROJECT_DIR: AMDC_ROOT });
}

function runAMDA(args) {
  const subcommand = args.shift();
  if (!subcommand || subcommand === 'help' || subcommand === '--help') {
    console.log('Usage: amtools amda <analyze|report-data> [options]');
    console.log('  analyze      Build canonical AMDA analysis JSON');
    console.log('  report-data  Build report data from analysis JSON');
    return EXIT.OK;
  }
  const scripts = {
    analyze: path.join(AMDA_ROOT, 'scripts', 'analyze-amda.py'),
    'report-data': path.join(AMDA_ROOT, 'scripts', 'prepare-report-data.py'),
  };
  const script = scripts[subcommand];
  if (!script) return usage(`unknown AMDA command: ${subcommand}`);
  const python = findExecutable(['python', 'python3', 'python.exe']);
  if (!python) {
    console.error('Python is required for AMDA commands. Run "amtools doctor".');
    return EXIT.CHECK;
  }
  return runExecutable(python, [script, ...args], ROOT);
}

function runPipeline(args) {
  const subcommand = args.shift();
  if (!subcommand || subcommand === 'help' || subcommand === '--help') {
    console.log('Usage: amtools pipeline <validate|dry-run> <manifest.json>');
    return EXIT.OK;
  }
  const manifest = args.shift();
  if (!manifest || args.length) return usage(`${subcommand} requires exactly one manifest path`);
  if (subcommand === 'validate') return runNode(MANIFEST_VALIDATOR, [manifest]);
  if (subcommand === 'dry-run') {
    const pwsh = findExecutable(['pwsh', 'pwsh.exe']);
    if (!pwsh) {
      console.error('PowerShell 7 (pwsh) is required for pipeline dry-run.');
      return EXIT.CHECK;
    }
    return runExecutable(pwsh, ['-NoProfile', '-File', PIPELINE_SCRIPT, '-ManifestPath', manifest, '-DryRun']);
  }
  return usage(`unknown pipeline command: ${subcommand}`);
}

function showHelp() {
  console.log(`AMTools unified CLI\n\nUsage: amtools <command> [options]\n\nCommands:\n  doctor                         Check local runtimes and project wiring\n  version                        Show the AMTools version\n  amdc <command> [options]      Run the compatible AMDC CLI\n  amda <command> [options]      Run an AMDA analysis command\n  pipeline validate <manifest>  Validate a CollectionManifest\n  pipeline dry-run <manifest>  Validate the isolated pipeline\n\nThe legacy "amdc" command remains supported.\n`);
}

async function main(argv) {
  const args = [...argv];
  let jsonOutput = false;
  if (args[0] === '--json') {
    jsonOutput = true;
    args.shift();
  }
  const command = args.shift();
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    showHelp();
    return EXIT.OK;
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    if (args.length === 1 && args[0] === '--json') jsonOutput = true;
    const info = versionInfo();
    console.log(jsonOutput ? JSON.stringify(info, null, 2) : `${info.name} ${info.version}`);
    return EXIT.OK;
  }
  if (command === 'doctor') {
    if (args.length === 1 && args[0] === '--json') jsonOutput = true;
    if (args.length > 0 && !(args.length === 1 && args[0] === '--json')) return usage('doctor accepts only --json');
    return doctor(jsonOutput);
  }
  if (jsonOutput) return usage('--json is only supported by doctor and version');
  if (command === 'amdc') return runAMDC(args);
  if (command === 'amda') return runAMDA(args);
  if (command === 'pipeline') return runPipeline(args);
  return usage(`unknown command: ${command}`);
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
  console.error(`AMTools failed: ${error.message}`);
  process.exitCode = EXIT.RUNTIME;
});
