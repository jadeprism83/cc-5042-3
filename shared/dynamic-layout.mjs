// Dynamic shaping for text that may contain codepoints outside the fixed
// atlases. The fixed manifests still supply every tile they always did; this
// layer only intervenes for codepoints they lack, resolving them through the
// bounded DynamicGlyphCache (pending -> uploaded / missing) and emitting draw
// records whose coordinates carry the cache epoch.
//
// Coordinate contract:
//   - atlas:'fixed'     -> sample the face's build-time texture
//   - atlas:'dynamic'   -> sample the bounded runtime texture at cell rect
//   - atlas:'placeholder' -> explicit CPU fallback tile (missing / no slot)
// Every dynamic/placeholder record embeds `epoch` and `slotIndex`; the
// renderer re-validates them against the cache before drawing, so a recycled
// coordinate can never paint another character.
import { buildKerningMap } from './layout.mjs';

export class DynamicShaper {
  constructor({ manifests, cache, provider, glAtlas }) {
    this.manifests = manifests;
    this.cache = cache;
    this.provider = provider;
    this.glAtlas = glAtlas;
    this._kern = new Map();
  }

  faceFor(cp) { return this.manifests.faceFor(cp); }

  kerning(faceId) {
    if (!this._kern.has(faceId)) {
      const m = this.manifests.byId.get(faceId);
      this._kern.set(faceId, m ? buildKerningMap(m) : new Map());
    }
    return this._kern.get(faceId);
  }

  // Single-line shaper mirroring layout.shapeLine but dynamic-aware.
  shapeLine(text, opts = {}) {
    const sizePx = opts.sizePx ?? 64;
    const tracking = opts.tracking ?? 0;
    const x0 = opts.x ?? 0;
    const y0 = opts.y ?? 0;
    const placements = [];
    let pen = 0;
    let prev = null;

    for (const ch of text) {
      const cp = ch.codePointAt(0);
      const faceId = this.faceFor(cp);
      const manifest = this.manifests.byId.get(faceId);
      const fixed = this.manifests.glyph(faceId, cp);

      if (prev && prev.faceId === faceId) {
        const k = this.kerning(faceId).get((prev.cp << 16) | cp);
        if (k != null) pen += k;
      }

      if (fixed && fixed.blank) {
        pen += fixed.advance + tracking;
        prev = { cp, faceId };
        continue;
      }

      if (fixed) {
        const g = fixed;
        const scale = sizePx / manifest.settings.texelsPerEm;
        placements.push({
          cp, faceId, atlas: 'fixed',
          x: x0 + pen * sizePx - g.ox * scale,
          y: y0 - g.oy * scale,
          w: g.w * scale, h: g.h * scale,
          u0: g.x, v0: g.y, du: g.w, dv: g.h,
          sizePx, advanceEm: g.advance, penPx: x0 + pen * sizePx,
          epoch: null, slotIndex: -1, placeholder: false, missing: false,
        });
        pen += g.advance + tracking;
        prev = { cp, faceId };
        continue;
      }

      // Outside the fixed atlases: go through the bounded runtime cache.
      // Font fallback: if the routed face has no on-demand source for this
      // codepoint but another face does, generate on that face instead. Only
      // when no face covers it do we land on the explicit placeholder.
      let faceForDynamic = faceId;
      if (!this.provider.hasGlyph(faceId, cp)) {
        const fallback = this._fallbackFace(faceId, cp);
        if (fallback) faceForDynamic = fallback;
      }
      const info = this.cache.request(faceForDynamic, cp, this.provider.generator);
      const settings = this.provider.settings;
      const scale = sizePx / settings.texelsPerEm;
      const penPx = x0 + pen * sizePx;

      if (info.state === 'resident' && !info.placeholder) {
        const slot = this.cache.slots.get(info.slotIndex);
        if (slot && slot.epoch === info.epoch && slot.tile) {
          const tile = slot.tile;
          const rect = this.glAtlas.cellRect(slot.index);
          placements.push({
            cp, faceId: faceForDynamic, atlas: 'dynamic',
            x: penPx - tile.ox * scale,
            y: y0 - tile.oy * scale,
            w: tile.width * scale, h: tile.height * scale,
            u0: rect.x, v0: rect.y, du: tile.width, dv: tile.height,
            sizePx, advanceEm: slot.advance, penPx,
            epoch: slot.epoch, slotIndex: slot.index,
            placeholder: false, missing: false, reason: null,
          });
          pen += slot.advance + tracking;
          prev = { cp, faceId: faceForDynamic };
          continue;
        }
        // Slot identity changed between request and shape: fall through to the
        // explicit placeholder rather than sampling a stale coordinate.
      }

      // Pending / missing / atlas-busy / invalidated: explicit placeholder.
      // Every placeholder samples the shared placeholder cell, so even a busy
      // identity that got no slot still renders a deliberate tofu rather than
      // another character's stale pixels.
      const ph = this.provider.buildPlaceholderTile();
      const tile = ph.tile;
      const phUV = this.glAtlas.placeholderUV() || { x: 0, y: 0 };
      placements.push({
        cp, faceId: faceForDynamic, atlas: 'placeholder',
        x: penPx - tile.ox * scale,
        y: y0 - tile.oy * scale,
        w: tile.width * scale, h: tile.height * scale,
        u0: phUV.x, v0: phUV.y,
        du: tile.width, dv: tile.height,
        sizePx, advanceEm: ph.advance, penPx,
        epoch: info.epoch, slotIndex: info.slotIndex,
        placeholder: true,
        missing: info.state === 'missing' || info.state === 'busy',
        reason: info.reason || info.error || null,
      });
      pen += ph.advance + tracking;
      prev = { cp, faceId: faceForDynamic };
    }

    return { placements, advancePx: pen * sizePx };
  }

  // Return a face that actually carries an on-demand source for the codepoint,
  // preferring the CJK face for non-Latin scripts. Null means no face covers
  // it, in which case the cache records an explicit missing/placeholder state.
  _fallbackFace(faceId, cp) {
    const candidates = faceId === 'cjk-regular'
      ? ['sans-book', 'sans-thin', 'sans-bold']
      : ['cjk-regular'];
    return candidates.find((id) => this.provider.hasGlyph(id, cp)) || null;
  }

  // Release per-frame references and roll the cache frame so LRU/eviction sees
  // a fresh reference set.
  endFrame() {
    this.cache.endFrame();
  }
}
