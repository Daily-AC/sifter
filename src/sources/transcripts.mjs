// What a person actually typed to their coding agents, read back out of the
// agents' own session logs.
//
// Both logs are full of text the person did not type: tool results, system
// reminders, and — in Codex — whole sessions whose "user" is another agent
// driving it through exec or the SDK. Only the interactive surfaces count.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function* walk(dir) {
  let names = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    const p = join(dir, n);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { if (n !== 'subagents') yield* walk(p); } else if (n.endsWith('.jsonl')) yield p;
  }
}

const lines = (f) => { try { return readFileSync(f, 'utf8').split('\n'); } catch { return []; } };

/** Claude Code: ~/.claude/projects/<dir>/<session>.jsonl */
export function* claudeMessages(root = join(homedir(), '.claude', 'projects')) {
  for (const f of walk(root)) {
    for (const line of lines(f)) {
      if (!line.includes('"type":"user"')) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type !== 'user' || o.isMeta || o.isSidechain || o.toolUseResult) continue;
      const c = o.message?.content;
      const texts = typeof c === 'string' ? [c]
        : Array.isArray(c) ? c.filter((x) => x?.type === 'text').map((x) => x.text) : [];
      for (const text of texts) {
        if (/^\s*<(system-reminder|command-|local-command|task-notification|bash-)/.test(text)) continue;
        yield { text, at: o.timestamp, session: o.sessionId, cwd: o.cwd };
      }
    }
  }
}

const CODEX_INTERACTIVE = new Set(['codex-tui', 'Codex Desktop', 'codex_work_desktop']);

/** Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, interactive sessions only. */
export function* codexMessages(root = join(homedir(), '.codex', 'sessions')) {
  for (const f of walk(root)) {
    const ls = lines(f);
    let meta; try { meta = JSON.parse(ls[0]).payload; } catch { continue; }
    if (!CODEX_INTERACTIVE.has(meta?.originator)) continue;
    for (const line of ls.slice(1)) {
      if (!line.includes('"role":"user"')) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const p = o.payload;
      if (p?.type !== 'message' || p.role !== 'user') continue;
      for (const c of p.content || []) {
        const text = c?.text || '';
        if (/^\s*(<environment_context|# AGENTS\.md|<user_instructions|<permissions|<turn_aborted|<skill|<codex_internal_context|The following is the Codex agent history)/.test(text)) continue;
        yield { text, at: o.timestamp, session: meta.id, cwd: meta.cwd };
      }
    }
  }
}
