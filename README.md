# blog.bherms.com

A static site: a small build script, one stylesheet, and Cloudflare Workers
Assets. No framework, no Worker script, no database.

```bash
npm install
npm run build      # src/ -> dist/
npm run dev        # build + wrangler dev
npm run deploy     # build + wrangler deploy
npm test           # model checks for the traffic post's simulators
```

## Adding a post

```
src/posts/<slug>/
  meta.json     title, eyebrow, deck, byline, date, description, tags, scripts
  body.html     the article — just what goes inside <main>
  js/           optional, copied to /<slug>/js/
```

Then `npm run build`. The build discovers it; there is no registry to update.
Set `"draft": true` in `meta.json` to keep it out of the build.

## Layout

```
build.mjs                 discovers posts, renders pages, writes dist/
src/site.config.mjs       site name, origin, nav, description
src/layout.mjs            the HTML shell — head, chrome, home, post, feed
src/styles/site.css       the design system, both themes
src/posts/<slug>/         one directory per post
test/model.test.mjs       headless physics checks for the traffic simulators
```

Deploys to `blog.bherms.com` as a Workers custom domain, which provisions its
own DNS record and certificate — there is no manual DNS step.
