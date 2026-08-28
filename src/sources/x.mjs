// Reading a resource post off X, without an API key and without a login.
//
// Three channels, tried in order, because the obvious one is quietly lossy:
//
//   fxtwitter        full text, t.co links already expanded          <- preferred
//   syndication      official, no auth, but TRUNCATES long posts     <- fallback
//   omnireach        the user's own tool; the only one that can SEARCH
//
// The truncation is the whole reason for the ladder. On the very post that
// started this project, syndication returned 176 of 341 characters and 2 of
// 5 links — the last three sites would have silently never existed. A
// pipeline that trusts one channel inherits its blind spot, so the ladder
// prefers completeness and records which channel answered.

import { normalizeUrl } from '../canonical.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export function tweetId(input) {
  if (/^\d{10,25}$/.test(String(input).trim())) return String(input).trim();
  const m = String(input).match(/(?:twitter|x)\.com\/[^/]+\/status(?:es)?\/(\d+)/i);
  return m?.[1] || null;
}

async function getJson(url, timeout = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: ctl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; } finally { clearTimeout(t); }
}

/** Every http(s) link in the text, in order, deduped. */
export function linksIn(text) {
  const found = (text || '').match(/https?:\/\/[^\s<>"'）)】\]]+/g) || [];
  const seen = new Set();
  const out = [];
  for (const raw of found) {
    const n = normalizeUrl(raw);
    if (!n) continue;
    // t.co links are unexpanded shorteners; they carry no information about
    // the destination, so a post full of them is a failed fetch, not data.
    if (/^https:\/\/t\.co\//.test(n)) { out.push({ url: n, shortened: true }); continue; }
    if (seen.has(n)) continue;
    seen.add(n);
    out.push({ url: n, shortened: false });
  }
  return out;
}

async function viaFx(id) {
  const d = await getJson(`https://api.fxtwitter.com/i/status/${id}`);
  const t = d?.tweet;
  if (!t?.text) return null;
  return {
    id, channel: 'fxtwitter',
    text: t.text,
    author: t.author?.screen_name || null,
    author_name: t.author?.name || null,
    created_at: t.created_at ? new Date(t.created_at).toISOString() : null,
    likes: t.likes ?? null, retweets: t.retweets ?? null,
    replies: t.replies ?? null, views: t.views ?? null,
    url: t.url || `https://x.com/i/status/${id}`,
  };
}

async function viaSyndication(id) {
  const d = await getJson(`https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=a`);
  if (!d?.text) return null;
  let text = d.text;
  // Swap t.co back to real destinations where the payload tells us how.
  for (const u of d.entities?.urls || []) {
    if (u.url && u.expanded_url) text = text.split(u.url).join(u.expanded_url);
  }
  const range = d.display_text_range?.[1];
  return {
    id, channel: 'syndication',
    text,
    truncated: typeof range === 'number' && range >= d.text.length,
    author: d.user?.screen_name || null,
    author_name: d.user?.name || null,
    created_at: d.created_at || null,
    likes: d.favorite_count ?? null,
    url: `https://x.com/${d.user?.screen_name || 'i'}/status/${id}`,
  };
}

/**
 * One post, as complete as any available channel can make it.
 * Channels are raced in order and the first *complete-looking* answer wins;
 * a truncated answer is kept only if nothing better arrives.
 */
export async function fetchPost(input) {
  const id = tweetId(input);
  if (!id) throw new Error(`not a post URL or id: ${input}`);

  let best = null;
  for (const get of [viaFx, viaSyndication]) {
    const r = await get(id);
    if (!r) continue;
    r.links = linksIn(r.text);
    r.unexpanded = r.links.filter((l) => l.shortened).length;
    if (!best) best = r;
    // A post whose links are all still t.co told us nothing useful.
    else if (r.unexpanded < best.unexpanded || r.text.length > best.text.length) best = r;
    if (r.unexpanded === 0 && !r.truncated) return r;
  }
  if (!best) throw new Error(`could not read post ${id} through any channel`);
  return best;
}

/**
 * Search needs a logged-in session, which only omnireach has. Optional by
 * design: without it sifter still works, you just feed it links yourself.
 */
export async function searchPosts(query, { limit = 20, omnireach = 'omnireach' } = {}) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  try {
    const { stdout } = await run(omnireach, ['search', query, '--sources', 'twitter', '--limit', String(limit), '--json'], {
      maxBuffer: 32 * 1024 * 1024, timeout: 120000,
    });
    const parsed = JSON.parse(stdout);
    return (parsed.results || []).map((r) => ({
      id: r.raw?.id || tweetId(r.url), url: r.url, author: r.author,
      text: r.raw?.text || r.content, created_at: r.ts,
      likes: r.engagement?.likes, views: r.engagement?.views,
    })).filter((r) => r.id);
  } catch (err) {
    throw new Error(
      `search needs omnireach on PATH (https://github.com/Daily-AC/omnireach).\n`
      + `Without it, pass post URLs directly: sifter add <post-url>\n${String(err.message).slice(0, 200)}`);
  }
}
