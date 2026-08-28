// Search, with no index server and no embedding API.
//
// The constraint is deliberate: an agent should be able to query this the
// moment it clones the repo, with no key to configure and no service to
// start. A few thousand entries fit in memory and scoring them all costs
// less than one network round trip, so the honest engineering answer is a
// linear scan with good field weighting.
//
// Two things matter more than clever ranking:
//   - Chinese and English have to work in one query. Tokenization is
//     whitespace for latin runs and bigrams for CJK, which is crude but
//     matches how these entries are actually written (mixed, in one line).
//   - Being popular is not the same as being relevant. Mentions and stars
//     only nudge results that already matched the text.

import { synonyms, stem } from './lexicon.mjs';

const CJK = /[一-鿿぀-ヿ가-힯]/;

export function tokenize(s) {
  const out = [];
  const text = String(s || '').toLowerCase();
  for (const run of text.match(/[a-z0-9][a-z0-9+.#_-]*|[一-鿿぀-ヿ가-힯]+/g) || []) {
    if (CJK.test(run)) {
      if (run.length === 1) out.push(run);
      for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
      if (run.length <= 4) out.push(run);
    } else {
      out.push(run);
      const st = stem(run);
      if (st !== run) out.push(st);
      // "beautifului" should also be findable as "beautiful" + "ui"
      for (const part of run.split(/[.+#_-]/)) if (part.length > 2 && part !== run) out.push(part);
    }
  }
  return out;
}

const FIELDS = [
  ['names', 3.0], ['title', 3.0], ['key', 2.5], ['tags', 2.0],
  ['sections', 1.8], ['site_name', 1.5], ['description', 1.2],
  ['claims', 1.0], ['url', 0.6],
];

function fieldText(e, f) {
  const v = e[f];
  if (!v) return '';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : x?.text || '')).join(' ');
  return String(v);
}

function buildDoc(e) {
  const doc = { entry: e, fields: {}, len: 0 };
  for (const [f] of FIELDS) {
    const toks = tokenize(fieldText(e, f));
    doc.fields[f] = toks;
    doc.len += toks.length;
  }
  return doc;
}

/** Quality signals, deliberately bounded so they cannot outvote relevance. */
function prior(e) {
  let p = 1;
  const m = e.mentions || 1;
  p *= 1 + Math.min(Math.log2(m), 3) * 0.18;            // corroboration
  if (e.github?.stars) p *= 1 + Math.min(Math.log10(e.github.stars + 1) / 5, 0.35);
  const st = e.liveness?.status;
  if (st === 'dead') p *= 0.15;
  else if (st === 'unknown') p *= 0.75;
  else if (st === 'blocked') p *= 0.9;
  else if (st === 'alive') p *= 1.1;
  if (e.github?.archived) p *= 0.8;
  if ((e.flags || []).includes('legal_risk')) p *= 0.9;
  return p;
}

export class Index {
  constructor(entries) {
    this.docs = entries.map(buildDoc);
    this.df = new Map();
    for (const d of this.docs) {
      const seen = new Set();
      for (const toks of Object.values(d.fields)) for (const t of toks) seen.add(t);
      for (const t of seen) this.df.set(t, (this.df.get(t) || 0) + 1);
    }
    this.N = this.docs.length || 1;
    this.avgLen = this.docs.reduce((s, d) => s + d.len, 0) / this.N || 1;
  }

  search(query, { limit = 10, filter, k1 = 1.2, b = 0.6, expand = true } = {}) {
    const asked = [...new Set(tokenize(query))];
    if (!asked.length) return [];

    // Cross-language expansion is weighted below the words actually typed:
    // a synonym match is evidence, not the same as a direct hit.
    const weights = new Map(asked.map((t) => [t, 1]));
    if (expand) {
      for (const raw of String(query).toLowerCase().match(/[a-z]+(?: [a-z]+)?|[一-鿿]+/g) || []) {
        for (const syn of synonyms(raw)) {
          for (const t of tokenize(syn)) if (!weights.has(t)) weights.set(t, 0.55);
        }
      }
      for (const t of asked) {
        for (const syn of synonyms(t)) {
          for (const s2 of tokenize(syn)) if (!weights.has(s2)) weights.set(s2, 0.55);
        }
      }
    }
    const q = [...weights.keys()];
    const results = [];

    for (const d of this.docs) {
      if (filter && !filter(d.entry)) continue;
      let score = 0;
      const hits = new Set();
      for (const t of q) {
        const idf = Math.log(1 + (this.N - (this.df.get(t) || 0) + 0.5) / ((this.df.get(t) || 0) + 0.5));
        if (idf <= 0) continue;
        let tf = 0;
        for (const [f, w] of FIELDS) {
          const c = d.fields[f].filter((x) => x === t).length;
          if (c) { tf += c * w; hits.add(t); }
        }
        if (!tf) continue;
        score += weights.get(t) * idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (d.len / this.avgLen)));
      }
      if (!score) continue;
      // Matching more of what was asked beats matching one word loudly.
      // Coverage is measured against the typed words, not the expansion.
      const askedHit = asked.filter((t) => hits.has(t)).length;
      score *= 0.55 + 0.45 * (askedHit / asked.length || hits.size / q.length);
      results.push({ entry: d.entry, score: score * prior(d.entry), matched: [...hits] });
    }

    return results.sort((a, b2) => b2.score - a.score).slice(0, limit);
  }
}

export function search(entries, query, opts) {
  return new Index(entries).search(query, opts);
}
