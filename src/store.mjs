// The library itself: merge, dedupe, persist.
//
// Storage is JSONL, one entry per line, because the index is meant to live
// in git. A line-per-resource file produces diffs a human can review — you
// can see that today's run added four sites and marked one dead, which is
// exactly the review a curated list needs and exactly what a database blob
// destroys.
//
// Merging is additive and never destructive. Sources accumulate; a second
// sighting of a site does not overwrite the first, it becomes evidence. That
// accumulation is the signal this index has and a hand-written awesome-list
// does not: how many independent people pointed at this thing.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { groupKey, normalizeUrl, bestUrl } from './canonical.mjs';
import { screen } from './privacy.mjs';
import { assessRisk } from './risk.mjs';

const now = () => new Date().toISOString();

export function load(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n')
    .filter((l) => l.trim())
    .map((l, i) => { try { return JSON.parse(l); } catch { console.warn(`skipping malformed line ${i + 1} of ${path}`); return null; } })
    .filter(Boolean);
}

export function save(path, entries) {
  mkdirSync(dirname(path), { recursive: true });
  const sorted = [...entries].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const tmp = path + '.tmp';
  writeFileSync(tmp, sorted.map((e) => JSON.stringify(e)).join('\n') + (sorted.length ? '\n' : ''));
  renameSync(tmp, path);   // never leave a half-written index behind
  return sorted.length;
}

/** Independent sources, counted the way a reader would count them. */
function countMentions(sources) {
  const seen = new Set();
  for (const s of sources) {
    if (s.type === 'x') seen.add('x:' + (s.author || s.post_id));
    else if (s.type === 'chrome') seen.add('chrome:' + (s.folder || 'default'));
    else seen.add(s.type + ':' + (s.by || s.at || ''));
  }
  return seen.size;
}

const pushUniq = (arr, v) => { if (v && !arr.includes(v)) arr.push(v); return arr; };

export class Library {
  constructor(entries = []) {
    this.byKey = new Map(entries.map((e) => [e.key, e]));
  }
  static open(path) { return new Library(load(path)); }
  all() { return [...this.byKey.values()]; }
  get(key) { return this.byKey.get(key); }

  /**
   * Fold one sighting into the library.
   * Returns { entry, created } so callers can report what actually changed.
   */
  upsert(cand, { blocklist = [] } = {}) {
    const url = normalizeUrl(cand.url);
    if (!url) return null;

    const verdict = screen(url, { blocklist });
    let finalUrl = url;
    const flags = [];
    if (verdict.private) {
      if (verdict.publicAncestor) { finalUrl = verdict.publicAncestor; flags.push('demoted'); }
      else flags.push('private');
    }

    const key = groupKey(finalUrl);
    if (!key) return null;

    let e = this.byKey.get(key);
    const created = !e;
    if (!e) {
      e = {
        key, url: finalUrl, title: null, description: null,
        names: [], claims: [], sections: [], local_sections: [], tags: [],
        flags: [], sources: [], mentions: 0,
        liveness: null, first_seen: now(),
      };
      this.byKey.set(key, e);
    }

    e.url = bestUrl([e.url, finalUrl]) || e.url;
    pushUniq(e.names, cand.name);
    // A heading a stranger wrote in a public post is public; the name of a
    // folder in your browser is how *you* organise your work. Both are
    // useful for grouping locally, only the first can be published.
    if (cand.source?.type === 'chrome') pushUniq((e.local_sections ||= []), cand.section);
    else pushUniq(e.sections, cand.section);
    for (const t of cand.tags || []) pushUniq(e.tags, t);
    if (cand.note) {
      const from = cand.source?.post || cand.source?.folder || cand.source?.type || 'unknown';
      if (!e.claims.some((c) => c.text === cand.note)) e.claims.push({ text: cand.note, from });
    }
    if (cand.source) {
      const sig = JSON.stringify([cand.source.type, cand.source.post_id || cand.source.folder, cand.source.author]);
      if (!e.sources.some((s) => JSON.stringify([s.type, s.post_id || s.folder, s.author]) === sig)) {
        e.sources.push(cand.source);
      }
    }

    for (const f of flags) pushUniq(e.flags, f);
    for (const f of assessRisk(e)) pushUniq(e.flags, f);
    e.mentions = countMentions(e.sources);
    e.last_seen = now();
    e.updated_at = now();
    return { entry: e, created };
  }

  /** Attach a probe result. Kept separate from upsert: sighting != verification. */
  applyProbe(key, p) {
    const e = this.byKey.get(key);
    if (!e || !p) return null;
    e.liveness = {
      status: p.status, code: p.code ?? null, note: p.note ?? null,
      checked_at: p.checked_at, final_url: p.final_url ?? null, ms: p.ms ?? null,
    };
    // The site's own words win over an author's pitch, but only if it has any.
    if (p.title && p.status !== 'dead') e.title = p.ogTitle || p.title;
    if (p.description) e.description = p.description;
    if (p.siteName) e.site_name = p.siteName;
    if (p.lang) e.lang = p.lang;
    if (p.image) e.image = p.image;
    if (p.stars !== undefined) {
      e.github = { stars: p.stars, language: p.language, topics: p.topics,
                   archived: p.archived, pushed_at: p.pushed_at, license: p.license };
      if (p.topics?.length) for (const t of p.topics) pushUniq(e.tags, t);
    }
    // Redirects can land somewhere risky that the original URL hid.
    for (const f of assessRisk(e)) pushUniq(e.flags, f);
    e.updated_at = now();
    return e;
  }

  /**
   * Fold entries that turned out to be the same site.
   *
   * Sites get renamed: godly.website now serves recent.design, so a library
   * built from links collected months apart holds one resource under two
   * keys with identical titles. Following the redirect fixes that.
   *
   * The trap is that a redirect is not always a rename. Plenty of sites
   * answer any unknown path with their homepage, so blindly following would
   * collapse unrelated dead links into whatever landing page they bounce to.
   * A target claimed by several distinct sources is treated as that kind of
   * catch-all and left alone.
   */
  mergeRedirects({ catchAllThreshold = 3 } = {}) {
    const moves = new Map();          // from key -> to key
    const targetCount = new Map();
    for (const e of this.all()) {
      const final = e.liveness?.final_url;
      if (!final || e.liveness.status === 'dead') continue;
      const to = groupKey(final);
      if (!to || to === e.key) continue;
      moves.set(e.key, to);
      targetCount.set(to, (targetCount.get(to) || 0) + 1);
    }

    const merged = [];
    for (const [from, to] of moves) {
      if (targetCount.get(to) >= catchAllThreshold) continue;   // looks like a catch-all
      const src = this.byKey.get(from);
      const dst = this.byKey.get(to);
      if (!src) continue;
      if (!dst) {                      // pure rename: carry the entry over
        src.key = to;
        pushUniq((src.aliases ||= []), from);
        this.byKey.delete(from);
        this.byKey.set(to, src);
        merged.push({ from, to, kind: 'renamed' });
        continue;
      }
      for (const n of src.names) pushUniq(dst.names, n);
      for (const sec of src.sections) pushUniq(dst.sections, sec);
      for (const t of src.tags) pushUniq(dst.tags, t);
      for (const f of src.flags) if (f !== 'demoted') pushUniq(dst.flags, f);
      for (const c of src.claims) if (!dst.claims.some((x) => x.text === c.text)) dst.claims.push(c);
      for (const s of src.sources) dst.sources.push(s);
      pushUniq((dst.aliases ||= []), from);
      dst.mentions = countMentions(dst.sources);
      if (src.first_seen < dst.first_seen) dst.first_seen = src.first_seen;
      dst.updated_at = now();
      this.byKey.delete(from);
      merged.push({ from, to, kind: 'merged' });
    }
    return merged;
  }
}
