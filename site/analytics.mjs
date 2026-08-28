// What this page records, and why it is shaped this way.
//
// The site needs one number to be useful: how often does a search come back
// empty? That is the rate at which the index fails the person in front of it.
// But knowing the rate does not require knowing the terms, and those are two
// very different things to hold. So they are split, and only one of them is
// collected:
//
//   Counted, always, anonymously — how many searches, how many came back
//   empty, how many results got opened. One record per visit, written when
//   the tab goes away. No identifier, no ordering, no text anybody typed.
//
//   The term itself — only when somebody presses a button that says it will
//   be sent. That is the same bargain sifter already offers for submissions:
//   the work happens on your machine, the link sits there, and you decide.
//
// The earlier version of this file reported every event as it happened, with
// an id tying them together, and leaned on the two servers being configured
// not to hold both halves. That protected who was asking while collecting
// everything they asked — and on a site this size, a referrer plus a language
// plus a sequence of actions identifies people perfectly well without an
// address. Not collecting it is the only version of this that does not
// require trusting an nginx config.

const ENDPOINT = '/e';
const TERM_CAP = 80;

/**
 * Three signals all mean no: the two a browser can send by itself, and one a
 * person can set by hand. A storage exception counts as a refusal too — in a
 * locked-down browser the choice is already expressed, and the alternative is
 * reaching for something more persistent to get around it.
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

function send(name, fields) {
  if (off) return;
  const params = new URLSearchParams({ e: name });
  for (const [k, v] of Object.entries(fields || {})) {
    if (v === undefined || v === null || v === '' || v === 0) continue;
    params.set(k, String(v).slice(0, TERM_CAP));
  }
  const url = `${ENDPOINT}?${params}`;
  // sendBeacon survives the page going away, which is the only moment the
  // summary is written. Called with no body on purpose: nginx logs the query
  // string and answers without reading anything.
  try {
    if (navigator.sendBeacon?.(url)) return;
  } catch {
    // Some content blockers throw here rather than returning false.
  }
  try {
    fetch(url, { method: 'POST', keepalive: true, mode: 'no-cors', cache: 'no-store' });
  } catch {
    // Reporting is never worth an error in the console of a page that works.
  }
}

// Exported so the counting rules below can be tested outside a browser;
// nothing reads it from outside except the summary and the test suite.
export const visit = { searches: 0, misses: 0, opens: 0, facets: 0, copied: false };

// The last search that was counted, so that refining one is not counted as
// another. Held in memory for the length of the visit and never sent.
let counted = null;

/**
 * Called on every keystroke. Typing "sha" -> "shad" -> "shader" is one search,
 * and the outcome that matters is the one it ended on: a query and the query
 * it grew from replace each other rather than accumulating.
 *
 * This undercounts in one case — "shader" edited into "shadow" passes through
 * "shad", so the chain never breaks and the two searches count as one. It errs
 * toward reporting fewer searches than happened, which is the safe direction
 * for a miss rate.
 */
export function searched(q, results) {
  if (!q) { counted = null; return; }

  if (counted && (q.startsWith(counted.q) || counted.q.startsWith(q))) {
    if (counted.n === 0 && results > 0) visit.misses--;
    if (counted.n > 0 && results === 0) visit.misses++;
    counted = { q, n: results };
    return;
  }

  visit.searches++;
  if (results === 0) visit.misses++;
  counted = { q, n: results };
}

/**
 * An open is reported on its own rather than folded into the summary, because
 * which entry ranked where is worth knowing per entry. It carries no query and
 * no visit id: the key is a row in a public index, not something anybody typed.
 */
export function opened(key, rank) {
  visit.opens++;
  send('open', { k: key, r: rank });
}

export function facetUsed() { visit.facets++; }
export function copied() { visit.copied = true; }

/** The only call that sends text a person typed, and only from a button. */
export function reportGap(term) {
  send('miss', { q: term });
}

let summarised = false;

/**
 * One record per visit, written once. Firing again on a later hide would make
 * one visit look like two, and the counts are worth more than the tail of a
 * session somebody came back to.
 */
function summarise() {
  if (summarised || off) return;
  summarised = true;

  let ref = '';
  try {
    ref = document.referrer ? new URL(document.referrer).hostname.replace(/^www\./, '') : '';
  } catch { /* opaque referrer */ }
  if (ref === location.hostname) ref = '';

  send('s', {
    n: visit.searches, m: visit.misses, o: visit.opens, f: visit.facets,
    c: visit.copied ? 1 : 0,
    ref,
    // A bucket, not a size: enough to answer "does the narrow layout deserve
    // more attention", not enough to help identify a screen.
    w: innerWidth < 560 ? 'sm' : innerWidth < 1000 ? 'md' : 'lg',
    l: (navigator.language || '').slice(0, 5),
  });
}

// Guarded so importing this module outside a browser is not an error — the
// counting rules are worth testing and a test runner has no document.
if (typeof document !== 'undefined') {
  addEventListener('pagehide', summarise);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') summarise();
  });
}
