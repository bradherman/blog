/* Builds src/ into dist/, which is what Cloudflare serves.
   No framework: posts are HTML bodies plus a meta.json, and the shell comes
   from src/layout.mjs. Adding a post means adding a directory. */

import { readFile, writeFile, mkdir, readdir, cp, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import site from './src/site.config.mjs';
import { renderPost, renderHome, renderFeed, formatDate } from './src/layout.mjs';
import { renderMarkdown } from './src/markdown.mjs';
import { renderCard, loadHero, CARD } from './src/og.mjs';
import { imageSize } from './src/imagesize.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, 'src');
const dist = join(root, 'dist');

const exists = async (p) => !!(await stat(p).catch(() => null));
const host = site.origin.replace(/^https?:\/\//, '');
const stripTags = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

async function collectPosts() {
  const dir = join(src, 'posts');
  if (!(await exists(dir))) return [];
  const names = await readdir(dir, { withFileTypes: true });
  const posts = [];
  for (const d of names) {
    if (!d.isDirectory()) continue;
    const base = join(dir, d.name);
    const metaPath = join(base, 'meta.json');
    if (!(await exists(metaPath))) continue;
    const meta = JSON.parse(await readFile(metaPath, 'utf8'));
    if (meta.draft) continue;
    meta.slug = meta.slug || d.name;
    posts.push({ meta, base });
  }
  /* newest first */
  posts.sort((a, b) => (a.meta.date < b.meta.date ? 1 : -1));
  return posts;
}

/* Markdown figures want width/height so images don't reflow the page as they
   load, and renderMarkdown is synchronous, so the post's art is measured up
   front and handed over as a lookup. */
async function measureImages(base) {
  const sizes = new Map();
  const walk = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (/\.(png|jpe?g|gif|webp)$/i.test(e.name)) {
        const size = imageSize(await readFile(full));
        if (size) sizes.set(relative(base, full).split(sep).join('/'), size);
      }
    }
  };
  await walk(base);
  return (href) => {
    if (/^(https?:)?\/\//.test(href)) return null;
    const key = href.replace(/^\.\//, '').replace(/^\//, '').split(/[?#]/)[0];
    return sizes.get(key) || null;
  };
}

/* A post is authored as Markdown or as HTML. Both end up as the content of
   <main>, styled by the same stylesheet — the choice is purely about which is
   less friction to write. */
async function renderBody({ meta, base }) {
  const md = join(base, 'body.md');
  if (await exists(md)) {
    return renderMarkdown(await readFile(md, 'utf8'), {
      slug: meta.slug,
      sizeOf: await measureImages(base)
    });
  }
  const html = join(base, 'body.html');
  if (await exists(html)) return readFile(html, 'utf8');
  throw new Error(`${meta.slug}: needs a body.md or a body.html`);
}

/* The share card. A post can point at a finished 1200x630 image with
   `socialImage`; otherwise one is drawn, over the post's `image` if it has
   one. Doing this at build time means sharing is never broken by having
   forgotten to make an image. */
async function buildCard({ meta, base, out }) {
  if (meta.socialImage) {
    const remote = /^https?:\/\//.test(meta.socialImage);
    const rel = meta.socialImage.replace(/^\.?\//, '');
    const url = remote ? meta.socialImage : `${site.origin}/${meta.slug}/${rel}`;
    const size = remote ? null : imageSize(await readFile(join(base, rel)).catch(() => null));
    return {
      image: url,
      imageType: /\.png$/i.test(url) ? 'image/png' : 'image/jpeg',
      imageWidth: size ? size.width : CARD.width,
      imageHeight: size ? size.height : CARD.height
    };
  }

  let hero = null;
  if (meta.image) {
    hero = await loadHero(join(base, meta.image.replace(/^\.?\//, '')));
    if (!hero) console.warn(`  ! ${meta.slug}: image "${meta.image}" not found; using the plain card`);
  }

  await writeFile(
    join(out, 'og.png'),
    renderCard({
      eyebrow: stripTags(meta.eyebrow),
      title: stripTags(meta.title),
      deck: stripTags(meta.description || meta.deck),
      footerLeft: host,
      footerRight: formatDate(meta.date),
      badge: meta.disclosure && meta.disclosure.tag,
      hero
    })
  );
  return {
    image: `${site.origin}/${meta.slug}/og.png`,
    imageType: 'image/png',
    imageWidth: CARD.width,
    imageHeight: CARD.height
  };
}

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
<rect width="32" height="32" rx="6" fill="#14181b"/>
<rect x="4" y="14" width="24" height="5" rx="1" fill="#3b4045"/>
<rect x="6" y="15.5" width="5" height="2" fill="#e6e0c6"/>
<rect x="14" y="15.5" width="5" height="2" fill="#e6e0c6"/>
<rect x="22" y="15.5" width="5" height="2" fill="#e6e0c6"/>
<circle cx="16" cy="8" r="3" fill="#00644a"/>
</svg>
`;

async function build() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });

  /* styles — one stylesheet for the whole site */
  await mkdir(join(dist, 'styles'), { recursive: true });
  await cp(join(src, 'styles', 'site.css'), join(dist, 'styles', 'site.css'));

  /* site-wide chrome (theme toggle, scroll indicator) — every page needs it */
  if (await exists(join(src, 'scripts'))) {
    await cp(join(src, 'scripts'), join(dist, 'scripts'), { recursive: true });
  }

  const posts = await collectPosts();

  for (const { meta, base } of posts) {
    const out = join(dist, meta.slug);
    await mkdir(out, { recursive: true });

    /* per-post assets travel with the post — copied first so a card that
       points at one is pointing at something that exists */
    for (const sub of ['js', 'img']) {
      if (await exists(join(base, sub))) {
        await cp(join(base, sub), join(out, sub), { recursive: true });
      }
    }

    const body = await renderBody({ meta, base });
    const card = await buildCard({ meta, base, out });
    await writeFile(join(out, 'index.html'), renderPost({ site, meta, body, card }));
  }

  /* the home page shares as the site itself */
  await writeFile(
    join(dist, 'og.png'),
    renderCard({
      eyebrow: site.name,
      title: site.tagline,
      deck: site.description,
      footerLeft: host,
      footerRight: `${posts.length} post${posts.length === 1 ? '' : 's'}`
    })
  );
  const homeCard = {
    image: `${site.origin}/og.png`,
    imageType: 'image/png',
    imageWidth: CARD.width,
    imageHeight: CARD.height
  };

  await writeFile(
    join(dist, 'index.html'),
    renderHome({ site, posts: posts.map((p) => p.meta), card: homeCard })
  );
  await writeFile(join(dist, 'feed.xml'), renderFeed({ site, posts: posts.map((p) => p.meta) }));
  await writeFile(join(dist, 'favicon.svg'), FAVICON);
  await writeFile(
    join(dist, 'robots.txt'),
    `User-agent: *\nAllow: /\nSitemap: ${site.origin}/sitemap.xml\n`
  );
  await writeFile(
    join(dist, 'sitemap.xml'),
    `<?xml version="1.0" encoding="utf-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${site.origin}/</loc></url>
${posts.map((p) => `  <url><loc>${site.origin}/${p.meta.slug}/</loc><lastmod>${p.meta.date}</lastmod></url>`).join('\n')}
</urlset>
`
  );

  console.log(`built ${posts.length} post${posts.length === 1 ? '' : 's'}:`);
  for (const { meta } of posts) console.log(`  /${meta.slug}/  ${meta.title}`);
  console.log(`  /            home`);
  console.log(`  /feed.xml    atom`);
}

build().catch((e) => {
  console.error(e);
  process.exit(1);
});
