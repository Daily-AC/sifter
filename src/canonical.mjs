// URL normalization and resource grouping.
//
// Two different jobs, deliberately kept apart:
//   normalizeUrl() -> a clean, dereferenced URL safe to store and to visit
//   groupKey()     -> the identity a resource is deduped on across sources
//
// A resource is a *place you can go back to*, not a page. Ten tweets linking
// ten different shadcn/ui doc pages describe one resource, so grouping folds
// paths away — except on platforms where the path IS the identity (a GitHub
// repo, an npm package, a netdisk share).

const TRACKING_PARAMS = [
  /^utm_/i, /^ref$/i, /^ref_/i, /^fbclid$/i, /^gclid$/i, /^msclkid$/i,
  /^spm$/i, /^scm$/i, /^from$/i, /^source$/i, /^share_/i, /^si$/i,
  /^igshid$/i, /^mc_[ce]id$/i, /^_hs/i, /^vd_source$/i, /^s$/i, /^t$/i,
];

// Host prefixes that are a language/locale skin of the same site, not a
// different product. `zh.z-library.sk` and `z-library.sk` are one resource.
const LOCALE_PREFIXES = new Set([
  'www', 'zh', 'zh-cn', 'zh-hans', 'cn', 'en', 'en-us', 'us', 'ja', 'jp',
  'ko', 'kr', 'de', 'fr', 'es', 'ru', 'pt', 'it', 'm', 'mobile',
]);

// host -> how many leading path segments carry identity.
const PATH_IDENTITY = {
  'github.com': 2, 'gitlab.com': 2, 'bitbucket.org': 2, 'codeberg.org': 2,
  'huggingface.co': 2, 'gitee.com': 2,
  'npmjs.com': 2,            // /package/<name>
  'pypi.org': 2,             // /project/<name>
  'crates.io': 2,            // /crates/<name>
  'marketplace.visualstudio.com': 1,
  'chromewebstore.google.com': 3,
  'apps.apple.com': 4,
  'pan.quark.cn': 2, 'pan.baidu.com': 2, 'www.aliyundrive.com': 2,
  'drive.google.com': 3, 'mega.nz': 2,
  'x.com': 3, 'twitter.com': 3,       // /<user>/status/<id>
  'youtube.com': 1, 'youtu.be': 1,
  'medium.com': 2, 'dev.to': 2, 'zhihu.com': 2, 'juejin.cn': 2,
  'reddit.com': 4, 'news.ycombinator.com': 1,
  'notion.so': 1, 'notion.site': 1,
  'figma.com': 3, 'codepen.io': 3, 'codesandbox.io': 2, 'stackblitz.com': 2,
  'vercel.app': 1, 'pages.dev': 1, 'netlify.app': 1, 'github.io': 1,
};

// Hosts whose subdomain is a user's own space, so the subdomain is identity
// and must never be stripped as a locale.
const SUBDOMAIN_IS_IDENTITY = [
  'vercel.app', 'pages.dev', 'netlify.app', 'github.io', 'gitlab.io',
  'herokuapp.com', 'workers.dev', 'surge.sh', 'glitch.me', 'repl.co',
  'notion.site', 'framer.website', 'webflow.io', 'myshopify.com',
];

export function normalizeUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim().replace(/[)\]，。、,;>"'》]+$/u, '');
  if (!/^https?:\/\//i.test(s)) {
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(s)) s = 'https://' + s;
    else return null;
  }
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  u.protocol = 'https:';
  u.hostname = u.hostname.toLowerCase().replace(/\.$/, '');
  u.username = ''; u.password = '';
  if ((u.port === '80' || u.port === '443')) u.port = '';

  const keep = new URLSearchParams();
  for (const [k, v] of u.searchParams) {
    if (TRACKING_PARAMS.some((re) => re.test(k))) continue;
    keep.append(k, v);
  }
  const sorted = [...keep.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  u.search = sorted.length ? '?' + new URLSearchParams(sorted).toString() : '';

  // A bare `#` or `#/` carries nothing; a real fragment may be SPA routing
  // or a deep anchor the author meant, so it is kept.
  if (u.hash === '#' || u.hash === '#/') u.hash = '';
  if (u.pathname !== '/' && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '');

  return u.toString();
}

function subdomainIsIdentity(host) {
  return SUBDOMAIN_IS_IDENTITY.some((suf) => host.endsWith('.' + suf));
}

/** Host with locale/www skins folded away. Preserves user-space subdomains. */
export function canonicalHost(host) {
  if (subdomainIsIdentity(host)) return host;
  const parts = host.split('.');
  while (parts.length > 2 && LOCALE_PREFIXES.has(parts[0])) parts.shift();
  if (parts.length > 2 && LOCALE_PREFIXES.has(parts[0])) parts.shift();
  return parts.join('.');
}

function pathIdentityDepth(host) {
  if (host in PATH_IDENTITY) return PATH_IDENTITY[host];
  for (const [suf, n] of Object.entries(PATH_IDENTITY)) {
    if (host.endsWith('.' + suf)) return n;
  }
  return 0;
}

/** Stable identity two links are deduped on. */
export function groupKey(url) {
  const n = normalizeUrl(url);
  if (!n) return null;
  const u = new URL(n);
  const host = canonicalHost(u.hostname);
  const depth = pathIdentityDepth(host);
  if (depth === 0) return host;
  const segs = u.pathname.split('/').filter(Boolean).slice(0, depth);
  if (!segs.length) return host;
  return host + '/' + segs.join('/').toLowerCase();
}

/**
 * Of several URLs for one resource, the one worth storing.
 * Prefers the shallowest real page: a landing page beats a deep doc anchor,
 * but the root beats nothing only when the root is what was actually linked.
 */
export function bestUrl(urls) {
  const norm = [...new Set(urls.map(normalizeUrl).filter(Boolean))];
  if (!norm.length) return null;
  return norm.sort((a, b) => {
    const ua = new URL(a), ub = new URL(b);
    const da = ua.pathname.split('/').filter(Boolean).length;
    const db = ub.pathname.split('/').filter(Boolean).length;
    if (da !== db) return da - db;
    if (!!ua.search !== !!ub.search) return ua.search ? 1 : -1;
    if (!!ua.hash !== !!ub.hash) return ua.hash ? 1 : -1;
    return a.length - b.length;
  })[0];
}
