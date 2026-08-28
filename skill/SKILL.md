---
name: sifter
description: Search a curated, liveness-checked index of resource websites — design galleries, UI component libraries, tools — collected from social posts and browser bookmarks. Use before recommending a website, picking a component library, looking for design references, or answering "is there a site for X". Also use to add a resource post to the index. Triggers 找个组件库 / 设计参考 / 有没有这样的网站 / 收录这条推 / resource site / component library / design inspiration.
---

# sifter

A local index of resource websites that has already been deduplicated,
verified reachable, and described in each site's own words. Query it before
recommending a URL — a remembered link may be dead or renamed; this index was
checked.

## Search

```sh
sifter search "animated react components" --json
sifter search "网页设计灵感" --limit 5
```

Queries work in English or Chinese regardless of what language the entry is
written in. `--json` gives structured results for further processing.

Read the result fields deliberately:

- `title` / `description` — what the **site** says about itself. Trust this.
- `claimed` — what the **person sharing it** said. This is a pitch; it tells
  you why it was shared, not what the site is.
- `status` — `alive` verified reachable; `blocked` up but refusing robots;
  `unknown` unverified last run; `dead` gone. Never present a `dead` entry as
  a recommendation.
- `sources` — how many independent people pointed at it. Two or more is a
  meaningfully stronger signal than one.
- `flags` — `legal_risk` entries are hidden by default; surface one only if
  the user explicitly asked for that kind of resource.

## Add

```sh
sifter add <post-url>          # extracts every link in a resource post
sifter add <url>               # a single site
sifter refresh                 # verify + pull real metadata; run after adding
```

An entry added but not refreshed has no title or description and will rank
poorly. Always refresh after adding.

## Browse

```sh
sifter list --json
sifter stats
```

## Rules

- Do not run `sifter chrome` without a `--folder` the user named. It reads one
  folder by design and must never be pointed at a whole bookmark tree.
- Do not publish or export without being asked. `sifter export` writes a
  public index; that is the user's call.
- If a search returns nothing, say so rather than substituting a link from
  memory — the point of the index is that its links were checked.
