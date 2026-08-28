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

const looksLikeHeading = (line) => {
  const bare = line.replace(EMOJI, '').trim();
  if (!bare || bare.length > 24) return false;
  if (URL_RE.test(line)) { URL_RE.lastIndex = 0; return false; }
  if (ORDINAL.test(line)) return false;
  // A heading is a short noun phrase: not a sentence, and not the lead-in
  // line that introduces the list ("这 5 个网站够用了：" ends in a colon and
  // is prose, however short).
  if (/[。！？.!?：:，,]$/.test(bare)) return false;
  if (/\d/.test(bare) && /[个条种款]/.test(bare)) return false;
  return true;
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
      if (looksLikeHeading(line)) section = clean(line) || null;
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
      if (!name) {
        for (let k = i - 1; k >= 0 && k >= i - 2; k--) {
          const prev = lines[k].trim();
          if (!prev) continue;
          URL_RE.lastIndex = 0;
          if (URL_RE.test(prev)) break;
          if (looksLikeHeading(prev)) { section = section || clean(prev); break; }
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
