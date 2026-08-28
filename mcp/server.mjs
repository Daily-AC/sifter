#!/usr/bin/env node
// An MCP server over stdio, with no SDK and no dependencies.
//
// The dependency-free choice is a product decision, not asceticism. The
// whole pitch is that an agent can reach this index immediately — one line
// in a config, `npx sifter-mcp`, no install step, no API key, nothing to
// keep running. Pulling in an SDK to speak a few hundred lines of JSON-RPC
// would trade that away for convenience that only the author enjoys.

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Library } from '../src/store.mjs';
import { search } from '../src/search.mjs';
import { verifySubmission, issueUrl } from '../src/submit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB = process.env.SIFTER_DB || join(HERE, '..', 'data', 'resources.jsonl');
// The jsonl is the shipped index; the packaged .json is a convenience view
// for anything fetching a single file, and is not in the npm tarball.
const PUBLIC_JSONL = join(HERE, '..', 'index', 'resources.jsonl');
const PUBLIC_JSON = join(HERE, '..', 'index', 'resources.json');

// The index is a file that other commands rewrite; re-read it when it moves
// so a long-lived agent session does not serve a stale library forever.
let cache = { at: 0, mtime: 0, lib: null };
function library() {
  const path = existsSync(DB) ? DB : null;
  if (path) {
    const m = statSync(path).mtimeMs;
    if (!cache.lib || cache.mtime !== m) cache = { mtime: m, lib: Library.open(path) };
    return cache.lib;
  }
  if (existsSync(PUBLIC_JSONL)) {
    const m = statSync(PUBLIC_JSONL).mtimeMs;
    if (!cache.lib || cache.mtime !== m) cache = { mtime: m, lib: Library.open(PUBLIC_JSONL) };
    return cache.lib;
  }
  if (existsSync(PUBLIC_JSON)) {
    const m = statSync(PUBLIC_JSON).mtimeMs;
    if (!cache.lib || cache.mtime !== m) {
      cache = { mtime: m, lib: new Library(JSON.parse(readFileSync(PUBLIC_JSON, 'utf8')).entries || []) };
    }
    return cache.lib;
  }
  return new Library([]);
}

const brief = (e) => ({
  key: e.key,
  name: e.title || e.names?.[0] || e.key,
  url: e.url,
  description: e.description || e.claims?.[0]?.text || null,
  sections: e.sections?.length ? e.sections : undefined,
  tags: e.tags?.length ? e.tags.slice(0, 8) : undefined,
  status: e.liveness?.status || 'unchecked',
  checked_at: e.liveness?.checked_at,
  sources: e.mentions,
  stars: e.github?.stars,
  flags: e.flags?.length ? e.flags : undefined,
  // What the people who shared it said, kept distinct from what the site
  // says about itself, so an agent can tell a pitch from a description.
  claimed: e.claims?.slice(0, 3).map((c) => c.text),
});

const TOOLS = [
  {
    name: 'sifter_search',
    description:
      'Search a curated index of resource websites (design galleries, UI component libraries, tools) '
      + 'collected from social posts and browser bookmarks, deduplicated across sources and liveness-checked. '
      + 'Queries may be English or Chinese; the index bridges the two. '
      + 'Use this before recommending a website or looking for a component library, design reference, or tool.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you are looking for, e.g. "animated react components" or "网页设计灵感"' },
        limit: { type: 'integer', description: 'Max results (default 8)', minimum: 1, maximum: 50 },
        include_risky: { type: 'boolean', description: 'Include entries flagged legal_risk (default false)' },
        only_alive: { type: 'boolean', description: 'Only entries verified reachable on the last check (default false)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'sifter_list',
    description: 'Browse the index by section or tag, or list everything. Use when you want an overview rather than a specific match.',
    inputSchema: {
      type: 'object',
      properties: {
        section: { type: 'string', description: 'Filter by section, e.g. "审美 设计相关"' },
        tag: { type: 'string', description: 'Filter by tag' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
    },
  },
  {
    name: 'sifter_submit',
    description:
      'Propose a resource website for the shared index. Verifies the URL locally first — privacy screen, '
      + 'liveness check, real metadata, duplicate check — and returns a prefilled GitHub issue link for a human '
      + 'to open. It does NOT file anything; submitting is the user\'s explicit act. Use when you or the user '
      + 'find a resource worth adding, and show the returned URL to the user.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The resource URL' },
        note: { type: 'string', description: 'One or two sentences on why it is worth indexing' },
        from: { type: 'string', description: 'Optional: the post URL where you saw it recommended' },
      },
      required: ['url'],
    },
  },
  {
    name: 'sifter_get',
    description: 'Full record for one entry, including every source that mentioned it and what each claimed.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string', description: 'Entry key, e.g. "ui.shadcn.com"' } },
      required: ['key'],
    },
  },
];

function call(name, args = {}) {
  const lib = library();
  const all = lib.all();
  if (!all.length) {
    return { text: 'The sifter index is empty. Populate it with `sifter add <post-url>` or `sifter chrome --folder "<name>"`.' };
  }

  if (name === 'sifter_search') {
    const res = search(all, String(args.query || ''), {
      limit: Math.min(args.limit || 8, 50),
      filter: (e) => {
        if ((e.flags || []).includes('private')) return false;
        if (!args.include_risky && (e.flags || []).includes('legal_risk')) return false;
        if (args.only_alive && e.liveness?.status !== 'alive') return false;
        return true;
      },
    });
    return { json: { query: args.query, count: res.length, results: res.map((r) => ({ ...brief(r.entry), score: +r.score.toFixed(3) })) } };
  }

  if (name === 'sifter_list') {
    let rows = all.filter((e) => !(e.flags || []).includes('private') && !(e.flags || []).includes('legal_risk'));
    if (args.section) rows = rows.filter((e) => (e.sections || []).some((s) => s.includes(args.section)));
    if (args.tag) rows = rows.filter((e) => (e.tags || []).includes(args.tag));
    rows.sort((a, b) => (b.mentions - a.mentions) || ((b.github?.stars || 0) - (a.github?.stars || 0)));
    return { json: { count: rows.length, entries: rows.slice(0, Math.min(args.limit || 50, 200)).map(brief) } };
  }

  if (name === 'sifter_submit') {
    return { pending: verifySubmission(String(args.url || ''), { note: args.note || null, from: args.from || null, lib })
      .then((v) => (v.ok
        ? { json: { verified: true, entry: v.entry, duplicate: v.duplicate, warnings: v.warnings,
                    issue_url: issueUrl(v),
                    next_step: 'Nothing has been filed. Show the issue_url to the user and let them decide to open it.' } }
        : { json: { verified: false, reason: v.reason, message: v.message,
                    next_step: 'Tell the user why it was refused. Do not file it.' } })) };
  }

  if (name === 'sifter_get') {
    const e = lib.get(String(args.key)) || all.find((x) => (x.aliases || []).includes(String(args.key)));
    if (!e) return { text: `No entry "${args.key}".` };
    if ((e.flags || []).includes('private')) return { text: `Entry "${args.key}" is marked private and is not served.` };
    return { json: e };
  }

  throw new Error(`unknown tool: ${name}`);
}

// ---- JSON-RPC over stdio ----------------------------------------------

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

// Requests that reach the network finish after the line that started them.
// Exiting the moment stdin closes drops their replies on the floor — which
// is invisible in a long-lived MCP session and immediate when anything
// pipes input in and closes it.
const inflight = new Set();
const track = (p) => {
  inflight.add(p);
  const done = () => inflight.delete(p);
  p.then(done, done);
  return p;
};
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

function handle(req) {
  const { id, method, params } = req;
  if (method === 'initialize') {
    return ok(id, {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'sifter', version: '0.1.0' },
    });
  }
  if (method === 'notifications/initialized' || method?.startsWith('notifications/')) return;
  if (method === 'tools/list') return ok(id, { tools: TOOLS });
  if (method === 'ping') return ok(id, {});
  if (method === 'tools/call') {
    try {
      const out = call(params?.name, params?.arguments || {});
      // Submission has to hit the network, so it alone answers asynchronously.
      if (out.pending) {
        track(out.pending
          .then((r) => ok(id, { content: [{ type: 'text', text: r.text ?? JSON.stringify(r.json, null, 2) }] }))
          .catch((err) => ok(id, { content: [{ type: 'text', text: `sifter error: ${err.message}` }], isError: true })));
        return;
      }
      const text = out.text ?? JSON.stringify(out.json, null, 2);
      return ok(id, { content: [{ type: 'text', text }] });
    } catch (err) {
      return ok(id, { content: [{ type: 'text', text: `sifter error: ${err.message}` }], isError: true });
    }
  }
  if (id !== undefined) fail(id, -32601, `method not found: ${method}`);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    try { handle(req); } catch (err) { if (req?.id !== undefined) fail(req.id, -32603, String(err.message)); }
  }
});
process.stdin.on('end', async () => {
  if (inflight.size) {
    await Promise.race([
      Promise.allSettled([...inflight]),
      new Promise((r) => setTimeout(r, 30_000).unref?.()),
    ]);
  }
  process.exit(0);
});
