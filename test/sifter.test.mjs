// Regression tests for the mistakes this pipeline actually made.
//
// Every case here failed at some point against real data. They are kept
// because each one was silent: nothing crashed, the index just quietly held
// something wrong — a live site marked dead, a truncated description, an
// employer's admin panel queued for publication.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, groupKey, bestUrl } from '../src/canonical.mjs';
import { screen } from '../src/privacy.mjs';
import { extractFromText, postContext } from '../src/extract.mjs';
import { assessRisk, publishable, sanitizeSources, sanitizeEntry } from '../src/risk.mjs';
import { parseHtml } from '../src/probe.mjs';
import { Library } from '../src/store.mjs';
import { search, tokenize } from '../src/search.mjs';
import { linksIn } from '../src/sources/x.mjs';
import { parseEvents, summarize } from '../tools/stats.mjs';
import { searched, visit } from '../site/analytics.mjs';

test('canonical: locale skins and www fold together', () => {
  assert.equal(groupKey('https://www.beautifului.dev/'), 'beautifului.dev');
  assert.equal(groupKey('http://zh.z-library.sk'), 'z-library.sk');
  assert.equal(groupKey('https://ui.shadcn.com/docs/components/button'), 'ui.shadcn.com');
});

test('canonical: user-space subdomains are identity, not decoration', () => {
  // Folding these to the platform would merge every project hosted there.
  assert.equal(groupKey('https://bloub.vercel.app/#etat=wide'), 'bloub.vercel.app');
  assert.equal(groupKey('https://a.pages.dev/'), 'a.pages.dev');
  assert.notEqual(groupKey('https://a.vercel.app/'), groupKey('https://b.vercel.app/'));
});

test('canonical: path is identity on code hosts', () => {
  assert.equal(groupKey('https://github.com/foo/bar/blob/main/README.md'), 'github.com/foo/bar');
  assert.notEqual(groupKey('https://github.com/foo/bar'), groupKey('https://github.com/foo/baz'));
});

test('canonical: tracking params dropped, meaningful ones kept', () => {
  assert.equal(normalizeUrl('https://a.com/x?utm_source=x&id=7&spm=1'), 'https://a.com/x?id=7');
  assert.equal(normalizeUrl('https://a.com/?ref=godly'), 'https://a.com/');
});

test('canonical: bestUrl prefers the landing page', () => {
  assert.equal(bestUrl(['https://a.com/docs/deep/page', 'https://a.com/']), 'https://a.com/');
});

test('privacy: consoles are caught at any label depth', () => {
  // `dc.console.aliyun.com` slipped through when only the first label was read.
  assert.ok(screen('https://dc.console.aliyun.com/next/index').private);
  assert.ok(screen('https://secure.backblaze.com/b2_buckets.htm').private);
  assert.ok(screen('http://jira.frp.ktvsky.com/browse/ERP-1?jql=x').private);
});

test('privacy: a shallow path never excuses a hard signal', () => {
  // `api.iamhc.cn/console` was briefly waved through as a "landing page".
  assert.ok(screen('https://api.iamhc.cn/console').private);
  assert.ok(screen('https://foo.com/login').private);
  // ...while a genuinely soft one still is.
  assert.equal(screen('https://stripe.com/account').private, false);
});

test('privacy: a private deep link demotes to its public parent', () => {
  const v = screen('https://studio.tripo3d.ai/workspace/generate');
  assert.ok(v.private);
  assert.equal(v.publicAncestor, 'https://studio.tripo3d.ai/');
});

test('privacy: internal hosts never demote to a publishable parent', () => {
  const v = screen('http://10.237.33.69/guest/login.php');
  assert.ok(v.private);
  assert.equal(v.publicAncestor, undefined);
});

test('extract: name, blurb and section come off a real post', () => {
  const post = '📚 电子书\n\n1. Z-Library：http://zh.z-library.sk —— 综合电子书搜索\n2. WeLib：https://zh.welib.org —— 图书、教材';
  const got = extractFromText(post);
  assert.equal(got.length, 2);
  assert.equal(got[0].name, 'Z-Library');
  assert.equal(got[0].note, '综合电子书搜索');
  assert.equal(got[0].section, '电子书');
});

test('extract: a name above a bare link is a name, not a section', () => {
  // This layout turned every entry into its own section heading and left
  // every name empty.
  const got = extractFromText(
    '之前分享过几个我常用的审美网站\n\n👉Awwwards — 全球网页设计奥斯卡\nhttps://awwwards.com\n适合看顶级网页设计\n\nRecent design\nhttps://recent.design\n找灵感效率很高');
  assert.equal(got.length, 2);
  assert.match(got[0].name, /Awwwards/);
  assert.equal(got[0].section, null);
  assert.equal(got[0].note, '适合看顶级网页设计');
  assert.equal(got[1].name, 'Recent design');
});

test('extract: a heading above a numbered list is still a heading', () => {
  const got = extractFromText(
    '📚 电子书\n1. Z-Library：http://zh.z-library.sk —— 综合搜索\n2. WeLib：https://zh.welib.org —— 教材');
  assert.equal(got[0].section, '电子书');
  assert.equal(got[0].name, 'Z-Library');
  assert.equal(got[1].section, '电子书');
});

test('extract: a name is recovered even when the blurb shares the link line', () => {
  const got = extractFromText('👉Design spells\nhttps://designspells.com/ 动效细节超棒');
  assert.equal(got[0].name, 'Design spells');
  assert.equal(got[0].section, null);
});

test('extract: a section claimed by only one entry is dropped', () => {
  const got = extractFromText(
    '影视\n1. A：https://a.com\n2. B：https://b.com\n\nQuirks\n3. C：https://c.com');
  assert.equal(got[0].section, '影视');
  assert.equal(got[1].section, '影视');
  assert.equal(got[2].section, null, 'a heading covering one entry is a misread name');
});

test('extract: the lead-in sentence is not a section heading', () => {
  const got = extractFromText('这 5 个网站够用了：\n\nBeautiful UI：https://beautifului.dev');
  assert.equal(got[0].section, null);
  assert.equal(got[0].name, 'Beautiful UI');
});

test('extract: unexpanded t.co links are not resources', () => {
  assert.equal(extractFromText('BeUI：https://t.co/abc').length, 0);
  assert.ok(linksIn('x https://t.co/abc')[0].shortened);
});

test('extract: post framing is captured for risk assessment', () => {
  const ctx = postContext('不想花钱，又想看书、追剧、听歌？这 15 个资源站可以先存着。\n\n📚 电子书\n1. X：https://a.com');
  assert.match(ctx, /不想花钱/);
});

test('risk: the post framing condemns entries that look innocent alone', () => {
  // Every streaming and music site was published-clean until framing counted:
  // no single line said "free", the sentence above the list did.
  const entry = {
    key: 'nivod.vip', url: 'https://nivod.vip/', names: ['泥视频'],
    sections: ['影视'], claims: [{ text: '电影、剧集、综艺、动漫' }],
    sources: [{ type: 'x', context: '不想花钱，又想看书、追剧、听歌？这 15 个资源站可以先存着。' }],
  };
  assert.ok(assessRisk(entry).includes('legal_risk'));
});

test('risk: known shadow libraries are flagged on the domain alone', () => {
  assert.ok(assessRisk({ key: 'annas-archive.gl', url: 'https://annas-archive.gl/' }).includes('legal_risk'));
});

test('risk: a demoted entry needs an independent source before publishing', () => {
  // Otherwise walking up from an employer's login page publishes the employer.
  const onlyBookmark = { key: 'merp.example.com', flags: ['demoted'], sources: [{ type: 'chrome' }], liveness: { status: 'alive' } };
  assert.equal(publishable(onlyBookmark).ok, false);
  const alsoPosted = { ...onlyBookmark, sources: [{ type: 'chrome' }, { type: 'x' }] };
  assert.equal(publishable(alsoPosted).ok, true);
});

test('export: bookmark provenance is anonymised, posts keep their credit', () => {
  // The published index leaked a bookmark folder path and a millisecond
  // timestamp — how someone organises their work and when they were at
  // their desk. Neither helps a reader.
  const clean = sanitizeSources([
    { type: 'chrome', folder: 'Other Bookmarks/审美 设计相关', at: '2026-06-10T15:09:09.989Z', title: 'Awwwards' },
    { type: 'x', author: 'someone', post: 'https://x.com/someone/status/1', at: '2026-08-22T01:06:00.000Z' },
  ]);
  assert.equal(clean[0].folder, undefined);
  assert.equal(clean[0].title, undefined);
  assert.equal(clean[0].at, '2026-06');
  assert.equal(clean[0].type, 'bookmark');
  assert.equal(clean[1].author, 'someone', 'a public post keeps its attribution');
  assert.equal(clean[1].at, '2026-08-22T01:06:00.000Z');
});

test('export: a bookmark folder name never becomes a public section', () => {
  // "审美 设计相关" is how one person labels a folder in their browser. It
  // was surfacing as a section heading in the published index and in search
  // results, alongside genuinely public headings lifted from posts.
  const lib = new Library();
  lib.upsert({ url: 'https://a.com/', section: '审美 设计相关', tags: ['design'],
               source: { type: 'chrome', folder: 'Other Bookmarks/审美 设计相关' } });
  lib.upsert({ url: 'https://a.com/', section: '电子书', source: { type: 'x', post_id: '1' } });
  const e = lib.get('a.com');
  assert.deepEqual(e.local_sections, ['审美 设计相关']);
  assert.deepEqual(e.sections, ['电子书'], 'a heading from a public post stays');
  const pub = sanitizeEntry(e);
  assert.equal(pub.local_sections, undefined);
  assert.ok(!JSON.stringify(pub).includes('审美'));
});

test('risk: a local folder name still counts as evidence when assessing risk', () => {
  assert.ok(assessRisk({
    key: 'x.com', local_sections: ['影视'],
    claims: [{ text: '免费在线观看' }], sources: [],
  }).includes('legal_risk'));
});

test('probe: an apostrophe does not truncate a description', () => {
  const html = `<meta name="description" content="recrée l'essentiel du bot">`;
  assert.equal(parseHtml(html).description, "recrée l'essentiel du bot");
});

test('probe: a title buried behind 200KB of framework script is still found', () => {
  // Measured at byte 216,000 on two live component-library sites.
  const filler = '<script>' + 'x'.repeat(250_000) + '</script>';
  const html = `<html><head>${filler}<title>Magic UI</title>`
    + '<meta name="description" content="Beautiful UI components"></head><body></body></html>';
  const got = parseHtml(html);
  assert.equal(got.title, 'Magic UI');
  assert.equal(got.description, 'Beautiful UI components');
});

test('probe: a title emitted outside <head> is still found', () => {
  // React 19 lets any component declare <title>; server rendering leaves it
  // in the body. One live site closed <head> at byte 5,141 and emitted its
  // title 210KB further down.
  const html = '<html><head><meta charset="utf-8"></head><body><div>hi</div>'
    + '<title>Fluid Functionalism</title><meta name="description" content="Refined UI components"></body></html>';
  const got = parseHtml(html);
  assert.equal(got.title, 'Fluid Functionalism');
  assert.equal(got.description, 'Refined UI components');
});

test('probe: an icon\'s <title> does not become the page title', () => {
  // Icon sets emit <title> inside inline SVG constantly, and it appears
  // before the real one whenever the real one is rendered late.
  const html = '<html><body><svg viewBox="0 0 24 24"><title>menu icon</title><path d="M0 0"/></svg>'
    + '<title>Real Page Title</title></body></html>';
  assert.equal(parseHtml(html).title, 'Real Page Title');
});

test('probe: entities are decoded', () => {
  assert.equal(parseHtml('<title>A &amp; B &#8212; C</title>').title, 'A & B — C');
});

test('store: the same site from two sources becomes one corroborated entry', () => {
  const lib = new Library();
  lib.upsert({ url: 'https://www.beautifului.dev/', name: 'Beautiful UI', source: { type: 'x', author: 'a', post_id: '1' } });
  lib.upsert({ url: 'https://beautifului.dev', name: 'BeautifulUI', source: { type: 'chrome', folder: 'design' } });
  assert.equal(lib.all().length, 1);
  assert.equal(lib.get('beautifului.dev').mentions, 2);
  assert.equal(lib.get('beautifului.dev').names.length, 2);
});

test('store: a rename folds, and both names stay findable', () => {
  const lib = new Library();
  lib.upsert({ url: 'https://godly.website/', name: 'Godly', source: { type: 'chrome', folder: 'd' } });
  lib.upsert({ url: 'https://recent.design/', name: 'Recent', source: { type: 'x', post_id: '9' } });
  lib.applyProbe('godly.website', { status: 'alive', code: 200, final_url: 'https://recent.design/?ref=godly', checked_at: new Date().toISOString() });
  const merged = lib.mergeRedirects();
  assert.equal(merged.length, 1);
  assert.equal(lib.all().length, 1);
  assert.ok(lib.get('recent.design').aliases.includes('godly.website'));
  assert.equal(lib.get('recent.design').names.length, 2);
});

test('store: a catch-all landing page does not swallow everything', () => {
  const lib = new Library();
  for (const h of ['a.com', 'b.com', 'c.com']) {
    lib.upsert({ url: `https://${h}/`, source: { type: 'x', post_id: h } });
    lib.applyProbe(h, { status: 'alive', code: 200, final_url: 'https://hub.com/', checked_at: new Date().toISOString() });
  }
  lib.mergeRedirects();
  assert.equal(lib.all().length, 3, 'three unrelated sites must not merge into one hub');
});

test('search: english stems and crosses into chinese', () => {
  const entries = [
    { key: 'threeui.com', title: 'Three.js Components, Templates & Interactive Shaders', names: [], tags: [], sections: [], claims: [], mentions: 1, liveness: { status: 'alive' } },
    { key: 'awwwards.com', title: 'Awwwards - Website Awards', description: 'the best web design inspiration', names: [], tags: [], sections: [], claims: [], mentions: 1, liveness: { status: 'alive' } },
  ];
  assert.equal(search(entries, 'shader')[0]?.entry.key, 'threeui.com');
  assert.equal(search(entries, '网页设计灵感')[0]?.entry.key, 'awwwards.com');
});

test('search: cjk queries tokenize into bigrams', () => {
  assert.ok(tokenize('设计灵感').includes('设计'));
});

test('search: dead entries sink but stay findable', () => {
  const base = { names: [], tags: [], sections: [], claims: [], mentions: 1 };
  const entries = [
    { ...base, key: 'dead.com', title: 'widget factory', liveness: { status: 'dead' } },
    { ...base, key: 'live.com', title: 'widget factory', liveness: { status: 'alive' } },
  ];
  const res = search(entries, 'widget factory');
  assert.equal(res[0].entry.key, 'live.com');
  assert.equal(res.length, 2);
});

// -- site analytics -----------------------------------------------------

const ev = (at, a) => JSON.stringify({ at: new Date(at).toISOString(), c: 'browser', a });
const zero = () => { searched(''); Object.assign(visit, { searches: 0, misses: 0, opens: 0, facets: 0, copied: false }); };

test('visit: a refined query is one search, not one per keystroke', () => {
  zero();
  searched('sha', 9);
  searched('shad', 4);
  searched('shader', 1);
  assert.equal(visit.searches, 1);
  assert.equal(visit.misses, 0);
});

test('visit: a miss that turns into a hit stops being a miss', () => {
  // The miss RATE is the number this whole design exists to produce, and it
  // is counted in the browser now. Typing past an empty result into a query
  // that finds something has to take the miss back with it, or the index
  // looks like it is failing people it actually served.
  zero();
  searched('godot', 0);
  assert.equal(visit.misses, 1);
  searched('godot shaders', 2);
  assert.equal(visit.searches, 1);
  assert.equal(visit.misses, 0);

  searched('unrelated thing', 0);
  assert.equal(visit.searches, 2);
  assert.equal(visit.misses, 1);
});

test('stats: the miss rate and the reported terms are separate quantities', () => {
  // A visit that missed four times and reported one term is not four reports
  // and not one miss. Reading either number as the other is the one way this
  // report can mislead, so it is pinned here.
  const { events } = parseEvents([
    ev(1000, 'e=s&n=6&m=4&o=1&w=lg&l=en-US'),
    ev(2000, 'e=miss&q=godot%20shaders'),
  ].join('\n'));
  const s = summarize(events);
  assert.equal(s.visits, 1);
  assert.equal(s.searches, 6);
  assert.equal(s.misses, 4);
  assert.equal(s.gaps.length, 1);
  assert.equal(s.gaps[0].q, 'godot shaders');
  // Counts stay numbers and lists stay lists. They collided once — one key
  // written twice in an object literal — and the report printed a rate of
  // NaN% next to "[object Object] opens".
  assert.equal(s.openCount, 1);
  assert.equal(Array.isArray(s.opens), true);
  assert.equal(typeof s.searches, 'number');
});

test('stats: absent fields are zero, not NaN', () => {
  // The collector omits a field rather than sending 0, so every count in a
  // quiet visit arrives missing. One NaN poisons every total downstream.
  const { events } = parseEvents([ev(1000, 'e=s&w=sm&l=zh-CN')].join('\n'));
  const s = summarize(events);
  assert.equal(s.searches, 0);
  assert.equal(s.misses, 0);
  assert.equal(s.copies, 0);
  assert.equal(s.searchingVisits, 0);
});

test('stats: crawlers are excluded unless asked for, and junk is counted not thrown', () => {
  const lines = [
    JSON.stringify({ at: new Date(1000).toISOString(), c: 'bot', a: 'e=s&n=1' }),
    ev(2000, 'e=s&n=1'),
    ev(3000, 'e=view&s=old&w=lg'),
    'not json at all',
  ].join('\n');
  assert.equal(parseEvents(lines).events.length, 1);
  assert.equal(parseEvents(lines).malformed, 2);      // the retired shape and the junk
  assert.equal(parseEvents(lines, { keepBots: true }).events.length, 2);
});
