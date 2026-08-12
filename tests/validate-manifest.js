const fs = require('fs');
const path = require('path');

const manifestPath = process.argv[2];
if (!manifestPath) {
  console.error('Usage: node tests/validate-manifest.js <manifest.json>');
  process.exit(2);
}

const absolutePath = path.resolve(manifestPath);
const manifest = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));

function fail(message) {
  console.error(`manifest invalid: ${message}`);
  process.exit(1);
}

const required = ['schemaVersion', 'batchId', 'source', 'status', 'requestedWeeks', 'categories', 'topDepth', 'artifacts'];
for (const key of required) {
  if (!(key in manifest)) fail(`missing ${key}`);
}
if (manifest.schemaVersion !== '1.0') fail(`unsupported schemaVersion ${manifest.schemaVersion}`);
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(manifest.batchId)) fail('invalid batchId');
if (!['manual', 'scheduled'].includes(manifest.source)) fail('invalid source');
if (!['requested', 'running', 'failed', 'synced'].includes(manifest.status)) fail('invalid status');
if (![100, 1000].includes(manifest.topDepth)) fail('invalid topDepth');
if (!Array.isArray(manifest.requestedWeeks) || !manifest.requestedWeeks.length) fail('requestedWeeks must be non-empty');
if (!manifest.requestedWeeks.every(value => /^\d{4}-\d{2}-\d{2}$/.test(value))) fail('invalid requestedWeeks');
if (!Array.isArray(manifest.categories) || !manifest.categories.length) fail('categories must be non-empty');

const artifacts = manifest.artifacts;
if (!artifacts || typeof artifacts !== 'object') fail('artifacts must be an object');
for (const key of ['runDir', 'snapshot', 'workbook']) {
  if (!(key in artifacts)) fail(`missing artifacts.${key}`);
}
if (!artifacts.workbook || artifacts.workbook.status !== 'synced') fail('artifacts.workbook must be synced');
if (!Array.isArray(artifacts.workbook.sheetNames) || !artifacts.workbook.sheetNames.length) {
  fail('artifacts.workbook.sheetNames must be non-empty');
}
if (manifest.status === 'synced' && !artifacts.workbook.revision) fail('synced manifest requires workbook.revision');

console.log(`manifest valid: ${path.basename(absolutePath)} | batch=${manifest.batchId} | source=${manifest.source} | sheets=${artifacts.workbook.sheetNames.length}`);
