// Regression tests for the link book. Each case is something the first
// version got wrong on real history: eleven thousand messages typed into
// Claude Code and Codex, replayed through the hook.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pick, keyOf, LinkBook, recall, recallRecent, keywords, asksAboutPast, describe } from '../src/links.mjs';
import { claudeMessages, claudeLogSince } from '../src/sources/transcripts.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

test('pick: a link typed flush against Chinese ends where the URL does', () => {
  const [l] = pick('https://github.com/citrolabs/ego-lite你去看看这个仓库，有什么牛逼的地方');
  assert.equal(l.key, 'github.com/citrolabs/ego-lite');
  assert.match(l.said, /你去看看这个仓库/);
});

test('pick: the same post shared twice is one link', () => {
  // ?s=20 and the author segment both vary between shares of one post.
  assert.equal(keyOf('https://x.com/goan999999/status/2103004497429541283?s=20'),
    keyOf('https://twitter.com/i/status/2103004497429541283'));
  assert.equal(keyOf('https://github.com/code-philia/arc-bench.git'), 'github.com/code-philia/arc-bench');
});

test('pick: work items, conversations, endpoints and private hosts are not resources', () => {
  const text = [
    'https://github.com/foo/bar/pull/12', 'https://chatgpt.com/c/abc', 'https://api.github.com/repos/x/y',
    'https://registry.npmmirror.com', 'http://127.0.0.1:8080', 'http://203.0.113.7', 'https://0.0.0.0',
    'https://me.example.org/cb?code=ddd45aa7a93aa4434335c4d3e9a1773d', 'https://build-s',
  ].join(' ');
  assert.deepEqual(pick(text).map((l) => l.key), []);
});

test('pick: the owner ignore list takes hosts and host/path prefixes', () => {
  const text = 'https://wiki.my-home.dev https://github.com/my-org/tool https://github.com/obra/superpowers';
  assert.deepEqual(pick(text, { ignore: ['my-home.dev', 'github.com/my-org'] }).map((l) => l.key),
    ['github.com/obra/superpowers']);
});

test('pick: relayed text and quoted replies are not links the user handed over', () => {
  assert.deepEqual(pick('Another Claude session sent a message: see https://github.com/a/b'), []);
  assert.deepEqual(pick('[91] assistant: installed from https://unity.com/ai'), []);
  assert.deepEqual(pick('> B 站上传页提示 https://www.bilibili.com/protocal/licence.html\n确认吗'), []);
});

test('pick: tracking noise does not split one page into two entries', () => {
  const a = pick('https://www.snickers.com/hungr-ai?rdt=1')[0].key;
  const b = pick('https://www.snickers.com/hungr-ai?rdt_cid=5930968656472413081')[0].key;
  assert.equal(a, b);
});

const vocab = { total: 10000, words: { 数据: 900, 应该: 800, 设计: 700, 赞同: 30, 相当: 30, 视频: 400 } };
const book = new LinkBook();
book.capture({ url: 'https://cf-optip.tagzxia.com/kb', key: 'cf-optip.tagzxia.com/kb', said: '国内访问慢，看看这篇' },
  { session: 'old', at: '2026-09-18T00:00:00Z' });
Object.assign(book.get('cf-optip.tagzxia.com/kb'), { title: 'Cloudflare Tunnel 优选 / 提速 知识库', text: '' });

test('recall: two words this person rarely uses bring a link back', () => {
  const hits = recall(book, 'Cloudflare Tunnel 进 VM 为啥这么慢', { vocab });
  assert.equal(hits[0]?.link.key, 'cf-optip.tagzxia.com/kb');
});

test('recall: words this person says all the time never do', () => {
  // "赞同, 相当" once matched a DeepSeek docs link whose note happened to
  // contain both.
  book.get('cf-optip.tagzxia.com/kb').notes.push({ text: '赞同，相当于把数据设计好' });
  assert.deepEqual(recall(book, '都赞同，相当于数据应该这样设计', { vocab }), []);
});

test('recall: without a learned vocabulary it stays silent rather than guess', () => {
  assert.deepEqual(recall(book, 'Cloudflare Tunnel 进 VM 为啥这么慢'), []);
});

test('keywords: an explicit question is searched on its topic, not on 之前给过你', () => {
  assert.ok(asksAboutPast('我之前给过你一个 Muse 的帖子是啥来着'));
  assert.ok(!asksAboutPast('帮我部署一下 home'));
  const v = { total: 10000, words: { 之前: 500, 帖子: 300, 一个: 900, 是啥: 120, 来着: 60 } };
  assert.deepEqual(keywords('我之前给过你一个 Muse 的帖子是啥来着', v), ['muse']);
});

test('describe: a short remark beats a pasted paragraph', () => {
  const e = { first_seen: '2026-09-25T00:00:00Z', notes: [],
    said: [{ text: '看看' }, { text: 'x'.repeat(200) }, { text: '想把这个接到我的状态屏上' }] };
  assert.equal(describe(e).said, '想把这个接到我的状态屏上');
});

test('claudeMessages: a link typed while the agent is mid-turn is read too, once', () => {
  // 2026-09-26: a link sent during a long turn was absorbed as a
  // queued_command attachment and never became a user entry, so backfill
  // missed it; 7% of real messages arrive this way.
  const root = mkdtempSync(join(tmpdir(), 'sifter-cc-'));
  mkdirSync(join(root, 'p'));
  const url = 'https://x.com/rexan_wong/status/2103707054108299437 这个会对你有帮助的';
  const row = (o) => JSON.stringify({ sessionId: 's1', timestamp: '2026-09-26T16:57:52Z', cwd: '/p', ...o });
  writeFileSync(join(root, 'p', 's1.jsonl'), [
    row({ type: 'user', message: { role: 'user', content: '开工' } }),
    row({ type: 'attachment', attachment: { type: 'queued_command', prompt: url, commandMode: 'prompt', origin: { kind: 'human' } } }),
    row({ type: 'attachment', attachment: { type: 'queued_command', prompt: '<task-notification>done</task-notification>', commandMode: 'task-notification' } }),
    row({ type: 'attachment', attachment: { type: 'queued_command', prompt: 'from another session', commandMode: 'prompt', origin: { kind: 'peer' } } }),
    row({ type: 'attachment', attachment: { type: 'queued_command', prompt: [{ type: 'text', text: '[Image #1] 看这里' }, { type: 'image' }], commandMode: 'prompt', origin: { kind: 'human' } } }),
    row({ type: 'user', message: { role: 'user', content: url } }),
  ].join('\n'));
  const texts = [...claudeMessages(root)].map((m) => m.text);
  assert.deepEqual(texts, ['开工', url, '[Image #1] 看这里']);
});

// 2026-09-27: links typed mid-turn only ever reached the book through a
// manual backfill, because Claude Code never runs UserPromptSubmit for
// them. A Stop hook now reads each turn's tail of the session log.
const logRow = (o) => JSON.stringify({ sessionId: 's2', timestamp: '2026-09-27T01:00:00Z', cwd: '/p', ...o }) + '\n';
const queuedRow = (text) => logRow({ type: 'attachment', attachment: { type: 'queued_command', prompt: text, commandMode: 'prompt', origin: { kind: 'human' } } });

test('claudeLogSince: reads what the log gained, and never half a line', () => {
  const log = join(mkdtempSync(join(tmpdir(), 'sifter-log-')), 's2.jsonl');
  writeFileSync(log, logRow({ type: 'user', message: { role: 'user', content: '开工' } }) + queuedRow('第一句'));
  const a = claudeLogSince(log);
  assert.deepEqual(a.messages.map((m) => [m.text, !!m.queued]), [['开工', false], ['第一句', true]]);
  // A line still being written is left for the next call.
  const half = queuedRow('第二句');
  appendFileSync(log, half.slice(0, 30));
  const b = claudeLogSince(log, a.next);
  assert.deepEqual(b.messages, []);
  assert.equal(b.next, a.next);
  appendFileSync(log, half.slice(30));
  assert.deepEqual(claudeLogSince(log, b.next).messages.map((m) => m.text), ['第二句']);
});

test('links queued: the Stop hook records links typed mid-turn, and only those', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sifter-stop-'));
  const log = join(dir, 's.jsonl');
  const session = `test-${process.pid}-${Date.now()}`;
  writeFileSync(log, logRow({ type: 'user', message: { role: 'user', content: 'https://prompt-hook.invalid/sees-this 看看' } })
    + queuedRow('https://mid-turn.invalid/typed-this 这个会对你有帮助的'));
  const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'sifter.mjs');
  try {
    const r = spawnSync(process.execPath, [cli, 'links', 'queued'], {
      input: JSON.stringify({ hook_event_name: 'Stop', session_id: session, transcript_path: log, cwd: '/p' }),
      env: { ...process.env, SIFTER_LINKS: join(dir, 'links.jsonl') }, encoding: 'utf8',
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    const book = readFileSync(join(dir, 'links.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    // The first link came through UserPromptSubmit already; this hook is
    // only for what that one never sees.
    assert.deepEqual(book.map((e) => [e.key, e.said[0].text]), [['mid-turn.invalid/typed-this', '这个会对你有帮助的']]);
  } finally { rmSync(join(tmpdir(), `sifter-links-read-${session}`), { force: true }); }
});

// 2026-09-26: "我最近迷上了用你去创作一些视频…" opened a new session an
// hour after three video-making posts were handed over, and nothing came
// back: "视频" is a word this person says every week, too common for recall().
const lately = new LinkBook();
const hand = (key, title, said, at, session = 'earlier') => {
  lately.capture({ url: `https://${key}`, key, said }, { session, at });
  lately.get(key).title = title;
};
hand('x.com/status/1', '开源了39种风格视频库后，我学会了如何用Opus5.5稳定出片', '又找到了一个博主分享的', '2026-09-26T17:04:00Z');
hand('x.com/status/2', 'Opus 5.5 自己写了一套卡通剪辑软件', '我想要的是那种教学视频可以发到抖音里的那种', '2026-09-26T16:35:00Z');
hand('example.org/deploy', '已经部署好了的服务清单', '已经部署好了', '2026-09-26T12:00:00Z');
hand('example.org/deploy2', '已经上线的服务', '已经可以用了', '2026-09-26T12:00:00Z');
const lv = { total: 8000, words: { 视频: 70, 已经: 143, 迷上: 2 } };
const opening = '我最近迷上了用你去创作一些视频，想去摸一下你的天花板在哪里。我现在想你做一个视觉效果比较惊艳的视频';

test('recallRecent: an everyday word naming two links handed over lately brings them back', () => {
  const hits = recallRecent(lately, opening, { vocab: lv, at: '2026-09-26T18:15:46Z', session: 'new' });
  assert.deepEqual(hits.map((h) => h.link.key), ['x.com/status/1', 'x.com/status/2']);
});

test('recallRecent: one link, an old link, or the same session is not a subject being worked on', () => {
  const at = '2026-09-26T18:15:46Z';
  const one = new LinkBook([lately.get('x.com/status/1')]);
  assert.deepEqual(recallRecent(one, opening, { vocab: lv, at, session: 'new' }), []);
  assert.deepEqual(recallRecent(lately, opening, { vocab: lv, at: '2026-10-10T00:00:00Z', session: 'new' }), []);
  assert.deepEqual(recallRecent(lately, opening, { vocab: lv, at, session: 'earlier' }), []);
});

test('recallRecent: function words and pasted walls of text never speak', () => {
  const at = '2026-09-26T18:15:46Z';
  assert.deepEqual(recallRecent(lately, '已经部署了吗', { vocab: lv, at, session: 'new' }), []);
  assert.deepEqual(recallRecent(lately, opening + ' 日志'.repeat(100), { vocab: lv, at, session: 'new' }), []);
});

test('replay: a message sees only what had been handed over and said before it', async () => {
  const { history, bookAt } = await import('../tools/replay-recall.mjs');
  // Codex copies a conversation into each fork with new timestamps; the
  // copy was never typed. "继续" twice in one session was.
  const msgs = history([
    { text: '把这个部署到 home 上', at: '2026-09-01T00:00:00Z', session: 'a' },
    { text: '继续', at: '2026-09-01T00:01:00Z', session: 'a' },
    { text: '继续', at: '2026-09-01T00:02:00Z', session: 'a' },
    { text: '把这个部署到 home 上', at: '2026-09-02T00:00:00Z', session: 'fork' },
  ]);
  assert.deepEqual(msgs.map((m) => `${m.session}:${m.text}`), ['a:把这个部署到 home 上', 'a:继续', 'a:继续']);
  const e = { key: 'k', said: [{ text: 'old', at: '2026-09-01T00:00:00Z' }, { text: 'new', at: '2026-09-03T00:00:00Z' }],
    notes: [{ text: 'later', at: '2026-09-04T00:00:00Z' }], first_seen: '2026-09-01T00:00:00Z' };
  assert.deepEqual(bookAt([e], '2026-08-31T00:00:00Z').all(), []);
  const then = bookAt([e], '2026-09-02T00:00:00Z').get('k');
  assert.deepEqual([then.said.map((s) => s.text), then.notes], [['old'], []]);
});
