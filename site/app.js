// The wall: every indexed site and every published video in one grid.
//
// Search is the tool's search — search.mjs is copied verbatim by
// tools/build-site.mjs, not reimplemented — run over sites and videos alike,
// since each card in wall.json already carries the fields it scores.

import { search } from './search.mjs?v=a97407f7';
import * as track from './analytics.mjs?v=57e76bbc';

const $ = (s) => document.querySelector(s);
const els = {
  wall: $('#wall'), cats: $('#cats'), q: $('#q'), status: $('#status'), bar: $('#bar'),
  stamp: $('#stamp'), copy: $('#copy'), toast: $('#toast'),
  player: $('#player'), pv: $('#pv'), pt: $('#pt'), pm: $('#pm'), close: $('#close'),
};

let data = null;
let cat = null;
const nodes = new Map();          // key -> card element, built once
let columns = 0;
let shown = [];

// Moving pictures are the point of the page, but not at the cost of someone
// who has asked for less motion or less data.
const still = matchMedia('(prefers-reduced-motion: reduce)').matches || navigator.connection?.saveData;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Very tall phone recordings would take a whole column each and very wide
// ones would be slivers; the picture is cropped into this band instead.
const ratio = (x) => Math.min(Math.max(x.h / x.w, 0.5), 1.34);
const wan = (n) => (n >= 10000 ? `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)}万` : n.toLocaleString());

const PLAY = '<svg width="10" height="10" viewBox="0 0 12 12" aria-hidden="true"><path d="M3.2 1.6v8.8L10.4 6z" fill="currentColor"/></svg>';
const GH = '<svg class="gh" width="20" height="20" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>';

function card(x) {
  const el = document.createElement('a');
  el.className = 'card';
  el.href = x.url;
  el.target = '_blank';
  el.rel = 'noopener noreferrer';
  el.dataset.k = x.key;

  let media;
  if (x.kind === 'repo') {
    media = `${GH}${x.stars ? `<span class="s">★ ${wan(x.stars)}</span>` : ''}
      <span class="o">${esc(x.owner)} /</span><span class="r">${esc(x.repo)}</span>`;
    media = `<span class="repo">${media}</span>`;
  } else {
    media = `<img alt="" loading="lazy" decoding="async" src="${esc(x.img)}">`;
    if (x.kind === 'video') media += `<span class="badge">${PLAY}</span>`;
  }
  const meta = x.kind === 'video'
    ? [x.by, ...x.flags].join(' · ')
    : [x.names[0], x.kind === 'repo' ? 'GitHub' : x.by].join(' · ');

  el.innerHTML = `<span class="media" style="aspect-ratio:1/${ratio(x).toFixed(4)}">${media}</span>
    <span class="cap"><p class="t">${esc(x.title)}</p><p class="m">${esc(meta)}</p></span>`;

  const img = el.querySelector('img');
  if (img) {
    const done = () => img.classList.add('in');
    if (img.complete) done(); else img.addEventListener('load', done, { once: true });
  }
  if (x.kind === 'video' && !still) watch.observe(el);
  return el;
}

// ─── loops: play what is on screen, pause what is not ───

const watch = new IntersectionObserver((entries) => {
  for (const { target, isIntersecting } of entries) {
    const x = byKey.get(target.dataset.k);
    let v = target.querySelector('video');
    if (isIntersecting) {
      if (!v) {
        // Built on first sight, not up front: 113 video elements that may
        // never be scrolled to are weight the page does not need.
        v = document.createElement('video');
        Object.assign(v, { muted: true, loop: true, playsInline: true, preload: 'auto', src: x.clip });
        v.setAttribute('muted', '');
        v.setAttribute('playsinline', '');
        v.addEventListener('playing', () => v.classList.add('on'), { once: true });
        target.querySelector('.media').insertBefore(v, target.querySelector('.badge'));
      }
      v.play().catch(() => {});
    } else if (v) {
      v.pause();
    }
  }
}, { rootMargin: '120px 0px' });

document.addEventListener('visibilitychange', () => {
  for (const v of els.wall.querySelectorAll('video')) {
    if (document.hidden) v.pause();
  }
  if (!document.hidden) {
    // Resume only the ones in view; the observer does not refire on its own.
    for (const el of els.wall.querySelectorAll('.card')) {
      const r = el.getBoundingClientRect();
      if (r.bottom > 0 && r.top < innerHeight) el.querySelector('video')?.play().catch(() => {});
    }
  }
});

// ─── layout ───

const byKey = new Map();

function columnCount() {
  const w = els.wall.clientWidth;
  return w >= 1180 ? 4 : w >= 820 ? 3 : 2;
}

/** Each card goes to the shortest column, so reading order stays roughly
 *  left-to-right, top-to-bottom and the first screen is the first items.
 *
 *  Two passes, both before the browser paints: the first puts every card in
 *  a column so its caption can be measured at the real column width, the
 *  second places them by those measured heights. Guessing caption heights
 *  instead left columns ending a card apart. */
function layout(list) {
  columns = columnCount();
  const cols = Array.from({ length: columns }, () => {
    const c = document.createElement('div');
    c.className = 'col';
    return c;
  });
  const cards = list.map((x, i) => {
    let el = nodes.get(x.key);
    if (!el) { el = card(x); nodes.set(x.key, el); }
    // Re-inserting a node restarts its entrance animation; stagger only the
    // first screenful so the rest are simply there when scrolled to.
    el.style.setProperty('--i', Math.min(i, 12));
    cols[i % columns].append(el);
    return el;
  });
  els.wall.replaceChildren(...cols);

  const colW = cols[0].clientWidth;
  const rowGap = parseFloat(getComputedStyle(cols[0]).rowGap) || 0;
  const tall = cards.map((el, i) => colW * ratio(list[i]) + el.lastElementChild.offsetHeight + rowGap);
  const heights = new Array(columns).fill(0);
  cards.forEach((el, i) => {
    const c = heights.indexOf(Math.min(...heights));
    cols[c].append(el);
    heights[c] += tall[i];
  });
}

function render() {
  const q = els.q.value.trim();
  const pool = cat ? data.items.filter((x) => x.cat === cat) : data.items;
  shown = q ? search(pool, q, { limit: 500 }).map((r) => r.entry) : pool;

  if (shown.length) {
    layout(shown);
  } else {
    // Only a search can come back empty, and the term is the useful thing
    // here. It is sent only if the button is pressed.
    els.wall.innerHTML = `<div class="empty" style="flex:1">没有找到「${esc(q)}」。换个说法试试，中英文都能搜。
      <br><button class="gap" type="button" data-term="${esc(q)}">告诉维护者想找「${esc(q)}」</button></div>`;
  }

  const catName = cat ? data.cats.find(([k]) => k === cat)[1] : null;
  els.status.textContent = q
    ? `${shown.length} 条结果`
    : catName ? `${catName} · ${shown.length} 条`
    : `${data.sites} 个网站 · ${data.videos} 段视频`;

  track.searched(q, shown.length);
}

function renderCats() {
  els.cats.innerHTML = [[null, '全部'], ...data.cats].map(([k, label]) =>
    `<button class="cat" type="button" data-cat="${k ?? ''}" aria-pressed="${k === cat}">${label}</button>`).join('');
}

// ─── events ───

els.cats.addEventListener('click', (e) => {
  const b = e.target.closest('.cat');
  if (!b) return;
  cat = b.dataset.cat || null;
  if (cat) track.facetUsed();
  // The category lives in the address, so a filtered wall can be shared.
  history.replaceState(null, '', cat ? `#${cat}` : location.pathname + location.search);
  renderCats();
  render();
  // Back to the top of the wall, not the top of the page.
  const top = els.wall.getBoundingClientRect().top + scrollY - els.bar.offsetHeight - 40;
  if (scrollY > top) scrollTo({ top, behavior: still ? 'auto' : 'smooth' });
});

let typing;
els.q.addEventListener('input', () => {
  clearTimeout(typing);
  typing = setTimeout(render, 120);
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== els.q && !els.player.open) {
    e.preventDefault();
    els.q.focus();
  }
});

els.wall.addEventListener('click', (e) => {
  const gap = e.target.closest('.gap');
  if (gap) {
    track.reportGap(gap.dataset.term);
    gap.outerHTML = '<p style="margin-top:18px">已收到，谢谢。</p>';
    return;
  }
  const el = e.target.closest('.card');
  if (!el) return;
  const x = byKey.get(el.dataset.k);
  track.opened(x.key, shown.indexOf(x) + 1);
  // A plain click on a video plays it here; a modified click still goes to
  // the post, which is what the link points at.
  if (x.kind === 'video' && !(e.metaKey || e.ctrlKey || e.shiftKey || e.button)) {
    e.preventDefault();
    play(x);
  }
});

function play(x) {
  els.pv.poster = x.img;
  els.pv.src = x.full;
  els.pt.textContent = x.title;
  els.pm.innerHTML = `${esc([x.by, ...x.flags].join(' · '))} · <a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">看原帖 ↗</a>`;
  els.player.showModal();
  els.pv.play().catch(() => {});
}
els.player.addEventListener('close', () => {
  els.pv.pause();
  els.pv.removeAttribute('src');
  els.pv.load();
});
els.close.addEventListener('click', () => els.player.close());
// The dialog fills the screen, so a click that lands on it rather than on
// the video or the caption is a click on the dark around them.
els.player.addEventListener('click', (e) => { if (e.target === els.player) els.player.close(); });

els.copy.addEventListener('click', async () => {
  const text = els.copy.querySelector('code').textContent;
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制');
  } catch {
    const r = document.createRange();
    r.selectNodeContents(els.copy.querySelector('code'));
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    toast('按 ⌘C 复制');
  }
  track.copied();
});

function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('on');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => els.toast.classList.remove('on'), 1600);
}

// A hairline under the bar once it is actually stuck, not before.
new IntersectionObserver(([e]) => els.bar.classList.toggle('stuck', !e.isIntersecting))
  .observe(els.bar.previousElementSibling);

addEventListener('resize', () => {
  if (data && shown.length && columnCount() !== columns) layout(shown);
}, { passive: true });

// ─── boot ───

try {
  const res = await fetch('./wall.json?v=6a647200');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  data = await res.json();
  for (const x of data.items) byKey.set(x.key, x);
  const asked = decodeURIComponent(location.hash.slice(1));
  if (data.cats.some(([k]) => k === asked)) cat = asked;
  const day = (iso) => new Date(iso).toLocaleDateString('zh-CN');
  els.stamp.textContent = `网站最近一次检查 ${day(data.checked_at)} · 内容更新于 ${day(data.generated_at)}`;
  renderCats();
  render();
} catch (err) {
  els.wall.innerHTML = `<p class="empty" style="flex:1">内容没有加载出来（${esc(err.message)}），刷新一下试试。</p>`;
}
