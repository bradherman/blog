/* Open Graph cards: the 1200x630 image that shows up when a post is shared.

   Every post gets one at build time, so sharing never depends on remembering to
   make an image. A post that supplies its own art gets that art, cropped and
   scrimmed with the title over it; a post that doesn't gets the site's road
   card. Either way the typography is the site's, so a link preview looks like
   it came from here.

   Text is converted to SVG paths with fontkit before resvg rasterises it. That
   means measurement and rendering use one engine and the output does not depend
   on which fonts happen to be installed — a card built in CI is byte-identical
   to one built on a laptop. */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Resvg } from '@resvg/resvg-js';
import { openSync as openFont } from 'fontkit';
import { imageSize } from './imagesize.mjs';

const require = createRequire(import.meta.url);

export const CARD = { width: 1200, height: 630 };

/* Charis SIL is an open Charter, which is the site's body face; Roboto Mono
   stands in for the system mono the stylesheet asks for. */
const FONT_FILES = {
  serifBold: '@expo-google-fonts/charis-sil/700Bold/CharisSIL_700Bold.ttf',
  serif: '@expo-google-fonts/charis-sil/400Regular/CharisSIL_400Regular.ttf',
  mono: '@expo-google-fonts/roboto-mono/400Regular/RobotoMono_400Regular.ttf',
  monoMedium: '@expo-google-fonts/roboto-mono/500Medium/RobotoMono_500Medium.ttf'
};

const fonts = {};
function font(name) {
  if (!fonts[name]) fonts[name] = openFont(require.resolve(FONT_FILES[name]));
  return fonts[name];
}

/* Palette. These are the stylesheet's dark-theme tokens: a card sits on other
   people's timelines, where dark reads better and matches the favicon. */
const C = {
  bg: '#14181b',
  asphalt: '#3b4045',
  marking: '#e6e0c6',
  accent: '#3fa980',
  title: '#e8ecee',
  deck: '#a6b0b6',
  faint: '#7e878d'
};

/* ---------------------------------------------------------------------------
   Type setting
   ------------------------------------------------------------------------ */

/** Advance width of a string in px at `size`, including tracking.
    Summed from the shaped positions rather than run.advanceWidth, which asks
    each glyph for a bounding box and throws on fonts whose last glyph is
    empty. */
function measure(f, text, size, tracking = 0) {
  const run = f.layout(text);
  let units = 0;
  for (const p of run.positions) units += p.xAdvance;
  return (units / f.unitsPerEm) * size + tracking * Math.max(run.glyphs.length - 1, 0);
}

/** One line of text as SVG path data, with `x`/`y` at the left baseline. */
function linePath(f, text, size, x, y, tracking = 0) {
  const run = f.layout(text);
  const s = size / f.unitsPerEm;
  let pen = x;
  let d = '';
  run.glyphs.forEach((glyph, i) => {
    const pos = run.positions[i];
    const gx = pen + pos.xOffset * s;
    const gy = y - pos.yOffset * s;
    for (const c of glyph.path.commands) {
      const a = c.args;
      /* Font space is y-up and SVG is y-down, so y is negated as it scales. */
      switch (c.command) {
        case 'moveTo':
          d += `M${r(gx + a[0] * s)} ${r(gy - a[1] * s)}`;
          break;
        case 'lineTo':
          d += `L${r(gx + a[0] * s)} ${r(gy - a[1] * s)}`;
          break;
        case 'quadraticCurveTo':
          d += `Q${r(gx + a[0] * s)} ${r(gy - a[1] * s)} ${r(gx + a[2] * s)} ${r(gy - a[3] * s)}`;
          break;
        case 'bezierCurveTo':
          d += `C${r(gx + a[0] * s)} ${r(gy - a[1] * s)} ${r(gx + a[2] * s)} ${r(gy - a[3] * s)} ${r(gx + a[4] * s)} ${r(gy - a[5] * s)}`;
          break;
        case 'closePath':
          d += 'Z';
          break;
      }
    }
    pen += pos.xAdvance * s + tracking;
  });
  return d;
}

const r = (n) => Math.round(n * 100) / 100;

/** Greedy word wrap. Words longer than the column are left to overhang. */
function wrap(f, text, size, maxWidth, tracking = 0) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && measure(f, next, size, tracking) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Wrap, then drop what doesn't fit, marking the truncation with an ellipsis. */
function clamp(f, text, size, maxWidth, maxLines, tracking = 0) {
  const lines = wrap(f, text, size, maxWidth, tracking);
  const kept = lines.slice(0, maxLines);

  if (lines.length > maxLines) {
    let last = kept[maxLines - 1];
    /* prefer losing a whole word to cutting one in half */
    while (last.includes(' ') && measure(f, last + '…', size, tracking) > maxWidth) {
      last = last.replace(/\s*\S+$/, '');
    }
    kept[maxLines - 1] = last + '…';
  }

  /* wrap() leaves a token wider than the column overhanging, because there is
     no space to break at. Nothing may run off the edge of a card, so any line
     still too wide gets trimmed by character. */
  for (let i = 0; i < kept.length; i++) {
    if (measure(f, kept[i], size, tracking) <= maxWidth) continue;
    let s = kept[i].replace(/…$/, '');
    while (s && measure(f, s + '…', size, tracking) > maxWidth) s = s.slice(0, -1);
    kept[i] = s + '…';
  }
  return kept;
}

/* ---------------------------------------------------------------------------
   The card
   ------------------------------------------------------------------------ */

const PAD = 76;
const COL = CARD.width - PAD * 2;

/**
 * Build the card SVG.
 * @param {object} o
 * @param {string} o.eyebrow  small uppercase label above the title
 * @param {string} o.title
 * @param {string} [o.deck]   one or two lines of supporting text
 * @param {string} o.footerLeft
 * @param {string} [o.footerRight]
 * @param {string} [o.badge]  authorship tag, drawn as a chip
 * @param {{data:Buffer,type:string}} [o.hero] background art
 */
export function cardSvg({ eyebrow, title, deck, footerLeft, footerRight, badge, hero }) {
  const serifBold = font('serifBold');
  const serif = font('serif');
  const mono = font('mono');
  const monoMed = font('monoMedium');

  const parts = [];

  /* -- background ------------------------------------------------------- */
  parts.push(`<rect width="${CARD.width}" height="${CARD.height}" fill="${C.bg}"/>`);

  if (hero) {
    const size = imageSize(hero.data) || { width: CARD.width, height: CARD.height };
    /* cover-fit, centred — the same crop the stylesheet gives a post hero */
    const scale = Math.max(CARD.width / size.width, CARD.height / size.height);
    const dw = size.width * scale;
    const dh = size.height * scale;
    const href = `data:${hero.type};base64,${hero.data.toString('base64')}`;
    parts.push(
      `<image x="${r((CARD.width - dw) / 2)}" y="${r((CARD.height - dh) / 2)}" width="${r(dw)}" height="${r(dh)}" href="${href}"/>`,
      /* Two scrims: one bottom-up behind the type stack, one from the left so
         the eyebrow stays legible over a busy or pale part of the picture. */
      `<rect width="${CARD.width}" height="${CARD.height}" fill="url(#scrim)"/>`,
      `<rect width="${CARD.width}" height="${CARD.height}" fill="url(#scrimX)"/>`
    );
  }

  /* -- the road, as on every page of the site ---------------------------- */
  parts.push(`<rect width="${CARD.width}" height="14" fill="${C.asphalt}"/>`);
  for (let x = 0; x < CARD.width; x += 46) {
    /* the final dash is cut to the edge rather than hanging over it */
    const w = Math.min(26, CARD.width - x);
    parts.push(`<rect x="${x}" y="5.5" width="${w}" height="3" fill="${C.marking}"/>`);
  }

  /* -- text stack, laid out from the bottom so long titles grow upward --- */
  const footerBaseline = CARD.height - 58;
  const stackBottom = footerBaseline - 62;
  const stackTop = 96;

  const EYE = { size: 21, tracking: 2.6 };
  const DECK = { size: 25, lh: 1.42 };

  const eyebrowText = String(eyebrow || '').toUpperCase();
  const deckLines = deck ? clamp(serif, deck, DECK.size, COL, 2) : [];

  /* Shrink the title until the whole stack fits the band. */
  let titleSize = 78;
  let titleLines;
  let stackHeight = 0;
  const titleLh = 1.15;
  const heightOf = (lines, size) =>
    (eyebrowText ? EYE.size + 26 : 0) +
    lines.length * size * titleLh +
    (deckLines.length ? 20 + deckLines.length * DECK.size * DECK.lh : 0);
  for (;;) {
    titleLines = wrap(serifBold, title, titleSize, COL);
    stackHeight = heightOf(titleLines, titleSize);
    if (titleLines.length <= 3 && stackBottom - stackHeight >= stackTop) break;
    if (titleSize <= 44) break;
    titleSize -= 2;
  }
  /* Re-run through clamp so the line cap and the per-line fit both apply, at
     whatever size the loop settled on. */
  titleLines = clamp(serifBold, title, titleSize, COL, 3);
  stackHeight = heightOf(titleLines, titleSize);

  /* A hero card leaves the space above the type to the picture. A plain one has
     nothing to show there, so the stack is centred in the band instead of
     stranded at the bottom under 300px of empty ink. */
  let y = stackBottom;
  if (!hero) {
    y = Math.min(stackBottom, stackTop + (stackBottom - stackTop + stackHeight) / 2);
  }
  if (deckLines.length) {
    for (let i = deckLines.length - 1; i >= 0; i--) {
      parts.push(path(linePath(serif, deckLines[i], DECK.size, PAD, y), C.deck));
      y -= DECK.size * DECK.lh;
    }
    y -= 20;
  }
  for (let i = titleLines.length - 1; i >= 0; i--) {
    parts.push(path(linePath(serifBold, titleLines[i], titleSize, PAD, y), C.title));
    y -= titleSize * titleLh;
  }
  if (eyebrowText) {
    y -= 6;
    const line = clamp(monoMed, eyebrowText, EYE.size, COL, 1, EYE.tracking)[0];
    parts.push(path(linePath(monoMed, line, EYE.size, PAD, y, EYE.tracking), C.accent));
  }

  /* -- footer ------------------------------------------------------------ */
  parts.push(
    `<rect x="${PAD}" y="${footerBaseline - 34}" width="${COL}" height="1" fill="${C.asphalt}"/>`
  );
  /* The footer is laid out right-to-left from the badge inward, and each piece
     is clamped to what is actually left. Right-aligned text positioned by
     subtracting its own width runs off the left edge otherwise. */
  const left = clamp(mono, footerLeft, 20, COL * 0.5, 1)[0] || '';
  parts.push(path(linePath(mono, left, 20, PAD, footerBaseline), C.faint));
  const leftEnd = PAD + measure(mono, left, 20);

  let rightEdge = CARD.width - PAD;
  if (badge) {
    const bSize = 15;
    const bTrack = 1.5;
    const label = clamp(monoMed, badge.toUpperCase(), bSize, COL * 0.32, 1, bTrack)[0];
    if (label) {
      const w = measure(monoMed, label, bSize, bTrack) + 24;
      const h = 30;
      const bx = rightEdge - w;
      const by = footerBaseline - 21;
      parts.push(
        `<rect x="${r(bx)}" y="${by}" width="${r(w)}" height="${h}" rx="3" fill="none" stroke="${C.accent}" stroke-width="1.5"/>`,
        path(linePath(monoMed, label, bSize, bx + 12, by + 20, bTrack), C.accent)
      );
      rightEdge = bx - 18;
    }
  }
  if (footerRight) {
    const room = rightEdge - leftEnd - 18;
    const text = room > 24 ? clamp(mono, footerRight, 20, room, 1)[0] : '';
    if (text) {
      const w = measure(mono, text, 20);
      parts.push(path(linePath(mono, text, 20, rightEdge - w, footerBaseline), C.faint));
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD.width}" height="${CARD.height}" viewBox="0 0 ${CARD.width} ${CARD.height}">
<defs>
  <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${C.bg}" stop-opacity="0.34"/>
    <stop offset="0.38" stop-color="${C.bg}" stop-opacity="0.70"/>
    <stop offset="1" stop-color="${C.bg}" stop-opacity="0.97"/>
  </linearGradient>
  <linearGradient id="scrimX" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="${C.bg}" stop-opacity="0.45"/>
    <stop offset="0.62" stop-color="${C.bg}" stop-opacity="0"/>
  </linearGradient>
</defs>
${parts.join('\n')}
</svg>`;
}

const path = (d, fill) => (d ? `<path d="${d}" fill="${fill}"/>` : '');

/** Rasterise a card to PNG bytes. */
export function renderCard(opts) {
  const svg = cardSvg(opts);
  return new Resvg(svg, {
    fitTo: { mode: 'width', value: CARD.width },
    /* Text is already paths, so no font lookup can happen at render time. */
    font: { loadSystemFonts: false }
  })
    .render()
    .asPng();
}

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

/** Read a post's hero art, if it declared one. Returns null when absent. */
export async function loadHero(file) {
  const ext = (file.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
  const type = MIME[ext];
  if (!type) return null;
  const data = await readFile(file).catch(() => null);
  return data ? { data, type } : null;
}
