// Browser-safe atlas assembly. Takes already-extracted glyph sources (outline
// commands in em units, advance in em) and produces a packed R8 atlas plus its
// manifest. The Node builder and the in-browser vector editor both call this,
// so an edit made in the editor goes through the exact kernel that built the
// shipped atlas.
import { flattenOutline } from './geometry.mjs';
import { buildGlyphTile, kernelError } from './sdf.mjs';
import { packTiles, blitTile, DEFAULT_GUTTER } from './pack.mjs';

export const DEFAULT_SETTINGS = {
  texelsPerEm: 64,
  rangeTexels: 10,
  padTexels: 16,
  maxWidth: 4096,
  maxHeight: 4096,
  gutter: DEFAULT_GUTTER,
  padding: 1,
};

export function normalizeSettings(input = {}) {
  const s = { ...DEFAULT_SETTINGS, ...input };
  const cfg = {
    texelsPerEm: Math.round(s.texelsPerEm),
    rangeTexels: Math.round(s.rangeTexels),
    padTexels: Math.round(s.padTexels),
    maxWidth: Math.round(s.maxWidth),
    maxHeight: Math.round(s.maxHeight),
    gutter: Math.max(0, Math.round(s.gutter)),
    padding: Math.max(0, Math.round(s.padding)),
  };
  if (!(cfg.texelsPerEm >= 4 && cfg.texelsPerEm <= 256)) {
    throw kernelError('TEXELS_PER_EM_RANGE', '每 em 采样数需在 4–256 之间', { value: cfg.texelsPerEm, field: 'texelsPerEm' });
  }
  if (!(cfg.rangeTexels >= 2 && cfg.rangeTexels <= 64)) {
    throw kernelError('RANGE_RANGE', '距离编码范围需在 2–64 texel 之间', { value: cfg.rangeTexels, field: 'rangeTexels' });
  }
  if (cfg.padTexels <= cfg.rangeTexels) {
    throw kernelError('PAD_TOO_SMALL', '图块边距必须严格大于距离编码范围，才能保证边缘饱和、不污染邻字', {
      padTexels: cfg.padTexels, rangeTexels: cfg.rangeTexels,
      hint: `padTexels ≥ ${cfg.rangeTexels + 1}`, field: 'padTexels',
    });
  }
  return cfg;
}

// glyphSources: [{ cp, glyphId, advance, cmds, band?, strokeEm?, scale?, offsetEm? }]
// cmds are em-unit fontkit-style commands ({c, a}) OR already-flattened contours.
// strokeEm: outline dilation (positive) / erosion (negative), applied as an
// exact bias to the signed distance before encoding.
// scale: {x,y} vector scale about the glyph origin; offsetEm: translation.
export function buildAtlasFromSources({ faceId, glyphSources, kerning = [], settings: rawSettings, faceMeta = null }) {
  const settings = normalizeSettings(rawSettings);
  const tiles = [];
  const prepared = new Map();
  const blanks = [];
  const dropped = [];
  let minLeft = Infinity, minTop = -Infinity, maxRight = -Infinity, minBottom = Infinity;

  for (const src of glyphSources) {
    const contours = src.contours
      ? src.contours.map((c) => ({ points: c.points.map((p) => p.slice()), closed: true }))
      : flattenOutline((src.cmds || []).map((c) => ({ command: c.c, args: c.a }))).map((c) => ({ points: c.points, closed: true }));
    if (!contours.length) {
      // Blank glyph (space and friends): no tile, but the advance is still a
      // font metric and must survive into the manifest.
      blanks.push({ cp: src.cp, glyphId: src.glyphId, advance: src.advance, band: src.band ?? 'latin' });
      continue;
    }

    const sx = src.scale?.x ?? 1, sy = src.scale?.y ?? 1;
    const tx = src.offsetEm?.x ?? 0, ty = src.offsetEm?.y ?? 0;
    const strokeEm = src.strokeEm ?? 0;
    if (sx === 0 || sy === 0) {
      throw kernelError('ZERO_SCALE', '字形缩放不能为 0', { cp: src.cp, scale: { x: sx, y: sy }, field: 'scale' });
    }
    const transformed = contours.map((c) => ({
      points: c.points.map(([x, y]) => [x * sx + tx, y * sy + ty]),
      closed: true,
    }));
    let tile;
    try {
      tile = buildGlyphTile(transformed, { ...settings, distanceBiasEm: strokeEm });
    } catch (err) {
      throw kernelError(err.code || 'TILE_FAILED', err.message, { ...(err.detail || {}), cp: src.cp });
    }
    if (!tile) { dropped.push({ cp: src.cp, reason: 'EMPTY_OUTLINE' }); continue; }
    const id = `g${src.glyphId}`;
    prepared.set(src.cp, { src, tile, id, transformed, strokeEm });
    tiles.push({ id, width: tile.width, height: tile.height });

    // Tile extents record where the (possibly dilated) ink lies, including the
    // pad. For bias, the field's visible edge is the original outline, so the
    // published tile rect is the tile rect; strokeEm is applied at render time
    // by shifting the decoded threshold, never by re-deriving the advance.
    minLeft = Math.min(minLeft, tile.tileEm.left);
    minTop = Math.max(minTop, tile.tileEm.top);
    maxRight = Math.max(maxRight, tile.tileEm.left + tile.tileEm.width);
    minBottom = Math.min(minBottom, tile.tileEm.top - tile.tileEm.height);
  }
  let packed;
  try {
    packed = packTiles(tiles, settings);
  } catch (err) {
    throw kernelError(err.code || 'ATLAS_FULL', err.message, { ...(err.detail || {}), field: 'atlas' });
  }
  const pixels = new Uint8Array(packed.width * packed.height);
  const glyphs = {};
  for (const [cp, { src, tile, id }] of prepared) {
    const placement = packed.placements.get(id);
    blitTile(pixels, packed.width, tile, placement);
    glyphs[cp] = {
      cp,
      glyphId: src.glyphId,
      x: placement.x, y: placement.y, w: tile.width, h: tile.height,
      ox: (0 - tile.tileEm.left) * settings.texelsPerEm,
      oy: tile.tileEm.top * settings.texelsPerEm,
      advance: src.advance,
      left: tile.tileEm.left,
      top: tile.tileEm.top,
      tileEmW: tile.tileEm.width,
      tileEmH: tile.tileEm.height,
      band: src.band ?? 'latin',
      strokeEm: src.strokeEm ?? 0,
    };
  }

  const blanksMap = {};
  for (const b of blanks) {
    blanksMap[b.cp] = {
      cp: b.cp, glyphId: b.glyphId, advance: b.advance, band: b.band, blank: true,
    };
  }

  return {
    schema: 1,
    face: faceId,
    settings,
    atlas: {
      width: packed.width, height: packed.height, bytes: pixels.length,
      padTexels: settings.padTexels, rangeTexels: settings.rangeTexels, gutter: settings.gutter,
      edgePolicy: '每个图块四周保留 padTexels 空边，padTexels > rangeTexels；距离场在边缘前已饱和，双线性采样不会跨入邻字。',
    },
    glyphs,
    blanks: blanksMap,
    kerning,
    dropped,
    inkExtentsEm: Number.isFinite(minLeft)
      ? { left: minLeft, top: minTop, right: maxRight, bottom: minBottom }
      : null,
    pixels,
    faceMeta,
  };
}
