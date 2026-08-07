# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## What this is

`blog.bherms.com` — a static site built by a small Node script and served by
Cloudflare Workers Assets. There is **no Worker script**: `wrangler.jsonc`
declares only `assets.directory`, which is enough to serve the site and keeps it
on the free tier. The custom domain provisions its own DNS record and TLS
certificate on `wrangler deploy`, so there is no manual DNS step.

Related: `bherms.com` itself is a separate Worker in `../brad-site` (a résumé
served as a browsable JSON feed). `bradleytherman.com` forwards to `bherms.com`.
This repo owns only the `blog.` subdomain.

## Commands

- `npm run build` — render `src/` into `dist/`
- `npm run dev` — build, then `wrangler dev` (http://localhost:8787)
- `npm run deploy` — build, then `wrangler deploy`
- `npm run new -- <slug>` — scaffold a draft post
- `npm test` — the traffic post's simulation models, then the publishing
  pipeline (Markdown output, share cards, and the `<head>` of every built page)
- `npx wrangler deploy --dry-run` — validate config without publishing

`npm test` takes a couple of minutes; almost all of it is the Monte Carlo in
`test/model.test.mjs`. Run `node test/site.test.mjs` alone when the change is to
the build rather than the simulators.

**Deploys are automatic.** Pushing to `main` runs `.github/workflows/deploy.yml`
(test → build → deploy), so prefer committing and pushing over running
`npm run deploy` by hand. The manual command still works and is the fallback if
Actions is unavailable, but a hand deploy from a dirty tree publishes something
no commit describes. The workflow deploys with the wrangler from
`package-lock.json`, not `cloudflare/wrangler-action`, so CI and local deploys
cannot drift apart on version.

To preview without wrangler: `npm run build && (cd dist && python3 -m http.server 8799)`.

## Architecture

**Build** (`build.mjs`) — discovers `src/posts/*/meta.json`, renders each post
through `src/layout.mjs`, copies each post's `js/` and `img/` directories
alongside it, draws a share card for every page, and emits the home page,
`feed.xml`, `sitemap.xml`, `robots.txt` and a favicon. Posts sort newest-first
by `date`. Set `"draft": true` in a post's `meta.json` to exclude it.

**Layout** (`src/layout.mjs`) — the only place page chrome exists. `renderPost`,
`renderHome` and `renderFeed`. The `<head>`, social tags, theme toggle and
scroll indicator are defined once here; a post file contains only its own
article content.

**Markdown** (`src/markdown.mjs`) — `body.md` → the same HTML a `body.html`
would contain, wrapped in a `<section class="prose">` so it lands in the grid.
On top of GFM it adds footnotes (`[^1]`), `:::aside` / `:::note` containers that
map onto the stylesheet's existing two block treatments, and standalone images
as figures. It curls quotes and turns `...` into an ellipsis but deliberately
leaves `--` alone. Raw HTML passes through, so a Markdown post can still host a
`<figure class="rig">` driven from `js/`.

**Share cards** (`src/og.mjs`) — a 1200×630 PNG per page, drawn at build time.
Type is measured and converted to outlines with fontkit before resvg rasterises
it, so measurement and rendering use one engine and nothing depends on installed
fonts. Fonts come from `node_modules`: Charis SIL (an open Charter, which is the
site's body face) and Roboto Mono. Do not swap a font without checking fontkit
can parse it — IBM Plex Mono, the obvious first choice, crashes it.

**Posts** (`src/posts/<slug>/`):
- `meta.json` — `title`, `eyebrow`, `deck`, `byline`, `date` (`YYYY-MM-DD`),
  `description` (used for the index card, `<meta>`, the share card and the
  feed), `tags`, and `scripts` (paths relative to the post, emitted as deferred
  `<script>` tags).
  Optional `disclosure` (`{ tag, note }`) renders the authorship badge under the
  byline and on the share card — `"Mostly AI"` and `"Human written"` are the two
  in use. Keep the tag scoped to authorship and let the note carry any nuance;
  "human written" is a claim about who wrote it, not a claim that no tool was
  used. Omit it and no badge appears, but prefer stating it: the site's standing
  promise in `site.config.mjs` is that anything mostly AI says so explicitly.
  Optional `image` (post-relative) is the post's lead art and becomes the
  background of its share card; optional `socialImage` is a finished 1200×630
  image used verbatim instead of drawing one.
- `body.md` **or** `body.html` — the article. Everything that would sit inside
  `<main>`; no `<html>`, `<head>`, masthead or footer. Those come from the
  layout. Markdown for ordinary prose, HTML for posts that are mostly apparatus.
  If both exist, `body.md` wins.
- `js/`, `img/` — optional, copied verbatim to `/<slug>/js/…`.

**Styles** (`src/styles/site.css`) — one stylesheet for the whole site, copied
to `/styles/site.css`. It is the design system, not per-page CSS: palette tokens
for both themes, the prose scale, and the "rig" components that interactive
figures are built from. Add a new post's styling here rather than inline, so the
site stays one system.

## Adding a post

`npm run new -- <slug>`, then write. Or create `src/posts/<slug>/` with a
`meta.json` and a `body.md` or `body.html` by hand and run `npm run build`.
Nothing else is registered anywhere — the build discovers it.

Both authoring paths render through the same layout and the same stylesheet, so
they are indistinguishable on the page. Choose Markdown unless the post needs
markup Markdown cannot express.

## Conventions

- Theming is token-driven. Both light and dark are defined explicitly in
  `:root`, under `@media (prefers-color-scheme: dark)` scoped with
  `:not([data-theme="light"])`, and under `:root[data-theme="dark"]`, so the
  viewer's toggle wins in both directions. Never style inside the media query
  directly — redefine tokens.
- Canvas figures read their colours from CSS custom properties via
  `Traffic.theme()`, which is cached; call `Traffic.invalidateTheme()` on a
  theme change rather than reading `getComputedStyle` per frame.
- Series colours (`--s1`/`--s2`/`--s3`) are a validated colourblind-safe trio.
  If you add a fourth, re-validate rather than picking by eye.
- Markdown emits plain elements (`ul`, `blockquote`, `pre`, `table`) rather than
  bespoke classes. Style those in the "prose" block of `site.css` so a
  hand-written post that needs a table gets the same one. Markdown bodies are
  wrapped in `<section class="prose">`; a hand-written post can put that class
  on its own `<section>` to opt into the same list rhythm.
- No page may declare `twitter:card=summary_large_image` without an image; a
  test enforces it, because that combination renders as a bare link.

## Notes

- `../brad-site` documents a Yarn Plug'n'Play interference from an ancestor
  `~/.pnp.cjs` that can break `wrangler dev`/`deploy` bundling. This repo has no
  Worker script to bundle, so it is unaffected.
- The traffic post's simulations have real model tests (`npm test`). They assert
  the physics and every quantitative claim the post makes; if a model changes and
  the numbers move, the post is wrong and the tests fail.
