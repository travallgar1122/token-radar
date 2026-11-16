// Local gate verification for blocks 1-2: reads the snapshot and the generated
// board and checks every constraint the task (and the starter's boardIssue)
// names, plus the dashboard caps, the compact data.js projection, the
// no-network rule and the screenshot limits.
// Usage: node tools/verify.mjs <snapshot.json> <outDir>

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const [snapshotPath, outDir] = process.argv.slice(2);
const snap = JSON.parse(readFileSync(snapshotPath, 'utf8'));
const boardDoc = JSON.parse(readFileSync(join(outDir, 'board.json'), 'utf8'));
const rows = boardDoc.rows;

let failures = 0;
function check(label, ok, detail = '') {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}\n`);
  if (!ok) failures++;
}

check('board.json is { rows: [...] }', Array.isArray(rows));
check('row count within 100..4000', rows.length >= 100 && rows.length <= 4000, `${rows.length} rows`);

const snapSlugs = new Set(snap.protocols.map((p) => p.slug));
check('every board slug exists in the snapshot', rows.every((r) => snapSlugs.has(r.slug)));

const boardSlugs = new Set(rows.map((r) => r.slug));
const missingWatch = snap.watchlist.filter((s) => snapSlugs.has(s) && !boardSlugs.has(s));
check('all watchlist protocols are on the board', missingWatch.length === 0, missingWatch.join(', ') || `${snap.watchlist.length} watchlist slugs covered`);

check('ranks are 1..n in order', rows.every((r, i) => r.rank === i + 1));
check(
  'implied values sorted descending by rank',
  rows.every((r, i) => i === 0 || rows[i - 1].implied_value_usd >= r.implied_value_usd),
);
check(
  'implied values are positive safe integers <= 1e12',
  rows.every((r) => Number.isSafeInteger(r.implied_value_usd) && r.implied_value_usd > 0 && r.implied_value_usd <= 1e12),
);
check('not all implied values equal', new Set(rows.map((r) => r.implied_value_usd)).size > 1);

let stepIssue = '';
for (const r of rows) {
  if (!Array.isArray(r.farm_steps) || r.farm_steps.length < 3 || r.farm_steps.length > 12) {
    stepIssue = `${r.slug}: ${Array.isArray(r.farm_steps) ? r.farm_steps.length : 'no'} steps`;
    break;
  }
  const bad = r.farm_steps.find((s) => typeof s !== 'string' || s.length < 20 || s.length > 600);
  if (bad !== undefined) {
    stepIssue = `${r.slug}: step of ${bad.length} chars`;
    break;
  }
}
check('every row has 3..12 farm steps of 20..600 chars', stepIssue === '', stepIssue);

const required = ['rank', 'slug', 'name', 'category', 'chains', 'tvl_usd', 'score', 'implied_value_usd', 'farm_steps'];
check(
  'every row carries the required fields',
  rows.every((r) => required.every((k) => k in r)),
);

// No two rows share an identical farm-step set (the anti-boilerplate smell test).
const stepSets = new Set(rows.map((r) => r.farm_steps.join('\n')));
check('no duplicate farm-step sets across rows', stepSets.size === rows.length, `${stepSets.size} unique sets`);

for (const f of ['board.json', 'dossier.json']) {
  check(`${f} written`, existsSync(join(outDir, f)), existsSync(join(outDir, f)) ? `${statSync(join(outDir, f)).size} bytes` : '');
}
// --- Dashboard (block 2): compact data, size caps, no-network, screenshots ---

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const dashDir = join(outDir, 'dashboard');
const dashFiles = walk(dashDir);
const dashBytes = dashFiles.reduce((n, f) => n + statSync(f).size, 0);
check(
  'dashboard within 400 files / 4 MiB',
  dashFiles.length <= 400 && dashBytes <= 4_194_304,
  `${dashFiles.length} files, ${dashBytes} bytes`,
);

const dataJsPath = join(dashDir, 'data.js');
check(
  'dashboard/data.js written (board-data.json retired)',
  existsSync(dataJsPath) && !existsSync(join(dashDir, 'board-data.json')),
);
let dataOk = false;
let dataJsSize = 0;
if (existsSync(dataJsPath)) {
  dataJsSize = statSync(dataJsPath).size;
  const text = readFileSync(dataJsPath, 'utf8');
  try {
    const parsed = JSON.parse(text.replace(/^window\.RADAR = /, '').replace(/;\s*$/, ''));
    dataOk =
      Array.isArray(parsed.rows) &&
      parsed.rows.length === rows.length &&
      parsed.rows.every((r) => !('farm_steps' in r)) &&
      typeof parsed.meta?.total_implied_value_usd === 'number';
  } catch {
    dataOk = false;
  }
}
check('data.js is a compact projection (rows match board, no farm_steps)', dataOk, `${dataJsSize} bytes`);
check('data.js <= 45 KB (leaves the dossier text cap to the dashboard source)', dataJsSize > 0 && dataJsSize <= 45_000, `${dataJsSize} bytes`);

// No-network: nothing the page loads may come from outside. Scan the
// dashboard's html/css/js for load patterns pointing at http(s) or
// protocol-relative URLs, and for network APIs at all. Plain-text mentions
// (e.g. the snapshot's source line inside data.js) are not loads and are
// not flagged.
const loadPatterns = [
  /\bsrc\s*=\s*["']\s*(https?:)?\/\//i,
  /\bhref\s*=\s*["']\s*(https?:)?\/\//i,
  /url\(\s*['"]?\s*(https?:)?\/\//i,
  /@import\s+['"](https?:)?\/\//i,
  /\bfetch\s*\(\s*['"`](https?:)?\/\//i,
  /\bimport\s*\(\s*['"`](https?:)?\/\//i,
  /XMLHttpRequest|sendBeacon|new\s+WebSocket/i,
];
let netIssue = '';
for (const f of dashFiles) {
  if (!/\.(html|css|js)$/i.test(f)) continue;
  const hit = loadPatterns.find((re) => re.test(readFileSync(f, 'utf8')));
  if (hit) {
    netIssue = `${f.slice(dashDir.length + 1)} matches ${hit}`;
    break;
  }
}
check('dashboard loads nothing from the network', netIssue === '', netIssue);

// Screenshots: exactly 3 images, each <= 256 KiB, long side <= 1280,
// short side >= 360. Dimensions read from the image headers.
function imageSize(buf) {
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}
const shots = readdirSync(join(outDir, 'screenshots')).filter((f) => /\.(png|jpe?g)$/i.test(f));
check('3 screenshot images in output', shots.length === 3, shots.join(', '));
let shotIssue = '';
const shotInfo = [];
for (const f of shots) {
  const buf = readFileSync(join(outDir, 'screenshots', f));
  const size = imageSize(buf);
  if (!size) {
    shotIssue = `${f}: unrecognised image format`;
    break;
  }
  const long = Math.max(size.w, size.h);
  const short = Math.min(size.w, size.h);
  shotInfo.push(`${f} ${size.w}x${size.h} ${buf.length}B`);
  if (buf.length > 262_144) {
    shotIssue = `${f}: ${buf.length} bytes > 256 KiB`;
    break;
  }
  if (long > 1280 || short < 360) {
    shotIssue = `${f}: ${size.w}x${size.h} outside limits (long <= 1280, short >= 360)`;
    break;
  }
}
check('screenshots within size/dimension limits', shotIssue === '', shotIssue || shotInfo.join('; '));

process.stdout.write(failures === 0 ? 'ALL CHECKS PASS\n' : `${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
