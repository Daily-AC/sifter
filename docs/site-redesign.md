# Site redesign, 2026-09-27

## Why

The old front page was the stock developer-tool landing page: dark canvas,
terminal mock-up, a four-tile "why not an awesome-list" grid, a JSON config
block. It explained how the index is built to people who had come to see what
is in it, and it showed none of it — a list of design sites with no design on
the page. The videos lived on a second page nobody reached from a shared link.

## What it is now

One page, in Chinese, for someone opening a shared link on a phone:

- a two-line headline, then straight into a wall of every site (a real
  screenshot of its first screen) and every video (a 4-second muted loop that
  plays while on screen);
- one line of Chinese per card saying what it is, written in
  `site/curation.json` for sites and taken from the video classification for
  videos;
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

- Deploy: `tools/deploy-site.sh` still tars the whole site each time, which
  is not workable with 1 GB of full-length video. Needs an incremental upload
  before this ships.
- One page is Chinese only. The GitHub README (English) links to it.
