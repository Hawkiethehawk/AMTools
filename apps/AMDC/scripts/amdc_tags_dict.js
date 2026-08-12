// @ts-check
// Build the optional AMDC tag taxonomy dictionary used by amdc-weekly.js.
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DEFAULT_ENDPOINT = 'https://appmagic.rocks/api/v2/tags';
const TOKEN_CACHE_NAME = 'amdc-token.json';
const MAX_ACCOUNT_PROFILES = 20;
const REQUIRED_IDS = [3, 126, 243572, 9, 76, 77, 243528, 115, 119, 243477, 243756, 244699];

function currentMondayCompact() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function usage() {
  console.log(`Usage:
  node scripts/amdc_tags_dict.js [options]

Options:
  --project-dir <dir>    Project root. Defaults to AMDC_PROJECT_DIR or cwd.
  --profile <profile>    Profile dir to try. Can be repeated.
  --out <file>           Output JSON. Defaults to Cache/<current-Monday>/amdc-tags-full.json.
  --endpoint <url>       Tags API endpoint. Defaults to ${DEFAULT_ENDPOINT}
  --timeout-ms <ms>      HTTP timeout. Defaults to 30000.
  --no-browser           Do not launch browser fallback when token cache is missing/stale.
  --help                 Show this help.
`);
}

function parseArgs(argv) {
  const args = {
    projectDir: process.env.AMDC_PROJECT_DIR || process.cwd(),
    profiles: [],
    out: process.env.AMDC_TAGS_DICT_OUT || '',
    endpoint: process.env.AMDC_TAGS_ENDPOINT || DEFAULT_ENDPOINT,
    timeoutMs: parseInt(process.env.AMDC_TAGS_TIMEOUT_MS || '30000', 10),
    noBrowser: process.env.AMDC_TAGS_NO_BROWSER === '1',
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--project-dir') args.projectDir = argv[++i] || args.projectDir;
    else if (a === '--profile') args.profiles.push(argv[++i] || '');
    else if (a === '--out') args.out = argv[++i] || args.out;
    else if (a === '--endpoint') args.endpoint = argv[++i] || args.endpoint;
    else if (a === '--timeout-ms') args.timeoutMs = parseInt(argv[++i] || '', 10);
    else if (a === '--no-browser') args.noBrowser = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  args.projectDir = path.resolve(args.projectDir);
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs < 3000) args.timeoutMs = 30000;
  if (!args.out) args.out = path.join(args.projectDir, 'Cache', currentMondayCompact(), 'amdc-tags-full.json');
  else args.out = path.resolve(args.projectDir, args.out);
  args.endpoint = resolveEndpoint(args.endpoint);
  return args;
}

function resolveEndpoint(endpoint) {
  const value = String(endpoint || '').trim();
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('/')) return `https://appmagic.rocks${value}`;
  return `https://appmagic.rocks/${value.replace(/^\/+/, '')}`;
}

function isSafeProfile(profile) {
  return /^\.amdc-userdata(?:-[A-Za-z0-9_-]+)?$/.test(profile || '');
}

function profileSortValue(profile) {
  if (profile === '.amdc-userdata') return 0;
  const m = /^\.amdc-userdata-([A-Za-z0-9_-]+)$/.exec(profile);
  if (!m) return 999;
  const first = m[1].slice(0, 1).toLowerCase();
  if (first >= 'b' && first <= 'z') return first.charCodeAt(0) - 'a';
  return 100 + first.charCodeAt(0);
}

function profilePath(projectDir, profile) {
  if (!isSafeProfile(profile)) throw new Error(`invalid profile: ${profile}`);
  return path.resolve(projectDir, profile);
}

function discoverProfiles(projectDir, requested) {
  let profiles = requested.filter(Boolean);
  if (!profiles.length && process.env.AMDC_ACCOUNTS) {
    profiles = process.env.AMDC_ACCOUNTS.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (!profiles.length && process.env.AMDC_USERDATA_DIR) {
    profiles = [process.env.AMDC_USERDATA_DIR.trim()].filter(Boolean);
  }
  if (!profiles.length) {
    try {
      profiles = fs.readdirSync(projectDir)
        .filter(d => /^\.amdc-userdata(?:-.+)?$/.test(d))
        .filter(d => {
          try { return fs.statSync(path.join(projectDir, d)).isDirectory(); } catch { return false; }
        });
    } catch {
      profiles = [];
    }
  }
  profiles = [...new Set(profiles.filter(isSafeProfile))]
    .filter(profile => {
      try { return fs.statSync(profilePath(projectDir, profile)).isDirectory(); } catch { return false; }
    })
    .sort((a, b) => profileSortValue(a) - profileSortValue(b) || a.localeCompare(b))
    .slice(0, MAX_ACCOUNT_PROFILES);
  return profiles;
}

function tokenCachePath(projectDir, profile) {
  return path.join(profilePath(projectDir, profile), TOKEN_CACHE_NAME);
}

function readTokenCache(projectDir, profile) {
  try {
    const raw = JSON.parse(fs.readFileSync(tokenCachePath(projectDir, profile), 'utf-8'));
    return raw && typeof raw.token === 'string' ? raw.token : '';
  } catch {
    return '';
  }
}

function writeTokenCache(projectDir, profile, token) {
  if (!token) return;
  try {
    fs.writeFileSync(tokenCachePath(projectDir, profile), JSON.stringify({
      token,
      savedAt: new Date().toISOString(),
    }), 'utf-8');
  } catch {}
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function readTokenViaBrowser(projectDir, profile) {
  let chromium;
  try {
    chromium = require('@playwright/test').chromium;
  } catch (error) {
    console.warn(`[tags] browser fallback unavailable: ${error && error.message ? error.message : error}`);
    return '';
  }

  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(profilePath(projectDir, profile), {
      headless: true,
      args: ['--disable-blink-features=AutomationControlled'],
      userAgent: UA,
      viewport: { width: 1920, height: 1080 },
    });
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto('https://appmagic.rocks/top-charts/apps', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2500);
    const token = await page.evaluate(() => (localStorage.getItem('datamagic.token') || '').replace(/^"|"$/g, ''));
    await ctx.close();
    return token || '';
  } catch (error) {
    try { if (ctx) await ctx.close(); } catch {}
    console.warn(`[tags] browser token read failed for ${profile}: ${error && error.message ? error.message : error}`);
    return '';
  }
}

function parseBodyText(text) {
  try {
    return { json: JSON.parse(text), text: '' };
  } catch {
    return { json: null, text: text.slice(0, 240) };
  }
}

async function fetchTagsPayload(endpoint, token, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      signal: controller.signal,
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/json',
        'User-Agent': UA,
      },
    });
    const text = await res.text();
    const parsed = parseBodyText(text);
    if (!res.ok) {
      return { ok: false, status: res.status, error: parsed.text || JSON.stringify(parsed.json || {}).slice(0, 240) };
    }
    if (!parsed.json) {
      return { ok: false, status: res.status, error: `non-json response: ${parsed.text}` };
    }
    return { ok: true, status: res.status, payload: parsed.json };
  } catch (error) {
    return { ok: false, status: 0, error: error && error.message ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function toParentIds(value, fallback = []) {
  const src = Array.isArray(value) ? value : fallback;
  return [...new Set(src.map(toInt).filter(n => n != null))];
}

function tagName(raw) {
  for (const key of ['name', 'title', 'label']) {
    const value = raw && raw[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function tagChildren(raw) {
  for (const key of ['children', 'items', 'tags']) {
    if (raw && Array.isArray(raw[key])) return raw[key];
  }
  return [];
}

function flattenTags(nodes, parentIds = []) {
  const out = [];
  for (const raw of Array.isArray(nodes) ? nodes : []) {
    if (!raw || typeof raw !== 'object') continue;
    const id = toInt(raw.id ?? raw.tag_id ?? raw.tagId ?? raw.value);
    const normalized = id == null ? null : {
      id,
      name: tagName(raw),
      type: typeof raw.type === 'string' ? raw.type : '',
      parent_ids: toParentIds(raw.parent_ids ?? raw.parentIds, parentIds),
    };
    if (normalized && normalized.name) out.push(normalized);
    const nextParents = normalized ? [normalized.id] : parentIds;
    out.push(...flattenTags(tagChildren(raw), nextParents));
  }
  return out;
}

function extractTagNodes(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  if (payload && payload.data && Array.isArray(payload.data.tags)) return payload.data.tags;
  if (payload && Array.isArray(payload.tags)) return payload.tags;
  throw new Error('tags payload does not contain an array at data/tags');
}

function normalizeTags(payload) {
  const tags = flattenTags(extractTagNodes(payload));
  const byId = new Map();
  for (const tag of tags) {
    const existing = byId.get(tag.id);
    if (!existing) {
      byId.set(tag.id, tag);
      continue;
    }
    byId.set(tag.id, {
      id: tag.id,
      name: tag.name || existing.name,
      type: tag.type || existing.type,
      parent_ids: [...new Set([...(existing.parent_ids || []), ...(tag.parent_ids || [])])],
    });
  }
  return Array.from(byId.values()).sort((a, b) => a.id - b.id);
}

function validateTags(tags) {
  if (!Array.isArray(tags) || tags.length < 1000) {
    throw new Error(`too few tags returned: ${Array.isArray(tags) ? tags.length : 0}`);
  }
  const ids = new Set(tags.map(t => t.id));
  const missing = REQUIRED_IDS.filter(id => !ids.has(id));
  if (missing.length) {
    throw new Error(`required category tag ids missing: ${missing.join(',')}`);
  }
  const bad = tags.find(t => !Number.isInteger(t.id) || !t.name || !Array.isArray(t.parent_ids));
  if (bad) {
    throw new Error(`invalid normalized tag row: ${JSON.stringify(bad).slice(0, 160)}`);
  }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, file);
}

function typeSummary(tags) {
  const counts = new Map();
  for (const tag of tags) counts.set(tag.type || '(blank)', (counts.get(tag.type || '(blank)') || 0) + 1);
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(', ');
}

async function tryToken(args, profile, source, token) {
  if (!token) return { ok: false, error: 'empty token' };
  const result = await fetchTagsPayload(args.endpoint, token, args.timeoutMs);
  if (!result.ok) {
    console.warn(`[tags] ${profile} ${source} failed: status=${result.status} ${result.error || ''}`.trim());
    return result;
  }
  const tags = normalizeTags(result.payload);
  validateTags(tags);
  writeJsonAtomic(args.out, tags);
  console.log(`[tags] wrote ${tags.length} tags -> ${args.out}`);
  console.log(`[tags] types: ${typeSummary(tags)}`);
  console.log(`[tags] source profile: ${profile} (${source})`);
  return { ok: true };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const profiles = discoverProfiles(args.projectDir, args.profiles);
  if (!profiles.length) throw new Error('no AMDC profile directories found');
  console.log(`[tags] endpoint: ${args.endpoint}`);
  console.log(`[tags] profiles: ${profiles.join(', ')}`);

  for (const profile of profiles) {
    const token = readTokenCache(args.projectDir, profile);
    if (!token) continue;
    console.log(`[tags] trying cached token: ${profile}`);
    const result = await tryToken(args, profile, 'cache', token);
    if (result.ok) return;
  }

  if (!args.noBrowser) {
    for (const profile of profiles) {
      console.log(`[tags] trying browser profile: ${profile}`);
      const token = await readTokenViaBrowser(args.projectDir, profile);
      if (!token) continue;
      const result = await tryToken(args, profile, 'browser', token);
      if (result.ok) {
        writeTokenCache(args.projectDir, profile, token);
        return;
      }
    }
  }

  throw new Error('all profiles failed to fetch tags dictionary');
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[tags] failed: ${error && error.message ? error.message : error}`);
    process.exit(1);
  });
}

module.exports = { fetchTagsPayload, normalizeTags, validateTags, resolveEndpoint };
