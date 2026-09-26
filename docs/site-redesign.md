# Site redesign, 2026-09-27

## Why

The old front page was the stock developer-tool landing page: dark canvas,
terminal mock-up, a four-tile "why not an awesome-list" grid, a JSON config
block. It explained how the index is built to people who had come to see what
is in it, and it showed none of it — a list of design sites with no design on
the page. The videos lived on a second page nobody reached from a shared link.

## What it is now

One page for someone opening a shared link on a phone, in Chinese for
zh-* browsers and English for the rest (a header link switches and is
remembered):

- a two-line headline, then straight into a wall of every site (a real
  screenshot of its first screen) and every video (a 4-second muted loop that
  plays while on screen);
- one line per card saying what it is, in both languages: `site/curation.json`
  for sites; for videos the Chinese comes from the video classification and
  the English from the private `data/videos/en.json`. Search indexes both;
- categories and search in a sticky bar; the category is kept in the URL
  (`/#3d`) so a filtered wall can be shared;
- a click on a video plays the whole thing, with sound, from our own server —
  video.twimg.com does not load from mainland China;
- how the index works is reduced to one closing section with the one-line
  Claude Code install.

Light and dark follow the system. Everything above is ordered by
`curation.json#featured`, then newest first with a site every fourth card.

## Media, and how to rebuild it

All media is private build input under `data/` and never committed:

| what | made by | size (113 videos, 38 sites) |
| --- | --- | --- |
| `data/shots/<key>.webp` | `node tools/site-shots.mjs` | ~1.3 MB |
| `data/videos/clip/<id>.{mp4,webp}` | `tools/video-clips.sh` | ~16 MB |
| `data/videos/full/<id>.mp4` | `tools/video-clips.sh` | ~1.0 GB |

`site-shots.mjs` hides cookie banners before the shot; a site behind Vercel's
bot checkpoint needs `SHOTS_HEADED=1`. `gooey.jakubantalik.com` shows a
"moved" notice, so its picture is its og:image, placed by hand.

## Open

- `sifter.lab.z10.dev`, which the README offers as the faster mirror for
  mainland China, fails TLS: the entrance presents a `*.z10.dev` certificate,
  which does not cover a second-level name. `wc.lab.z10.dev` fails the same
  way, so it is the entrance, not this site.

## Deploy

`tools/deploy-site.sh` uploads only what changed (see the comment at its
top): the host has no rsync, so the new version starts as a hard-linked copy
of the live one and only new or resized media crosses the wire.
