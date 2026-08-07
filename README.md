# blog.bherms.com

A static site: a small build script, one stylesheet, and Cloudflare Workers
Assets. No framework, no Worker script, no database.

```bash
npm install
npm run build          # src/ -> dist/
npm run dev            # build + wrangler dev
npm run deploy         # build + wrangler deploy
npm run new -- <slug>  # scaffold a draft post
npm test               # simulator physics + the publishing pipeline
```

## Adding a post

```bash
npm run new -- how-i-think-about-x
```

```
src/posts/<slug>/
  meta.json     title, eyebrow, deck, byline, date, description, tags
  body.md       the article, in Markdown          ─┐ pick one
  body.html     the article, as raw HTML          ─┘
  js/ img/      optional, copied to /<slug>/js/ and /<slug>/img/
```

Then `npm run build`. The build discovers it; there is no registry to update.
Set `"draft": true` in `meta.json` to keep it out of the build.

**Markdown** covers ordinary writing. It renders into the site's own styles, and
adds three things on top of CommonMark/GFM:

| | |
| --- | --- |
| `[^1]` and `[^1]: …` | footnotes, numbered by order of first reference |
| `:::aside` / `:::note` | the two callout treatments the stylesheet has |
| `![alt](src "caption")` | a figure; the first one is the post's lead image |

Raw HTML passes straight through, so a Markdown post can still drop in a
`<figure class="rig">` and drive it from `js/`.

**HTML** is for posts that are mostly apparatus — the interactive ones. The body
is everything that sits inside `<main>`; the masthead, footer, theme toggle and
head come from the layout either way, so both kinds of post look identical.

## Sharing

Every page gets a 1200×630 card and a full set of `og:` and `twitter:` tags,
built from the post's own metadata. Nothing needs to be made by hand.

- Set `"image": "img/thing.jpg"` and the card is that art, cropped, with the
  title over a scrim.
- Set neither and the card is the site's road design: eyebrow, title,
  description, date, and the authorship badge if the post declares one.
- Set `"socialImage": "img/card.png"` to use a finished 1200×630 image verbatim.

Cards are drawn at build time. The fonts come from `node_modules` and the type
is converted to outlines before rasterising, so a card never depends on which
fonts happen to be installed on the machine that built it.

## Layout

```
build.mjs                 discovers posts, renders pages, writes dist/
scripts/new-post.mjs      the scaffold behind `npm run new`
src/site.config.mjs       site name, origin, nav, description
src/layout.mjs            the HTML shell — head, social tags, home, post, feed
src/markdown.mjs          Markdown -> the site's HTML
src/og.mjs                the 1200x630 share cards
src/imagesize.mjs         image dimensions from a file header
src/styles/site.css       the design system, both themes
src/posts/<slug>/         one directory per post
test/model.test.mjs       headless physics checks for the traffic simulators
test/site.test.mjs        markdown, cards, and the <head> of every built page
```

## Deploying

Push to `main`. GitHub Actions runs `npm test`, then `npm run build`, then
`wrangler deploy`; a failing model check stops the deploy rather than shipping
a post whose prose contradicts its own simulators. Pull requests run the same
job without the deploy step.

`npm run deploy` still works from a laptop and is the fallback if Actions is
down. Both use the wrangler pinned in `package-lock.json`.

The site is a Workers custom domain, which provisions its own DNS record and
certificate — there is no manual DNS step.
