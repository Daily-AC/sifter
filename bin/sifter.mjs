#!/usr/bin/env node
// sifter — sift scattered resource links into an index an agent can search.

import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { Library, save, collect, collectChrome, refresh, exportable, findProfiles, listFolders, findFolder } from '../src/pipeline.mjs';
import { search } from '../src/search.mjs';
import { renderMarkdown } from '../src/render.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.SIFTER_HOME || join(HERE, '..');
const DB = process.env.SIFTER_DB || join(ROOT, 'data', 'resources.jsonl');

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
  ${C.b('sifter chrome')} --folder <name>     import ONE named bookmark folder
  ${C.b('sifter chrome')} --list              show folders you could import
  ${C.b('sifter refresh')} [--all]            check liveness + pull real metadata
  ${C.b('sifter search')} <query>             search the library
  ${C.b('sifter list')} [--flag <f>]          list entries
  ${C.b('sifter export')} [--out <dir>]       write the publishable index
  ${C.b('sifter stats')}                      what's in the library

  ${C.dim('--json')}       machine-readable output
  ${C.dim('--db <path>')}  library location (default ${DB.replace(homedir(), '~')})

  ${C.dim('sifter never reads your whole bookmark tree; name the folder you want.')}`);
}

const lib = Library.open(flag('db') && flag('db') !== true ? String(flag('db')) : DB);
const persist = () => save(flag('db') && flag('db') !== true ? String(flag('db')) : DB, lib.all());
const json = () => argv.includes('--json');

switch (cmd) {
  case 'add': {
    const inputs = positional();
    if (!inputs.length) { console.error('usage: sifter add <url>...'); process.exit(1); }
    const st = await collect(lib, inputs, {
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

  default: usage(); if (cmd && cmd !== '--help' && cmd !== '-h') process.exit(1);
}
