#!/usr/bin/env node
// sifter — sift scattered resource links into an index an agent can search.

import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { Library, save, collect, collectChrome, refresh, exportable, findProfiles, listFolders, findFolder } from '../src/pipeline.mjs';
import { search } from '../src/search.mjs';
import { verifySubmission, renderIssue, issueUrl, toIndexEntry, REPO } from '../src/submit.mjs';
import { renderMarkdown } from '../src/render.mjs';
import { LinkBook, saveBook, pick, recall, find, enrich, describe, readIgnore, learnVocab, readVocab, asksAboutPast, keywords } from '../src/links.mjs';
import { claudeMessages, codexMessages } from '../src/sources/transcripts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.SIFTER_HOME || join(HERE, '..');
const LOCAL_DB = process.env.SIFTER_DB || join(ROOT, 'data', 'resources.jsonl');
const SHIPPED = join(ROOT, 'index', 'resources.jsonl');

// Reads fall back to the index shipped with the repo, writes never do.
// Without this a fresh `npx sifter search ...` answers "nothing matched"
// while several hundred verified entries sit in index/ — the exact promise
// the README makes, broken on the first command anyone runs.
const dbFor = (mode) => {
  const explicit = flag('db');
  if (explicit && explicit !== true) return String(explicit);
  if (mode === 'write') return LOCAL_DB;
  return existsSync(LOCAL_DB) ? LOCAL_DB : (existsSync(SHIPPED) ? SHIPPED : LOCAL_DB);
};
const DB = LOCAL_DB;
const LINKS = process.env.SIFTER_LINKS || join(ROOT, 'data', 'links.jsonl');
const LINKS_IGNORE = join(dirname(LINKS), 'links-ignore.txt');
const LINKS_VOCAB = join(dirname(LINKS), 'links-vocab.json');

const C = process.stdout.isTTY ? {
  dim: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`, c: (s) => `\x1b[36m${s}\x1b[0m`,
} : new Proxy({}, { get: () => (s) => s });

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name, def = null) => {
  const i = argv.indexOf('--' + name);
  if (i === -1) return def;
  const next = argv[i + 1];
  return !next || next.startsWith('--') ? true : next;
};
const positional = () => argv.slice(1).filter((a, i, arr) =>
  !a.startsWith('--') && !(i > 0 && arr[i - 1].startsWith('--') && !arr[i - 1].includes('=')));

const dot = (s) => ({ alive: C.g('●'), blocked: C.y('◐'), dead: C.r('○'), unknown: C.dim('?') }[s] || C.dim('·'));

function usage() {
  console.log(`${C.b('sifter')} — sift scattered resource links into a searchable index

  ${C.b('sifter add')} <url|post-url>...      add resource posts or plain links
  ${C.b('sifter add')} <url> --from <post>    credit a hand-resolved link to its post
  ${C.b('sifter chrome')} --folder <name>     import ONE named bookmark folder
  ${C.b('sifter chrome')} --list              show folders you could import
  ${C.b('sifter refresh')} [--all]            check liveness + pull real metadata
  ${C.b('sifter search')} <query>             search the library
  ${C.b('sifter list')} [--flag <f>]          list entries
  ${C.b('sifter submit')} <url> --note "..."  propose a resource for the shared index
  ${C.b('sifter export')} [--out <dir>]       write the publishable index
  ${C.b('sifter stats')}                      what's in the library
  ${C.b('sifter links')} [query]              links you handed your agent, newest first or by relevance
  ${C.b('sifter links note')} <url> "..."     record what came of one
  ${C.b('sifter links backfill')}             pull links out of past Claude Code / Codex sessions

  ${C.dim('--json')}       machine-readable output
  ${C.dim('--db <path>')}  library location (default ${DB.replace(homedir(), '~')})

  ${C.dim('sifter never reads your whole bookmark tree; name the folder you want.')}`);
}

const WRITES = new Set(['add', 'chrome', 'refresh']);
const lib = Library.open(dbFor(WRITES.has(cmd) ? 'write' : 'read'));
const persist = () => save(dbFor('write'), lib.all());
const json = () => argv.includes('--json');

switch (cmd) {
  case 'add': {
    const inputs = positional();
    if (!inputs.length) { console.error('usage: sifter add <url>...'); process.exit(1); }
    const st = await collect(lib, inputs, {
      from: flag('from') === true ? null : flag('from'),
      onItem: (r) => { if (!json()) console.log(`  ${r.created ? C.g('+') : C.dim('=')} ${r.entry.key}`); },
    });
    persist();
    if (json()) console.log(JSON.stringify(st, null, 2));
    else {
      console.log(`\n${st.posts} post(s), ${st.direct} direct link(s) → ${C.b(st.added)} new, ${st.merged} merged`);
      for (const f of st.failed) console.log(C.r('  ! ') + f);
      if (st.added) console.log(C.dim('\nrun `sifter refresh` to verify them and pull real titles'));
    }
    break;
  }

  case 'chrome': {
    const profiles = findProfiles();
    if (!profiles.length) { console.error('no Chromium bookmark file found'); process.exit(1); }
    const want = flag('profile');

    if (argv.includes('--list') || !flag('folder')) {
      for (const p of profiles) {
        if (want && want !== true && p.profile !== want && p.browser !== want) continue;
        let folders = [];
        try { folders = listFolders(p.path); } catch { continue; }
        if (!folders.length) continue;
        console.log(C.b(`${p.browser}/${p.profile}`));
        for (const f of folders) console.log(`  ${String(f.count).padStart(4)}  ${f.folder || '(root)'}`);
      }
      console.log(C.dim('\nimport one with: sifter chrome --folder "<name>"'));
      break;
    }

    let target;
    try {
      target = findFolder(String(flag('folder')), {
        profiles: want && want !== true ? profiles.filter((p) => p.profile === want || p.browser === want) : profiles,
      });
    } catch (err) { console.error(C.r(err.message)); process.exit(1); }

    const st = collectChrome(lib, { profilePath: target.path, folder: target.folder, tag: flag('tag') === true ? null : flag('tag') });
    persist();
    console.log(json() ? JSON.stringify({ ...st, profile: `${target.browser}/${target.profile}`, folder: target.folder }, null, 2)
      : `${C.dim(target.browser + '/' + target.profile)}  read ${st.read} from "${target.folder}" → ${C.b(st.added)} new, ${st.merged} merged`);
    break;
  }

  case 'refresh': {
    const all = argv.includes('--all');
    let n = 0;
    const st = await refresh(lib, {
      maxAge: all ? 0 : 7 * 864e5,
      concurrency: Number(flag('concurrency', 6)) || 6,
      onResult: (e, r) => { if (!json()) console.log(`  ${dot(r.status)} ${e.key.slice(0, 40).padEnd(42)}${C.dim((r.title || r.note || '').slice(0, 46))}`); n++; },
    });
    persist();
    const by = {};
    for (const e of lib.all()) if (e.liveness) by[e.liveness.status] = (by[e.liveness.status] || 0) + 1;
    if (json()) { console.log(JSON.stringify({ ...st, by }, null, 2)); break; }
    for (const m of st.merged || []) console.log(C.dim(`  ⇢ ${m.from} ${m.kind} into ${m.to}`));
    console.log(`\nchecked ${n}${st.skipped ? C.dim(`, ${st.skipped} still fresh`) : ''} — `
      + Object.entries(by).map(([k, v]) => `${dot(k)} ${v} ${k}`).join('  ')
      + ((st.merged || []).length ? C.dim(`  (${st.merged.length} folded by redirect)`) : ''));
    break;
  }

  case 'search': case 'find': case 's': {
    const q = positional().join(' ');
    if (!q) { console.error('usage: sifter search <query>'); process.exit(1); }
    const showRisk = argv.includes('--all');
    const res = search(lib.all(), q, {
      limit: Number(flag('limit', 10)) || 10,
      filter: (e) => showRisk || !(e.flags || []).includes('private'),
    });
    if (json()) { console.log(JSON.stringify(res.map((r) => ({ score: +r.score.toFixed(3), ...r.entry })), null, 2)); break; }
    if (!res.length) { console.log(C.dim('nothing matched')); break; }
    for (const { entry: e, score } of res) {
      const badge = (e.flags || []).includes('legal_risk') ? C.y(' [risk]') : '';
      console.log(`${dot(e.liveness?.status)} ${C.b(e.title || e.names[0] || e.key)}${badge} ${C.dim(score.toFixed(2))}`);
      console.log(`  ${C.c(e.url)}`);
      const desc = e.description || e.claims?.[0]?.text;
      if (desc) console.log(`  ${desc.slice(0, 130)}`);
      const bits = [e.mentions > 1 ? `${e.mentions} sources` : null, e.github?.stars ? `★${e.github.stars}` : null, ...(e.sections || []).slice(0, 2)].filter(Boolean);
      if (bits.length) console.log(C.dim(`  ${bits.join(' · ')}`));
      console.log();
    }
    break;
  }

  case 'list': {
    const f = flag('flag');
    const rows = lib.all().filter((e) => (f && f !== true ? (e.flags || []).includes(String(f)) : true));
    if (json()) { console.log(JSON.stringify(rows, null, 2)); break; }
    for (const e of rows.sort((a, b) => b.mentions - a.mentions)) {
      console.log(`${dot(e.liveness?.status)} ${e.key.slice(0, 38).padEnd(40)}${C.dim(String(e.mentions))} ${(e.flags || []).join(',')}`);
    }
    console.log(C.dim(`\n${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}`));
    break;
  }

  case 'export': {
    const outDir = resolve(String(flag('out') === true || !flag('out') ? join(ROOT, 'index') : flag('out')));
    const { entries, held } = exportable(lib, { allowRisk: argv.includes('--allow-risk') });
    mkdirSync(outDir, { recursive: true });
    // Three views of the same entries, each for a different reader:
    //   .jsonl  the library itself, so CI can re-verify the published index
    //   .json   one packaged document, for anything that wants a single fetch
    //   .md     the browsable list, for people
    save(join(outDir, 'resources.jsonl'), entries);
    writeFileSync(join(outDir, 'resources.json'), JSON.stringify({
      generated_at: new Date().toISOString(), count: entries.length, entries,
    }, null, 2));
    writeFileSync(join(outDir, 'README.md'), renderMarkdown(entries));
    const why = {};
    for (const h of held) why[h.why] = (why[h.why] || 0) + 1;
    console.log(json() ? JSON.stringify({ out: outDir, published: entries.length, held: why }, null, 2)
      : `published ${C.b(entries.length)} → ${outDir.replace(homedir(), '~')}\n`
        + `held back ${held.length}: ${Object.entries(why).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}`);
    break;
  }

  case 'submit': {
    const target = positional()[0];
    if (!target) {
      console.error('usage: sifter submit <url> --note "why it is worth indexing"');
      process.exit(1);
    }
    const v = await verifySubmission(target, {
      note: flag('note') === true ? null : flag('note'),
      from: flag('from') === true ? null : flag('from'),
      lib,
    });

    if (!v.ok) {
      // Refused here, on the contributor's machine, rather than in someone
      // else's review queue.
      console.error(`${C.r('✗')} ${v.message}`);
      process.exit(1);
    }

    const url = issueUrl(v, { repo: flag('repo') === true ? REPO : (flag('repo') || REPO) });
    if (json()) { console.log(JSON.stringify({ ...v, issue_url: url, index_entry: toIndexEntry(v) }, null, 2)); break; }

    console.log(`${dot(v.entry.liveness.status)} ${C.b(v.entry.title || v.entry.key)}`);
    console.log(`  ${C.c(v.entry.url)}`);
    if (v.entry.description) console.log(`  ${v.entry.description.slice(0, 140)}`);
    if (v.entry.github?.stars) console.log(C.dim(`  ★${v.entry.github.stars}`));
    if (v.duplicate) console.log(C.y(`  already indexed as ${v.duplicate.key} — submitting adds one more independent mention`));
    for (const w of v.warnings) console.log(C.y(`  ⚠︎ ${w}`));
    console.log();

    if (argv.includes('--open')) {
      const { spawnSync } = await import('node:child_process');
      const gh = spawnSync('gh', ['--version'], { stdio: 'ignore' }).status === 0;
      if (gh) {
        const r = spawnSync('gh', ['issue', 'create', '--repo', REPO,
          '--title', `Add: ${v.entry.title || v.entry.key}`, '--body', renderIssue(v), '--label', 'submission'],
          { stdio: 'inherit' });
        if (r.status === 0) break;
        console.log(C.dim('gh failed; falling back to a browser link'));
      }
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      spawnSync(opener, [url], { stdio: 'ignore' });
      console.log(C.dim('opened in your browser'));
      break;
    }

    console.log('Open this to file it (nothing has been sent):');
    console.log(url);
    console.log(C.dim('\nor add --open to file it directly'));
    break;
  }

  case 'stats': {
    const all = lib.all();
    const by = (fn) => { const m = {}; for (const e of all) for (const v of [].concat(fn(e) || [])) if (v) m[v] = (m[v] || 0) + 1; return m; };
    const out = {
      entries: all.length,
      liveness: by((e) => e.liveness?.status || 'unchecked'),
      flags: by((e) => (e.flags?.length ? e.flags : 'clean')),
      sources: by((e) => e.sources.map((s) => s.type)),
      corroborated: all.filter((e) => e.mentions > 1).length,
    };
    if (json()) { console.log(JSON.stringify(out, null, 2)); break; }
    console.log(`${C.b(out.entries)} entries, ${out.corroborated} seen from more than one source`);
    for (const [k, v] of Object.entries(out)) {
      if (typeof v !== 'object') continue;
      console.log(`\n${C.b(k)}`);
      for (const [n, c] of Object.entries(v).sort((a, b) => b[1] - a[1])) console.log(`  ${String(c).padStart(4)}  ${n}`);
    }
    break;
  }

  case 'links': {
    const sub = argv[1];
    const book = LinkBook.open(LINKS);

    if (sub === 'hook') { await linksHook(book); break; }

    if (sub === 'backfill') {
      // Agents' session logs are deleted on a rolling window (Claude Code
      // keeps about a month), so history not captured now is gone.
      const msgs = [...claudeMessages(), ...codexMessages()].sort((a, b) => (a.at < b.at ? -1 : 1));
      const ignore = readIgnore(LINKS_IGNORE);
      const before = book.all().length;
      for (const m of msgs) for (const f of pick(m.text, { ignore })) book.capture(f, m);
      saveBook(LINKS, book);
      const vocab = learnVocab(msgs);
      writeFileSync(LINKS_VOCAB, JSON.stringify(vocab));
      console.log(`read ${msgs.length} messages → ${C.b(book.all().length - before)} new links (${book.all().length} total), vocabulary of ${Object.keys(vocab.words).length} words`);
      console.log(C.dim('run `sifter links enrich` to fetch what each one is'));
      break;
    }

    if (sub === 'enrich') {
      const due = book.all().filter((e) => argv.includes('--all') || !e.enriched_at
        || (e.enrich_error && Date.now() - Date.parse(e.enriched_at) > 864e5));
      for (const e of due) {
        await enrich(e);
        if (!json()) console.log(`  ${e.enrich_error ? C.r('!') : C.g('+')} ${e.key.slice(0, 50).padEnd(52)}${C.dim((e.title || e.enrich_error || '').slice(0, 50))}`);
      }
      // Enriching takes seconds of network time, and a prompt submitted in
      // another session meanwhile may have captured a new link. Merge into
      // what is on disk now rather than writing back a stale snapshot.
      const fresh = LinkBook.open(LINKS);
      for (const e of due) {
        const cur = fresh.get(e.key);
        if (!cur) continue;
        for (const f of ['kind', 'title', 'text', 'author', 'posted_at', 'media', 'stars', 'topics', 'status', 'enriched_at', 'enrich_error']) {
          if (e[f] === undefined) delete cur[f]; else cur[f] = e[f];
        }
      }
      saveBook(LINKS, fresh);
      if (!json()) console.log(C.dim(`\nenriched ${due.length}`));
      break;
    }

    if (sub === 'note') {
      const [, target, ...words] = positional();
      const e = target && words.length ? book.note(target, words.join(' ')) : null;
      if (!e) { console.error(target ? `not in the link book: ${target}` : 'usage: sifter links note <url> "what came of it"'); process.exit(1); }
      saveBook(LINKS, book);
      console.log(`${C.g('✓')} ${e.key}`);
      break;
    }

    const q = positional().join(' ');
    const rows = q
      ? find(book, q, { limit: Number(flag('limit', 8)) || 8 })
      : book.all().sort((a, b) => (a.first_seen < b.first_seen ? 1 : -1)).slice(0, Number(flag('limit', 20)) || 20);
    if (json()) { console.log(JSON.stringify(rows, null, 2)); break; }
    if (!rows.length) { console.log(C.dim(q ? 'nothing matched' : `no links yet (${LINKS.replace(homedir(), '~')})`)); break; }
    for (const e of rows) {
      const d = describe(e);
      console.log(`${C.dim(d.day)} ${C.b(d.what || e.key)}`);
      console.log(`  ${C.c(e.url)}`);
      if (d.said) console.log(`  「${d.said}」${d.project ? C.dim(' · ' + d.project) : ''}`);
      if (d.note) console.log(`  ${C.y('→')} ${d.note}`);
      console.log();
    }
    break;
  }

  default: usage(); if (cmd && cmd !== '--help' && cmd !== '-h') process.exit(1);
}

/**
 * Claude Code's UserPromptSubmit hook. Reads the event on stdin, remembers
 * any resource links in the prompt, and hands back earlier links that look
 * relevant as context for the model. Must stay fast and must never fail the
 * prompt: every error path exits 0 with no output.
 */
async function linksHook(book) {
  let ev;
  try { ev = JSON.parse(readFileSync(0, 'utf8')); } catch { return; }
  const prompt = String(ev.prompt || '');
  const session = ev.session_id || null;
  const me = fileURLToPath(import.meta.url);
  const cli = `node ${me.replace(homedir(), '~')} links`;

  const found = pick(prompt, { ignore: readIgnore(LINKS_IGNORE) });
  for (const f of found) book.capture(f, { session, cwd: ev.cwd || null });
  if (found.length) {
    saveBook(LINKS, book);
    // Fetching titles is seconds of network time; the prompt cannot wait.
    const { spawn } = await import('node:child_process');
    spawn(process.execPath, [me, 'links', 'enrich'], { detached: true, stdio: 'ignore' }).unref();
  }

  // Once per session per link: a reminder repeated every turn is noise.
  const seenFile = join(tmpdir(), `sifter-links-${String(session).replace(/[^\w-]/g, '')}.json`);
  let shown = [];
  try { shown = JSON.parse(readFileSync(seenFile, 'utf8')); } catch {}
  const fresh = new Set(found.map((f) => f.key));
  const vocab = readVocab(LINKS_VOCAB);
  const asking = asksAboutPast(prompt);
  // Searched on what the question is about, not on "之前给过你", which
  // matches every link someone once said that about.
  const topic = asking ? keywords(prompt, vocab).join(' ') : '';
  const hits = asking
    ? (topic ? find(book, topic, { limit: 5 }).filter((e) => !fresh.has(e.key)) : [])
    : recall(book, prompt, {
      vocab,
      skip: (e) => fresh.has(e.key) || shown.includes(e.key) || e.said.every((s) => s.session === session),
    }).map((h) => h.link);

  const lines = [];
  if (hits.length) {
    if (!asking) writeFileSync(seenFile, JSON.stringify([...shown, ...hits.map((e) => e.key)]));
    lines.push(asking
      ? `[sifter links] 用户在问以前给过的链接。按相关度的候选（不一定准，可用 \`${cli} <关键词>\` 换词再搜）：`
      : '[sifter links] 用户以前亲手给过、和这条消息可能相关的链接（自动召回）：');
    for (const e of hits) {
      const d = describe(e, { max: 80 });
      lines.push(`- ${d.day} ${e.url}${d.what ? ` —— ${d.what}` : ''}`);
      if (d.said) lines.push(`  用户当时说：「${d.said}」${d.project ? `（在 ${d.project}）` : ''}`);
      if (d.note) lines.push(`  后来的结论：${d.note}`);
    }
    if (!asking) lines.push('确实相关就在回复里主动提一句「你之前给过……」并考虑用上；不相关就忽略，不要硬提。');
  }
  if (found.length) {
    lines.push(`[sifter links] 已自动记下本条消息里的 ${found.length} 个链接。处理完如果有明确结论（用上了、试过不行、做成了什么），用 \`${cli} note <url> "<一句话>"\` 补上，下次召回会带着它。`);
  }
  if (!lines.length) return;
  const out = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: lines.join('\n') } };
  if (found.length) out.systemMessage = `已收录 ${found.length} 个链接：${found.map((f) => f.key).join('、').slice(0, 120)}`;
  process.stdout.write(JSON.stringify(out));
}
