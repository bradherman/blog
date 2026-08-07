/* Scaffold a post.

     npm run new -- my-slug
     npm run new -- my-slug --title "A Better Title" --html

   Creates src/posts/<slug>/ with a meta.json and a body, marked draft so it
   builds locally but stays off the site until you remove the flag. Nothing
   registers it anywhere — the build discovers the directory. */

import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const VALUED = new Set(['--title']);

const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (VALUED.has(a)) flags[a.slice(2)] = argv[++i];
  else if (a.startsWith('--')) flags[a.slice(2)] = true;
  else positional.push(a);
}
const flag = (name) => (typeof flags[name] === 'string' ? flags[name] : null);
const has = (name) => flags[name] === true;

const slug = positional[0];
if (!slug) {
  console.error('usage: npm run new -- <slug> [--title "Title"] [--html]');
  process.exit(1);
}
if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
  console.error(`"${slug}" should be lowercase letters, numbers and hyphens.`);
  process.exit(1);
}

const dir = join(root, 'src', 'posts', slug);
if (await stat(dir).catch(() => null)) {
  console.error(`${slug} already exists.`);
  process.exit(1);
}

const title =
  flag('title') ||
  slug.replace(/-/g, ' ').replace(/(^|\s)\w/g, (m) => m.toUpperCase());

const today = new Date().toISOString().slice(0, 10);
const markdown = !has('html');

const meta = {
  title,
  eyebrow: 'Essay',
  deck: 'One line under the title, setting up what the piece is about.',
  byline: 'Brad Herman',
  date: today,
  description:
    'The summary used on the home page, in the share card and in the feed. ' +
    'Two sentences at most.',
  tags: [],
  draft: true
};

await mkdir(dir, { recursive: true });
await writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');

const BODY_MD = `Open with the thing worth reading, not with throat-clearing.

## The first section

Ordinary Markdown: **bold**, *italic*, [links](https://example.com), lists,
tables and code all render into the site's styles.

- a list item
- another one

:::aside
A quiet note in the margin voice.
:::

:::note
An accent-washed callout, for something the reader should not miss.
:::

A claim that needs a source.[^1]

[^1]: Author, *Where it was published*, year.
`;

const BODY_HTML = `<section>

  <p>
    Open with the thing worth reading, not with throat-clearing.
  </p>

  <h2>The first section</h2>

  <p>
    A hand-written body is everything that sits inside &lt;main&gt;. The
    masthead, footer and theme toggle come from the layout.
  </p>

</section>
`;

await writeFile(join(dir, markdown ? 'body.md' : 'body.html'), markdown ? BODY_MD : BODY_HTML);

console.log(`created src/posts/${slug}/`);
console.log(`  meta.json`);
console.log(`  ${markdown ? 'body.md' : 'body.html'}`);
console.log(`\nIt is a draft. Remove "draft": true from meta.json to publish.`);
console.log(`Preview with: npm run dev`);
