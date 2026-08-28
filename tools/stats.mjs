#!/usr/bin/env node
// Reads the site's event log and answers the question the log exists for:
// what did people look for, and what did the index not have?
//
//   node tools/stats.mjs                 last 14 days
//   node tools/stats.mjs --days 90
//   node tools/stats.mjs --json          for piping somewhere
//   node tools/stats.mjs --local f.log   a file you already pulled down
//   node tools/stats.mjs --bots          include crawler traffic
//
// The log has no addresses in it (see deploy/analytics.nginx.conf), so nothing
// here can be per-person and nothing tries to be. The unit is a tab visit.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i === -1 ? d : (argv[i + 1] ?? true);
};
const has = (n) => argv.includes(`--${n}`);

const DAYS = Number(flag('days', 14));
const HOST = flag('host', process.env.SIFTER_SITE_HOST || 'ls');
const LOCAL = flag('local', null);
const KEEP_BOTS = has('bots');
const AS_JSON = has('json');

const C = process.stdout.isTTY && !AS_JSON ? {
  dim: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`, c: (s) => `\x1b[36m${s}\x1b[0m`,
} : new Proxy({}, { get: () => (s) => s });

// -- read ---------------------------------------------------------------

function raw() {
  if (LOCAL) return readFileSync(LOCAL, 'utf8');
  // zcat -f reads the rotated .gz files and the current plain one with the
  // same command, so the history does not disappear at the first rotation.
  return execFileSync('ssh', [HOST, 'sudo zcat -f /var/log/sifter/events.log* 2>/dev/null'], {
    encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
  });
}

const since = Date.now() - DAYS * 86400_000;
const events = [];
let malformed = 0;

for (const line of raw().split('\n')) {
  if (!line.trim()) continue;
  let rec;
  try { rec = JSON.parse(line); } catch { malformed++; continue; }
  const at = Date.parse(rec.at);
  if (!Number.isFinite(at) || at < since) continue;
  if (!KEEP_BOTS && rec.c !== 'browser') continue;

  const p = new URLSearchParams(rec.a || '');
  const e = p.get('e');
  if (!e) { malformed++; continue; }
  events.push({
    at, kind: e, session: p.get('s') || '?',
    q: p.get('q') || '', n: Number(p.get('n') ?? NaN), f: p.get('f') || '',
    k: p.get('k') || '', r: Number(p.get('r') ?? NaN),
    ref: p.get('ref') || '', w: p.get('w') || '', lang: p.get('l') || '',
  });
}

events.sort((a, b) => a.at - b.at);

// -- fold ---------------------------------------------------------------

const sessions = new Map();
for (const ev of events) {
  if (!sessions.has(ev.session)) sessions.set(ev.session, []);
  sessions.get(ev.session).push(ev);
}

// A session that reports far past the client's own cap is a script wearing a
// browser's User-Agent, and its terms are not anybody's questions.
const SANE = 80;
const scripted = [...sessions].filter(([, evs]) => evs.length > SANE).map(([s]) => s);
for (const s of scripted) sessions.delete(s);

/**
 * Typing "sha" -> "shad" -> "shader" is one search, not three, and only the
 * term someone settled on says what they wanted. Consecutive reports where one
 * is a prefix of the other collapse into the longer one — which is also the
 * right treatment for backspacing, seen from the other side.
 */
function fold(searches) {
  const out = [];
  for (const s of searches) {
    const prev = out[out.length - 1];
    if (prev && (s.q.startsWith(prev.q) || prev.q.startsWith(s.q))) {
      // Keep the term someone settled on, but the moment they started typing
      // it. A folded search covers a span, and an open lands inside that span:
      // carrying the later timestamp forward orphans the click that the search
      // actually produced, and the report then says nothing led anywhere.
      if (s.q.length >= prev.q.length) out[out.length - 1] = { ...s, at: prev.at };
      continue;
    }
    out.push(s);
  }
  return out;
}

const searches = [];
const opens = [];
const facets = [];
const views = [];
let copies = 0;

for (const [, evs] of sessions) {
  const settled = fold(evs.filter((e) => e.kind === 'search'));
  const sessionOpens = evs.filter((e) => e.kind === 'open');
  for (const s of settled) {
    // Did this search lead anywhere? An open carries the query it came from,
    // so the pairing is exact rather than a guess from timestamps.
    s.opened = sessionOpens.some((o) => o.q === s.q && o.at >= s.at);
    searches.push(s);
  }
  opens.push(...sessionOpens);
  facets.push(...evs.filter((e) => e.kind === 'facet'));
  views.push(...evs.filter((e) => e.kind === 'view'));
  copies += evs.filter((e) => e.kind === 'copy').length;
}

const tally = (list, key) => {
  const m = new Map();
  for (const x of list) {
    const k = typeof key === 'function' ? key(x) : x[key];
    if (!k) continue;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
};

const misses = searches.filter((s) => s.n === 0);
const missTally = tally(misses, 'q');

// -- report -------------------------------------------------------------

if (AS_JSON) {
  console.log(JSON.stringify({
    window_days: DAYS, sessions: sessions.size, views: views.length,
    searches: searches.length, misses: misses.length, opens: opens.length, copies,
    missed_terms: missTally.map(([q, n]) => ({ q, n })),
    top_searches: tally(searches, 'q').slice(0, 40).map(([q, n]) => ({ q, n })),
    top_opened: tally(opens, 'k').slice(0, 40).map(([k, n]) => ({ key: k, n })),
    facets: tally(facets, 'f').map(([f, n]) => ({ facet: f, n })),
    referrers: tally(views, 'ref').map(([ref, n]) => ({ ref, n })),
    widths: Object.fromEntries(tally(views, 'w')),
    languages: Object.fromEntries(tally(views, 'lang').slice(0, 8)),
    dropped: { malformed, scripted_sessions: scripted.length },
  }, null, 2));
  process.exit(0);
}

const bar = (n, max, width = 18) =>
  C.dim('▏'.padStart(1)) + '█'.repeat(Math.max(1, Math.round((n / max) * width)));

function section(title, rows, { empty = 'nothing yet' } = {}) {
  console.log(`\n${C.b(title)}`);
  if (!rows.length) { console.log(`  ${C.dim(empty)}`); return; }
  const max = Math.max(...rows.map((r) => r[1]));
  const w = Math.max(...rows.map((r) => String(r[0]).length));
  for (const [label, n, note] of rows) {
    console.log(`  ${String(label).padEnd(Math.min(w, 46))}  ${String(n).padStart(4)} ${C.dim(bar(n, max))}${note ? '  ' + C.dim(note) : ''}`);
  }
}

const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');

console.log(`\n${C.b('sifter.z10.dev')} ${C.dim(`· last ${DAYS} days`)}`);
console.log(`  ${sessions.size} visits · ${views.length} page loads · ${searches.length} searches · ${opens.length} opens · ${copies} install copies`);
console.log(C.dim(`  ${pct(searches.filter((s) => s.opened).length, searches.length)} of searches led to an open · ${pct(misses.length, searches.length)} found nothing`));
if (scripted.length || malformed) {
  console.log(C.dim(`  dropped: ${scripted.length} scripted session(s), ${malformed} unparseable line(s)`));
}

// First, because it is the only number here that should change what the
// index contains. Everything below is context for reading it.
section(C.y('Searched for, found nothing') + C.dim('  — candidates for the index'),
  missTally.map(([q, n]) => [q, n]),
  { empty: searches.length ? 'every search matched something' : 'no searches recorded yet' });

section('Top searches', tally(searches, 'q').slice(0, 15).map(([q, n]) => {
  const opened = searches.filter((s) => s.q === q && s.opened).length;
  return [q, n, `${opened} opened`];
}));

section('Most opened', tally(opens, 'k').slice(0, 15).map(([k, n]) => {
  const ranks = opens.filter((o) => o.k === k && Number.isFinite(o.r)).map((o) => o.r);
  const avg = ranks.length ? (ranks.reduce((a, b) => a + b, 0) / ranks.length).toFixed(1) : null;
  return [k, n, avg ? `avg position ${avg}` : null];
}));

section('Facets used', tally(facets, 'f').slice(0, 10).map(([f, n]) => [f, n]));
section('Came from', tally(views, 'ref').slice(0, 10).map(([r, n]) => [r, n]),
  { empty: 'all direct' });

const widths = tally(views, 'w');
const langs = tally(views, 'lang').slice(0, 6);
if (widths.length || langs.length) {
  console.log(`\n${C.b('Readers')}`);
  if (widths.length) console.log(`  screen   ${widths.map(([w, n]) => `${w} ${n}`).join('  ')}`);
  if (langs.length) console.log(`  language ${langs.map(([l, n]) => `${l} ${n}`).join('  ')}`);
}
console.log();
