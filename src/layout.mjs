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

/* Everything a link preview needs, in one place. Facebook, LinkedIn, Slack and
   iMessage read the og:* tags; Twitter/X prefers twitter:* and falls back to
   og:*, but it is stated explicitly so a summary_large_image card can never be
   declared without the image it promises. Absolute URLs are required here —
   every crawler resolves these without a base. */
function social({ site, title, description, canonical, card }) {
  const tags = [
    `<meta property="og:type" content="${card.type}">`,
    `<meta property="og:site_name" content="${esc(site.title)}">`,
    `<meta property="og:title" content="${plain(title)}">`,
    `<meta property="og:description" content="${plain(description)}">`,
    `<meta property="og:url" content="${esc(canonical)}">`,
    `<meta property="og:locale" content="en_US">`
  ];

  if (card.image) {
    tags.push(
      `<meta property="og:image" content="${esc(card.image)}">`,
      `<meta property="og:image:type" content="${esc(card.imageType || 'image/png')}">`,
      `<meta property="og:image:width" content="${card.imageWidth}">`,
      `<meta property="og:image:height" content="${card.imageHeight}">`,
      `<meta property="og:image:alt" content="${plain(card.imageAlt || title)}">`
    );
  }

  if (card.type === 'article') {
    tags.push(`<meta property="article:published_time" content="${esc(card.published)}">`);
    tags.push(`<meta property="article:author" content="${esc(site.author)}">`);
    for (const tag of card.tags || []) {
      tags.push(`<meta property="article:tag" content="${esc(tag)}">`);
    }
  }

  /* Without an image, a large-image card renders as a bare link. Degrade to the
     small card rather than promising art that isn't there. */
  tags.push(
    `<meta name="twitter:card" content="${card.image ? 'summary_large_image' : 'summary'}">`,
    `<meta name="twitter:title" content="${plain(title)}">`,
    `<meta name="twitter:description" content="${plain(description)}">`
  );
  if (card.image) {
    tags.push(`<meta name="twitter:image" content="${esc(card.image)}">`);
    tags.push(`<meta name="twitter:image:alt" content="${plain(card.imageAlt || title)}">`);
  }
  if (site.twitter) {
    tags.push(`<meta name="twitter:site" content="${esc(site.twitter)}">`);
    tags.push(`<meta name="twitter:creator" content="${esc(site.twitter)}">`);
  }

  return tags.join('\n');
}

function head({ site, title, socialTitle, description, canonical, card, extraCss }) {
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${plain(description)}">
<meta name="author" content="${esc(site.author)}">
<link rel="canonical" href="${esc(canonical)}">
${social({ site, title: socialTitle || title, description, canonical, card })}
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

export function renderPost({ site, meta, body, card = {} }) {
  const canonical = `${site.origin}/${meta.slug}/`;
  const scripts = ['/scripts/site.js']
    .concat(meta.scripts || [])
    .map((s) => `<script src="${esc(s)}" defer></script>`)
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
${head({
  site,
  title: `${meta.title} — ${site.title}`,
  /* og:site_name already names the site; repeating it in the card title just
     eats the two lines a preview gets. */
  socialTitle: meta.title,
  description: meta.description,
  canonical,
  card: {
    ...card,
    type: 'article',
    published: meta.date,
    tags: meta.tags,
    imageAlt: card.imageAlt || `${plain(meta.title)} — ${site.title}`
  }
})}
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

export function renderHome({ site, posts, card = {} }) {
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
${head({
  site,
  title: `${site.title} — ${site.tagline}`,
  description: site.description,
  canonical: site.origin + '/',
  card: { ...card, type: 'website', imageAlt: card.imageAlt || `${site.title} — ${site.tagline}` }
})}
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
