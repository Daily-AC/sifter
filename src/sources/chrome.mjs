// Reading bookmarks out of a Chromium browser profile.
//
// Deliberately narrow: this reads ONE named folder and refuses to walk the
// whole tree. A bookmark bar is not a curated list — it is a mix of design
// galleries, an employer's admin panels, a JIRA ticket, and a router login
// page. Slurping all of it and calling the result a resource index is how
// you end up publishing where someone works. If you want a folder indexed,
// name it.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOTS = {
  darwin: [
    'Library/Application Support/Google/Chrome',
    'Library/Application Support/Google/Chrome Canary',
    'Library/Application Support/Microsoft Edge',
    'Library/Application Support/BraveSoftware/Brave-Browser',
    'Library/Application Support/Arc/User Data',
    'Library/Application Support/Vivaldi',
  ],
  linux: ['.config/google-chrome', '.config/chromium', '.config/microsoft-edge', '.config/BraveSoftware/Brave-Browser'],
  win32: [
    'AppData/Local/Google/Chrome/User Data',
    'AppData/Local/Microsoft/Edge/User Data',
    'AppData/Local/BraveSoftware/Brave-Browser/User Data',
  ],
};

/** Every profile on this machine that has a bookmarks file. */
export function findProfiles() {
  const out = [];
  for (const rel of ROOTS[process.platform] || []) {
    const root = join(homedir(), rel);
    if (!existsSync(root)) continue;
    let dirs = [];
    try { dirs = readdirSync(root).filter((d) => { try { return statSync(join(root, d)).isDirectory(); } catch { return false; } }); }
    catch { continue; }
    for (const d of dirs) {
      const f = join(root, d, 'Bookmarks');
      if (existsSync(f)) out.push({ browser: rel.split('/').pop(), profile: d, path: f });
    }
  }
  return out;
}

// Chrome timestamps: microseconds since 1601-01-01.
const CHROME_EPOCH_OFFSET = 11644473600000;
const chromeTime = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? new Date(n / 1000 - CHROME_EPOCH_OFFSET).toISOString() : null;
};

function* walk(node, trail) {
  if (node?.type === 'folder') {
    const t = [...trail, node.name || ''];
    for (const c of node.children || []) yield* walk(c, t);
  } else if (node?.type === 'url' && node.url) {
    yield { folder: trail.slice(1).join('/'), folderName: trail[trail.length - 1] || '',
            title: node.name || '', url: node.url, added: chromeTime(node.date_added) };
  }
}

export function listFolders(path) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const counts = new Map();
  for (const v of Object.values(data.roots || {})) {
    if (!v || typeof v !== 'object' || !v.children) continue;
    for (const b of walk(v, [v.name || ''])) counts.set(b.folder, (counts.get(b.folder) || 0) + 1);
  }
  return [...counts.entries()].map(([folder, count]) => ({ folder, count })).sort((a, b) => b.count - a.count);
}

/**
 * Bookmarks from one named folder.
 * `folder` matches the last path segment or the full path, case-insensitively.
 * Passing nothing throws — refusing to guess is the point.
 */
export function readFolder(path, folder, { recursive = true } = {}) {
  if (!folder || !String(folder).trim()) {
    throw new Error('a folder name is required; sifter never reads your whole bookmark tree.\n'
      + 'Run `sifter chrome --list` to see folder names.');
  }
  const want = String(folder).trim().toLowerCase();
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const all = [];
  for (const v of Object.values(data.roots || {})) {
    if (!v || typeof v !== 'object' || !v.children) continue;
    all.push(...walk(v, [v.name || '']));
  }
  const hit = all.filter((b) => {
    const full = b.folder.toLowerCase();
    const leaf = b.folderName.toLowerCase();
    return leaf === want || full === want || full.endsWith('/' + want)
      || (recursive && (full.startsWith(want + '/') || full.includes('/' + want + '/')));
  });
  if (!hit.length) {
    const names = [...new Set(all.map((b) => b.folder))].filter(Boolean).slice(0, 20);
    throw new Error(`no bookmark folder matched "${folder}".\nAvailable:\n  ` + names.join('\n  '));
  }
  return hit;
}
