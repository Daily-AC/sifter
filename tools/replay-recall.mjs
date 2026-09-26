#!/usr/bin/env node
// Replays everything typed into Claude Code and Codex through the recall
// channels, as if the hook had been running all along.
//
//   node tools/replay-recall.mjs                          how often each channel speaks
//   node tools/replay-recall.mjs --sample 40 --seed 7     a random sample of one channel's hits, to judge
//   node tools/replay-recall.mjs --channel rare           ...of the rare-word channel instead
//   node tools/replay-recall.mjs --probe "天花板"          what messages containing this would have recalled
//   node tools/replay-recall.mjs --json                   everything, for another script
//
// Reads the private book and vocabulary under data/ (SIFTER_HOME, or
// SIFTER_LINKS for the book, as the CLI does).
//
// Each message sees the book as it stood when it was typed: only links
// already handed over, only what had been said about them and noted by
// then. Titles and post text are fetched once, seconds after a link arrives,
// so they are used as they are now. The vocabulary is learned from all of
// history, future included; it is counts of words, and a few messages more
// or less barely move them.
//
// Codex copies a conversation into each session forked from it, with fresh
// timestamps. A message that turns up again word for word in another
// session is counted once; the same words twice in one session ("继续")
// were typed twice and are kept. Of 11,419 messages the readers returned
// on 2026-09-27, 7,050 remain.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LinkBook, recall, recallRecent, pick, readVocab, asksAboutPast, describe } from '../src/links.mjs';
import { load } from '../src/store.mjs';
import { claudeMessages, codexMessages } from '../src/sources/transcripts.mjs';

const ROOT = process.env.SIFTER_HOME || join(dirname(fileURLToPath(import.meta.url)), '..');
const LINKS = process.env.SIFTER_LINKS || join(ROOT, 'data', 'links.jsonl');
const VOCAB = join(dirname(LINKS), 'links-vocab.json');

const argv = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = argv.indexOf('--' + name);
  return i === -1 ? def : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true);
};

/** Every message once, oldest first. */
export function history(messages) {
  const first = new Map();
  const out = [];
  for (const m of [...messages].filter((m) => m.at).sort((a, b) => (a.at < b.at ? -1 : 1))) {
    const t = m.text.trim();
    if (first.has(t) && first.get(t) !== m.session) continue;
    first.set(t, m.session);
    out.push(m);
  }
  return out;
}

/** The book as it stood at `at`. */
export function bookAt(entries, at) {
  const out = [];
  for (const e of entries) {
    const said = e.said.filter((s) => s.at < at);
    if (!said.length) continue;
    out.push({ ...e, said, notes: (e.notes || []).filter((n) => n.at < at), first_seen: said[0].at });
  }
  return new LinkBook(out);
}

/**
 * Runs each message through both channels the way the hook would: links in
 * the message itself, links only ever handed over in this same session, and
 * links a channel already brought up in this session are skipped. Questions
 * about an earlier link take the search path instead and are not counted.
 */
export function replay(entries, messages, vocab) {
  const shown = { rare: new Map(), recent: new Map() };
  const once = (ch, s) => { if (!shown[ch].has(s)) shown[ch].set(s, new Set()); return shown[ch].get(s); };
  const rows = [];
  for (const m of messages) {
    if (asksAboutPast(m.text)) { rows.push({ m, asking: true, rare: [], recent: [] }); continue; }
    const book = bookAt(entries, m.at);
    const fresh = new Set(pick(m.text).map((f) => f.key));
    const skip = (ch) => (e) => fresh.has(e.key) || once(ch, m.session).has(e.key)
      || e.said.every((s) => s.session === m.session);
    const rare = recall(book, m.text, { vocab, skip: skip('rare') });
    const recent = recallRecent(book, m.text, { vocab, at: m.at, session: m.session, skip: skip('recent') });
    for (const h of rare) once('rare', m.session).add(h.link.key);
    for (const h of recent) once('recent', m.session).add(h.link.key);
    rows.push({ m, rare, recent });
  }
  return rows;
}

// Deterministic, so a judged sample can be drawn again.
function shuffle(xs, seed) {
  let s = Number(seed) || 1;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

const show = (r, ch) => {
  const lines = [`${r.m.at.slice(0, 16)}  ${r.m.text.replace(/\s+/g, ' ').slice(0, 200)}`];
  for (const h of r[ch]) {
    const d = describe(h.link, { max: 70 });
    lines.push(`    [${h.matched.join(', ')}] ${d.day} ${d.what || h.link.key}${d.said ? `  「${d.said.slice(0, 50)}」` : ''}`);
  }
  return lines.join('\n');
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const entries = load(LINKS);
  const vocab = readVocab(VOCAB);
  const messages = history([...claudeMessages(), ...codexMessages()]);
  const rows = replay(entries, messages, vocab);
  const n = rows.length;
  const fired = (ch) => rows.filter((r) => r[ch].length);
  const pct = (k) => `${(100 * k / n).toFixed(2)}%`;
  const both = rows.filter((r) => r.rare.length && r.recent.length).length;

  if (flag('json')) {
    console.log(JSON.stringify(rows.filter((r) => r.rare.length || r.recent.length).map((r) => ({
      at: r.m.at, session: r.m.session, text: r.m.text.slice(0, 400),
      rare: r.rare.map((h) => ({ key: h.link.key, matched: h.matched })),
      recent: r.recent.map((h) => ({ key: h.link.key, matched: h.matched })),
    }))));
  } else if (flag('probe')) {
    const q = String(flag('probe'));
    for (const r of rows.filter((r) => r.m.text.includes(q))) {
      console.log(`${show(r, 'rare')}\n  rare: ${r.rare.length}  recent: ${r.recent.length}`);
      if (r.recent.length) console.log(show(r, 'recent').split('\n').slice(1).join('\n'));
    }
  } else {
    console.log(`${n} messages (${entries.length} links in the book today)`);
    console.log(`  rare   ${String(fired('rare').length).padStart(4)}  ${pct(fired('rare').length)}`);
    console.log(`  recent ${String(fired('recent').length).padStart(4)}  ${pct(fired('recent').length)}`);
    console.log(`  both   ${String(both).padStart(4)}`);
    if (flag('sample')) {
      const ch = flag('channel') === 'rare' ? 'rare' : 'recent';
      const pick = shuffle(fired(ch), flag('seed', 1)).slice(0, Number(flag('sample')) || 30);
      console.log(`\n${pick.length} of ${fired(ch).length} ${ch} hits, oldest first:\n`);
      for (const r of pick.sort((a, b) => (a.m.at < b.m.at ? -1 : 1))) console.log(show(r, ch) + '\n');
    }
  }
}
