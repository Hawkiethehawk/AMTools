#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { batchStopped, stoppedBatchState, eventsThroughStop, terminateProcessTree } = require('./batch-cancellation');

const stoppedAt = '2026-08-13T04:22:04.569Z';
const stopped = stoppedBatchState({
  state: 'starting',
  children: [
    { historyId: 'queued', state: 'queued' },
    { historyId: 'running', state: 'running' },
    { historyId: 'done', state: 'done', finishedAt: '2026-08-13T04:21:00.000Z', exitCode: 0 },
  ],
}, stoppedAt);

assert.strictEqual(batchStopped(stopped), true);
assert.strictEqual(stopped.children[0].state, 'stopped');
assert.strictEqual(stopped.children[1].state, 'stopped');
assert.strictEqual(stopped.children[2].state, 'done');
assert.strictEqual(stopped.children[2].exitCode, 0);

const events = eventsThroughStop([
  { at: '2026-08-13T04:22:01.000Z', message: '任务初始化' },
  { at: stoppedAt, message: '批量采集已停止' },
  { at: '2026-08-13T04:22:37.000Z', message: '开始应用数据采集' },
  { at: '2026-08-13T04:22:41.000Z', message: '总任务完成' },
]);
assert.deepStrictEqual(events.map(event => event.message), ['任务初始化', '批量采集已停止']);

async function waitForClose(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('idle worker was not terminated')), 5000);
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function runStoppedWorkerBarrierTest() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amdc-stopped-worker-'));
  const outputDir = path.join(projectDir, 'Cache', 'history', '20260813-042201-test');
  const stateFile = path.join(projectDir, 'Cache', 'history', 'batch-state', 'batch-test.json');
  const eventFile = path.join(projectDir, 'Cache', 'history', 'batch-events', 'batch-test.ndjson');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(stoppedBatchState({
    version: 1,
    batchId: 'batch-test',
    state: 'starting',
    children: [{ historyId: '20260813-042201-test', weekAnchor: '2026-08-03', state: 'queued' }],
  }, stoppedAt), null, 2));
  const manifest = {
    version: 1,
    batchId: 'batch-test',
    items: [{ historyId: '20260813-042201-test', weekAnchor: '2026-08-03', outputDir }],
  };
  try {
    const result = await new Promise((resolve, reject) => {
      const worker = spawn(process.execPath, [path.join(__dirname, 'amdc-weekly.js')], {
        cwd: projectDir,
        env: {
          ...process.env,
          AMDC_PROJECT_DIR: projectDir,
          AMDC_BATCH_MANIFEST: JSON.stringify(manifest),
          AMDC_BATCH_ID: 'batch-test',
          AMDC_BATCH_STATE_FILE: stateFile,
          AMDC_BATCH_EVENT_FILE: eventFile,
          AMDC_CATEGORIES: JSON.stringify(['PDF阅读器']),
          AMDC_ACCOUNTS: '.amdc-userdata',
          AMDC_NO_OPEN: '1',
        },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      worker.stdout.on('data', chunk => { output += String(chunk); });
      worker.stderr.on('data', chunk => { output += String(chunk); });
      const timer = setTimeout(() => {
        terminateProcessTree(worker);
        reject(new Error('pre-stopped worker did not exit before collection startup'));
      }, 5000);
      worker.once('close', code => {
        clearTimeout(timer);
        resolve({ code, output });
      });
      worker.once('error', reject);
    });
    assert.notStrictEqual(result.code, 0, result.output);
    const finalState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.strictEqual(finalState.state, 'stopped');
    assert.strictEqual(finalState.detail, '批量采集已停止');
    const events = fs.existsSync(eventFile) ? fs.readFileSync(eventFile, 'utf8') : '';
    assert.ok(!events.includes('总任务完成'));
    assert.ok(!events.includes('开始榜单确认'));
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}

(async () => {
  const idleWorker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  assert.strictEqual(terminateProcessTree(idleWorker), true);
  await waitForClose(idleWorker);
  await runStoppedWorkerBarrierTest();
  console.log('batch cancellation ok');
})().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
