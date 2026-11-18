// Shelf packer for R8 glyph tiles. Deterministic: glyphs are sorted by
// descending height (then id) so the same input always produces the same atlas,
// which is what the report and the committed atlas manifest rely on.
import { kernelError } from './sdf.mjs';

export const DEFAULT_GUTTER = 2;

export function packTiles(tiles, opts = {}) {
  const padding = opts.padding ?? 1;
  const gutter = opts.gutter ?? DEFAULT_GUTTER;
  const maxWidth = opts.maxWidth ?? 2048;
  const maxHeight = opts.maxHeight ?? 2048;
  if (!tiles.length) return { width: 0, height: 0, placements: new Map() };

  const order = tiles.map((t, i) => ({ ...t, _order: i }))
    .sort((a, b) => (b.height - a.height) || (b.width - a.width) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const placements = new Map();
  let x = padding, y = padding, shelfH = 0, width = 0;

  for (const t of order) {
    const w = t.width + gutter * 2;
    const h = t.height + gutter * 2;
    if (w > maxWidth) throw kernelError('TILE_TOO_WIDE', '字形图块超过图集最大宽度', { id: t.id, tileWidth: t.width, maxWidth });
    if (x + w + padding > maxWidth) {
      x = padding;
      y += shelfH;
      shelfH = 0;
    }
    if (y + h + padding > maxHeight) {
      throw kernelError('ATLAS_FULL', '字形图集放不下全部图块', { id: t.id, atY: y + h, maxHeight });
    }
    placements.set(t.id, { x: x + gutter, y: y + gutter, width: t.width, height: t.height });
    x += w;
    width = Math.max(width, x);
    shelfH = Math.max(shelfH, h);
  }
  const height = y + shelfH + padding;
  // Width/height are padded out to whole shelf extents, no power-of-two forcing.
  return { width, height, placements };
}

export function blitTile(atlasData, atlasWidth, tile, placement) {
  const { width, height, data } = tile;
  for (let row = 0; row < height; row++) {
    const src = row * width;
    const dst = (placement.y + row) * atlasWidth + placement.x;
    atlasData.set(data.subarray(src, src + width), dst);
  }
}
