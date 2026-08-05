/* The HTML shell. Every page on the site is one of these two functions, so
   the chrome — head, theme toggle, scroll indicator, footer — lives in exactly
   one place and a post is only ever its own content. */

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
           .replace(/"/g, '&quot;');

/* Strip tags for use in <meta> content, where markup is not allowed. */
const plain = (s) => esc(String(s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());

export const formatDate = (iso) =>
  new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'
  });

function head({ site, title, description, canonical, extraCss }) {
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${plain(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(site.title)}">
<meta property="og:title" content="${plain(title)}">
<meta property="og:description" content="${plain(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta name="twitter:card" content="summary_large_image">
<link rel="alternate" type="application/atom+xml" href="/feed.xml" title="${esc(site.title)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/styles/site.css">${extraCss || ''}
<script>try{var t=localStorage.getItem("theme");if(t==="dark"||t==="light")document.documentElement.setAttribute("data-theme",t)}catch(e){}</script>`;
}

/* The chrome that wraps every page. The scroll indicator is a road: an asphalt
   strip with a centre line that advances as you read. */
const CHROME_TOP = `<div class="progress-road" aria-hidden="true"><i id="progress-dash"></i></div>

<button id="theme-toggle" class="theme-toggle" type="button" aria-label="Switch colour theme">
  <span aria-hidden="true">◐</span>
</button>`;

function siteFooter(site) {
  const links = site.nav
    .map((n) => `<a href="${esc(n.href)}">${esc(n.label)}</a>`)
    .join('<span aria-hidden="true"> · </span>');
  return `<footer class="colophon">
  <nav class="colophon-nav">${links}<span aria-hidden="true"> · </span><a href="/feed.xml">Feed</a></nav>
  ${site.aiPolicy ? `<p class="colophon-policy">${esc(site.aiPolicy)}</p>` : ''}
</footer>`;
}

export function renderPost({ site, meta, body }) {
  const canonical = `${site.origin}/${meta.slug}/`;
  const scripts = ['/scripts/site.js']
    .concat(meta.scripts || [])
    .map((s) => `<script src="${esc(s)}" defer></script>`)
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
${head({ site, title: `${meta.title} — ${site.title}`, description: meta.description, canonical })}
</head>
<body class="page-post">
${CHROME_TOP}

<header class="masthead">
  <p class="eyebrow"><a class="eyebrow-home" href="/">${esc(site.title)}</a> <span aria-hidden="true">/</span> ${meta.eyebrow}</p>
  <h1>${meta.title}</h1>
  <p class="deck">${meta.deck}</p>
  <p class="byline"><time datetime="${esc(meta.date)}">${formatDate(meta.date)}</time> · ${meta.byline}</p>
${meta.disclosure ? `  <p class="disclosure"><span class="disclosure-tag">${esc(meta.disclosure.tag)}</span> ${meta.disclosure.note}</p>` : ''}
</header>

<main>
${body}
</main>

${siteFooter(site)}
${scripts}
</body>
</html>
`;
}

export function renderHome({ site, posts }) {
  const items = posts
    .map(
      (p) => `    <li class="post-item">
      <a class="post-link" href="/${esc(p.slug)}/">
        <p class="post-meta"><time datetime="${esc(p.date)}">${formatDate(p.date)}</time>${
          p.tags && p.tags.length
            ? ` <span aria-hidden="true">·</span> ${p.tags.map(esc).join(', ')}`
            : ''
        }</p>
        <h2 class="post-title">${p.title}</h2>
        <p class="post-deck">${esc(p.description || p.deck)}</p>
      </a>
    </li>`
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
${head({ site, title: `${site.title} — ${site.tagline}`, description: site.description, canonical: site.origin + '/' })}
</head>
<body class="page-home">
${CHROME_TOP}

<header class="masthead masthead-home">
  <p class="eyebrow">${esc(site.name)}</p>
  <h1>${esc(site.tagline)}</h1>
  <p class="deck">${esc(site.description)}</p>
</header>

<main>
  <section class="listing">
    <p class="section-tag">Writing</p>
    <ol class="post-list">
${items}
    </ol>
  </section>
</main>

${siteFooter(site)}
<script src="/scripts/site.js" defer></script>
</body>
</html>
`;
}

export function renderFeed({ site, posts }) {
  const updated = posts.length
    ? new Date(posts[0].date + 'T12:00:00Z').toISOString()
    : new Date(0).toISOString();
  const entries = posts
    .map(
      (p) => `  <entry>
    <title>${plain(p.title)}</title>
    <link href="${site.origin}/${esc(p.slug)}/"/>
    <id>${site.origin}/${esc(p.slug)}/</id>
    <updated>${new Date(p.date + 'T12:00:00Z').toISOString()}</updated>
    <summary>${plain(p.description || p.deck)}</summary>
  </entry>`
    )
    .join('\n');

  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${plain(site.title)}</title>
  <subtitle>${plain(site.description)}</subtitle>
  <link href="${site.origin}/feed.xml" rel="self"/>
  <link href="${site.origin}/"/>
  <id>${site.origin}/</id>
  <updated>${updated}</updated>
  <author><name>${plain(site.author)}</name></author>
${entries}
</feed>
`;
}
