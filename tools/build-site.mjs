#!/usr/bin/env node
// Assembles the static site.
//
// The one rule worth stating: the site does NOT get its own search
// implementation. src/search.mjs and src/lexicon.mjs are copied verbatim,
// so the ranking a visitor sees in the browser is the ranking the CLI
// prints and the ranking the MCP server returns. A second implementation
// would drift, and the drift would be invisible — the site would quietly
// become a demo of something the tool does not do.

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'site');
const INDEX = join(ROOT, 'index', 'resources.json');

if (!existsSync(INDEX)) {
  console.error('No published index. Run `sifter export` first.');
  process.exit(1);
}

mkdirSync(SITE, { recursive: true });

for (const f of ['search.mjs', 'lexicon.mjs']) {
  copyFileSync(join(ROOT, 'src', f), join(SITE, f));
}

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
  search: stamp(join(SITE, 'search.mjs')),
  lexicon: stamp(join(SITE, 'lexicon.mjs')),
};

// The chain is app.js -> search.mjs -> lexicon.mjs, so rewrite inner imports
// before hashing the file that points at them.
let searchSrc = readFileSync(join(SITE, 'search.mjs'), 'utf8')
  .replace(/from '\.\/lexicon\.mjs'/, `from './lexicon.mjs?v=${v.lexicon}'`);
writeFileSync(join(SITE, 'search.mjs'), searchSrc);
v.search = stamp(join(SITE, 'search.mjs'));

let appSrc = readFileSync(join(ROOT, 'site', 'app.js'), 'utf8')
  .replace(/from '\.\/search\.mjs(\?v=[a-f0-9]+)?'/, `from './search.mjs?v=${v.search}'`);
writeFileSync(join(SITE, 'app.js'), appSrc);
const appV = stamp(join(SITE, 'app.js'));

let html = readFileSync(join(SITE, 'index.html'), 'utf8')
  .replace(/src="\.\/app\.js(\?v=[a-f0-9]+)?"/, `src="./app.js?v=${appV}"`);
writeFileSync(join(SITE, 'index.html'), html);

const data = JSON.parse(readFileSync(INDEX, 'utf8'));

// Trim to what the page actually renders. Provenance stays — it is the
// point — but the raw liveness timings and per-source engagement numbers
// are weight a visitor never sees.
const entries = data.entries.map((e) => ({
  key: e.key, url: e.url, title: e.title, description: e.description,
  names: e.names?.slice(0, 3), claims: e.claims?.slice(0, 2).map((c) => c.text),
  sections: e.sections, tags: e.tags?.slice(0, 6), flags: e.flags,
  status: e.liveness?.status, checked_at: e.liveness?.checked_at,
  stars: e.github?.stars, archived: e.github?.archived,
  mentions: e.mentions,
  posts: (e.sources || []).filter((s) => s.type === 'x')
    .map((s) => ({ author: s.author, url: s.post })).slice(0, 3),
  first_seen: e.first_seen,
}));

writeFileSync(join(SITE, 'resources.json'), JSON.stringify({
  generated_at: data.generated_at, count: entries.length, entries,
}));

const bytes = (p) => (readFileSync(p).length / 1024).toFixed(1) + ' kB';
console.log(`site built: ${entries.length} entries`);
for (const f of ['index.html', 'app.js', 'resources.json', 'search.mjs', 'lexicon.mjs']) {
  console.log(`  ${f.padEnd(18)} ${bytes(join(SITE, f))}`);
}
console.log(`  fingerprints: app=${appV} search=${v.search} lexicon=${v.lexicon}`);
