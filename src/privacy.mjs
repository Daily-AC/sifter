// Keeps personal URLs out of a shared index.
//
// Bookmark folders are honest about what people actually save: a design
// gallery sits next to a Backblaze console, a JIRA ticket, and a login page
// for someone's shop admin. Publishing that verbatim leaks where you have
// accounts and what you work on. So every URL is screened before it can be
// exported, and anything screened out stays local rather than being deleted.
//
// The screen errs toward marking things private. A false positive costs one
// public entry; a false negative publishes your admin panel.

const HOST_PREFIX = [
  'console', 'admin', 'secure', 'dashboard', 'portal', 'manage', 'manager',
  'my', 'account', 'accounts', 'auth', 'login', 'sso', 'id', 'billing',
  'jira', 'confluence', 'gitlab', 'jenkins', 'grafana', 'kibana', 'nexus',
  'vpn', 'mail', 'webmail', 'owa', 'erp', 'crm', 'oa', 'hr',
];

// Words that mean "you are logged in" no matter how shallow the path.
const PATH_HARD = [
  '/login', '/signin', '/sign-in', '/signup', '/sign-up', '/register',
  '/auth', '/oauth', '/logout', '/console', '/admin', '/dashboard',
  '/billing', '/checkout', '/invoice', '/subscription', '/workspace',
  '/browse/',           // jira ticket
];

// Words that often name a logged-in area but also name ordinary marketing
// pages (`/account` on a pricing site, `/settings` in docs). Shallow and
// query-free, these are given the benefit of the doubt.
const PATH_SOFT = [
  '/account', '/profile', '/settings', '/preferences',
  '/my/', '/me/', '/user/', '/users/me', '/orders',
];

const QUERY_SIGNAL = [
  /token/i, /secret/i, /passwo?rd/i, /^key$/i, /apikey/i, /api_key/i,
  /session/i, /sig$/i, /signature/i, /jql/i, /^code$/i, /access/i,
  /^auth/i, /credential/i,
];

// Reachable only from a specific network, so useless to anyone else even
// if it were harmless to publish.
const PRIVATE_HOST = [
  /^localhost$/i, /^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./,
  /\.local$/i, /\.internal$/i, /\.lan$/i, /\.corp$/i, /\.frp\./i,
  /^\[?[0-9a-f:]+\]?$/i,
];

// Files, not places.
const FILE_EXT = /\.(zip|rar|7z|tar|gz|dmg|pkg|exe|msi|apk|ipa|iso|pdf|docx?|xlsx?|pptx?|csv|mp4|mp3|png|jpe?g|gif|webp|svg)$/i;

export function screen(url, opts = {}) {
  const reasons = [];
  let u;
  try { u = new URL(url); } catch { return { private: true, reasons: ['unparseable'], kind: 'invalid' }; }

  const host = u.hostname.toLowerCase();
  const path = u.pathname.toLowerCase();
  const segs = host.split('.');

  if (PRIVATE_HOST.some((re) => re.test(host))) reasons.push('private-network');
  // Checks every label, not just the first: `dc.console.aliyun.com` is as
  // much a console as `console.aliyun.com`.
  if (segs.length > 2) {
    const hit = segs.slice(0, -2).find((seg) => HOST_PREFIX.includes(seg));
    if (hit) reasons.push(`host-prefix:${hit}`);
  }
  for (const p of PATH_HARD) if (path.includes(p)) { reasons.push(`path:${p}`); break; }
  for (const p of PATH_SOFT) if (path.includes(p)) { reasons.push(`soft-path:${p}`); break; }
  for (const [k, v] of u.searchParams) {
    if (QUERY_SIGNAL.some((re) => re.test(k))) { reasons.push(`query:${k}`); break; }
    if (v.length > 60 && /^[A-Za-z0-9_\-.=]+$/.test(v)) { reasons.push(`query:${k}(opaque)`); break; }
  }
  if (u.hash && /token|access|id_token|session/i.test(u.hash)) reasons.push('fragment-credential');
  if (FILE_EXT.test(path)) reasons.push('direct-file');

  for (const d of opts.blocklist || []) {
    if (host === d || host.endsWith('.' + d)) reasons.push(`blocklist:${d}`);
  }

  const softOnly = reasons.length > 0 && reasons.every((r) => r.startsWith('soft-path:'));
  const shallow = path.split('/').filter(Boolean).length <= 1;
  if (softOnly && shallow && !u.search) {
    return { private: false, reasons, kind: 'public', note: 'shallow path, treated as landing page' };
  }

  const isPrivate = reasons.length > 0;
  const out = { private: isPrivate, reasons, kind: isPrivate ? 'private' : 'public' };

  // A private URL usually hangs off a perfectly public product. Rather than
  // dropping `studio.tripo3d.ai/workspace/generate` entirely, walk up to the
  // shallowest ancestor that screens clean and offer that instead — the
  // resource is real, only the deep link was personal.
  if (isPrivate && !reasons.some((r) => r === 'private-network' || r.startsWith('blocklist:'))) {
    const parts = u.pathname.split('/').filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i--) {
      const cand = u.origin + (i ? '/' + parts.slice(0, i).join('/') : '/');
      const sub = screen(cand, { ...opts, _noFallback: true });
      if (!sub.private) { out.publicAncestor = cand; break; }
    }
  }
  return out;
}
