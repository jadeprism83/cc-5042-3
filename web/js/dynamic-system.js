// Browser wiring for the bounded dynamic glyph atlas: one GlDynamicAtlas
// texture, one DynamicGlyphCache lifecycle, one DynamicGlyphProvider, and the
// uploader bridge between them. The tour/dynamic views only talk to this
// facade; GL fence details stay inside the bridge.
import { DynamicGlyphCache } from '../../shared/dynamic-atlas.mjs';
import { DynamicGlyphProvider } from '../../shared/dynamic-provider.mjs';
import { DynamicShaper } from '../../shared/dynamic-layout.mjs';
import { GlDynamicAtlas } from './gl-dynamic-atlas.js';

export const DYNAMIC_GRID = { cellW: 96, cellH: 96, cols: 8, rows: 8 };

export async function createDynamicSystem(gl, { grid = DYNAMIC_GRID, capacity = 56, sourceUrl } = {}) {
  const provider = await DynamicGlyphProvider.load(sourceUrl);
  const cells = grid.cols * grid.rows;
  const cap = Math.min(capacity, cells - 1); // one physical cell is the shared placeholder
  const glAtlas = new GlDynamicAtlas(gl, { ...grid, rows: grid.rows });
  const phTile = provider.buildPlaceholderTile().tile;
  glAtlas.installPlaceholder(phTile);

  const uploader = {
    uploadTile: (slot, tile) => glAtlas.uploadTile(slot, tile),
    paintPlaceholder: (slot) => {
      // Copy the shared placeholder bytes into the reserved slot's cell.
      const rect = glAtlas.cellRect(slot.index);
      const t = phTile;
      return glAtlas.uploadBytes(slot, t.data, t.width, t.height).then(() => rect);
    },
    recycleSlot: (slotInfo) => glAtlas.recycleSlot(slotInfo),
    isReusable: (index) => glAtlas.isReusable(index),
    destroy: () => glAtlas.destroy(),
  };

  const cache = new DynamicGlyphCache({ slots: cap, uploader });
  const shaper = new DynamicShaper({
    manifests: null, // injected by attachManifests once the fixed atlases load
    cache, provider, glAtlas,
  });

  return {
    cache, provider, glAtlas, shaper,
    texture: glAtlas.texture,
    placeholderUV: () => glAtlas.placeholderUV(),
    attachManifests(manifests) { shaper.manifests = manifests; },
    pump() { glAtlas.pumpFences(); },
    async drainFences() { return glAtlas.drainFences(); },
    destroy() { return cache.destroy(); },
  };
}
