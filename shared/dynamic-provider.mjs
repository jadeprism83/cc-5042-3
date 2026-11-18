// Runtime glyph-source provider for the bounded dynamic atlas.
//
// The browser never ships a font parser. A build-time tool
// (tools/build-dynamic-sources.mjs) extracts the on-demand codepoint pool from
// the distributable fonts with fontkit and writes web/atlas/dynamic-sources.json
// (em-unit outline commands + advances, exactly like outlines.json but for
// codepoints the fixed atlases do not cover). At runtime this module turns
// those sources into SDF tiles through the same kernel the CLI uses, and
// produces an explicit placeholder tile when the pool has no glyph.
//
// Nothing here draws text: the output is always R8 distance data plus a font
// advance, which the layout layer and GPU renderer consume like any other tile.
import { flattenOutline } from './geometry.mjs';
import { buildGlyphTile, kernelError, ENCODE_NEUTRAL } from './sdf.mjs';

// Deterministic hollow-box placeholder ("tofu") dimensions in em. It is built
// with the same R8 encoding as a real glyph, so a missing character is always a
// deliberate, recognisable mark — never stale pixels from a recycled slot.
export const PLACEHOLDER = { advanceEm: 0.6, boxEm: 0.72, strokeEm: 0.045 };

export class DynamicGlyphProvider {
  constructor({ sources, settings }) {
    // sources: { faces: { faceId: { [cp]: { cp, glyphId, advance, cmds } } } }
    this.faces = sources?.faces || {};
    this.settings = settings || sources?.settings;
    this.presets = sources?.languagePresets || {};
  }

  static async load(url = './atlas/dynamic-sources.json') {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw kernelError('SOURCES_LOAD_FAILED', `无法读取动态字形源（HTTP ${res.status}）`, { url });
    const payload = await res.json();
    return new DynamicGlyphProvider({ sources: payload, settings: payload.settings });
  }

  hasGlyph(faceId, cp) {
    return Boolean(this.faces[faceId] && this.faces[faceId][cp]);
  }

  // Generator handed to DynamicGlyphCache.request. Resolves to
  // { tile, advance } or rejects (the cache records the rejection as a missing
  // state and keeps the placeholder on screen).
  generator = (faceId, cp) => {
    const src = this.faces[faceId]?.[cp];
    if (!src) {
      return Promise.reject(kernelError('GLYPH_MISSING', '动态字形池中没有该字形，使用占位符', { faceId, cp }));
    }
    let tile;
    try {
      const contours = flattenOutline(src.cmds.map((c) => ({ command: c.c, args: c.a })));
      if (!contours.length) {
        return Promise.reject(kernelError('EMPTY_GLYPH', '字形轮廓为空', { faceId, cp }));
      }
      tile = withOrigin(buildGlyphTile(contours, this.settings), this.settings.texelsPerEm);
    } catch (err) {
      return Promise.reject(err);
    }
    return Promise.resolve({ tile, advance: src.advance });
  };

  // Explicit placeholder tile for pending/missing/busy identities. Built over a
  // fixed em rect so every placeholder occupies a predictable cell region; the
  // rect is centred on the pen origin using the placeholder advance.
  buildPlaceholderTile() {
    if (this._placeholder) return this._placeholder;
    const { texelsPerEm, rangeTexels } = this.settings;
    const box = PLACEHOLDER.boxEm;
    const half = box / 2;
    const stroke = PLACEHOLDER.strokeEm;
    // Four bars of the hollow square, expressed as polygons so the standard
    // nonzero-winding distance kernel handles them without special cases.
    const x0 = -half, x1 = half, y0 = -half, y1 = half;
    const s = stroke;
    const bars = [
      rectPts(x0, y1 - s, x1, y1),
      rectPts(x0, y0, x1, y0 + s),
      rectPts(x0, y0, x0 + s, y1),
      rectPts(x1 - s, y0, x1, y1),
    ];
    const tile = buildGlyphTile(bars, this.settings);
    this._placeholder = { tile: withOrigin(tile, this.settings.texelsPerEm), advance: PLACEHOLDER.advanceEm, neutral: ENCODE_NEUTRAL, rangeTexels, texelsPerEm };
    return this._placeholder;
  }

  // Default advance used while a tile has not been generated yet. The pen must
  // keep moving even before the real glyph resolves.
  pendingAdvanceEm() { return PLACEHOLDER.advanceEm; }
}

// Attach the glyph-origin offset inside the tile, in texels. This mirrors the
// fixed atlas manifest's ox/oy (see shared/atlas-build.mjs): the tile top-left
// relative to the pen on the baseline is (-ox, -oy).
export function withOrigin(tile, texelsPerEm) {
  tile.ox = (0 - tile.tileEm.left) * texelsPerEm;
  tile.oy = tile.tileEm.top * texelsPerEm;
  return tile;
}

function rectPts(minX, minY, maxX, maxY) {
  return { points: [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]], closed: true };
}
