// Turning a resource post back into the list its author was writing.
//
// These posts are a genre with a stable shape:
//
//     📚 电子书
//     1. Z-Library：http://zh.z-library.sk —— 综合电子书搜索
//     2. WeLib：https://zh.welib.org —— 图书、教材、学术资料
//
// Three things worth keeping, and they are not equally trustworthy:
//   name    what the author calls it        — a label, often wrong or stylized
//   note    what the author claims it does  — marketing, but it is WHY it was
//                                             posted, so it is kept verbatim
//   section the heading it appeared under   — a free, human-made category
//
// None of it overrides what the site says about itself later; it sits
// alongside as provenance. The author's claim and the site's own <title>
// disagreeing is a signal, not a conflict to resolve here.

import { normalizeUrl } from './canonical.mjs';

const URL_RE = /https?:\/\/[^\s<>"'）)】\]，,；;]+/g;

// Leading list ornaments: "1." "1、" "①" "- " "* " "・"
const ORDINAL = /^\s*(?:[（(]?\d{1,3}[.)、．:：]|[-*·•‣・▪]|[①-⑳]|[⓪-⓿])\s*/u;
// Punctuation between a name and its link, or a link and its blurb.
const SEP_AFTER_NAME = /[：:\-—–|｜>》→\s]+$/u;
const SEP_BEFORE_NOTE = /^[\s：:\-—–|｜(（【\[]*(?:——|--)?[\s：:\-—–]*/u;

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}]/gu;

/**
 * A line holding nothing but a link.
 *
 * This is what separates a section heading from a resource name in the very
 * common "name / link / blurb" layout:
 *
 *     Awwwards — 全球网页设计奥斯卡      <- a name, because a bare URL follows
 *     https://awwwards.com
 *     适合看顶级网页设计
 *
 *     📚 电子书                          <- a heading, because a list follows
 *     1. Z-Library：http://zh.z-library.sk
 *
 * Without the lookahead, every entry in the first layout became its own
 * section and lost its name.
 */
const isBareLink = (line) => {
  const t = (line || '').trim();
  if (!t) return false;
  URL_RE.lastIndex = 0;
  const m = t.match(URL_RE);
  if (!m || m.length !== 1) return false;
  const rest = t.replace(m[0], '').replace(/^[👉➡️→▶️\s·•\-—:：]*/u, '').trim();
  // The link may be trailed by its own blurb on the same line — authors mix
  // "name / link / blurb" and "name / link + blurb" freely inside one post.
  // What matters is that the line STARTS with the link, so the name it
  // belongs to is the line above.
  return rest.length === 0 || t.replace(/^[👉➡️→▶️\s·•\-—:：]*/u, '').startsWith(m[0]);
};

// Words that mean the line is narrating, not labelling.
const NARRATION = /分享|推荐|整理|收藏|介绍|常用|以下|如下|这些|不要错过|建议|存着|安利|盘点/;

const looksLikeHeading = (line, next = null) => {
  // A bare link on the next line means this one names that link.
  if (next !== null && isBareLink(next)) return false;

  const bare = line.replace(EMOJI, '').trim();
  if (!bare) return false;
  if (URL_RE.test(line)) { URL_RE.lastIndex = 0; return false; }
  if (ORDINAL.test(line)) return false;

  // A section heading is a short noun-phrase label — "电子书", "影视",
  // "Tools" — not a sentence. The lead-in above a list is prose and reads
  // as a heading to any length-based rule alone: "之前分享过几个我常用的
  // 审美网站" is 15 characters of narration and became a section.
  if (/[。！？.!?：:，,、]$/.test(bare)) return false;
  if (NARRATION.test(bare)) return false;
  const cjk = (bare.match(/[一-鿿぀-ヿ가-힯]/g) || []).length;
  if (cjk) return bare.length <= 8;
  return bare.split(/\s+/).length <= 3 && bare.length <= 24;
};

const clean = (s) => (s || '').replace(EMOJI, '').replace(/\s+/g, ' ').trim();

/** Resource candidates from one post's text. */
export function extractFromText(text, { maxNote = 200 } = {}) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  let section = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    URL_RE.lastIndex = 0;
    const urls = line.match(URL_RE) || [];

    if (!urls.length) {
      if (!line.trim()) continue;
      let nextNonEmpty = null;
      for (let k = i + 1; k < lines.length; k++) { if (lines[k].trim()) { nextNonEmpty = lines[k]; break; } }
      if (looksLikeHeading(line, nextNonEmpty)) section = clean(line) || null;
      continue;
    }

    for (const raw of urls) {
      const url = normalizeUrl(raw);
      if (!url) continue;
      if (/^https:\/\/t\.co\//.test(url)) continue;      // unexpanded, useless

      const at = line.indexOf(raw);
      let before = line.slice(0, at);
      let after = line.slice(at + raw.length);

      let name = clean(before.replace(ORDINAL, '').replace(SEP_AFTER_NAME, ''));
      let note = clean(after.replace(SEP_BEFORE_NOTE, ''));

      // A link alone on its line borrows the nearest text above and below.
      if (!name && isBareLink(line)) {
        for (let k = i - 1; k >= 0 && k >= i - 2; k--) {
          const prev = lines[k].trim();
          if (!prev) continue;
          URL_RE.lastIndex = 0;
          if (URL_RE.test(prev)) break;
          name = clean(prev.replace(ORDINAL, '').replace(SEP_AFTER_NAME, ''));
          break;
        }
      }
      if (!note) {
        const next = (lines[i + 1] || '').trim();
        URL_RE.lastIndex = 0;
        if (next && !URL_RE.test(next) && !looksLikeHeading(next) && !ORDINAL.test(next)) {
          note = clean(next);
        }
      }

      // A "name" that is really a whole sentence is the post's prose, not a
      // label — keep it as the note instead of pretending it names the site.
      if (name.length > 40 || /[。！？]/.test(name)) {
        if (!note) note = name;
        name = '';
      }

      out.push({
        url,
        name: name || null,
        note: note ? note.slice(0, maxNote) : null,
        section: section || null,
      });
    }
  }

  // A section heading labels a group. One that ended up attached to a
  // single entry is almost always that entry's own name misread as a
  // heading — post layouts vary too much to catch every variant by shape,
  // but a real heading covers several links and a misread name covers one.
  // Losing a genuine single-entry section only costs grouping; keeping a
  // false one pollutes every published index that groups by it.
  const perSection = new Map();
  for (const c of out) if (c.section) perSection.set(c.section, (perSection.get(c.section) || 0) + 1);
  for (const c of out) if (c.section && perSection.get(c.section) < 2) c.section = null;

  // Same link twice in one post: keep the richer mention.
  const byUrl = new Map();
  for (const c of out) {
    const prev = byUrl.get(c.url);
    const score = (x) => (x.name ? 2 : 0) + (x.note ? 1 : 0) + (x.section ? 1 : 0);
    if (!prev || score(c) > score(prev)) byUrl.set(c.url, c);
  }
  return [...byUrl.values()];
}

/**
 * The prose above the list. A post's framing is evidence about every entry
 * under it — "不想花钱，又想看书、追剧、听歌" tells you what all fifteen of
 * those sites are, while no individual line does.
 */
export function postContext(text, { max = 240 } = {}) {
  const lead = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    URL_RE.lastIndex = 0;
    if (URL_RE.test(line)) break;
    if (line.trim()) lead.push(line.trim());
    if (lead.join(' ').length > max) break;
  }
  return lead.join(' ').slice(0, max) || null;
}

/**
 * Names from a list that carries no links at all.
 *
 * A large share of resource posts are written this way on purpose — six
 * numbered products, every link parked in the replies or burned into a
 * screenshot, so the post itself has nothing to extract. Reporting only
 * "no links" throws away the part that was actually informative. These
 * names are returned as leads for a human to resolve; sifter will not guess
 * URLs for them, because a plausible wrong link is worse than none.
 */
export function leadsIn(text) {
  const leads = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    URL_RE.lastIndex = 0;
    if (!ORDINAL.test(line) || URL_RE.test(line)) continue;
    const body = line.replace(ORDINAL, '').trim();
    // "beUI ：页面总差一点..." — the name is what precedes the first
    // sentence-level punctuation.
    const name = clean(body.split(/[：:，,。！？\n]/)[0]);
    if (name && name.length <= 40) leads.push(name);
  }
  return [...new Set(leads)];
}

/** Candidates from a fetched post, tagged with where they came from. */
export function extractFromPost(post) {
  const context = postContext(post.text);
  return extractFromText(post.text).map((c) => ({
    ...c,
    source: {
      type: 'x',
      context,
      post: post.url,
      post_id: post.id,
      author: post.author,
      at: post.created_at,
      engagement: { likes: post.likes ?? null, retweets: post.retweets ?? null, views: post.views ?? null },
      channel: post.channel,
    },
  }));
}
