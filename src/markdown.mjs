/* Markdown → the same HTML a hand-written body.html would contain.
   A post can be authored either way; this module exists so that writing prose
   is cheap without the markup drifting away from the design system. Everything
   it emits is styled by src/styles/site.css — nothing here carries its own
   presentation.

   Beyond CommonMark/GFM it understands three things the site actually uses:
     [^1] / [^1]: …   footnotes, numbered by order of first reference
     :::note … :::    a callout, rendered as the site's aside
     ![alt](src "…")  a standalone image, rendered as a figure with a caption

   Raw HTML passes through untouched, so a Markdown post can still drop in a
   <figure class="rig"> and drive it with its own JavaScript. */

import { Marked } from 'marked';

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
           .replace(/"/g, '&quot;');

/* Text-node escaping. Leaves existing entities alone so an author who writes
   &amp; or &nbsp; gets what they meant, and leaves quotes alone because
   smarten() has already turned them into typographic ones. */
const escText = (s) =>
  String(s).replace(/&(?![#\w]+;)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* The site's prose uses real typography. Authors type ASCII; this converts the
   punctuation that has an unambiguous typographic form. Dashes are deliberately
   left alone — `--` stays `--` rather than becoming an em dash. */
function smarten(text) {
  return text
    .replace(/&#39;/g, "'")
    .replace(/\.\.\./g, '…')
    /* opening double quote after start-of-string or whitespace/open bracket */
    .replace(/(^|[\s([{‘“])"/g, '$1“')
    .replace(/"/g, '”')
    /* an apostrophe inside a word is always a right single quote */
    .replace(/(\w)'(\w)/g, '$1’$2')
    .replace(/(^|[\s([{])'/g, '$1‘')
    .replace(/'/g, '’');
}

export const slugify = (s) =>
  String(s)
    .replace(/<[^>]+>/g, '')
    .toLowerCase()
    .replace(/[‘’']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section';

/* ---------------------------------------------------------------------------
   Extensions
   ------------------------------------------------------------------------ */

function footnotes(state) {
  return [
    {
      name: 'footnoteRef',
      level: 'inline',
      start: (src) => src.indexOf('[^'),
      tokenizer(src) {
        const m = /^\[\^([^\]\s]+)\](?!:)/.exec(src);
        if (!m) return;
        return { type: 'footnoteRef', raw: m[0], id: m[1] };
      },
      renderer(token) {
        let n = state.order.indexOf(token.id);
        const first = n === -1;
        if (first) n = state.order.push(token.id) - 1;
        const i = n + 1;
        /* Only the first citation carries the id; a second reference to the
           same note must not duplicate it, or the back-link is ambiguous and
           the document has two elements with one id. */
        const id = first ? ` id="cite-${i}"` : '';
        return `<sup><a href="#ref-${i}"${id}>${i}</a></sup>`;
      }
    },
    {
      name: 'footnoteDef',
      level: 'block',
      start: (src) => {
        const m = /^\[\^[^\]\s]+\]:/m.exec(src);
        return m ? m.index : undefined;
      },
      tokenizer(src) {
        const m = /^\[\^([^\]\s]+)\]:[ \t]*([^\n]*(?:\n(?![ \t]*\n|\[\^)[^\n]*)*)/.exec(src);
        if (!m) return;
        const token = { type: 'footnoteDef', raw: m[0], id: m[1], tokens: [] };
        this.lexer.inlineTokens(m[2].trim().replace(/\n[ \t]*/g, ' '), token.tokens);
        return token;
      },
      renderer(token) {
        /* Rendered here so the live parser handles the inline content; the
           list itself is emitted after the body, in reference order. */
        state.defs.set(token.id, this.parser.parseInline(token.tokens));
        return '';
      }
    }
  ];
}

const callout = {
  name: 'callout',
  level: 'block',
  start: (src) => {
    const m = /^:::/m.exec(src);
    return m ? m.index : undefined;
  },
  tokenizer(src) {
    const m = /^:::[ \t]*([a-z][a-z0-9-]*)?[ \t]*\n([\s\S]*?)\n:::[ \t]*(?:\n+|$)/.exec(src);
    if (!m) return;
    const token = { type: 'callout', raw: m[0], variant: m[1] || 'aside', tokens: [] };
    this.lexer.blockTokens(m[2], token.tokens);
    return token;
  },
  renderer(token) {
    /* Reuse the two block treatments the stylesheet already has rather than
       inventing a third: `aside` is the quiet left-ruled note, `note` is the
       accent-washed callout. */
    const cls = CALLOUTS[token.variant] || `callout callout-${token.variant}`;
    return `<div class="${cls}">${this.parser.parse(token.tokens)}</div>\n`;
  }
};

const CALLOUTS = { aside: 'aside', note: 'callout' };

/* ---------------------------------------------------------------------------
   Renderer overrides
   ------------------------------------------------------------------------ */

function figure(img, isFirstBlock, sizeOf) {
  const cls = isFirstBlock ? 'post-hero' : 'post-figure';
  const alt = esc(img.text || '');
  const cap = img.title ? `\n  <figcaption>${esc(img.title)}</figcaption>` : '';
  /* Explicit dimensions reserve the space before the bytes arrive. The lead
     image is what the reader is waiting for, so it loads eagerly. */
  const d = sizeOf(img.href);
  const dim = d ? ` width="${d.width}" height="${d.height}"` : '';
  const load = isFirstBlock ? 'eager' : 'lazy';
  return `<figure class="${cls}">\n  <img src="${esc(img.href)}" alt="${alt}"${dim} loading="${load}" decoding="async">${cap}\n</figure>\n`;
}

function overrides(state, sizeOf) {
  return {
    text(token) {
      if (token.tokens) return this.parser.parseInline(token.tokens);
      const out = smarten(token.text);
      return token.escaped ? out : escText(out);
    },

    /* A paragraph containing nothing but an image is a figure, not a
       paragraph with an image loose inside it. */
    paragraph(token) {
      const kids = (token.tokens || []).filter(
        (t) => !(t.type === 'text' && !t.raw.trim()) && t.type !== 'space'
      );
      if (kids.length === 1 && kids[0].type === 'image') {
        const first = !state.sawBlock;
        state.sawBlock = true;
        return figure(kids[0], first, sizeOf);
      }
      state.sawBlock = true;
      return `<p>${this.parser.parseInline(token.tokens)}</p>\n`;
    },

    /* Headings carry ids so sections are linkable. The post title is the only
       h1 on the page and it comes from meta.json, so a Markdown body starts at
       h2; `#` and `##` both land there rather than producing a second h1. */
    heading(token) {
      const depth = Math.min(Math.max(token.depth, 2), 6);
      const text = this.parser.parseInline(token.tokens);
      state.sawBlock = true;
      return `<h${depth} id="${esc(slugify(token.text))}">${text}</h${depth}>\n`;
    },

    blockquote(token) {
      state.sawBlock = true;
      return `<blockquote>${this.parser.parse(token.tokens)}</blockquote>\n`;
    },

    table(token) {
      state.sawBlock = true;
      const cell = (c, tag, align) =>
        `<${tag}${align ? ` style="text-align:${align}"` : ''}${
          tag === 'th' ? ' scope="col"' : ''
        }>${this.parser.parseInline(c.tokens)}</${tag}>`;
      const head = token.header
        .map((c, i) => cell(c, 'th', token.align[i]))
        .join('');
      const body = token.rows
        .map(
          (row) =>
            `<tr>${row.map((c, i) => cell(c, 'td', token.align[i])).join('')}</tr>`
        )
        .join('\n');
      return `<div class="table-wrap">\n<table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table>\n</div>\n`;
    }
  };
}

/* ---------------------------------------------------------------------------
   Entry point
   ------------------------------------------------------------------------ */

/**
 * Render a Markdown post body into the HTML that goes inside <main>.
 * `sizeOf(href)` may return `{width,height}` for a post-relative image so the
 * figure can reserve its space; returning null just omits the attributes.
 */
export function renderMarkdown(src, { slug = '', sizeOf = () => null } = {}) {
  const state = { defs: new Map(), order: [], sawBlock: false };
  const md = new Marked({ gfm: true, breaks: false });
  md.use({
    extensions: [...footnotes(state), callout],
    renderer: overrides(state, sizeOf)
  });

  let html = md.parse(String(src).trim());

  /* Definitions that were never cited would otherwise vanish silently. */
  for (const id of state.defs.keys()) {
    if (!state.order.includes(id)) {
      warn(slug, `footnote [^${id}] is defined but never referenced`);
      state.order.push(id);
    }
  }

  if (state.order.length) {
    const items = state.order
      .map((id, i) => {
        if (!state.defs.has(id)) {
          warn(slug, `footnote [^${id}] is referenced but never defined`);
        }
        return `    <li id="ref-${i + 1}">${state.defs.get(id) || ''} <a href="#cite-${i + 1}" class="ref-back" aria-label="Back to reference ${i + 1}">↩</a></li>`;
      })
      .join('\n');
    html += `\n<h2 id="notes">Notes</h2>\n<ol class="refs refs-numbered">\n${items}\n</ol>\n`;
  }

  return `<section class="prose">\n${html}</section>\n`;
}

function warn(slug, msg) {
  console.warn(`  ! ${slug ? slug + ': ' : ''}${msg}`);
}
