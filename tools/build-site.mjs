#!/usr/bin/env node
// Assembles the static site.
//
// The one rule worth stating: the site does NOT get its own search
// implementation. src/search.mjs and src/lexicon.mjs are copied verbatim,
// so the ranking a visitor sees in the browser is the ranking the CLI
// prints and the ranking the MCP server returns. A second implementation
// would drift, and the drift would be invisible — the site would quietly
// become a demo of something the tool does not do.
//
// The page is one wall: every indexed site as a screenshot, every published
// video as a loop, in a single wall.json. What each card says in Chinese,
// and which cards open the page, comes from site/curation.json.

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, rmSync, linkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'site');
const INDEX = join(ROOT, 'index', 'resources.json');
const SHOTS = join(ROOT, 'data', 'shots');
const VIDEOS = join(ROOT, 'data', 'videos');

if (!existsSync(INDEX)) {
  console.error('No published index. Run `sifter export` first.');
  process.exit(1);
}

mkdirSync(SITE, { recursive: true });

for (const f of ['search.mjs', 'lexicon.mjs']) {
  copyFileSync(join(ROOT, 'src', f), join(SITE, f));
}

// ─── the wall ───

const CATS = [
  ['design', '设计资源'], ['agent', 'Agent 与工具'], ['video', 'AI 视频'], ['3d', '3D'],
  ['motion', '代码动效'], ['game', '游戏'], ['image', '图像'], ['voice', '语音'],
  ['launch', '发布'], ['misc', '其他'],
];
const CAT = Object.fromEntries(CATS);
const FLAG = { prompt: '附提示词', open: '开源', howto: '讲了做法' };

const curation = JSON.parse(readFileSync(join(SITE, 'curation.json'), 'utf8'));
const index = JSON.parse(readFileSync(INDEX, 'utf8'));

/** Width and height from a WebP header, so the page can reserve each
 *  card's exact box before its picture arrives and nothing jumps. */
function webpSize(file) {
  const b = readFileSync(file);
  const fmt = b.toString('ascii', 12, 16);
  if (fmt === 'VP8 ') return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
  if (fmt === 'VP8L') { const x = b.readUInt32LE(21); return [(x & 0x3fff) + 1, ((x >> 14) & 0x3fff) + 1]; }
  if (fmt === 'VP8X') return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
  throw new Error(`${file}: not a WebP this reader knows`);
}

// Media is linked, not copied: the full videos run to hundreds of megabytes
// and are identical on every build.
function place(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  try { linkSync(from, to); } catch { copyFileSync(from, to); }
}

for (const d of ['s', 'v']) rmSync(join(SITE, d), { recursive: true, force: true });

const shotKey = (key) => key.replace(/[^a-z0-9.-]/gi, '_');
const missing = [];

const sites = index.entries.map((e) => {
  const note = curation.sites[e.key];
  if (!note) missing.push(e.key);
  const gh = e.key.match(/^github\.com\/([^/]+)\/([^/]+)$/);
  const item = {
    kind: gh ? 'repo' : 'site',
    key: e.key, url: e.url, cat: note?.cat || 'design',
    title: note?.zh || e.description || e.title,
    names: [note?.name || e.site_name || e.title, e.title].filter(Boolean),
    tags: [CAT[note?.cat || 'design'], ...(e.tags || []).slice(0, 6)],
    description: e.description, claims: e.claims?.slice(0, 2).map((c) => c.text),
    by: gh ? `${gh[1]}/${gh[2]}` : new URL(e.url).hostname.replace(/^www\./, ''),
    mentions: e.mentions, at: e.first_seen,
  };
  if (gh) {
    // Every GitHub repo screenshots as the same grey page, so repos get a
    // typeset card instead of a picture.
    Object.assign(item, { owner: gh[1], repo: gh[2], stars: e.github?.stars, w: 16, h: 10 });
  } else {
    const shot = join(SHOTS, `${shotKey(e.key)}.webp`);
    if (!existsSync(shot)) { missing.push(`shot:${e.key}`); return null; }
    const [w, h] = webpSize(shot);
    place(shot, join(SITE, 's', `${shotKey(e.key)}.webp`));
    Object.assign(item, { img: `s/${shotKey(e.key)}.webp`, w, h });
  }
  return item;
}).filter(Boolean);

// Videos. Their source, data/videos/videos.json, is private: it holds every
// candidate, including the ones held back from publishing. Only cards not
// marked `hide` reach the site, with their media and none of the post text.
let videos = [];
if (existsSync(join(VIDEOS, 'videos.json'))) {
  videos = JSON.parse(readFileSync(join(VIDEOS, 'videos.json'), 'utf8'))
    .filter((x) => !x.hide)
    .map((x) => {
      const clip = join(VIDEOS, 'clip', `${x.id}.mp4`);
      const still = join(VIDEOS, 'clip', `${x.id}.webp`);
      const full = join(VIDEOS, 'full', `${x.id}.mp4`);
      if (![clip, still, full].every(existsSync)) { missing.push(`video:${x.id}`); return null; }
      const [w, h] = webpSize(still);
      place(clip, join(SITE, 'v', `${x.id}.mp4`));
      place(still, join(SITE, 'v', `${x.id}.webp`));
      place(full, join(SITE, 'v', 'full', `${x.id}.mp4`));
      const flags = x.flags.map((f) => FLAG[f]);
      return {
        kind: 'video', key: x.id, url: x.url, cat: x.cat, title: x.zh,
        names: [x.author, x.name], tags: [CAT[x.cat], ...flags], flags,
        by: `@${x.author}`, at: x.at, likes: x.likes,
        img: `v/${x.id}.webp`, clip: `v/${x.id}.mp4`, full: `v/full/${x.id}.mp4`, w, h,
      };
    })
    .filter(Boolean);
}

// Order: the hand-picked first screen, then everything else newest first,
// with a site every fourth card so the index is not buried under videos.
const byKey = new Map([...sites, ...videos].map((x) => [x.key, x]));
const featured = curation.featured.map((k) => byKey.get(k)).filter(Boolean);
const taken = new Set(featured.map((x) => x.key));
const restVideos = videos.filter((x) => !taken.has(x.key)).sort((a, b) => (a.at < b.at ? 1 : -1));
const restSites = sites.filter((x) => !taken.has(x.key))
  .sort((a, b) => (b.mentions - a.mentions) || ((a.kind === 'repo') - (b.kind === 'repo')) || a.key.localeCompare(b.key));
const rest = [];
while (restVideos.length || restSites.length) {
  for (let i = 0; i < 3 && restVideos.length; i++) rest.push(restVideos.shift());
  if (restSites.length) rest.push(restSites.shift());
}
const items = [...featured, ...rest];

const counted = {};
for (const x of items) counted[x.cat] = (counted[x.cat] || 0) + 1;

const wall = JSON.stringify({
  checked_at: index.generated_at,
  generated_at: new Date().toISOString(),
  sites: sites.length, videos: videos.length,
  cats: CATS.filter(([k]) => counted[k]),
  items,
});
writeFileSync(join(SITE, 'wall.json'), wall);

// ─── fingerprints ───
//
// Content fingerprints on every module reference.
//
// Learned the hard way on the first deploy: nginx served .mjs as
// application/octet-stream, the browser refused to execute the module, and
// the one-hour Cache-Control meant fixing the MIME type did nothing for
// anyone who had already loaded the page — a blank index for an hour, with
// no error a visitor could act on. Fingerprinted URLs make a corrected file
// a different resource, so a fix reaches everyone on their next load while
// unchanged assets still cache for as long as we like.
const stamp = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 8);

const v = {
  lexicon: stamp(join(SITE, 'lexicon.mjs')),
  // analytics.mjs has no imports of its own, so its hash is final here.
  analytics: stamp(join(SITE, 'analytics.mjs')),
  wall: stamp(join(SITE, 'wall.json')),
};

// The chain is app.js -> {search.mjs -> lexicon.mjs, analytics.mjs, wall.json},
// so rewrite inner references before hashing the file that points at them.
const searchSrc = readFileSync(join(SITE, 'search.mjs'), 'utf8')
  .replace(/from '\.\/lexicon\.mjs'/, `from './lexicon.mjs?v=${v.lexicon}'`);
writeFileSync(join(SITE, 'search.mjs'), searchSrc);
v.search = stamp(join(SITE, 'search.mjs'));

const appSrc = readFileSync(join(SITE, 'app.js'), 'utf8')
  .replace(/from '\.\/search\.mjs(\?v=[a-f0-9]+)?'/, `from './search.mjs?v=${v.search}'`)
  .replace(/from '\.\/analytics\.mjs(\?v=[a-f0-9]+)?'/, `from './analytics.mjs?v=${v.analytics}'`)
  .replace(/'\.\/wall\.json(\?v=[a-f0-9]+)?'/, `'./wall.json?v=${v.wall}'`);
writeFileSync(join(SITE, 'app.js'), appSrc);
const appV = stamp(join(SITE, 'app.js'));

const html = readFileSync(join(SITE, 'index.html'), 'utf8')
  .replace(/src="\.\/app\.js(\?v=[a-f0-9]+)?"/, `src="./app.js?v=${appV}"`)
  // Same fingerprints as the references in app.js, or each preload is a
  // second resource and every visitor downloads the file twice.
  .replace(/href="\.\/search\.mjs(\?v=[a-f0-9]+)?"/, `href="./search.mjs?v=${v.search}"`)
  .replace(/href="\.\/lexicon\.mjs(\?v=[a-f0-9]+)?"/, `href="./lexicon.mjs?v=${v.lexicon}"`)
  .replace(/href="\.\/wall\.json(\?v=[a-f0-9]+)?"/, `href="./wall.json?v=${v.wall}"`);
writeFileSync(join(SITE, 'index.html'), html);

const kb = (n) => (n / 1024).toFixed(1) + ' kB';
console.log(`site built: ${sites.length} sites, ${videos.length} videos, ${featured.length} featured`);
for (const f of ['index.html', 'app.js', 'wall.json', 'search.mjs', 'lexicon.mjs', 'analytics.mjs']) {
  console.log(`  ${f.padEnd(14)} ${kb(readFileSync(join(SITE, f)).length)}`);
}
if (missing.length) console.log(`  not on the wall: ${missing.join(', ')}`);
