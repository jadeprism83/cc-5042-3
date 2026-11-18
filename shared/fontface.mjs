// Font face pipeline. One module resolves a font face (static TTF or a variable
// font instance), shapes runs, and hands flattened em-unit contours to the SDF
// kernel. The atlas builder (CLI), the browser editor, and the tests all use it.
import * as fontkit from 'fontkit';
import { flattenOutline } from './geometry.mjs';

export const FACES = {
  'sans-thin': {
    file: 'DejaVuSans-ExtraLight.ttf',
    label: 'DejaVu Sans ExtraLight',
    weight: 200,
    style: 'thin',
    family: 'pavilion-thin',
    license: 'DejaVu (Bitstream Vera)',
  },
  'sans-book': {
    file: 'DejaVuSans.ttf',
    label: 'DejaVu Sans Book',
    weight: 400,
    style: 'regular',
    family: 'pavilion-book',
    license: 'DejaVu (Bitstream Vera)',
  },
  'sans-bold': {
    file: 'DejaVuSans-Bold.ttf',
    label: 'DejaVu Sans Bold',
    weight: 700,
    style: 'bold',
    family: 'pavilion-bold',
    license: 'DejaVu (Bitstream Vera)',
  },
  'cjk-regular': {
    file: 'NotoSansSC-VF.ttf',
    label: 'Noto Sans SC',
    weight: 400,
    style: 'regular',
    family: 'pavilion-cjk',
    license: 'SIL OFL 1.1',
    variable: { axis: 'wght', min: 100, max: 900, default: 400 },
  },
};

const cache = new Map();

// `resolve` is called with a face id and returns an object exposing
// openFont(buffer) -> fontkit font. Node reads from disk; the browser reads
// from Cache Storage / fetch. Both paths reach the same fontkit API.
export function getFont(faceId, resolve) {
  const spec = FACES[faceId];
  if (!spec) throw faceError('UNKNOWN_FACE', `未知字体：${faceId}`, { faceId, faces: Object.keys(FACES) });
  const weight = spec.weight;
  const key = `${faceId}@${weight}`;
  if (cache.has(key)) return cache.get(key);
  const base = resolve(faceId, spec.file);
  let font = base;
  if (spec.variable) {
    font = base.getVariation({ [spec.variable.axis]: weight });
  }
  cache.set(key, font);
  return font;
}

export function clearFontCache() { cache.clear(); }

export function faceError(code, message, detail) {
  const e = new Error(message);
  e.code = code;
  e.detail = detail;
  return e;
}

// Segment a string into runs by face: CJK codepoints use the CJK face, all
// others use the supplied Latin face. Keeps the runtime layout dependencies
// explicit instead of relying on browser font-stack fallback.
const CJK_RE = /[⺀-鿿豈-﫿　-〿＀-￯]/;
export function isCjk(cp) {
  return CJK_RE.test(String.fromCodePoint(cp));
}

// Shape one text string with a fixed face. Returns positioned glyph records in
// em units. Positions come from fontkit.layout so GPOS kerning is honoured.
export function shapeRun(font, text) {
  const run = font.layout(text);
  const unitsPerEm = font.unitsPerEm;
  const out = [];
  let penX = 0;
  for (let i = 0; i < run.glyphs.length; i++) {
    const g = run.glyphs[i];
    const pos = run.positions[i];
    const glyph = g;
    out.push({
      glyphId: g.id,
      cluster: pos ? (run.glyphs[i].codePoints ? run.glyphs[i].codePoints[0] : i) : i,
      advanceEm: (pos?.xAdvance ?? glyph.advanceWidth) / unitsPerEm,
      offsetEm: { x: (pos?.xOffset ?? 0) / unitsPerEm, y: (pos?.yOffset ?? 0) / unitsPerEm },
      penEm: penX,
      codePoint: glyph.codePoints ? glyph.codePoints[0] : null,
    });
    penX += (pos?.xAdvance ?? glyph.advanceWidth) / unitsPerEm;
  }
  return { glyphs: out, advanceEm: penX };
}

// Positioned, face-segmented runs for a paragraph.
export function shapeParagraph(text, faces, resolve) {
  const runs = [];
  const chars = [...text];
  let seg = '';
  let segFace = null;
  const flush = () => {
    if (!seg) return;
    const font = getFont(segFace, resolve);
    const shaped = shapeRun(font, seg);
    for (const g of shaped.glyphs) g.face = segFace;
    runs.push({ face: segFace, text: seg, glyphs: shaped.glyphs, advanceEm: shaped.advanceEm });
    seg = '';
  };
  for (const ch of chars) {
    const cp = ch.codePointAt(0);
    const face = isCjk(cp) ? 'cjk-regular' : faces;
    if (face !== segFace) { flush(); segFace = face; }
    seg += ch;
  }
  flush();
  return runs;
}

// Flatten a glyph's outline into em-unit contours, offset by the glyph's own
// path coordinates (fontkit paths are already in font units, y-up).
export function glyphContours(font, glyphId) {
  const glyph = font.getGlyph(glyphId);
  if (!glyph || !glyph.path) return { contours: [], advanceEm: 0 };
  const upm = font.unitsPerEm;
  const contours = flattenOutline(glyph.path.commands).map((c) => ({
    points: c.points.map(([x, y]) => [x / upm, y / upm]),
    closed: true,
  }));
  return { contours, advanceEm: glyph.advanceWidth / upm, bbox: glyph.bbox };
}

// Horizontal advance without shaping (single glyph). Kerning is applied at the
// run level; a lone glyph has no pair to kern against.
export function glyphAdvanceEm(font, glyphId) {
  const g = font.getGlyph(glyphId);
  return g ? g.advanceWidth / font.unitsPerEm : 0;
}
