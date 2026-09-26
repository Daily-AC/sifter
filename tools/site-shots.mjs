#!/usr/bin/env node
// Screenshot the first screen of every site in the public index into
// data/shots/<key>.webp, which the site shows as each entry's picture.
//
// A resource list of design sites that shows no design asks the visitor to
// take its word for it. The picture is the site as a visitor would see it on
// a laptop, not its og:image, which is often a logo on a flat colour.
//
//   node tools/site-shots.mjs              only sites without a shot yet
//   node tools/site-shots.mjs --all        retake everything
//   node tools/site-shots.mjs rareui.com   retake the keys named
//
// Drives one headless Chrome over CDP rather than `chrome --screenshot`:
// --virtual-time-budget never elapses on a page that animates forever, and
// half of these sites do, so that route hung on the first batch. Here each
// page gets a fixed real-time settle and is shot whatever state it is in.
// A site still showing a bot challenge afterwards can be retaken with
// SHOTS_HEADED=1, which opens a visible window: Vercel's checkpoint turns
// away headless Chrome but lets an ordinary window through.

import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'shots');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9400 + Math.floor(Math.random() * 400);
const SETTLE_MS = 7000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const all = args.includes('--all');
const only = args.filter((a) => !a.startsWith('--'));
mkdirSync(OUT, { recursive: true });

export const shotKey = (key) => key.replace(/[^a-z0-9.-]/gi, '_');
const entries = JSON.parse(readFileSync(join(ROOT, 'index', 'resources.json'), 'utf8')).entries
  .filter((e) => only.length ? only.includes(e.key) : all || !existsSync(join(OUT, `${shotKey(e.key)}.webp`)));
if (!entries.length) { console.log('nothing to shoot'); process.exit(0); }

const profile = mkdtempSync(join(tmpdir(), 'sifter-shots-'));
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const chrome = spawn(CHROME, [
  ...(process.env.SHOTS_HEADED ? [] : ['--headless=new']), '--hide-scrollbars', '--mute-audio', '--no-first-run',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=1440,900',
  ...(proxy ? [`--proxy-server=${proxy}`] : []), 'about:blank',
], { stdio: 'ignore' });

async function endpoint() {
  for (let i = 0; i < 60; i++) {
    try { return await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(500); }
  }
  throw new Error('Chrome never opened its debugging port');
}

// One browser-level socket; each site gets its own target so a page that
// wedges its renderer cannot take the next site down with it.
const { webSocketDebuggerUrl } = await endpoint();
const ws = new WebSocket(webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}, sessionId, timeoutMs = 20000) => new Promise((res, rej) => {
  const id = ++seq;
  const t = setTimeout(() => { pending.delete(id); rej(new Error(`${method} timed out`)); }, timeoutMs);
  pending.set(id, (m) => { clearTimeout(t); m.error ? rej(new Error(m.error.message)) : res(m.result); });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
});

async function shoot(e) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', newWindow: true });
  try {
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    await send('Page.enable', {}, sessionId);
    await send('Page.navigate', { url: e.url }, sessionId, 30000);
    await sleep(SETTLE_MS);
    // Cookie banners are the site's legal furniture, not its design, and they
    // sit on top of the first screen. Hide any fixed layer that talks about
    // cookies or consent before the shot.
    await send('Runtime.evaluate', { expression: `for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if ((cs.position === 'fixed' || cs.position === 'sticky') && el.textContent.length < 2000
          && /cookie|consent|gdpr|allow analytics/i.test(el.textContent)) el.style.setProperty('display', 'none', 'important');
    }` }, sessionId);
    await sleep(400);
    const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1440, height: 900, scale: 1 } }, sessionId, 30000);
    const png = join(profile, `${shotKey(e.key)}.png`);
    writeFileSync(png, Buffer.from(data, 'base64'));
    execFileSync('cwebp', ['-quiet', '-q', '80', '-resize', '1080', '0', png, '-o', join(OUT, `${shotKey(e.key)}.webp`)]);
    console.log(`ok    ${e.key}`);
  } catch (err) {
    console.log(`fail  ${e.key}  ${err.message}`);
  } finally {
    await send('Target.closeTarget', { targetId }).catch(() => {});
  }
}

// A few at a time: enough to overlap the settle waits, few enough that the
// pages are not starving each other of CPU while their animations run.
const queue = [...entries];
await Promise.all(Array.from({ length: 4 }, async () => {
  while (queue.length) await shoot(queue.shift());
}));

ws.close();
chrome.kill();
await sleep(300);
rmSync(profile, { recursive: true, force: true });
