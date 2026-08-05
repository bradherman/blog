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
- `npm test` — headless checks on the traffic post's simulation models
- `npx wrangler deploy --dry-run` — validate config without publishing

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
alongside it, and emits the home page, `feed.xml`, `sitemap.xml`, `robots.txt`
and a favicon. Posts sort newest-first by `date`. Set `"draft": true` in a
post's `meta.json` to exclude it.

**Layout** (`src/layout.mjs`) — the only place page chrome exists. `renderPost`,
`renderHome` and `renderFeed`. The `<head>`, theme toggle and scroll indicator
are defined once here; a post file contains only its own article content.

**Posts** (`src/posts/<slug>/`):
- `meta.json` — `title`, `eyebrow`, `deck`, `byline`, `date` (`YYYY-MM-DD`),
  `description` (used for the index card, `<meta>` and the feed), `tags`, and
  `scripts` (paths relative to the post, emitted as deferred `<script>` tags).
  Optional `disclosure` (`{ tag, note }`) renders the authorship badge under the
  byline — `"Mostly AI"` and `"Human written"` are the two in use. Keep the tag
  scoped to authorship and let the note carry any nuance; "human written" is a
  claim about who wrote it, not a claim that no tool was used. Omit it and no
  badge appears, but prefer stating it: the site's standing promise in
  `site.config.mjs` is that anything mostly AI says so explicitly.
- `body.html` — the article. Everything that would sit inside `<main>`; no
  `<html>`, `<head>`, masthead or footer. Those come from the layout.
- `js/`, `img/` — optional, copied verbatim to `/<slug>/js/…`.

**Styles** (`src/styles/site.css`) — one stylesheet for the whole site, copied
to `/styles/site.css`. It is the design system, not per-page CSS: palette tokens
for both themes, the prose scale, and the "rig" components that interactive
figures are built from. Add a new post's styling here rather than inline, so the
site stays one system.

## Adding a post

Create `src/posts/<slug>/` with `meta.json` and `body.html`, then
`npm run build`. Nothing else is registered anywhere — the build discovers it.

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

## Notes

- `../brad-site` documents a Yarn Plug'n'Play interference from an ancestor
  `~/.pnp.cjs` that can break `wrangler dev`/`deploy` bundling. This repo has no
  Worker script to bundle, so it is unaffected.
- The traffic post's simulations have real model tests (`npm test`). They assert
  the physics and every quantitative claim the post makes; if a model changes and
  the numbers move, the post is wrong and the tests fail.
