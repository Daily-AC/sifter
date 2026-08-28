# sifter

Resource posts are everywhere and useless.

Someone on X lists fifteen sites worth bookmarking. You save the post. Two
months later you need one of them and you cannot remember which post it was,
four of the links are dead, three of them were the same site under different
names, and your coding agent — which is the thing that would actually *use*
these — has no way to see any of it.

`sifter` turns those scattered posts and bookmark folders into one index that
is deduplicated, checked for liveness, described in the sites' own words, and
searchable by an agent over MCP.

```
$ sifter add https://x.com/someone/status/2092937412490260513
  + beautifului.dev
  + beui.dev
  + rareui.com
  + transitions.dev
  + ui.shadcn.com

$ sifter refresh
  ● beautifului.dev    Beautiful UI — Crafted primitives for AI-native interfaces
  ● rareui.com         Rare UI — Rare Animated React Components
  ⇢ godly.website merged into recent.design

$ sifter search "动画组件"
● Rare UI — Rare Animated React Components
  https://rareui.com/
  A free, open-source registry of rare animated React components...
  2 sources · 审美 设计相关
```

## Why not just an awesome-list

An awesome-list is a text file someone edits by hand. It goes stale silently:
links rot, sites get renamed, the same tool appears in three sections, and the
one-line description is whatever the submitter wrote in 2021.

sifter is derived data, so none of that accumulates.

**It merges what is actually the same thing.** `www.beautifului.dev` and
`beautifului.dev` are one entry. So are `zh.z-library.sk` and `z-library.sk`.
So are `godly.website` and `recent.design`, because the first now redirects to
the second — that rename is caught on the next refresh, and both names stay
searchable.

**It knows what is still alive, and it does not lie about it.** The obvious
implementation checks for HTTP 200 and calls everything else dead. Measured
against real resource links, that deletes working sites: two of the first nine
tested returned 403 because Cloudflare does not like robots. `blocked` is
therefore its own verdict, distinct from both `alive` and `dead`.

**It describes things in their own words.** A post says *"Rare UI — the best
animated components"*. The site's own title says *"Rare UI — Rare Animated
React Components"*, and its meta description says what it is built with. The
index searches on the latter and keeps the former as provenance, so you can
see what was claimed and what is true.

**It counts corroboration.** When the same site arrives from a post and from
your bookmarks, that is recorded — `2 sources`. Independent people pointing at
the same thing is a better signal than a star count, and no hand-written list
has it.

**An agent can query it.** This is the part an awesome-list structurally
cannot do. A 5,000-line README has to be read whole into context. An MCP
server answers `"animated react components"` with eight ranked entries.

## Install

```sh
npx sifter --help          # no install
npm i -g sifter            # or install it
```

Node 20+. No dependencies, no API key, no service to run.

## Collect

**From a post.** No login and no API key — sifter reads posts through public
channels, preferring the one that returns complete text:

```sh
sifter add https://x.com/user/status/123456789
sifter add https://x.com/user/status/123 https://example.com/some-tool
```

> The official syndication endpoint truncates long posts. On the post that
> started this project it returned 176 of 341 characters and 2 of 5 links —
> the last three sites would have silently never existed. sifter tries
> channels in order and prefers whichever returns a complete answer.

**From your bookmarks.** sifter reads **one folder that you name**, and
refuses to walk your whole bookmark tree:

```sh
sifter chrome --list                      # what folders exist
sifter chrome --folder "Design" --tag design
```

That refusal is the point. A bookmark bar is not a curated list — it is a
design gallery sitting next to your employer's admin panel, a JIRA ticket, and
a router login page. Indexing all of it and publishing the result is how you
leak where you work. Name the folder you mean.

**Searching for posts** needs a logged-in session, which sifter does not have.
If you use [omnireach](https://github.com/Daily-AC/omnireach) it will be used
for that; otherwise pass links yourself.

## Verify and enrich

```sh
sifter refresh              # anything not checked in the last week
sifter refresh --all
```

Each entry is fetched once: liveness, real title, real description, language,
and — for GitHub repos — stars, topics, license, and whether it is archived.
Renames discovered through redirects are folded here.

## Search

```sh
sifter search "animated react components"
sifter search "网页设计灵感"          # queries cross languages
sifter search "shader" --limit 3 --json
```

Search is a linear scan with BM25 scoring, bigram tokenization for CJK,
conservative English stemming, and a small editable bilingual word list
(`src/lexicon.mjs`). It runs the moment you clone the repo — no embedding API,
nothing to configure. Corroboration, stars and liveness nudge the ranking but
cannot outvote relevance, and dead entries sink rather than disappear.

## Give it to your agent

```json
{
  "mcpServers": {
    "sifter": {
      "command": "npx",
      "args": ["-y", "sifter-mcp"],
      "env": { "SIFTER_DB": "/path/to/your/resources.jsonl" }
    }
  }
}
```

Three tools: `sifter_search`, `sifter_list`, `sifter_get`. With no `SIFTER_DB`
the server serves the public index shipped in this repo, so an agent has
something useful to search before you have collected anything.

## Publish

```sh
sifter export               # -> index/resources.json + index/README.md
```

`index/README.md` is a real browsable awesome-list, generated. Nothing is
published that has not passed the screen:

| held back | why |
|---|---|
| `private` | a login page, console, or internal host |
| `demoted` without an independent source | a private deep link whose public parent nothing else vouched for |
| `legal_risk` | shadow libraries, streaming mirrors, cracked software |
| `dead` | not reachable on the last check |

Risk is **marked, never dropped**. Your local library keeps everything you
actually saw; export decides what ships. Changing your mind later is a flag
filter, not a re-crawl. Pass `--allow-risk` if you disagree — it is your
repository and your jurisdiction.

The risk screen is a heuristic and over-flags on purpose. It reads the framing
of the whole post, not just the line a link sits on, because that is where the
evidence usually is: none of fifteen streaming sites described itself as
piracy, but the sentence above the list said *"don't want to pay, but want to
read books and watch shows?"*

## Data

One JSON object per line, in git, so a day's changes read as a reviewable
diff — four sites added, one marked dead — instead of a binary blob.

```json
{
  "key": "recent.design",
  "url": "https://recent.design/",
  "aliases": ["godly.website"],
  "title": "Recent — Design Inspiration",
  "description": "The best design inspiration on the Internet.",
  "names": ["Recent — Design Inspiration", "Godly - Astronomically good web design inspiration"],
  "claims": [{ "text": "...", "from": "https://x.com/..." }],
  "sections": ["审美 设计相关"],
  "flags": [],
  "liveness": { "status": "alive", "code": 200, "checked_at": "2026-08-28T..." },
  "sources": [{ "type": "chrome", "folder": "..." }, { "type": "x", "author": "..." }],
  "mentions": 2
}
```

`SIFTER_DB` points at it; the default is `data/resources.jsonl`.

## Privacy

- One named folder, never the whole bookmark tree.
- Entries screened `private` are stored locally and **never** probed over the
  network, exported, or served over MCP.
- A private deep link demotes to its public parent, and that parent is
  published only if some independent public source also vouched for it —
  otherwise walking up from your employer's login page publishes your
  employer.
- Nothing is uploaded anywhere. The index is a file you own.

## Development

```sh
npm test        # 24 regression tests, no network
```

Every test in there is a mistake this pipeline actually made against real
data, and every one of them was silent — a live site marked dead, a French
description truncated at an apostrophe, a whole post's worth of streaming
mirrors queued for publication.

## License

MIT
