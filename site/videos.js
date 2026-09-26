// The videos page: a filterable grid over videos.json. No search library —
// a hundred-odd cards are matched by substring on what a card shows.

const $ = (s) => document.querySelector(s);
const els = { q: $('#q'), filters: $('#filters'), sort: $('#sort'), grid: $('#grid'), count: $('#count'), stamp: $('#stamp') };

const CATS = [
  ['video', 'AI 视频'], ['motion', '代码动效'], ['3d', '3D'], ['game', '游戏'], ['image', '图像'],
  ['design', '设计资源'], ['agent', 'Agent 与工具'], ['voice', '语音'], ['launch', '发布'], ['misc', '其他'],
];
const CAT = Object.fromEntries(CATS);
const FLAG = { prompt: '附提示词', open: '开源', howto: '讲了做法' };
const SORTS = [['new', '最新'], ['liked', '最多赞']];

let items = [];
let cat = null;
let sort = 'new';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const day = (iso) => iso.slice(0, 10);
const compact = (n) => (n >= 10000 ? `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)}万` : String(n));

// What a visitor can see on a card is what they can search for, and nothing
// else: matching hidden post text would surface cards with no visible reason.
const haystack = (v) => [v.zh, v.author, v.name, CAT[v.cat], ...v.flags.map((f) => FLAG[f])].join(' ').toLowerCase();

function card(v) {
  const tags = v.flags.map((f) => `<span class="tag">${FLAG[f]}</span>`).join('');
  return `<a class="card" href="${esc(v.url)}" target="_blank" rel="noopener">
    <div class="thumb">
      <img src="${esc(v.poster)}" alt="" loading="lazy" decoding="async">
      <span class="play" aria-hidden="true"><svg width="11" height="11" viewBox="0 0 12 12"><path d="M3 1.8v8.4L10 6z" fill="currentColor"/></svg></span>
      ${v.videos > 1 ? `<span class="multi">${v.videos} 段</span>` : ''}
    </div>
    <div class="body">
      <p class="zh">${esc(v.zh)}</p>
      <div class="tail">
        <span class="who">@${esc(v.author)}</span><span class="sep">·</span><span>${day(v.at)}</span>
        <span class="sep">·</span><span class="likes"><svg width="11" height="11" viewBox="0 0 16 16" aria-label="赞"><path d="M8 14s-5.5-3.4-5.5-7.3A3 3 0 0 1 8 4.9a3 3 0 0 1 5.5 1.8C13.5 10.6 8 14 8 14z" fill="currentColor"/></svg>${compact(v.likes)}</span>
        ${cat ? '' : `<span class="tag">${CAT[v.cat]}</span>`}${tags}
      </div>
    </div>
  </a>`;
}

function render() {
  const q = els.q.value.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  let rows = items.filter((v) => (!cat || v.cat === cat) && words.every((w) => v._h.includes(w)));
  rows = rows.sort(sort === 'liked' ? (a, b) => b.likes - a.likes : (a, b) => (a.at < b.at ? 1 : -1));
  els.grid.innerHTML = rows.length ? rows.map(card).join('') : '<div class="empty">没有匹配的视频</div>';
  els.count.textContent = rows.length === items.length ? `共 ${items.length} 条` : `${rows.length} / ${items.length} 条`;
}

function renderFilters() {
  const n = {};
  for (const v of items) n[v.cat] = (n[v.cat] || 0) + 1;
  const chips = [[null, '全部', items.length], ...CATS.filter(([k]) => n[k]).map(([k, label]) => [k, label, n[k]])];
  els.filters.innerHTML = chips.map(([k, label, c]) =>
    `<button class="chip" type="button" data-cat="${k ?? ''}" aria-pressed="${k === cat}">${label}<span class="n">${c}</span></button>`).join('');
}

els.filters.addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  cat = b.dataset.cat || null;
  renderFilters();
  render();
});
els.sort.addEventListener('click', () => {
  sort = sort === 'new' ? 'liked' : 'new';
  els.sort.textContent = `排序：${Object.fromEntries(SORTS)[sort]}`;
  render();
});
els.q.addEventListener('input', render);

try {
  const res = await fetch('./videos.json');
  const data = await res.json();
  items = data.items.map((v) => ({ ...v, _h: haystack(v) }));
  els.stamp.textContent = `更新于 ${day(data.generated_at)}`;
  els.sort.textContent = '排序：最新';
  renderFilters();
  render();
} catch {
  els.grid.innerHTML = '<div class="empty">视频列表没有加载出来，刷新一下试试。</div>';
}
