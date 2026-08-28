// What this page records, and what it deliberately does not.
//
// The useful question the site can answer is not "how many people came" — it
// is "what did someone look for and not find". A search that returns nothing
// is a gap in the index, stated by a real person in their own words, and it
// is the only number here that changes what sifter should go collect.
// Everything else exists to make that one readable: without knowing whether
// anybody searched at all, a week of zero misses means either a complete
// index or an empty room.
//
// The collector is this file and nothing else. There is no third-party
// script, no cookie, no localStorage, no fingerprint, and no IP address in
// the store — events arrive as a query string on a request that nginx logs
// and answers 204, so the entire backend is one `location` block and a text
// file that logrotate ages out. See deploy/analytics.nginx.conf.

const ENDPOINT = '/e';

// A session that reports more than this is either broken or being scripted;
// either way the tail is noise and dropping it costs nothing real.
const MAX_EVENTS = 60;

// Long enough for a truncated term to be worthless to an attacker fishing
// for pasted secrets, short enough to keep a real query intact.
const QUERY_CAP = 80;

// Silence before typing counts as a search. Every keystroke re-renders, and
// reporting each one would turn "shader" into six searches and bury the
// terms people actually stopped to read.
const SETTLE = 700;

/**
 * Opting out has to be genuinely free, so three separate signals all mean no:
 * the two the browser can send on its own, and one a person can set by hand.
 * A storage exception counts as opt-out too — in a locked-down browser the
 * choice has effectively already been expressed, and the alternative is
 * reaching for something more persistent to work around it.
 */
function optedOut() {
  try {
    if (navigator.doNotTrack === '1' || window.doNotTrack === '1') return true;
    if (navigator.globalPrivacyControl) return true;
    if (localStorage.getItem('sifter:no-analytics')) return true;
  } catch {
    return true;
  }
  return false;
}

const off = optedOut();

// Groups events within one tab visit so "three searches then an open" is
// distinguishable from three separate people. It dies with the tab: there is
// no persistent identifier here, and no way to recognise a returning visitor.
let sid = Math.random().toString(36).slice(2, 10);
try {
  const stored = sessionStorage.getItem('sifter:s');
  if (stored) sid = stored;
  else sessionStorage.setItem('sifter:s', sid);
} catch {
  // No sessionStorage: the in-memory id still groups this page load.
}

let sent = 0;

function send(name, fields) {
  if (off || sent >= MAX_EVENTS) return;
  sent++;

  const params = new URLSearchParams({ e: name, s: sid });
  for (const [k, v] of Object.entries(fields || {})) {
    if (v === undefined || v === null || v === '') continue;
    params.set(k, String(v).slice(0, QUERY_CAP));
  }
  const url = `${ENDPOINT}?${params}`;

  // sendBeacon survives the page going away, which a plain fetch does not —
  // it is called with no body on purpose, so nginx gets an empty POST it can
  // answer without reading anything.
  try {
    if (navigator.sendBeacon?.(url)) return;
  } catch {
    // Some content-blockers throw here rather than returning false.
  }
  try {
    fetch(url, { method: 'POST', keepalive: true, mode: 'no-cors', cache: 'no-store' });
  } catch {
    // Reporting is never worth an error in the console of a page that works.
  }
}

export function view() {
  let ref = '';
  try {
    ref = document.referrer ? new URL(document.referrer).hostname.replace(/^www\./, '') : '';
  } catch {
    ref = '';
  }
  if (ref === location.hostname) ref = '';

  send('view', {
    ref,
    // A bucket, not a size: enough to answer "should the narrow layout get
    // more attention", not enough to help identify a screen.
    w: innerWidth < 560 ? 'sm' : innerWidth < 1000 ? 'md' : 'lg',
    l: (navigator.language || '').slice(0, 5),
  });
}

let pending = null;
let timer = null;

/** Called on every keystroke; reports at most once per settled query. */
export function search(q, results, filter) {
  clearTimeout(timer);
  if (!q) { pending = null; return; }
  pending = { q, results, filter };
  timer = setTimeout(flush, SETTLE);
}

function flush() {
  if (!pending) return;
  const { q, results, filter } = pending;
  pending = null;
  // Prefixes of one another are still reported — "shad" then "shader" both
  // go out — because collapsing them needs the whole session and the reader
  // has it: tools/stats.mjs folds a prefix chain into its longest term.
  send('search', { q, n: results, f: filter });
}

export function open(key, q, rank) {
  send('open', { k: key, q, r: rank });
}

export function facet(name) {
  send('facet', { f: name });
}

export function copy() {
  send('copy', {});
}

// A search someone typed and then left on screen is the most interesting
// kind — they read the results and stopped. pagehide fires where unload does
// not, particularly on mobile.
addEventListener('pagehide', () => { clearTimeout(timer); flush(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { clearTimeout(timer); flush(); }
});
