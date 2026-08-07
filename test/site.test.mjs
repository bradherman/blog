/* Checks on the publishing pipeline itself.

   The point of these is that a post can be written two ways and shared on any
   platform, and neither should be able to break quietly. They cover what the
   Markdown renderer emits, what the share-card renderer produces, and what the
   built pages actually claim in their <head>.

   Run: node test/site.test.mjs
*/
import { readFile, readdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderMarkdown } from '../src/markdown.mjs';
import { Resvg } from '@resvg/resvg-js';
import { renderCard, cardSvg, loadHero, CARD } from '../src/og.mjs';
import { imageSize } from '../src/imagesize.mjs';
import site from '../src/site.config.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ harness */
let failures = 0;
function section(name) {
  console.log(`\n${name}`);
}
function ok(name, cond, detail = '') {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ''}`);
  }
}
const contains = (hay, needle, name) =>
  ok(name, String(hay).includes(needle), `expected to find: ${needle}`);

/* ------------------------------------------------------------- markdown */
section('Markdown');

const md = renderMarkdown(
  `![Lead art](img/lead.png "A caption")

## A heading

Prose with "quotes", an apostrophe in it's middle and an ellipsis...
A claim.[^a] The same claim again.[^a] A different one.[^b]

# A single hash

R&D, a < b, 5 > 3.

- one
- two

> Quoted.

:::aside
Quiet.
:::

:::note
Loud.
:::

| Metric | Value |
| ------ | ----: |
| Speed  | 20 |

\`\`\`js
const s = "left -- alone...";
\`\`\`

![Second](img/two.png)

[^a]: First source.
[^b]: Second source.
`,
  { slug: 'test', sizeOf: (h) => (h === 'img/lead.png' ? { width: 1024, height: 768 } : null) }
);

contains(md, '<section class="prose">', 'wraps the body in a prose section');
contains(md, '<figure class="post-hero">', 'the opening image becomes the hero figure');
contains(md, 'width="1024" height="768"', 'known image dimensions are written out');
contains(md, 'loading="eager"', 'the lead image is not lazy-loaded');
contains(md, '<figcaption>A caption</figcaption>', 'an image title becomes a caption');
contains(md, '<figure class="post-figure">', 'a later image is an ordinary figure');
contains(md, '<h2 id="a-heading">', 'headings are h2 and carry an id');
ok('`#` is clamped to h2 rather than making a second h1', !/<h1/.test(md));
contains(md, '“quotes”', 'straight double quotes are curled');
contains(md, 'it’s', 'apostrophes are curled');
contains(md, '…', 'three dots become an ellipsis');
ok('dashes are left alone', md.includes('left -- alone'), 'code should not be smartened');
contains(md, 'R&amp;D, a &lt; b, 5 &gt; 3.', 'text is HTML-escaped');
contains(md, '<div class="aside">', ':::aside reuses the aside style');
contains(md, '<div class="callout">', ':::note reuses the callout style');
contains(md, '<div class="table-wrap">', 'tables are wrapped so they can scroll');
contains(md, '<code class="language-js">', 'fenced code keeps its language');
contains(md, '<blockquote>', 'blockquotes survive');

/* Footnotes: numbered by first reference, ids never repeated. */
contains(md, '<sup><a href="#ref-1" id="cite-1">1</a></sup>', 'first citation carries the anchor id');
ok(
  'a repeated citation reuses the number without repeating the id',
  (md.match(/href="#ref-1"/g) || []).length === 2 &&
    (md.match(/id="cite-1"/g) || []).length === 1
);
contains(md, '<li id="ref-2">Second source.', 'notes are listed in reference order');
const ids = md.match(/id="[^"]+"/g) || [];
ok('every id on the page is unique', new Set(ids).size === ids.length,
  `duplicates: ${ids.filter((v, i) => ids.indexOf(v) !== i).join(', ')}`);

/* An undefined footnote should still produce a note, not vanish. */
const orphan = renderMarkdown('Claim.[^missing]', { slug: 'test' });
contains(orphan, '<li id="ref-1">', 'a referenced-but-undefined note still gets a slot');

/* --------------------------------------------------------------- imagesize */
section('Image measurement');

const jpeg = await readFile(join(root, 'src/posts/dei-the-myth-of-merit/img/boardroom.jpg'));
const jpegSize = imageSize(jpeg);
ok('reads JPEG dimensions', jpegSize && jpegSize.width === 1024 && jpegSize.height === 1024,
  JSON.stringify(jpegSize));
ok('returns null rather than throwing on junk', imageSize(Buffer.alloc(64)) === null);
ok('returns null on a truncated buffer', imageSize(Buffer.alloc(4)) === null);

/* -------------------------------------------------------------- share card */
section('Share cards');

const plain = renderCard({
  eyebrow: 'Essay',
  title: 'A Title',
  deck: 'A deck.',
  footerLeft: 'blog.bherms.com',
  footerRight: '6 August 2026',
  badge: 'Human written'
});
const plainSize = imageSize(plain);
ok('renders a PNG at exactly 1200x630',
  plainSize && plainSize.width === CARD.width && plainSize.height === CARD.height,
  JSON.stringify(plainSize));

const hero = await loadHero(join(root, 'src/posts/dei-the-myth-of-merit/img/boardroom.jpg'));
ok('loads hero art', !!hero);
const withHero = renderCard({
  eyebrow: 'Essay',
  title: 'A Title Over Art',
  deck: 'A deck.',
  footerLeft: 'blog.bherms.com',
  hero
});
const heroSize = imageSize(withHero);
ok('the hero variant is the same size', heroSize && heroSize.width === CARD.width);
ok('the hero variant differs from the plain one', !withHero.equals(plain));

/* Nothing may run off the edge of a card. The rendered bounding box is the
   union of the full-bleed background and every glyph, so it is exactly the
   canvas when the type fits and wider when it doesn't. */
const overflows = (opts) => {
  const box = new Resvg(cardSvg(opts), { font: { loadSystemFonts: false } }).getBBox();
  return box.x < -0.5 || box.x + box.width > CARD.width + 0.5;
};

const stress = {
  eyebrow: 'X'.repeat(200),
  title: 'Word '.repeat(120).trim(),
  deck: 'Deck. '.repeat(80).trim(),
  footerLeft: 'blog.bherms.com',
  footerRight: '6 August 2026',
  badge: 'Mostly AI'
};
ok('an absurd title still renders', imageSize(renderCard(stress)).width === CARD.width);
ok('and nothing spills past the edge', !overflows(stress));
ok('an unbreakable token is trimmed rather than overhanging', !overflows({
  eyebrow: 'A'.repeat(120),
  title: 'B'.repeat(120),
  deck: 'C'.repeat(200),
  footerLeft: 'blog.bherms.com',
  footerRight: 'D'.repeat(60),
  badge: 'E'.repeat(40)
}));

ok('rendering is deterministic', renderCard({
  eyebrow: 'Essay', title: 'A Title', deck: 'A deck.',
  footerLeft: 'blog.bherms.com', footerRight: '6 August 2026', badge: 'Human written'
}).equals(plain));

/* ------------------------------------------------------------------- build */
section('Built site');

execFileSync('node', ['build.mjs'], { cwd: root, stdio: 'pipe' });

const dist = join(root, 'dist');
const exists = async (p) => !!(await stat(p).catch(() => null));

const postDirs = [];
for (const d of await readdir(join(root, 'src/posts'), { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  const metaFile = join(root, 'src/posts', d.name, 'meta.json');
  if (!(await exists(metaFile))) continue;
  const meta = JSON.parse(await readFile(metaFile, 'utf8'));
  if (!meta.draft) postDirs.push(meta.slug || d.name);
}

ok('the build produced at least one post', postDirs.length > 0);

for (const slug of postDirs) {
  const html = await readFile(join(dist, slug, 'index.html'), 'utf8');
  const label = `/${slug}/`;

  const ogImage = (html.match(/<meta property="og:image" content="([^"]+)"/) || [])[1];
  ok(`${label} declares an og:image`, !!ogImage);
  ok(`${label} og:image is an absolute URL`, !!ogImage && ogImage.startsWith(site.origin + '/'),
    ogImage);

  /* A generated card must be on disk; a post pointing at its own art need not
     have produced one. */
  if (ogImage && ogImage.endsWith('/og.png')) {
    const file = join(dist, ogImage.slice(site.origin.length + 1));
    ok(`${label} the card it points at exists`, await exists(file), file);
    const size = imageSize(await readFile(file));
    ok(`${label} the card is 1200x630`, size.width === 1200 && size.height === 630);
  }

  contains(html, '<meta name="twitter:card" content="summary_large_image">',
    `${label} asks for a large card`);
  contains(html, '<meta name="twitter:image"', `${label} gives Twitter the image`);
  contains(html, '<meta property="og:type" content="article">', `${label} is typed as an article`);
  contains(html, '<meta property="article:published_time"', `${label} states its date`);
  contains(html, `<link rel="canonical" href="${site.origin}/${slug}/">`, `${label} is canonical`);
  contains(html, '<meta property="og:image:width" content="1200">', `${label} sizes the image`);

  const ogTitle = (html.match(/<meta property="og:title" content="([^"]*)"/) || [])[1];
  ok(`${label} og:title omits the site suffix`, ogTitle && !ogTitle.endsWith(site.title), ogTitle);
}

const home = await readFile(join(dist, 'index.html'), 'utf8');
contains(home, `<meta property="og:image" content="${site.origin}/og.png">`, '/ has its own card');
contains(home, '<meta property="og:type" content="website">', '/ is typed as a website');
ok('/ card is on disk', await exists(join(dist, 'og.png')));

/* Sanity: no page should ever promise a large image card without an image. */
for (const page of ['index.html', ...postDirs.map((s) => join(s, 'index.html'))]) {
  const html = await readFile(join(dist, page), 'utf8');
  const large = html.includes('content="summary_large_image"');
  const hasImage = /<meta name="twitter:image" content="[^"]+"/.test(html);
  ok(`${page} does not claim a large card without art`, !large || hasImage);
}

console.log(failures === 0
  ? '\nAll site checks passed.\n'
  : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
