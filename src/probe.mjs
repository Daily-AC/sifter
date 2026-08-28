// Visits a URL once and answers two questions with the same request:
// is it still there, and what does it actually say about itself.
//
// The naive version of this is `curl -o /dev/null -w %{http_code}` and a
// check for 200. That is wrong in a way that quietly poisons the index:
// measured against nine real resource links, two returned 403 — both alive,
// both simply refusing a robot. Marking them dead deletes good resources;
// marking them alive without noticing hides that nobody verified them. So
// blocked is its own verdict, and it is neither.
//
// The description matters as much as the status. A resource post says
// "Rare UI - the best animated components"; the site's own <title> says
// "Rare UI — Rare Animated React Components". The second is what a search
// index should match on, because it is what the thing calls itself.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const BLOCK_BODY = [
  /just a moment/i, /attention required/i, /checking your browser/i,
  /cf-browser-verification/i, /enable javascript and cookies/i,
  /ddos-guard/i, /请开启 ?javascript/i, /访问验证/i, /人机验证/i,
  /captcha/i, /are you a robot/i, /access denied/i,
];

const decodeEntities = (s) => s
  .replace(/&(?:amp|#38);/g, '&').replace(/&(?:lt|#60);/g, '<')
  .replace(/&(?:gt|#62);/g, '>').replace(/&(?:quot|#34);/g, '"')
  .replace(/&(?:apos|#39);/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));

function meta(html, ...names) {
  for (const n of names) {
    const re = new RegExp(
      `<meta[^>]+(?:name|property)\\s*=\\s*(["'])${n}\\1[^>]*>`, 'i');
    const tag = html.match(re)?.[0];
    // Match the closing quote to the OPENING one. A description written
    // `content="bloub recrée l'oiseau"` is perfectly legal HTML, and a
    // character class of [^"'] truncates it at the apostrophe — quietly,
    // mid-sentence, in every French and English-possessive description.
    const val = tag?.match(/content\s*=\s*(["'])([\s\S]*?)\1/i)?.[2];
    if (val?.trim()) return decodeEntities(val.trim()).replace(/\s+/g, ' ');
  }
  return null;
}

export function parseHtml(html) {
  const head = html.slice(0, 200_000);
  const rawTitle = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return {
    title: rawTitle ? decodeEntities(rawTitle.trim()).replace(/\s+/g, ' ').slice(0, 200) : null,
    ogTitle: meta(head, 'og:title', 'twitter:title'),
    description: (meta(head, 'description', 'og:description', 'twitter:description') || '').slice(0, 500) || null,
    siteName: meta(head, 'og:site_name', 'application-name'),
    image: meta(head, 'og:image', 'twitter:image'),
    lang: head.match(/<html[^>]+lang\s*=\s*["']([^"']+)["']/i)?.[1] || null,
  };
}

export async function probe(url, { timeout = 15000, signal } = {}) {
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort('timeout'), timeout);
  if (signal) signal.addEventListener('abort', () => ctl.abort(), { once: true });

  const out = { url, checked_at: new Date().toISOString(), status: 'unknown' };
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctl.signal,
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9,zh-CN;q=0.8',
      },
    });
    out.code = res.status;
    out.final_url = res.url;
    out.redirected = res.url !== url;

    const ctype = res.headers.get('content-type') || '';
    const isHtml = /html|xml|text\/plain/i.test(ctype);
    let body = '';
    if (isHtml) {
      const buf = await res.arrayBuffer();
      const cs = ctype.match(/charset=([\w-]+)/i)?.[1] || 'utf-8';
      try { body = new TextDecoder(cs).decode(buf); }
      catch { body = new TextDecoder('utf-8').decode(buf); }
    } else {
      res.body?.cancel?.();
    }

    const looksBlocked = BLOCK_BODY.some((re) => re.test(body.slice(0, 8000)))
      || !!res.headers.get('cf-mitigated');

    if (res.status >= 200 && res.status < 300) {
      out.status = looksBlocked ? 'blocked' : 'alive';
    } else if (res.status === 403 || res.status === 429 || res.status === 503) {
      // The site is up and answering; it just does not answer *us*.
      out.status = 'blocked';
      out.note = looksBlocked ? 'bot-challenge' : `http ${res.status}`;
    } else if (res.status === 404 || res.status === 410) {
      out.status = 'dead';
    } else if (res.status >= 500) {
      out.status = 'unknown';
      out.note = `server error ${res.status}`;
    } else {
      out.status = 'unknown';
    }

    if (body && out.status !== 'dead') Object.assign(out, parseHtml(body));
  } catch (err) {
    // Node wraps network failures: `err.message` is a useless "fetch failed"
    // and the real reason (ENOTFOUND, ECONNREFUSED) hides in `err.cause.code`.
    // Reading only the message marks dead domains as merely unknown.
    const cause = err?.cause;
    const msg = [err?.name, err?.message, cause?.code, cause?.message, err?.code]
      .filter(Boolean).join(' ');
    if (/abort|timeout/i.test(msg)) { out.status = 'unknown'; out.note = 'timeout'; }
    else if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|dns/i.test(msg)) { out.status = 'dead'; out.note = 'dns-failure'; }
    else if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH/i.test(msg)) { out.status = 'dead'; out.note = 'unreachable'; }
    else if (/certificate|SSL|TLS/i.test(msg)) { out.status = 'blocked'; out.note = 'tls-error'; }
    else { out.status = 'unknown'; out.note = msg.slice(0, 120); }
  } finally {
    clearTimeout(timer);
  }
  out.ms = Date.now() - started;
  return out;
}

/** GitHub repos describe themselves better through the API than through HTML. */
export async function probeGithub(owner, repo, { token = process.env.GITHUB_TOKEN } = {}) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'sifter' };
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
    if (res.status === 404) return { status: 'dead', note: 'repo not found' };
    if (!res.ok) return null;
    const j = await res.json();
    return {
      status: 'alive',
      title: j.full_name,
      description: j.description,
      stars: j.stargazers_count,
      language: j.language,
      topics: j.topics || [],
      archived: j.archived,
      pushed_at: j.pushed_at,
      license: j.license?.spdx_id || null,
      homepage: j.homepage || null,
    };
  } catch { return null; }
}

export async function probeAll(urls, { concurrency = 6, ...opts } = {}) {
  const results = new Array(urls.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
    while (i < urls.length) {
      const idx = i++;
      results[idx] = await probe(urls[idx], opts);
    }
  });
  await Promise.all(workers);
  return results;
}
