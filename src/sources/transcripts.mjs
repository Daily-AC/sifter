// What a person actually typed to their coding agents, read back out of the
// agents' own session logs.
//
// Both logs are full of text the person did not type: tool results, system
// reminders, and — in Codex — whole sessions whose "user" is another agent
// driving it through exec or the SDK. Only the interactive surfaces count.

import { readFileSync, readdirSync, statSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';
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
  for (const f of walk(root)) yield* claudeLog(lines(f));
}

/**
 * What the person typed in one stretch of a Claude Code session log. A
 * message typed while the agent is mid-turn is folded into that turn as a
 * queued_command attachment and never becomes a user entry, so it is read
 * from there too, marked `queued`: no UserPromptSubmit hook ever saw it. If
 * the queue drains after the turn instead, the same text also arrives as a
 * user entry; count it once.
 */
export function* claudeLog(logLines) {
  const seen = new Set();
  for (const line of logLines) {
    if (!line.includes('"type":"user"') && !line.includes('"queued_command"')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.isMeta || o.isSidechain) continue;
    let c;
    const queued = o.type === 'attachment';
    if (o.type === 'user' && !o.toolUseResult) c = o.message?.content;
    else if (queued && o.attachment?.type === 'queued_command'
      && o.attachment.origin?.kind === 'human' && o.attachment.commandMode === 'prompt') c = o.attachment.prompt;
    else continue;
    const texts = typeof c === 'string' ? [c]
      : Array.isArray(c) ? c.filter((x) => x?.type === 'text').map((x) => x.text) : [];
    for (const text of texts) {
      if (/^\s*<(system-reminder|command-|local-command|task-notification|bash-)/.test(text)) continue;
      const key = `${o.sessionId}\0${text.trim()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      yield { text, at: o.timestamp, session: o.sessionId, cwd: o.cwd, ...(queued ? { queued } : {}) };
    }
  }
}

/**
 * What a Claude Code session log gained after byte `from`, and where to
 * start next time. Logs only grow, so a hook that runs every turn reads a
 * few kilobytes, not the whole session. Only complete lines are read; one
 * still being written is left for the next call.
 */
export function claudeLogSince(path, from = 0) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size < from) from = 0;   // not the file the offset was taken from
    const buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from);
    const end = buf.lastIndexOf(0x0a) + 1;
    return { messages: [...claudeLog(buf.toString('utf8', 0, end).split('\n'))], next: from + end };
  } finally { closeSync(fd); }
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
