// The page's search is the tool's search — search.mjs is copied verbatim by
// tools/build-site.mjs, not reimplemented. If ranking changes in the CLI it
// changes here, and a visitor is never shown a demo of behaviour the tool
// does not actually have.

import { search } from './search.mjs?v=86b4acfa';
import * as track from './analytics.mjs?v=57e76bbc';

const $ = (s) => document.querySelector(s);
// A long placeholder is useful on a wide input and truncated garbage on a
// narrow one, so it is set from the actual measured width, not a guess.
const PLACEHOLDER = {
  wide: 'Search the index — animated react components, 网页设计灵感, shader…',
  mid: 'Search — animated components, 设计灵感…',
  narrow: 'Search the index…',
};

const els = {
  q: $('#q'), results: $('#results'), filters: $('#filters'),
  count: $('#count'), sort: $('#sort'), stamp: $('#stamp'),
  toast: $('#toast'), hint: $('#hint'), copy: $('#copy-install'),
};

let entries = [];
let filter = null;                 // active tag/section, or null
let order = 'relevance';           // relevance -> corroboration -> recent

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

function ago(iso) {
  if (!iso) return null;
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(mins)) return null;
  if (mins < 90) return `${Math.max(mins, 1)}m ago`;
  const h = Math.round(mins / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.remove('on'), 1700);
}

/** Facets worth offering: only those covering more than one entry. */
function facets(list) {
  const counts = new Map();
  for (const e of list) {
    for (const f of [...(e.sections || []), ...(e.tags || [])]) {
      if (!f || f.length > 22) continue;
      counts.set(f, (counts.get(f) || 0) + 1);
    }
  }
  return [...counts.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).slice(0, 8);
}

function card(e, i) {
  const status = e.status || 'unknown';
  const desc = e.description || '';
  const claim = e.claims?.[0];
  const bits = [];
  if (e.mentions > 1) bits.push(`<span class="badge"><strong>${e.mentions}</strong> sources</span>`);
  if (e.stars) bits.push(`<span class="badge">★${e.stars.toLocaleString()}</span>`);
  if (e.archived) bits.push('<span class="badge">archived</span>');
  if (status === 'blocked') bits.push('<span class="badge">refuses robots</span>');
  const when = ago(e.checked_at);
  if (when) bits.push(`<span class="badge">checked ${when}</span>`);

  const tags = (e.tags || []).slice(0, 3).map((t) => `<span class="tag">${esc(t)}</span>`).join('');

  return `<a class="row" role="listitem" data-k="${esc(e.key)}" data-i="${i}" href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">
    <div class="row-top">
      <span class="dot ${status}" title="${status}"></span>
      <span class="name">${esc(e.title || e.names?.[0] || e.key)}</span>
      <span class="host">${esc(host(e.url))}</span>
    </div>
    ${desc ? `<p class="desc">${esc(desc)}</p>` : ''}
    ${claim ? `<p class="claim">${esc(claim)}</p>` : ''}
    <div class="tail">${tags}${bits.join('<span class="sep">·</span>')}</div>
  </a>`;
}

function render() {
  const q = els.q.value.trim();
  const pool = filter
    ? entries.filter((e) => (e.sections || []).includes(filter) || (e.tags || []).includes(filter))
    : entries;

  let rows;
  if (q) {
    rows = search(pool, q, { limit: 200 }).map((r) => r.entry);
    if (order === 'corroboration') rows = [...rows].sort((a, b) => b.mentions - a.mentions);
    if (order === 'recent') rows = [...rows].sort((a, b) => (b.first_seen || '').localeCompare(a.first_seen || ''));
  } else {
    rows = [...pool].sort((a, b) => {
      if (order === 'recent') return (b.first_seen || '').localeCompare(a.first_seen || '');
      return (b.mentions - a.mentions) || ((b.stars || 0) - (a.stars || 0))
        || (a.title || a.key).localeCompare(b.title || b.key);
    });
  }

  els.count.textContent = !entries.length ? 'index unavailable'
    : q ? `${rows.length} of ${pool.length} match “${q}”`
    : `${rows.length} resources${filter ? ` in ${filter}` : ''}`;

  // Three different empty states, because they mean three different things
  // and only one of them is the visitor's doing. Showing "nothing matched"
  // for an index that failed to load blames the person for a broken deploy.
  let empty;
  if (!entries.length) {
    empty = 'The index came back empty. That is a deploy problem, not your search — '
      + '<a href="https://github.com/Daily-AC/sifter/issues" style="color:var(--body)">tell us</a>.';
  } else if (q) {
    // The term is the useful thing here and it is only sent if this is
    // pressed. Nothing about the search has left the browser before that.
    empty = `Nothing matched <code>${esc(q)}</code>.<br>`
      + 'Try fewer words — search bridges English and Chinese, so “动画组件” and “animated components” both work.'
      + `<br><button class="gap" data-term="${esc(q)}">Tell the maintainers about “${esc(q)}”</button>`;
  } else {
    empty = `Nothing in <code>${esc(filter || '')}</code> yet.`;
  }

  els.results.innerHTML = rows.length ? rows.map(card).join('') : `<div class="empty">${empty}</div>`;
  els.results.scrollTop = 0;

  // Only searches run against a loaded index are worth counting; a zero here
  // would otherwise read as a gap in the index rather than a failed deploy.
  if (entries.length) track.searched(q, rows.length);
}

function renderFilters() {
  const fs = facets(entries);
  els.filters.innerHTML = [
    `<button class="chip" data-f="" aria-pressed="${!filter}">All<span class="n">${entries.length}</span></button>`,
    ...fs.map(([f, n]) =>
      `<button class="chip" data-f="${esc(f)}" aria-pressed="${filter === f}">${esc(f)}<span class="n">${n}</span></button>`),
  ].join('');
}

const ORDERS = { relevance: 'Most corroborated', corroboration: 'Recently added', recent: 'Most corroborated' };
function renderSort() {
  els.sort.textContent = order === 'recent' ? 'Recently added ↓' : 'Most corroborated ↓';
}

els.q.addEventListener('input', render);
els.q.addEventListener('focus', () => els.hint.style.visibility = 'hidden');
els.q.addEventListener('blur', () => { if (!els.q.value) els.hint.style.visibility = 'visible'; });

els.results.addEventListener('click', (ev) => {
  const gap = ev.target.closest('.gap');
  if (gap) {
    track.reportGap(gap.dataset.term);
    gap.outerHTML = '<span class="gap-done">Sent — thank you.</span>';
    return;
  }
  // Which entry got opened and where it ranked. No query travels with it.
  const row = ev.target.closest('.row');
  if (!row) return;
  track.opened(row.dataset.k, Number(row.dataset.i) + 1);
});

els.filters.addEventListener('click', (ev) => {
  const b = ev.target.closest('.chip');
  if (!b) return;
  filter = b.dataset.f || null;
  if (filter) track.facetUsed();
  renderFilters();
  render();
});

els.sort.addEventListener('click', () => {
  order = order === 'recent' ? 'relevance' : 'recent';
  renderSort();
  render();
});

// `/` focuses search the way a command palette does.
document.addEventListener('keydown', (ev) => {
  if (ev.key === '/' && document.activeElement !== els.q && !ev.metaKey && !ev.ctrlKey) {
    ev.preventDefault();
    els.q.focus();
  } else if (ev.key === 'Escape' && document.activeElement === els.q) {
    els.q.value = ''; render(); els.q.blur();
  }
});

els.copy.addEventListener('click', async () => {
  const text = 'npx @z10/sifter search "design inspiration"';
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
    track.copied();
  } catch {
    // Clipboard is blocked in some contexts; select it so the user can copy.
    const r = document.createRange();
    r.selectNodeContents(els.copy.querySelector('.t'));
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    toast('Press ⌘C to copy');
    track.copied();
  }
});

function fitPlaceholder() {
  const w = els.q.getBoundingClientRect().width;
  els.q.placeholder = w > 560 ? PLACEHOLDER.wide : w > 330 ? PLACEHOLDER.mid : PLACEHOLDER.narrow;
}
addEventListener('resize', fitPlaceholder, { passive: true });

(async function boot() {
  try {
    // No cache option here: nginx already serves this no-cache, and overriding
    // the mode would stop the request matching the <link rel=preload> in the
    // HTML, fetching the file twice instead of once.
    const res = await fetch('./resources.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    entries = data.entries || [];
    const alive = entries.filter((e) => e.status === 'alive').length;
    els.stamp.textContent =
      `${entries.length} resources · ${alive} verified reachable · last checked ${new Date(data.generated_at).toISOString().slice(0, 10)}`;
    renderFilters();
    renderSort();
    render();
    fitPlaceholder();
  } catch (err) {
    els.results.innerHTML =
      `<div class="empty">Could not load the index (${esc(err.message)}).<br>
       The whole thing is a static file — <code>resources.json</code> — so this is usually a bad deploy.</div>`;
    els.count.textContent = 'failed to load';
    // The filter and sort skeletons are static markup; nothing else clears
    // them on this path, and they would pulse next to a failure message.
    els.filters.innerHTML = '';
    els.sort.textContent = '';
  }
})();
