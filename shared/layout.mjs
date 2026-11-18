// Runtime text layout. Consumes atlas manifests only: no font files, no canvas
// text measurement, no browser shaping.
//
// INVARIANT: pen advance uses the glyph's `advance` metric (em) plus explicit
// tracking. It never uses the atlas tile width. A tile carries padTexels of
// blank margin on each side and that margin is layout-inert. The tile rect is
// placed relative to the pen using the tile origin (ox, oy), which comes from
// ink bounds, so a glyph whose tile overhangs its advance still renders in the
// right place.
import { isCjkCodepoint } from './content.mjs';

export function buildKerningMap(manifest) {
  const m = new Map();
  for (const [a, b, v] of manifest.kerning) m.set((a << 16) | b, v);
  return m;
}

export function makeManifests(index, byId, opts = {}) {
  const cache = new Map();
  const latinFace = opts.latinFace ?? 'sans-book';
  const api = {
    index,
    byId,
    latinFace,
    // Reads the mutable `latinFace` so the UI weight selector can retarget the
    // Latin face without rebuilding the manifest set.
    faceFor(cp) {
      if (isCjkCodepoint(cp)) return 'cjk-regular';
      return api.latinFace;
    },
    kerning(faceId) {
      if (!cache.has(faceId)) cache.set(faceId, buildKerningMap(byId.get(faceId)));
      return cache.get(faceId);
    },
    glyph(faceId, cp) {
      const m = byId.get(faceId);
      return m.glyphs[cp] || m.blanks[cp] || null;
    },
  };
  return api;
}

// Core single-line shaper. Emits one record per drawable glyph plus a running
// pen. A `strokeEm` on the manifest is a distance bias baked into the tile;
// the runtime does not need to know it unless it draws a contour reference.
export function shapeLine(manifests, text, { sizePx = 64, tracking = 0, x = 0, y = 0 } = {}) {
  const placements = [];
  let pen = 0;              // in em
  let prev = null;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    const faceId = manifests.faceFor(cp);
    const manifest = manifests.byId.get(faceId);
    const g = manifests.glyph(faceId, cp);
    if (!g) {
      const m = manifest.glyphs[77];
      pen += (m ? m.advance : 0.5) + tracking;
      prev = null;
      continue;
    }
    let kernEm = 0;
    if (prev) {
      const k = manifests.kerning(prev.faceId).get((prev.cp << 16) | cp);
      if (k != null) { kernEm = k; pen += k; }
    }
    if (!g.blank) {
      const scale = sizePx / manifest.settings.texelsPerEm;
      // ox/oy are the glyph origin inside the tile, in texels. The tile's
      // top-left, relative to the pen on the baseline, is (-ox, -oy) texels.
      // This uses the tile's own origin, never the tile width as spacing.
      placements.push({
        cp, glyphId: g.glyphId, faceId, band: g.band,
        x: x + pen * sizePx - g.ox * scale,
        y: y - g.oy * scale,
        w: g.w * scale,
        h: g.h * scale,
        u0: g.x, v0: g.y, du: g.w, dv: g.h,
        advancePx: g.advance * sizePx,
        kernEm,
        penPx: x + pen * sizePx,
      });
    }
    pen += g.advance + tracking;
    prev = { cp, faceId, band: g.band };
  }
  return { placements, advancePx: pen * sizePx };
}

// Closing punctuation that must not start a line, and opening punctuation that
// must not end one. Implemented as a hang: the token is kept on the current
// line even if that overflows the measure slightly, which is what a typesetter
// would do rather than pushing a lone 。 to the next line.
const NO_LINE_START = new Set([...'，。、；：！？）」』》〉】〕…—–·,.;:!?)]}%']);
const NO_LINE_END = new Set([...'（「『《〈【〔(']);

function canBreakBefore(tok) {
  if (!tok) return true;
  return !NO_LINE_START.has(tok[0]);
}

function canBreakAfter(tok) {
  if (!tok) return true;
  return !NO_LINE_END.has(tok[tok.length - 1]);
}

// Word/CJK-aware wrapping. Line breaking uses advances only. `maxWidthPx`
// is the measure; CJK breaks between characters, Latin only at whitespace.
export function layoutParagraph(manifests, text, opts = {}) {
  const sizePx = opts.sizePx ?? 64;
  const lineHeightEm = opts.lineHeightEm ?? 1.45;
  const maxWidthPx = opts.maxWidthPx ?? Infinity;
  const align = opts.align ?? 'left';
  const tracking = opts.tracking ?? 0;

  const tokens = tokenize(text);
  const lines = [];
  let cur = [];
  let curW = 0;
  const measure = (toks) => measureTokens(manifests, toks, { sizePx, tracking });

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === '\n') { lines.push({ tokens: cur, width: curW }); cur = []; curW = 0; continue; }
    const w = measure([tok]);
    const over = curW + w > maxWidthPx && cur.length;
    if (over && canBreakBefore(tok) && canBreakAfter(cur[cur.length - 1])) {
      lines.push({ tokens: cur, width: curW });
      cur = [];
      curW = 0;
      if (/^\s+$/.test(tok)) continue;
    }
    if (/^\s+$/.test(tok) && !cur.length) continue;
    cur.push(tok);
    curW += w;
  }
  if (cur.length) lines.push({ tokens: cur, width: curW });

  const out = [];
  let cursorY = 0;
  for (const line of lines) {
    let startX = 0;
    if (align === 'center' && Number.isFinite(maxWidthPx)) startX = (maxWidthPx - line.width) / 2;
    else if (align === 'right' && Number.isFinite(maxWidthPx)) startX = maxWidthPx - line.width;
    // Convention: `y` handed to shapeLine is the baseline. Paragraph y is the
    // top of the line box, so caller stacks downward with para.height.
    const baseline = cursorY + sizePx * BASELINE_RATIO;
    const shaped = shapeLine(manifests, line.tokens.join(''), { sizePx, tracking, x: startX, y: baseline });
    out.push({
      y: cursorY,
      baselineY: baseline,
      width: line.width,
      startX,
      placements: shaped.placements,
      text: line.tokens.join(''),
    });
    cursorY += sizePx * lineHeightEm;
  }
  return { lines: out, height: cursorY, sizePx };
}

// Baseline position inside a line box, as a fraction of the font size. The
// atlas tiles are laid out from the font's own ascender/descender, so this is
// only used to stack line boxes; it does not affect glyph placement.
export const BASELINE_RATIO = 0.82;

export function tokenize(text) {
  const tokens = [];
  let buf = '';
  for (const ch of text) {
    if (ch === '\n') { if (buf) { tokens.push(buf); buf = ''; } tokens.push('\n'); continue; }
    if (/\s/.test(ch)) { if (buf) { tokens.push(buf); buf = ''; } tokens.push(ch); continue; }
    if (isCjkCodepoint(ch.codePointAt(0))) {
      if (buf) { tokens.push(buf); buf = ''; }
      tokens.push(ch);
    } else buf += ch;
  }
  if (buf) tokens.push(buf);
  return tokens;
}

function measureTokens(manifests, tokens, { sizePx, tracking }) {
  let pen = 0;
  let prev = null;
  for (const tok of tokens) {
    for (const ch of tok) {
      const cp = ch.codePointAt(0);
      const faceId = manifests.faceFor(cp);
      const g = manifests.glyph(faceId, cp);
      if (!g) { pen += (0.5 + tracking) * sizePx; prev = null; continue; }
      if (prev && prev.faceId === faceId) {
        const k = manifests.kerning(faceId).get((prev.cp << 16) | cp);
        if (k != null) pen += k * sizePx;
      }
      pen += (g.advance + tracking) * sizePx;
      prev = { cp, faceId };
    }
  }
  return pen;
}

// Width of a shaped line, returned without building placements (used by the
// tests to prove that tile padding does not leak into tracking).
export function measureText(manifests, text, { sizePx = 64, tracking = 0 } = {}) {
  return measureTokens(manifests, tokenize(text), { sizePx, tracking });
}
