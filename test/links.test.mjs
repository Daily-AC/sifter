// Regression tests for the link book. Each case is something the first
// version got wrong on real history: eleven thousand messages typed into
// Claude Code and Codex, replayed through the hook.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pick, keyOf, LinkBook, recall, keywords, asksAboutPast, describe } from '../src/links.mjs';
import { claudeMessages } from '../src/sources/transcripts.mjs';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
