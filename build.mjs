/* Builds src/ into dist/, which is what Cloudflare serves.
   No framework: posts are HTML bodies plus a meta.json, and the shell comes
   from src/layout.mjs. Adding a post means adding a directory. */

import { readFile, writeFile, mkdir, readdir, cp, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import site from './src/site.config.mjs';
import { renderPost, renderHome, renderFeed } from './src/layout.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, 'src');
const dist = join(root, 'dist');

const exists = async (p) => !!(await stat(p).catch(() => null));

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
    const body = await readFile(join(base, 'body.html'), 'utf8');
    const out = join(dist, meta.slug);
    await mkdir(out, { recursive: true });
    await writeFile(join(out, 'index.html'), renderPost({ site, meta, body }));

    /* per-post assets travel with the post */
    for (const sub of ['js', 'img']) {
      if (await exists(join(base, sub))) {
        await cp(join(base, sub), join(out, sub), { recursive: true });
      }
    }
  }

  await writeFile(join(dist, 'index.html'), renderHome({ site, posts: posts.map((p) => p.meta) }));
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
