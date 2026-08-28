// Letting other people add to the index.
//
// The obvious version of "submit a link" is a form that takes a URL and a
// sentence, and it produces a queue of work for whoever maintains the list:
// dead links, duplicates of things already indexed, someone's dashboard URL
// pasted by accident, and descriptions written by whoever was most excited.
//
// So a submission runs the same pipeline the index itself runs — normalize,
// privacy screen, fetch, liveness, risk — BEFORE it becomes anyone else's
// problem. What reaches the maintainer is a verified record: the site's own
// title and description, a liveness verdict with a timestamp, and a note
// saying whether it duplicates something already there. Contributions that
// cannot pass are refused with the reason, on the contributor's machine,
// where it costs one person ten seconds instead of a reviewer ten minutes.
//
// Nothing is transmitted anywhere by this module. It returns a payload and
// a URL; opening it is a separate, explicit act.

import { normalizeUrl, groupKey } from './canonical.mjs';
import { screen } from './privacy.mjs';
import { probe, probeGithub } from './probe.mjs';
import { assessRisk } from './risk.mjs';

export const REPO = process.env.SIFTER_REPO || 'Daily-AC/sifter';

/**
 * Verify a candidate the way the pipeline would.
 * Returns { ok, reason, entry, duplicate } — never throws for bad input.
 */
export async function verifySubmission(rawUrl, { note = null, from = null, lib = null } = {}) {
  const url = normalizeUrl(rawUrl);
  if (!url) return { ok: false, reason: 'not-a-url', message: `"${rawUrl}" is not a URL.` };

  const priv = screen(url);
  if (priv.private) {
    return {
      ok: false, reason: 'private',
      message: priv.publicAncestor
        ? `That looks like a personal or logged-in page (${priv.reasons.join(', ')}). Did you mean ${priv.publicAncestor}?`
        : `That looks like a personal or logged-in page (${priv.reasons.join(', ')}), so it will not be published.`,
    };
  }

  const key = groupKey(url);
  const existing = lib?.get(key);

  const m = key.match(/^github\.com\/([^/]+)\/([^/]+)$/);
  const result = m ? (await probeGithub(m[1], m[2])) || (await probe(url)) : await probe(url);

  if (result.status === 'dead') {
    return { ok: false, reason: 'dead', message: `That URL is not reachable (${result.note || result.code}).` };
  }

  const entry = {
    key, url,
    title: result.ogTitle || result.title || null,
    description: result.description || null,
    note: note || null,
    liveness: { status: result.status, code: result.code ?? null, checked_at: result.checked_at, note: result.note ?? null },
    github: result.stars !== undefined
      ? { stars: result.stars, language: result.language, topics: result.topics, archived: result.archived, license: result.license }
      : undefined,
    from: from || null,
  };
  entry.flags = assessRisk({ ...entry, names: [], claims: note ? [{ text: note }] : [], sections: [], sources: [] });

  return {
    ok: true,
    entry,
    duplicate: existing ? { key: existing.key, mentions: existing.mentions, url: existing.url } : null,
    warnings: [
      result.status === 'blocked' ? 'The site answered, but refuses automated checks, so its metadata could not be read.' : null,
      entry.flags.includes('legal_risk') ? 'Flagged legal_risk by the heuristic; a maintainer will decide.' : null,
      !entry.title ? 'No title could be read — likely a client-rendered page. Please add a description in the note.' : null,
    ].filter(Boolean),
  };
}

/** The issue body a maintainer will read. */
export function renderIssue(v) {
  const e = v.entry;
  const lines = [
    `**URL:** ${e.url}`,
    `**Key:** \`${e.key}\``,
    '',
    '### Verified locally by sifter',
    '',
    '| | |',
    '|---|---|',
    `| Liveness | \`${e.liveness.status}\`${e.liveness.code ? ` (HTTP ${e.liveness.code})` : ''} — checked ${e.liveness.checked_at} |`,
    `| Title | ${e.title ? e.title.replace(/\|/g, '\\|') : '_none readable_'} |`,
    `| Description | ${e.description ? e.description.slice(0, 300).replace(/\|/g, '\\|') : '_none_'} |`,
  ];
  if (e.github) {
    lines.push(`| GitHub | ★${e.github.stars}${e.github.language ? ` · ${e.github.language}` : ''}`
      + `${e.github.license ? ` · ${e.github.license}` : ''}${e.github.archived ? ' · **archived**' : ''} |`);
  }
  if (e.flags?.length) lines.push(`| Flags | ${e.flags.map((f) => `\`${f}\``).join(', ')} |`);
  if (e.from) lines.push(`| Seen in | ${e.from} |`);
  lines.push('');
  if (e.note) lines.push('### Why it is worth indexing', '', e.note, '');
  if (v.duplicate) {
    lines.push(`> ⚠︎ Already in the index as \`${v.duplicate.key}\` (${v.duplicate.mentions} source(s)).`,
      '> Submitting anyway records one more independent mention, which raises its ranking.', '');
  }
  for (const w of v.warnings) lines.push(`> ⚠︎ ${w}`);
  if (v.warnings.length) lines.push('');
  lines.push('---', '',
    '<sub>Submitted with `sifter submit`. Liveness and metadata above were fetched on the submitter\'s',
    'machine at the time shown; a maintainer re-verifies before merging.</sub>');
  return lines.join('\n');
}

/** A prefilled issue URL — works for anyone, with nothing installed. */
export function issueUrl(v, { repo = REPO } = {}) {
  const title = `Add: ${v.entry.title || v.entry.key}`;
  const q = new URLSearchParams({ title, body: renderIssue(v), labels: 'submission' });
  return `https://github.com/${repo}/issues/new?${q}`;
}

/** The line this entry would occupy in the index, for a pull request. */
export function toIndexEntry(v, { submitter = null } = {}) {
  const e = v.entry;
  const now = new Date().toISOString();
  return {
    key: e.key, url: e.url, title: e.title, description: e.description,
    names: e.title ? [e.title] : [],
    claims: e.note ? [{ text: e.note, from: e.from || 'submission' }] : [],
    sections: [], tags: [], flags: e.flags || [],
    liveness: e.liveness,
    ...(e.github ? { github: e.github } : {}),
    sources: [{ type: 'submission', at: now, ...(submitter ? { by: submitter } : {}), ...(e.from ? { post: e.from } : {}) }],
    mentions: 1, first_seen: now, last_seen: now, updated_at: now,
  };
}
