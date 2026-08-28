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
//
// parseEvents and summarize are exported and covered by the test suite: the
// folding rule below got this wrong once in a way that printed a confident
// zero rather than failing, which is exactly the kind of mistake the rest of
// this repository's tests exist for.

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// A session reporting far past the client's own cap is a script wearing a
// browser's User-Agent, and its terms are nobody's questions.
const SANE_SESSION = 80;

/** One log line -> one event, or null if it is not one. */
function parseLine(line, { since = 0, keepBots = false } = {}) {
  let rec;
  try { rec = JSON.parse(line); } catch { return null; }
  const at = Date.parse(rec.at);
  if (!Number.isFinite(at) || at < since) return undefined;      // outside the window, not malformed
  if (!keepBots && rec.c !== 'browser') return undefined;

  const p = new URLSearchParams(rec.a || '');
  const kind = p.get('e');
  if (!kind) return null;
  return {
    at, kind, session: p.get('s') || '?',
    q: p.get('q') || '', n: Number(p.get('n') ?? NaN), f: p.get('f') || '',
    k: p.get('k') || '', r: Number(p.get('r') ?? NaN),
    ref: p.get('ref') || '', w: p.get('w') || '', lang: p.get('l') || '',
  };
}

export function parseEvents(text, opts = {}) {
  const events = [];
  let malformed = 0;
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    const ev = parseLine(line, opts);
    if (ev === null) { malformed++; continue; }
    if (ev === undefined) continue;
    events.push(ev);
  }
  events.sort((a, b) => a.at - b.at);
  return { events, malformed };
}

/**
 * Typing "sha" -> "shad" -> "shader" is one search, not three, and only the
 * term someone settled on says what they wanted. Consecutive reports where one
 * is a prefix of the other collapse into the longer one — which is also the
 * right treatment for backspacing, seen from the other side.
 *
 * The surviving record keeps the moment typing STARTED. A folded search covers
 * a span and an open lands inside it; carrying the later timestamp forward
 * orphans the click the search actually produced, and the report then says
 * nothing led anywhere while the log plainly shows the click.
 */
export function fold(searches) {
  const out = [];
  for (const s of searches) {
    const prev = out[out.length - 1];
    if (prev && (s.q.startsWith(prev.q) || prev.q.startsWith(s.q))) {
      if (s.q.length >= prev.q.length) out[out.length - 1] = { ...s, at: prev.at };
      continue;
    }
    out.push(s);
  }
  return out;
}

/** Sessions, folded searches, and whether each search led anywhere. */
export function summarize(events) {
  const sessions = new Map();
  for (const ev of events) {
    if (!sessions.has(ev.session)) sessions.set(ev.session, []);
    sessions.get(ev.session).push(ev);
  }

  const scripted = [...sessions].filter(([, evs]) => evs.length > SANE_SESSION).map(([s]) => s);
  for (const s of scripted) sessions.delete(s);

  const searches = [];
  const opens = [];
  const facets = [];
  const views = [];
  let copies = 0;

  for (const [, evs] of sessions) {
    const sessionOpens = evs.filter((e) => e.kind === 'open');
    for (const s of fold(evs.filter((e) => e.kind === 'search'))) {
      // An open carries the query it came from, so the pairing is exact
      // rather than a guess from timestamps alone.
      s.opened = sessionOpens.some((o) => o.q === s.q && o.at >= s.at);
      searches.push(s);
    }
    opens.push(...sessionOpens);
    facets.push(...evs.filter((e) => e.kind === 'facet'));
    views.push(...evs.filter((e) => e.kind === 'view'));
    copies += evs.filter((e) => e.kind === 'copy').length;
  }

  return {
    sessions: sessions.size, searches, opens, facets, views, copies,
    misses: searches.filter((s) => s.n === 0),
    scripted: scripted.length,
  };
}

export const tally = (list, key) => {
  const m = new Map();
  for (const x of list) {
    const k = typeof key === 'function' ? key(x) : x[key];
    if (!k) continue;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
};

// -- command line -------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  const flag = (n, d = null) => {
    const i = argv.indexOf(`--${n}`);
    return i === -1 ? d : (argv[i + 1] ?? true);
  };
  const has = (n) => argv.includes(`--${n}`);

  const DAYS = Number(flag('days', 14));
  const HOST = flag('host', process.env.SIFTER_SITE_HOST || 'ls');
  const LOCAL = flag('local', null);
  const AS_JSON = has('json');

  const C = process.stdout.isTTY && !AS_JSON ? {
    dim: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`,
    g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`,
    r: (s) => `\x1b[31m${s}\x1b[0m`, c: (s) => `\x1b[36m${s}\x1b[0m`,
  } : new Proxy({}, { get: () => (s) => s });

  // zcat -f reads the rotated .gz files and the current plain one with one
  // command, so the history does not disappear at the first rotation.
  const text = LOCAL
    ? readFileSync(LOCAL, 'utf8')
    : execFileSync('ssh', [HOST, 'sudo zcat -f /var/log/sifter/events.log* 2>/dev/null'],
        { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

  const { events, malformed } = parseEvents(text, {
    since: Date.now() - DAYS * 86400_000,
    keepBots: has('bots'),
  });
  const s = summarize(events);
  const missTally = tally(s.misses, 'q');

  if (AS_JSON) {
    console.log(JSON.stringify({
      window_days: DAYS, sessions: s.sessions, views: s.views.length,
      searches: s.searches.length, misses: s.misses.length,
      opens: s.opens.length, copies: s.copies,
      missed_terms: missTally.map(([q, n]) => ({ q, n })),
      top_searches: tally(s.searches, 'q').slice(0, 40).map(([q, n]) => ({ q, n })),
      top_opened: tally(s.opens, 'k').slice(0, 40).map(([k, n]) => ({ key: k, n })),
      facets: tally(s.facets, 'f').map(([f, n]) => ({ facet: f, n })),
      referrers: tally(s.views, 'ref').map(([ref, n]) => ({ ref, n })),
      widths: Object.fromEntries(tally(s.views, 'w')),
      languages: Object.fromEntries(tally(s.views, 'lang').slice(0, 8)),
      dropped: { malformed, scripted_sessions: s.scripted },
    }, null, 2));
    return;
  }

  const bar = (n, max, width = 18) =>
    C.dim('▏') + '█'.repeat(Math.max(1, Math.round((n / max) * width)));

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
  console.log(`  ${s.sessions} visits · ${s.views.length} page loads · ${s.searches.length} searches · ${s.opens.length} opens · ${s.copies} install copies`);
  console.log(C.dim(`  ${pct(s.searches.filter((x) => x.opened).length, s.searches.length)} of searches led to an open · ${pct(s.misses.length, s.searches.length)} found nothing`));
  if (s.scripted || malformed) {
    console.log(C.dim(`  dropped: ${s.scripted} scripted session(s), ${malformed} unparseable line(s)`));
  }

  // First, because it is the only number here that should change what the
  // index contains. Everything below is context for reading it.
  section(C.y('Searched for, found nothing') + C.dim('  — candidates for the index'),
    missTally.map(([q, n]) => [q, n]),
    { empty: s.searches.length ? 'every search matched something' : 'no searches recorded yet' });

  section('Top searches', tally(s.searches, 'q').slice(0, 15).map(([q, n]) => {
    const opened = s.searches.filter((x) => x.q === q && x.opened).length;
    return [q, n, `${opened} opened`];
  }));

  section('Most opened', tally(s.opens, 'k').slice(0, 15).map(([k, n]) => {
    const ranks = s.opens.filter((o) => o.k === k && Number.isFinite(o.r)).map((o) => o.r);
    const avg = ranks.length ? (ranks.reduce((a, b) => a + b, 0) / ranks.length).toFixed(1) : null;
    return [k, n, avg ? `avg position ${avg}` : null];
  }));

  section('Facets used', tally(s.facets, 'f').slice(0, 10).map(([f, n]) => [f, n]));
  section('Came from', tally(s.views, 'ref').slice(0, 10).map(([r, n]) => [r, n]),
    { empty: 'all direct' });

  const widths = tally(s.views, 'w');
  const langs = tally(s.views, 'lang').slice(0, 6);
  if (widths.length || langs.length) {
    console.log(`\n${C.b('Readers')}`);
    if (widths.length) console.log(`  screen   ${widths.map(([w, n]) => `${w} ${n}`).join('  ')}`);
    if (langs.length) console.log(`  language ${langs.map(([l, n]) => `${l} ${n}`).join('  ')}`);
  }
  console.log();
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main();
}
