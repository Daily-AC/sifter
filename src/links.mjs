// Links handed to an agent, remembered.
//
// The index proper is a curated list of *sites*. This is the other half of
// the problem: the post, repo or article someone pastes into a conversation
// with "try this", where what is worth keeping is the link itself plus why it
// was handed over. Two months later the question is never "which component
// library exists" but "what was that post I sent you about syncing Muse", and
// the words said while pasting it are the best index there is.
//
// Kept in its own file and never exported. What someone typed next to a link
// ("deploy this on my home box") is theirs, not the public index's.

import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { load, save } from './store.mjs';
import { normalizeUrl, canonicalHost } from './canonical.mjs';
import { screen } from './privacy.mjs';
import { Index } from './search.mjs';
import { fetchPost, tweetId } from './sources/x.mjs';
import { probe, probeGithub } from './probe.mjs';

const now = () => new Date().toISOString();

// RFC 3986 characters only, so a link typed flush against Chinese text
// ("github.com/a/b你去看看") ends where the URL does. Brackets and quotes
// are left out: they close markdown links far more often than they appear
// inside a URL.
const URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#@!$&*+,;=%]+/g;

// Links, but not things anyone comes back to: work items, conversations,
// endpoints, and pages that only mean something while logged in.
const NOT_A_RESOURCE = [
  /^github\.com\/[^/]+\/[^/]+\/(pull|pulls|issues|actions|commit|commits|compare|runs|releases\/download|settings)(\/|$)/i,
  /^github\.com\/(login|settings|notifications|new|orgs|organizations|sponsors)(\/|$)/i,
  /^(x|twitter)\.com\/(home|i\/(?!web\/status)|search|notifications|messages|settings|compose)/i,
  /^(claude\.ai|chatgpt\.com|chat\.openai\.com|chat\.qwen\.ai|gemini\.google\.com|kimi\.com|kimi\.moonshot\.cn|doubao\.com|chat\.deepseek\.com)(\/|$)/i,
  /^(share\.)?gemini\.google(\.com)?(\/|$)/i, /^platform\.openai\.com(\/|$)/i,
  /^api\.[^/]+/i, /\.googleapis\.com(\/|$)/i, /^registry\./i,
  /^(example|xxxx|foo|bar)\.(com|org|net)(\/|$)/i,
];

// Text that someone else wrote and the user merely relayed: agent-to-agent
// messages, pasted tool logs, pasted command JSON. Links in it were not
// handed over by the user.
const RELAYED = /<teammate-message|Another Claude session sent a message|<task-notification|tool \w+ (result|call):|\[\d+\] (assistant|tool)\b|"command": \[/;

/** Host or host/path prefixes the owner never wants remembered, one per line. */
export function readIgnore(path) {
  if (!path || !existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n')
    .map((l) => l.replace(/#.*/, '').trim().toLowerCase())
    .filter(Boolean);
}

/** Identity a link is remembered under. Tracking noise and `.git` fold away. */
export function keyOf(url) {
  const n = normalizeUrl(url);
  if (!n) return null;
  const id = tweetId(n);
  if (id) return `x.com/status/${id}`;
  const u = new URL(n);
  const path = u.pathname.replace(/\.git$/i, '').replace(/\/+$/, '');
  return canonicalHost(u.hostname) + (path || (u.search ? '/' : '')) + u.search;
}

function ignored(key, ignore) {
  const k = key.toLowerCase();
  const host = k.split(/[/?#]/)[0];
  return ignore.some((p) => (p.includes('/')
    ? k === p || k.startsWith(p + '/')
    : host === p || host.endsWith('.' + p)));
}

/**
 * The resource links in a message, with what was said around each one.
 * Private-looking URLs (tokens in the query, consoles, LAN hosts) are
 * dropped here, before anything is written, not filtered on the way out.
 */
export function pick(text, { ignore = [] } = {}) {
  const s = String(text || '');
  if (RELAYED.test(s)) return [];
  // A `>` line quotes someone else, usually the agent's own earlier reply.
  const own = s.split('\n').map((l) => (/^\s*>/.test(l) ? '' : l)).join('\n');
  const out = [];
  const seen = new Set();
  for (const m of own.matchAll(URL_RE)) {
    const raw = m[0].replace(/[.,;:!?*]+$/, '');
    const url = normalizeUrl(raw);
    if (!url) continue;
    const host = new URL(url).hostname;
    // A hostname with no real TLD is a fragment of a stack trace or a
    // wrapped curl line, and a bare IP is somebody's own machine.
    if (!/\.[a-z]{2,}$/i.test(host) || /^\d+(\.\d+){3}$/.test(host)) continue;
    if (screen(url).private) continue;
    const key = keyOf(url);
    if (!key || seen.has(key)) continue;
    if (NOT_A_RESOURCE.some((re) => re.test(key)) || ignored(key, ignore)) continue;
    seen.add(key);
    out.push({ url, key, said: around(own, m.index, raw.length) });
  }
  return out;
}

// The sentence or two around a link is why it was sent. A long prompt that
// merely contains a link three paragraphs down is mostly about something
// else, so only whole sentences within a short reach of the link are kept.
const STOP = /[。！？!?\n]/;
function around(text, at, len, reach = 100) {
  let before = text.slice(Math.max(0, at - reach), at);
  let after = text.slice(at + len, at + len + reach);
  if (at - reach > 0) { const i = before.search(STOP); if (i >= 0) before = before.slice(i + 1); }
  if (at + len + reach < text.length) {
    const cut = [...after.matchAll(new RegExp(STOP, 'g'))].pop();
    if (cut) after = after.slice(0, cut.index + 1);
  }
  return (before + ' ' + after)
    .replace(URL_RE, ' ')
    .replace(/<\/?pasted_content[^>]*>/g, ' ')
    .replace(/\[Image #\d+\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export class LinkBook {
  constructor(entries = []) { this.byKey = new Map(entries.map((e) => [e.key, e])); }
  static open(path) { return new LinkBook(load(path)); }
  all() { return [...this.byKey.values()]; }
  get(keyOrUrl) { return this.byKey.get(keyOrUrl) || this.byKey.get(keyOf(keyOrUrl)); }

  /** Record one sighting. A link sent twice is sent for two reasons; keep both. */
  capture({ url, key, said }, { session = null, cwd = null, at = now() } = {}) {
    let e = this.byKey.get(key);
    const created = !e;
    if (!e) {
      e = { key, url, first_seen: at, said: [], notes: [] };
      this.byKey.set(key, e);
    }
    if (!e.said.some((x) => x.session && x.session === session && x.text === said)) {
      e.said.push({ text: said || '', at, session, project: cwd ? basename(cwd) : null });
    }
    if (at < e.first_seen) e.first_seen = at;
    return { entry: e, created };
  }

  note(keyOrUrl, text) {
    const e = this.get(keyOrUrl);
    if (!e) return null;
    e.notes.push({ text, at: now() });
    return e;
  }
}

export const saveBook = (path, book) => save(path, book.all());

/** What the link is, in its own words. Failures are recorded, not thrown. */
export async function enrich(e) {
  try {
    if (tweetId(e.url)) {
      const p = await fetchPost(e.url);
      e.kind = 'post';
      e.author = p.author;
      e.posted_at = p.created_at;
      // Posts that are only a video or an article link have no words of
      // their own; the article's title or the medium is what identifies them.
      const words = (p.text || '').replace(/https?:\/\/\S+/g, '').trim();
      e.text = [p.article?.title, p.article?.preview, words].filter(Boolean).join('\n').slice(0, 2000);
      e.media = p.media?.length ? [...new Set(p.media)] : undefined;
      // "🚨 Breaking:" is a first line, not a title; keep reading until
      // there is enough to recognise the post by.
      let head = '';
      for (const l of words.split(/\r?\n/)) {
        head = (head + ' ' + l.trim()).trim();
        if (head.replace(/[\p{Emoji_Presentation}\s:：]/gu, '').length >= 12) break;
      }
      e.title = p.article?.title || head.slice(0, 120)
        || (e.media?.includes('video') ? `@${p.author} 的视频帖` : null);
    } else if (/^github\.com\/[^/]+\/[^/]+/.test(e.key)) {
      const [, owner, repo] = e.key.split('/');
      const g = await probeGithub(owner, repo);
      if (!g) throw new Error('github api unavailable');
      e.kind = 'repo';
      e.title = g.title || `${owner}/${repo}`;
      e.text = g.description || null;
      e.stars = g.stars ?? null;
      e.topics = g.topics || [];
      e.status = g.status;
    } else {
      const r = await probe(e.url);
      e.kind = 'page';
      e.title = r.title || r.ogTitle || null;
      e.text = r.description || null;
      e.status = r.status;
    }
    delete e.enrich_error;
  } catch (err) {
    e.enrich_error = String(err.message || err).slice(0, 160);
  }
  e.enriched_at = now();
  return e;
}

// English words too common to say which link a message is about. Chinese
// needs no list: the learned vocabulary (learnVocab) knows which Chinese
// words this person uses all the time, and English mostly arrives pasted,
// so it is under-counted there.
const FILLER = new Set([
  'the', 'this', 'that', 'and', 'for', 'with', 'you', 'can', 'are', 'was', 'not', 'but', 'from',
  'your', 'our', 'have', 'has', 'will', 'into', 'its', 'about', 'what', 'how', 'why', 'when', 'all',
  'https', 'http', 'com', 'www', 'status', 'github', 'repo', 'source', 'open', 'code', 'tool', 'tools',
  'file', 'files', 'command', 'run', 'use', 'using', 'new', 'one', 'get', 'set', 'make', 'more', 'just',
  'end', 'turn', 'like', 'same', 'first', 'last', 'next', 'type', 'text', 'content', 'context', 'progress',
  'which', 'there', 'their', 'they', 'them', 'then', 'than', 'these', 'those', 'would', 'should', 'could',
  'been', 'were', 'does', 'did', 'done', 'doing', 'any', 'some', 'each', 'only', 'also', 'very', 'other',
  'over', 'after', 'before', 'still', 'even', 'much', 'many', 'most', 'such', 'here', 'where', 'while',
  'user', 'users', 'agent', 'agents', 'task', 'tasks', 'work', 'working', 'output', 'input', 'line',
  'data', 'server', 'proxy', 'test', 'tests', 'app', 'bar', 'page', 'fetch', 'loop', 'model', 'key',
]);

// What the message itself says, without what it pastes. Code, logs and
// quoted replies share vocabulary with everything and mean nothing here.
function ownWords(text, max = 600) {
  const s = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<([a-z_-]+)[^>]*>[\s\S]*?<\/\1>/gi, (m, tag) => (tag === 'pasted_content' ? m : ' '))
    .split('\n')
    .filter((l) => !/^\s*>/.test(l) && !/[{};]\s*$|^\s*[$#]\s|^\s*at\s|\d{2}:\d{2}:\d{2}|=>|\\n/.test(l))
    .join(' ')
    .replace(URL_RE, ' ');
  return s.slice(0, max);
}

// Chinese has no spaces, and cutting it into overlapping pairs manufactures
// words that straddle two real ones ("这边已经登录" gives 边已, 经登), each
// of which then matches something. The ICU segmenter built into Node knows
// real words; pairs are formed only where it gave up and left single
// characters behind, which is where new words like 抖音 and 剪映 live.
const SEG = new Intl.Segmenter('zh', { granularity: 'word' });
const FUNCTION_CHARS = /[的了是我你他她它这那个一在有和就都也要会能把被给让吗呢吧啊嘛呀啥下上不没很还又再去来说看想做用到得着过们么什怎样些其之与而及或但并从对为以于将已]/;

function words(text) {
  const out = [];
  for (const m of String(text || '').toLowerCase().matchAll(/[a-z0-9][a-z0-9+#_-]*(?:\.[a-z0-9]+)*|[一-鿿]+/g)) {
    const w = m[0];
    if (!/[一-鿿]/.test(w)) {
      if (w.length > 2 || /[a-z]\d|\d[a-z]/.test(w)) out.push(w);
      continue;
    }
    let loose = '';
    const flush = () => {
      for (let i = 0; i < loose.length - 1; i++) {
        const pair = loose.slice(i, i + 2);
        if (!FUNCTION_CHARS.test(pair)) out.push(pair);
      }
      loose = '';
    };
    for (const { segment } of SEG.segment(w)) {
      if (segment.length === 1) { loose += segment; continue; }
      flush();
      out.push(segment);
    }
    flush();
  }
  return out;
}

const terms = (s) => [...new Set(words(s).filter((t) => !FILLER.has(t) && !/^\d+$/.test(t)))];

/**
 * How often this person uses each word, learned from what they have typed.
 * Rarity inside a hundred saved links says nothing about Chinese in
 * general: "数据" and "设计" are in three entries and in a thousand of the
 * person's messages. Their own speech is the reference corpus, and a word
 * weighs what it tells you: "赞同" little, "招新" a lot.
 */
export function learnVocab(messages, { keep = 3 } = {}) {
  const counts = new Map();
  let total = 0;
  for (const m of messages) {
    if (RELAYED.test(m.text || '')) continue;
    total++;
    for (const t of terms(ownWords(m.text))) counts.set(t, (counts.get(t) || 0) + 1);
  }
  const words = Object.fromEntries([...counts].filter(([, c]) => c >= keep).sort((x, y) => y[1] - x[1]));
  return { total, words };
}

export function readVocab(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return { total: 0, words: {} }; }
}

/**
 * The words in a message that say what it is about. Words in more than one
 * of this person's messages in 500 are how they talk, not what they are
 * talking about.
 */
export function keywords(text, vocab = { total: 0, words: {} }) {
  const M = vocab.total || 1;
  return terms(ownWords(text)).filter((t) => (vocab.words[t] || 0) <= M / 500);
}

/**
 * Earlier links that look relevant to a new message.
 *
 * This runs on every prompt, so it is tuned to stay quiet; a reminder that
 * fires on noise teaches everyone to skip it. Replaying eleven thousand real
 * messages, plain BM25 with a cut-off fired on 40% of them: a pasted log says
 * "source" and "repo", and so does every GitHub entry. What identifies a link
 * is a word this person rarely uses, shared with the link's title or with
 * what they said when handing it over. A hit needs two such words, and
 * enough rarity between them; tuned on that replay, it fires on about one
 * message in two hundred, and the model decides whether to mention it.
 */
export function recall(book, text, { limit = 3, rare = 5, min = 10, vocab = { total: 0, words: {} }, skip = () => false } = {}) {
  if (RELAYED.test(String(text || ''))) return [];
  const M = vocab.total || 1;
  const said = (t) => vocab.words[t] || 0;
  const asked = keywords(text, vocab);
  if (asked.length < 2) return [];
  const all = book.all();
  const fields = all.map((e) => {
    // What the user said about a link identifies it only while it is short;
    // a pasted paragraph says a hundred things and is treated like body text.
    const words = e.said.map((s) => s.text);
    return {
      e,
      own: new Set(terms([e.title, ...words.filter((t) => t.length <= 80), ...(e.notes || []).map((n) => n.text), ...(e.topics || [])].join(' '))),
      body: new Set(terms([e.text || '', ...words.filter((t) => t.length > 80)].join(' '))),
    };
  });
  const df = new Map();
  for (const f of fields) for (const t of new Set([...f.own, ...f.body])) df.set(t, (df.get(t) || 0) + 1);
  const weight = (t) => Math.log((M + 1) / (said(t) + 1));
  const out = [];
  for (const f of fields) {
    if (skip(f.e)) continue;
    const inOwn = asked.filter((t) => f.own.has(t) && df.get(t) <= rare);
    const inBody = asked.filter((t) => !f.own.has(t) && f.body.has(t) && df.get(t) <= rare);
    if (!inOwn.length || inOwn.length + inBody.length < 2) continue;
    const score = inOwn.reduce((s, t) => s + weight(t), 0) + 0.5 * inBody.reduce((s, t) => s + weight(t), 0);
    if (score < min) continue;
    out.push({ link: f.e, score: +score.toFixed(2), matched: [...inOwn, ...inBody] });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Explicit search, when someone asks: ranked, not gated. */
export function find(book, query, { limit = 8 } = {}) {
  const docs = book.all().map((e) => ({
    key: e.key, title: e.title || '', description: e.text || '', url: e.url, link: e,
    claims: [...e.said.map((s) => s.text), ...(e.notes || []).map((n) => n.text)],
    tags: [...new Set(e.said.map((s) => s.project).filter(Boolean)), ...(e.topics || [])],
  }));
  return new Index(docs).search(query, { limit }).map((h) => h.entry.link);
}

// "我之前给过你一个…的帖子", "上次发你那个仓库": a direct question about an
// earlier link, which deserves a looser search than an unprompted reminder.
const ASKING = /(之前|以前|上次|前几天|前阵子|那天|早先|先前).{0,16}(给|发|贴|丢|分享|转)(过|了|你|给)|我(给|发)过你|(那个|那篇|那条)(帖子|推|链接|仓库|repo|网站|文章|视频)/i;
export const asksAboutPast = (text) => ASKING.test(String(text || ''));

/** One line a person can recognise the link by. */
export function describe(e, { max = 90 } = {}) {
  // The longest thing said that is still a remark rather than a pasted
  // paragraph says best why the link was sent.
  const remarks = e.said.map((s) => s.text).filter(Boolean);
  const said = remarks.filter((t) => t.length <= 80).sort((a, b) => b.length - a.length)[0] || remarks[0] || '';
  const what = (e.title || e.text || '').replace(/\s+/g, ' ').slice(0, max);
  const note = e.notes?.length ? e.notes[e.notes.length - 1].text : '';
  return { day: e.first_seen.slice(0, 10), what, said: said.slice(0, max), note,
    project: e.said.map((s) => s.project).filter(Boolean).pop() || null };
}
