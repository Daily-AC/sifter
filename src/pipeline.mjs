// The verbs, kept out of the CLI so the MCP server and any script can call
// exactly what the terminal calls.

import { Library, save } from './store.mjs';
import { fetchPost, tweetId } from './sources/x.mjs';
import { extractFromPost, leadsIn } from './extract.mjs';
import { readFolder, findProfiles, listFolders } from './sources/chrome.mjs';
import { probe, probeGithub, probeAll } from './probe.mjs';
import { publishable, sanitizeEntry } from './risk.mjs';
import { normalizeUrl, groupKey } from './canonical.mjs';

/** Add posts and/or plain resource URLs. */
export async function collect(lib, inputs, { onItem = () => {}, from = null } = {}) {
  // A post that lists six products and links none of them is a common genre;
  // the names are real recommendations, the URLs are in the replies or an
  // image. Someone resolves them by hand, and without `from` that work lands
  // in the index as an anonymous manual entry, severing it from the post
  // that recommended it — losing both the attribution and the corroboration
  // count. `resolved_by_hand` marks the link as human-supplied rather than
  // read out of the text, because sifter itself will not guess a URL.
  let fromPost = null;
  if (from) {
    const post = await fetchPost(from);
    fromPost = {
      type: 'x', post: post.url, post_id: post.id, author: post.author,
      at: post.created_at, context: (post.text || '').split(/\r?\n/)[0]?.slice(0, 240) || null,
      engagement: { likes: post.likes ?? null, retweets: post.retweets ?? null, views: post.views ?? null },
      channel: post.channel, resolved_by_hand: true,
    };
  }
  const stats = { posts: 0, direct: 0, added: 0, merged: 0, failed: [] };
  for (const raw of inputs) {
    const id = tweetId(raw);
    try {
      if (id) {
        const post = await fetchPost(id);
        const cands = extractFromPost(post);
        stats.posts++;
        for (const c of cands) {
          const r = lib.upsert(c);
          if (r) { r.created ? stats.added++ : stats.merged++; onItem(r, post); }
        }
        if (!cands.length) {
          const leads = leadsIn(post.text);
          stats.failed.push(leads.length
            ? `${raw}: no links in the post, but it names ${leads.length}: ${leads.join(', ')}`
            : `${raw}: post had no links`);
          if (leads.length) (stats.leads ||= []).push({ post: post.url, names: leads });
        }
      } else {
        const url = normalizeUrl(raw);
        if (!url) { stats.failed.push(`${raw}: not a URL`); continue; }
        const r = lib.upsert({
          url, name: null,
          source: fromPost || { type: 'manual', at: new Date().toISOString() },
        });
        stats.direct++;
        if (r) { r.created ? stats.added++ : stats.merged++; onItem(r, null); }
      }
    } catch (err) { stats.failed.push(`${raw}: ${err.message}`); }
  }
  return stats;
}

/**
 * Locate a folder by name across every browser profile on the machine.
 * Nobody knows which Chrome profile their bookmarks live in, and being told
 * "no folder matched" because the tool guessed `Default` is a lie about the
 * data. Search all of them; only ask when the name is genuinely ambiguous.
 */
export function findFolder(folder, { profiles = findProfiles() } = {}) {
  const want = String(folder || '').trim().toLowerCase();
  if (!want) throw new Error('a folder name is required; sifter never reads your whole bookmark tree.');
  const hits = [];
  for (const p of profiles) {
    let folders = [];
    try { folders = listFolders(p.path); } catch { continue; }
    for (const f of folders) {
      const full = f.folder.toLowerCase();
      const leaf = full.split('/').pop();
      if (leaf === want || full === want || full.endsWith('/' + want)) hits.push({ ...p, folder: f.folder, count: f.count });
    }
  }
  if (!hits.length) {
    const all = profiles.flatMap((p) => { try { return listFolders(p.path).map((f) => `${p.browser}/${p.profile}: ${f.folder} (${f.count})`); } catch { return []; } });
    throw new Error(`no bookmark folder named "${folder}" in any profile.\nFound:\n  ` + (all.join('\n  ') || '(none)'));
  }
  if (hits.length > 1) {
    const distinct = new Set(hits.map((h) => `${h.browser}/${h.profile}`));
    if (distinct.size > 1) {
      throw new Error(`"${folder}" exists in more than one profile; pick one with --profile:\n  `
        + hits.map((h) => `${h.browser}/${h.profile} (${h.count} bookmarks)`).join('\n  '));
    }
  }
  return hits.sort((a, b) => b.count - a.count)[0];
}

export function collectChrome(lib, { profilePath, folder, tag }) {
  const bookmarks = readFolder(profilePath, folder);
  const stats = { read: bookmarks.length, added: 0, merged: 0, skipped: 0 };
  for (const b of bookmarks) {
    const r = lib.upsert({
      url: b.url,
      name: b.title || null,
      section: b.folderName || null,
      tags: tag ? [tag] : [],
      source: { type: 'chrome', folder: b.folder, at: b.added, title: b.title },
    });
    if (!r) { stats.skipped++; continue; }
    r.created ? stats.added++ : stats.merged++;
  }
  return stats;
}

/** Verify and enrich. Entries checked recently are left alone. */
export async function refresh(lib, { maxAge = 7 * 864e5, only, concurrency = 6, onResult = () => {} } = {}) {
  const cutoff = Date.now() - maxAge;
  const total = lib.all().length;
  const due = lib.all().filter((e) => {
    if (only && !only(e)) return false;
    if ((e.flags || []).includes('private')) return false;   // never phone home for a private URL
    const at = e.liveness?.checked_at ? Date.parse(e.liveness.checked_at) : 0;
    return at < cutoff;
  });

  const gh = due.filter((e) => /^github\.com\//.test(e.key));
  const web = due.filter((e) => !/^github\.com\//.test(e.key));

  for (const e of gh) {
    const [, owner, repo] = e.key.split('/');
    const r = await probeGithub(owner, repo);
    const merged = r ? { ...r, checked_at: new Date().toISOString(), url: e.url } : await probe(e.url);
    lib.applyProbe(e.key, merged);
    onResult(e, merged);
  }

  const results = await probeAll(web.map((e) => e.url), { concurrency });
  results.forEach((r, i) => { lib.applyProbe(web[i].key, r); onResult(web[i], r); });

  // Counted before merging: folding two entries into one must not read as
  // a negative number of skipped entries.
  const skipped = total - due.length;
  const merged = lib.mergeRedirects();
  return { checked: due.length, skipped, merged };
}

/** The subset that may ship, plus the reasons for everything held back. */
export function exportable(lib, { allowRisk = false } = {}) {
  const out = [], held = [];
  for (const e of lib.all()) {
    const v = publishable(e, { allowRisk });
    if (!v.ok) { held.push({ key: e.key, why: v.why }); continue; }
    out.push(sanitizeEntry(e));
  }
  out.sort((a, b) => (b.mentions - a.mentions) || (a.key < b.key ? -1 : 1));
  return { entries: out, held };
}

export { Library, save, findProfiles, listFolders, groupKey };
