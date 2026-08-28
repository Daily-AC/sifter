// Flags entries that are fine to keep privately but risky to publish.
//
// A shared index of shadow libraries and streaming mirrors is a DMCA target,
// and a repository that can be taken down is a repository nobody can rely
// on. So risk is *marked*, never silently dropped: the local library keeps
// everything the user actually saw, and export decides what ships. Changing
// your mind later is a flag filter, not a re-crawl.
//
// This is a heuristic and says so. It is tuned to over-flag, and `sifter
// review` exists so a person can overrule it either way.

const KNOWN_SHADOW = [
  'z-library.sk', 'z-lib.io', 'z-lib.org', 'singlelogin.re', 'zlibrary',
  'annas-archive', 'libgen', 'sci-hub', 'welib.org', 'b-ok', 'bookfi',
  'nexusstc', 'pirate', '1337x', 'thepiratebay', 'rarbg', 'nyaa',
  'fmovies', 'putlocker', '123movies', 'sflix', 'kgbook',
];

const RISK_WORDS = [
  /破解|免费下载|无损下载|盗版|绿色版|激活码|注册机|去广告版|开心版/,
  /在线观看|免费看剧|免费追剧|影视资源|磁力|种子|BT下载|网盘资源/,
  /crack(ed)?\b|keygen|nulled|warez|torrent|piracy|free movies|watch free/i,
];

const RISK_SECTIONS = /影视|电影|美剧|追剧|音乐|听歌|电子书|书籍|漫画|资源站|软件下载/;

// Netdisk share links rot within weeks and often carry redistributed media.
const EPHEMERAL_SHARE = /pan\.quark\.cn|pan\.baidu\.com|aliyundrive|alipan\.com|mega\.nz|123pan|lanzou/;

export function assessRisk(entry) {
  const flags = new Set();
  // The framing of the post an entry came from counts as evidence about it.
  const contexts = (entry.sources || []).map((s) => s.context).filter(Boolean);
  const hay = [
    entry.key, entry.url, entry.title, entry.description,
    ...(entry.names || []), ...(entry.claims || []).map((c) => c.text),
    ...(entry.sections || []), ...contexts,
  ].filter(Boolean).join(' ');

  if (KNOWN_SHADOW.some((d) => (entry.key || '').includes(d) || (entry.url || '').includes(d))) {
    flags.add('legal_risk');
    flags.add('shadow_library');
  }
  if (RISK_WORDS.some((re) => re.test(hay))) flags.add('legal_risk');
  // A media-shaped section plus a free-stuff framing anywhere in the post
  // condemns the whole list, not just the lines that said so themselves.
  const freeFraming = /免费|白嫖|不花钱|不想花钱|省钱|资源站|下载|观看|追剧|听歌|看片/.test(
    [...contexts, ...(entry.sections || []), ...(entry.claims || []).map((c) => c.text)].join(' '));
  if ((entry.sections || []).some((s) => RISK_SECTIONS.test(s)) && freeFraming) flags.add('legal_risk');
  if (EPHEMERAL_SHARE.test(entry.url || '')) { flags.add('ephemeral'); flags.add('legal_risk'); }

  return [...flags];
}

/**
 * Strips provenance that identifies the person who curated an entry.
 *
 * Sources are worth publishing — they are why an entry is trustworthy — but
 * they are not equally public. A post is already public and its author
 * deserves the credit, so it ships whole. A bookmark is a record of one
 * person's browsing: the folder path names how they organize their work,
 * and a millisecond timestamp says when they were at their desk. Neither
 * adds anything for a reader; both are somebody's private life.
 *
 * So local sources survive as evidence of corroboration and nothing more.
 */
export function sanitizeSources(sources = []) {
  return sources.map((s) => {
    if (s.type === 'x') return s;
    if (s.type === 'chrome') return { type: 'bookmark', at: s.at ? String(s.at).slice(0, 7) : undefined };
    const { by, path, folder, title, ...rest } = s;
    return { ...rest, at: s.at ? String(s.at).slice(0, 7) : undefined };
  });
}

/**
 * What may be published.
 * Beyond risk flags, this enforces the rule that saved the day during
 * development: an entry that only exists because a PRIVATE url was demoted
 * to its public parent is not published unless some independent, public
 * source also vouched for it. Otherwise walking up from an employer's login
 * page quietly publishes the employer's domain.
 */
export function publishable(entry, { allowRisk = false } = {}) {
  const flags = entry.flags || [];
  if (flags.includes('private')) return { ok: false, why: 'private' };
  if (!allowRisk && flags.includes('legal_risk')) return { ok: false, why: 'legal_risk' };
  if (flags.includes('demoted')) {
    const vouched = (entry.sources || []).some((s) => s.type !== 'chrome');
    if (!vouched) return { ok: false, why: 'demoted-without-public-source' };
  }
  if (entry.liveness?.status === 'dead') return { ok: false, why: 'dead' };
  return { ok: true };
}
