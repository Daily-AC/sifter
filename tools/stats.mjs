#!/usr/bin/env node
// Reads the site's event log.
//
//   node tools/stats.mjs                 last 14 days
//   node tools/stats.mjs --days 90
//   node tools/stats.mjs --json          for piping somewhere
//   node tools/stats.mjs --local f.log   a file you already pulled down
//   node tools/stats.mjs --bots          include crawler traffic
//
// Two kinds of record, and the difference between them is the whole design:
//
//   s     one per visit, written when the tab goes away. Counts only — how
//         many searches, how many empty, how many opens. No identifier, no
//         ordering, no text anybody typed.
//   miss  a term somebody chose to send by pressing a button that said so.
//   open  which entry was opened and where it ranked. Public index keys.
//
// So the miss RATE comes from every visit, and the miss TERMS come only from
// people who volunteered them. Those two numbers answer different questions
// and should never be read as one: a rate of 30% with four reported terms
// means the index is failing far more often than four times.

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const KINDS = new Set(['s', 'miss', 'open']);

export function parseEvents(text, { since = 0, keepBots = false } = {}) {
  const events = [];
  let malformed = 0;

  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { malformed++; continue; }

    const at = Date.parse(rec.at);
    if (!Number.isFinite(at) || at < since) continue;
    if (!keepBots && rec.c !== 'browser') continue;

    const p = new URLSearchParams(rec.a || '');
    const kind = p.get('e');
    if (!KINDS.has(kind)) { malformed++; continue; }

    const num = (f) => Number(p.get(f) || 0);
    events.push({
      at, kind,
      searches: num('n'), misses: num('m'), opens: num('o'), facets: num('f'),
      copied: num('c') === 1,
      ref: p.get('ref') || '', w: p.get('w') || '', lang: p.get('l') || '',
      q: p.get('q') || '', k: p.get('k') || '', r: num('r'),
    });
  }

  events.sort((a, b) => a.at - b.at);
  return { events, malformed };
}

export function summarize(events) {
  const visits = events.filter((e) => e.kind === 's');
  const gaps = events.filter((e) => e.kind === 'miss');
  const opens = events.filter((e) => e.kind === 'open');
  const sum = (f) => visits.reduce((a, v) => a + v[f], 0);

  return {
    visits: visits.length,
    searches: sum('searches'),
    misses: sum('misses'),
    facets: sum('facets'),
    copies: visits.filter((v) => v.copied).length,
    // A visit that searched at least once, as opposed to one that landed and
    // read the page — the denominator for "did the search work for them".
    searchingVisits: visits.filter((v) => v.searches > 0).length,
    // Two counts of the same act, kept apart because they can disagree: the
    // summary is one number a visit reported about itself, and the events are
    // what actually arrived. A visit killed before it could summarise leaves
    // its opens behind, so the rate uses the self-reported pair (same visits
    // in numerator and denominator) and the listing uses the events.
    openCount: sum('opens'),
    opens, gaps, visitRecords: visits,
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
    y: (s) => `\x1b[33m${s}\x1b[0m`,
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
  const gapTally = tally(s.gaps, 'q');
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');

  if (AS_JSON) {
    console.log(JSON.stringify({
      window_days: DAYS, visits: s.visits, searching_visits: s.searchingVisits,
      searches: s.searches, misses: s.misses,
      opens: s.opens.length, opens_self_reported: s.openCount,
      facet_uses: s.facets, install_copies: s.copies,
      miss_rate: s.searches ? s.misses / s.searches : null,
      reported_gaps: gapTally.map(([q, n]) => ({ term: q, n })),
      opened: tally(s.opens, 'k').slice(0, 40).map(([k, n]) => ({ key: k, n })),
      referrers: tally(s.visitRecords, 'ref').map(([ref, n]) => ({ ref, n })),
      widths: Object.fromEntries(tally(s.visitRecords, 'w')),
      languages: Object.fromEntries(tally(s.visitRecords, 'lang').slice(0, 8)),
      unparseable_lines: malformed,
    }, null, 2));
    return;
  }

  const bar = (n, max, width = 18) => C.dim('▏') + '█'.repeat(Math.max(1, Math.round((n / max) * width)));

  function section(title, rows, { empty = 'nothing yet' } = {}) {
    console.log(`\n${C.b(title)}`);
    if (!rows.length) { console.log(`  ${C.dim(empty)}`); return; }
    const max = Math.max(...rows.map((r) => r[1]));
    const w = Math.max(...rows.map((r) => String(r[0]).length));
    for (const [label, n, note] of rows) {
      console.log(`  ${String(label).padEnd(Math.min(w, 46))}  ${String(n).padStart(4)} ${C.dim(bar(n, max))}${note ? '  ' + C.dim(note) : ''}`);
    }
  }

  console.log(`\n${C.b('sifter.z10.dev')} ${C.dim(`· last ${DAYS} days`)}`);
  console.log(`  ${s.visits} visits · ${s.searchingVisits} searched · ${s.searches} searches · ${s.opens.length} opens · ${s.copies} install copies`);
  console.log(C.dim(`  ${pct(s.misses, s.searches)} of searches found nothing · ${pct(s.openCount, s.searches)} of searches led to an open`));
  if (malformed) console.log(C.dim(`  ${malformed} unreadable line(s)`));

  // The rate above says how often the index fails. This says what it was
  // missing, and only for the people who chose to tell us — it is a floor on
  // the gaps, never a census of them.
  section(C.y('Gaps people reported') + C.dim('  — sent on purpose, one button press each'),
    gapTally.map(([q, n]) => [q, n]),
    { empty: s.misses ? `${s.misses} searches found nothing and nobody pressed the button` : 'no empty searches yet' });

  section('Most opened', tally(s.opens, 'k').slice(0, 15).map(([k, n]) => {
    const ranks = s.opens.filter((o) => o.k === k && o.r > 0).map((o) => o.r);
    const avg = ranks.length ? (ranks.reduce((a, b) => a + b, 0) / ranks.length).toFixed(1) : null;
    return [k, n, avg ? `avg position ${avg}` : null];
  }));

  section('Came from', tally(s.visitRecords, 'ref').slice(0, 10).map(([r, n]) => [r, n]),
    { empty: 'all direct' });

  const widths = tally(s.visitRecords, 'w');
  const langs = tally(s.visitRecords, 'lang').slice(0, 6);
  if (widths.length || langs.length) {
    console.log(`\n${C.b('Readers')}`);
    if (widths.length) console.log(`  screen   ${widths.map(([w, n]) => `${w} ${n}`).join('  ')}`);
    if (langs.length) console.log(`  language ${langs.map(([l, n]) => `${l} ${n}`).join('  ')}`);
    if (s.facets) console.log(`  facets   used ${s.facets} time(s)`);
  }
  console.log();
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main();
}
