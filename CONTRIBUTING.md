# Contributing

## Submitting a resource

```sh
npx @z10/sifter submit https://example.com --note "what it gives you that the alternatives don't"
```

This verifies the URL on your machine first — privacy screen, liveness check,
real title and description, duplicate check — then prints a prefilled issue
link. Nothing is sent until you open it.

Add `--open` to file it directly (uses `gh` if you have it), or `--from <post-url>`
if you saw it recommended somewhere, which is recorded as provenance.

No Node? Use the [issue form](../../issues/new?template=submit.yml). A bot runs
the same check and posts the result on the thread.

### What gets accepted

A resource is worth indexing if someone looking for its category would be
glad to find it. Concretely:

- **Public.** Not a dashboard, login page, internal tool, or personal account
  page. The privacy screen rejects most of these automatically.
- **Reachable.** Dead links are refused at submission.
- **Its own thing.** A component library, gallery, tool, or reference — not a
  blog post *about* one, and not a link aggregator whose entries belong here
  individually.
- **Honestly described.** The index stores what the site says about itself.
  Your note explains why it earns a place; it is kept as provenance, not
  passed off as a neutral description.

Self-submission is fine, and marked as such. Submitting your own project
repeatedly under different links is not.

Entries flagged `legal_risk` — shadow libraries, streaming mirrors, cracked
software — are kept out of the published index. That is a decision about what
this repository can host, not a judgment about you.

## Changing the code

```sh
git clone https://github.com/Daily-AC/sifter && cd sifter
npm test
```

No dependencies, and the tests do not touch the network — every one of them
is a mistake this pipeline made against real data, kept so it cannot come
back. If you fix a defect, add the case that caught it.

Things worth knowing before changing extraction or probing:

- Liveness has four states, not two. `blocked` means the site is up and
  refusing robots; collapsing it into `dead` deletes working resources.
- A section heading is inferred, and the inference is deliberately
  conservative. Losing a real heading costs grouping; keeping a false one
  pollutes the published index.
- Anything sourced from a browser bookmark is private by default. Folder
  names and timestamps must not reach `index/`.
