// Capture the three judge screenshots of the generated dashboard.
//
// Serves <outDir>/dashboard on a local port, then drives the Playwright
// Chromium binary over the DevTools protocol: navigate, wait for load,
// scroll each section into view, capture the 1280x800 viewport. (Plain
// `chrome --screenshot` with a #fragment URL is not used: headless Chrome
// captures the scrolled region before it is painted and returns a blank
// frame.) A frame over the gate's 256 KiB cap is re-encoded as JPEG.
// Shots land in this repo's screenshots/; re-run main.ts afterwards so the
// output tree (and the dossier) picks them up.
//
// Usage: node tools/screenshots.mjs [outDir]   (default: out-test)

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.argv[2] ?? join(root, 'out-test');
const dashDir = join(outDir, 'dashboard');
const shotsDir = join(root, 'screenshots');
const chrome = join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const PORT = 8734;
const CDP_PORT = 9333;
const MAX_BYTES = 262_144; // the gate's 256 KiB per-screenshot cap

if (!existsSync(join(dashDir, 'index.html')) || !existsSync(join(dashDir, 'data.js'))) {
  process.stderr.write(`screenshots: ${dashDir} has no index.html/data.js — run main.ts first\n`);
  process.exit(2);
}
if (!existsSync(chrome)) {
  process.stderr.write(`screenshots: no Chromium at ${chrome}\n`);
  process.exit(2);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
  cwd: dashDir,
  stdio: 'ignore',
});
const browser = spawn(
  chrome,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--window-size=1280,800',
    `--remote-debugging-port=${CDP_PORT}`,
    '--remote-debugging-address=127.0.0.1',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

/** A minimal CDP client over the target's WebSocket. */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
    } else if (msg.method && listeners.has(msg.method)) {
      for (const fn of listeners.get(msg.method)) fn(msg.params);
    }
  });
  return {
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    once(method) {
      return new Promise((resolve) => {
        const arr = listeners.get(method) ?? [];
        const fn = (params) => {
          listeners.set(method, arr.filter((f) => f !== fn));
          resolve(params);
        };
        arr.push(fn);
        listeners.set(method, arr);
      });
    },
    close() {
      ws.close();
    },
  };
}

try {
  // Wait for the dashboard server and the CDP endpoint.
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/index.html`);
      up = res.ok;
    } catch {
      await wait(200);
    }
  }
  if (!up) throw new Error('static server did not come up');
  let version = null;
  for (let i = 0; i < 50 && !version; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (res.ok) version = await res.json();
    } catch {
      await wait(200);
    }
  }
  if (!version) throw new Error('chrome CDP endpoint did not come up');

  const pageUrl = `http://127.0.0.1:${PORT}/index.html`;
  const targetRes = await fetch(
    `http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(pageUrl)}`,
    { method: 'PUT' },
  );
  const target = await targetRes.json();
  const cdp = await connect(target.webSocketDebuggerUrl);

  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url: pageUrl });
  await loaded;
  // Let app.js render and the compositor paint before any capture.
  await wait(600);

  const shots = [
    ['board.png', 'window.scrollTo(0, 0)'],
    ['watchlist.png', "document.getElementById('watchlist').scrollIntoView({ block: 'start' })"],
    ['methodology.png', "document.getElementById('worked-example').scrollIntoView({ block: 'start' })"],
  ];
  for (const [file, scrollExpr] of shots) {
    await cdp.send('Runtime.evaluate', { expression: scrollExpr });
    await wait(400); // paint the newly scrolled region
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const pngPath = join(shotsDir, file);
    writeFileSync(pngPath, Buffer.from(shot.data, 'base64'));
    let size = statSync(pngPath).size;
    if (size > MAX_BYTES) {
      // Over the gate's cap: re-encode the same frame as JPEG (~q85).
      const jpgPath = pngPath.replace(/\.png$/i, '.jpg');
      execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', pngPath, '-q:v', '4', jpgPath]);
      unlinkSync(pngPath);
      size = statSync(jpgPath).size;
      process.stdout.write(`screenshots: wrote ${file.replace(/\.png$/i, '.jpg')} (jpeg, ${size} bytes)\n`);
    } else {
      process.stdout.write(`screenshots: wrote ${file} (${size} bytes)\n`);
    }
  }
  cdp.close();
} finally {
  browser.kill();
  server.kill();
}
