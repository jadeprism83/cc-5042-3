// Bounded runtime glyph atlas cache.
//
// The shipped atlases (web/atlas/*.r8) are fixed build-time products. When a
// tour string contains a codepoint those atlases do not cover, this cache
// generates its SDF tile at runtime through the *same* kernel
// (shared/sdf.mjs / geometry.mjs) and uploads it into one bounded GPU texture.
//
// Lifecycle rules enforced here:
//   - The atlas never grows past `slots` capacity. A full cache evicts LRU
//     entries, but only entries whose reference count is zero: glyphs still in
//     use by the current scene can never be evicted and therefore never have
//     their slot stolen by another character.
//   - Every slot and every glyph identity carries a generation (epoch). A slot
//     reused by another character gets a new epoch; a late generator result is
//     only accepted when its identity epoch still matches the slot's epoch.
//     Stale uploads can never overwrite a newer allocation.
//   - Layout caches hold the epoch they were resolved against and are
//     invalidated when it changes, so they can never keep dereferencing a
//     recycled coordinate.
//   - Pending and missing identities never point at a previous occupant's
//     pixels: they resolve to an explicit placeholder tile, and evicted slots
//     are cleared to the saturated "far outside" value before reuse.
//
// This module is GL-free: the host injects the GPU operations (upload/clear and
// the GPU completion boundary), so the whole lifecycle is unit-testable in Node
// with an in-memory fake.
import { kernelError } from './sdf.mjs';

export const SLOT_PENDING = 'pending';      // reserved, placeholder pixels only
export const SLOT_RESIDENT = 'resident';    // real glyph bytes uploaded
export const SLOT_MISSING = 'missing';      // font has no glyph; placeholder pixels

function dynError(code, message, detail = null) {
  return kernelError(code, message, detail);
}

// One cache per dynamic texture. `opts`:
//   slots       - fixed slot capacity (bounded; the texture never grows)
//   uploader    - host GPU bridge:
//       uploadTile(slot, tile)           -> Promise resolves after upload
//       clearSlot(slot)                  -> Promise resolves after slot clear
//       prepareReuse(slot)               -> Promise resolves once the GPU is
//                                           done with the slot's old contents
//   onChange    - optional callback fired on every state transition (UI/test)
export class DynamicGlyphCache {
  constructor({ slots, uploader, onChange = null }) {
    if (!Number.isInteger(slots) || slots < 1) {
      throw dynError('BAD_CAPACITY', '动态图集槽位数必须为正整数', { slots });
    }
    this.capacity = slots;
    this.uploader = uploader;
    this.onChange = onChange;
    // index -> slot record; absent indices are free (but may be queued for GPU
    // completion before they can be handed out again).
    this.slots = new Map();
    this.identities = new Map();   // `${faceId}/${cp}` -> identity record
    this.tasks = new Map();        // identity key -> in-flight generator task
    this.epochSeq = 0;
    this.frame = 0;
    this.layoutEpoch = 0;          // bumps whenever a published coordinate changes
    this.destroyed = false;
    this.stats = {
      requested: 0, generated: 0, uploaded: 0, evicted: 0, rejectedStale: 0,
      missing: 0, capacityRefused: 0,
    };
  }

  key(faceId, cp) { return `${faceId}/${cp}`; }

  // ---- shaping-side API -------------------------------------------------

  // Resolve one identity for the current frame. Never throws for a missing
  // glyph or a full atlas: those become explicit placeholder states. Returns
  // { state, slot, epoch, placeholder, reason } and starts an asynchronous
  // generation when no resident entry exists.
  request(faceId, cp, generator) {
    if (this.destroyed) throw dynError('CACHE_DESTROYED', '动态图集已销毁，不能再请求字形', { faceId, cp });
    this.stats.requested++;
    const key = this.key(faceId, cp);
    const known = this.identities.get(key);
    if (known) {
      const slot = this.slots.get(known.slotIndex);
      if (slot && slot.epoch === known.epoch) {
        slot.lastUsedFrame = this.frame;
        slot.refs++;
        return this._publish(known, slot);
      }
      // Identity record points at a recycled slot: drop it and re-resolve.
      this.identities.delete(key);
    }

    // No live identity. Reserve a slot first (placeholder content), then ask
    // the generator for the real tile. The reservation is what stops two
    // concurrent requests for the same glyph from taking two slots.
    const slotIndex = this._allocateIndex(faceId, cp);
    if (slotIndex == null) {
      this.stats.capacityRefused++;
      this._emit({ type: 'capacity-refused', faceId, cp, frame: this.frame });
      return { state: 'busy', placeholder: true, reason: 'ATLAS_BUSY', faceId, cp, epoch: -1, slotIndex: -1 };
    }

    const epoch = ++this.epochSeq;
    const slot = {
      index: slotIndex, epoch, faceId, cp,
      state: SLOT_PENDING, refs: 1, lastUsedFrame: this.frame,
      tile: null, placeholder: true,
    };
    this.slots.set(slotIndex, slot);
    const identity = { key, faceId, cp, slotIndex, epoch, state: SLOT_PENDING };
    this.identities.set(key, identity);
    this.layoutEpoch++;
    // Immediately paint the explicit placeholder into the slot. Until this
    // resolves the screen shows a deliberate tofu, never the recycled slot's
    // previous character.
    Promise.resolve(this.uploader.paintPlaceholder(slot)).catch((err) => {
      this._emit({ type: 'placeholder-error', slotIndex, epoch, error: err.message });
    });
    this._emit({ type: 'reserve', faceId, cp, slotIndex, epoch });

    // Dedup: concurrent requests for the same identity share one task.
    if (!this.tasks.has(key)) {
      const task = this._runGenerator(key, generator, { faceId, cp, epoch, slotIndex });
      this.tasks.set(key, task);
    }
    return this._publish(identity, slot);
  }

  // Frame-scoped references: the scene calls release() once per request() after
  // it has finished issuing draws. Entries with refs > 0 are pinned against
  // eviction for the frame.
  release(faceId, cp) {
    const identity = this.identities.get(this.key(faceId, cp));
    if (!identity) return;
    const slot = this.slots.get(identity.slotIndex);
    if (slot && slot.epoch === identity.epoch && slot.refs > 0) slot.refs--;
  }

  // Called by the scene between frames. References are per-frame counts, so
  // they reset; nothing in use during the frame is evictable until this runs.
  endFrame() {
    this.frame++;
    for (const slot of this.slots.values()) slot.refs = 0;
  }

  // ---- generation --------------------------------------------------------

  async _runGenerator(key, generator, ticket) {
    let result;
    try {
      result = await generator(ticket.faceId, ticket.cp);
    } catch (err) {
      result = { error: err };
    }
    if (this.destroyed) return;
    const slot = this.slots.get(ticket.slotIndex);
    // Identity/epoch guard: the slot may already have been recycled to another
    // character. A late task must never overwrite the newer occupant.
    if (!slot || slot.epoch !== ticket.epoch || slot.faceId !== ticket.faceId || slot.cp !== ticket.cp) {
      this.stats.rejectedStale++;
      this.tasks.delete(key);
      this._emit({ type: 'stale-rejected', faceId: ticket.faceId, cp: ticket.cp, slotIndex: ticket.slotIndex, epoch: ticket.epoch });
      return;
    }
    this.stats.generated++;
    if (!result || result.error || !result.tile) {
      await this._installMissing(slot, result?.error || dynError('GLYPH_MISSING', '字体中没有该字形', { faceId: ticket.faceId, cp: ticket.cp }));
    } else {
      await this._installResident(slot, result);
    }
    this.tasks.delete(key);
  }

  async _installResident(slot, result) {
    const { tile, advance } = result;
    try {
      await this.uploader.uploadTile(slot, tile);
    } catch (err) {
      await this._installMissing(slot, dynError('UPLOAD_FAILED', '字形上传 GPU 失败', { cause: err.message, faceId: slot.faceId, cp: slot.cp }));
      return;
    }
    if (this.destroyed) return;
    const still = this.slots.get(slot.index);
    // Re-check after the await: another state transition could in theory only
    // come from destroy(), but guard the epoch anyway.
    if (!still || still.epoch !== slot.epoch) {
      this.stats.rejectedStale++;
      return;
    }
    slot.state = SLOT_RESIDENT;
    slot.placeholder = false;
    slot.tile = tile;
    slot.advance = advance;
    const identity = this.identities.get(this.key(slot.faceId, slot.cp));
    if (identity) identity.state = SLOT_RESIDENT;
    this.layoutEpoch++;
    this.stats.uploaded++;
    this._emit({ type: 'uploaded', faceId: slot.faceId, cp: slot.cp, slotIndex: slot.index, epoch: slot.epoch });
  }

  async _installMissing(slot, error) {
    slot.state = SLOT_MISSING;
    slot.placeholder = true;
    slot.error = error;
    const identity = this.identities.get(this.key(slot.faceId, slot.cp));
    if (identity) identity.state = SLOT_MISSING;
    this.stats.missing++;
    this.layoutEpoch++;
    this._emit({ type: 'missing', faceId: slot.faceId, cp: slot.cp, slotIndex: slot.index, epoch: slot.epoch, error: error.code });
  }

  // ---- allocation / eviction --------------------------------------------

  _allocateIndex(faceId, cp) {
    const reusable = (i) => (this.uploader.isReusable ? this.uploader.isReusable(i) : true);
    for (let i = 0; i < this.capacity; i++) {
      if (!this.slots.has(i) && reusable(i)) return i;
    }
    // Full: evict the least recently used, unreferenced entry. Pinned entries
    // (refs > 0, i.e. glyphs the current scene is still drawing) are skipped.
    const victim = [...this.slots.values()]
      .filter((s) => s.refs === 0)
      .sort((a, b) => (a.lastUsedFrame - b.lastUsedFrame) || (a.epoch - b.epoch))[0];
    if (!victim) return null;
    this._evict(victim);
    // The evicted index is parked behind a GPU fence and therefore not yet
    // reusable; find another free index, otherwise report a busy atlas.
    for (let i = 0; i < this.capacity; i++) {
      if (!this.slots.has(i) && reusable(i)) return i;
    }
    return null;
  }

  _evict(slot) {
    const key = this.key(slot.faceId, slot.cp);
    // A still-running generator for this identity must not resurrect into the
    // recycled slot: its epoch check will fail once the slot gets a new epoch.
    this.identities.delete(key);
    this.slots.delete(slot.index);
    this.stats.evicted++;
    this.layoutEpoch++;
    this._emit({ type: 'evict', faceId: slot.faceId, cp: slot.cp, slotIndex: slot.index, epoch: slot.epoch });
    // Hand the now-logically-free index to the host. The host parks it until
    // the GPU completion boundary (fence) allows reuse, then clears it. The
    // index stays absent from this.slots while parked.
    this.uploader.recycleSlot({ index: slot.index, epoch: slot.epoch }).catch((err) => {
      this._emit({ type: 'recycle-error', slotIndex: slot.index, error: err.message });
    });
  }

  // Explicit eviction used by the UI "recycle" control and by tests.
  evictIdentity(faceId, cp) {
    const identity = this.identities.get(this.key(faceId, cp));
    if (!identity) return false;
    const slot = this.slots.get(identity.slotIndex);
    if (!slot || slot.epoch !== identity.epoch) {
      this.identities.delete(this.key(faceId, cp));
      return false;
    }
    if (slot.refs > 0) {
      throw dynError('GLYP_PINNED', '该字形仍被当前场景引用，不能回收', { faceId, cp, refs: slot.refs });
    }
    this._evict(slot);
    return true;
  }

  // ---- introspection -----------------------------------------------------

  _publish(identity, slot) {
    return {
      state: slot.state,
      placeholder: slot.placeholder,
      slotIndex: slot.index,
      epoch: slot.epoch,
      faceId: identity.faceId,
      cp: identity.cp,
      advance: slot.advance ?? null,
      error: slot.error ? slot.error.code : null,
    };
  }

  snapshot() {
    return {
      capacity: this.capacity,
      used: this.slots.size,
      frame: this.frame,
      layoutEpoch: this.layoutEpoch,
      stats: { ...this.stats },
      slots: [...this.slots.values()].map((s) => ({
        index: s.index, epoch: s.epoch, faceId: s.faceId, cp: s.cp,
        state: s.state, placeholder: s.placeholder, refs: s.refs,
        lastUsedFrame: s.lastUsedFrame,
        char: safeChar(s.cp), error: s.error ? s.error.code : null,
      })),
      tasks: [...this.tasks.keys()],
    };
  }

  // Await all generator tasks currently queued. Tests and the UI use this to
  // observe the pending -> uploaded transition deterministically.
  async settled() {
    while (this.tasks.size) {
      await Promise.all([...this.tasks.values()]);
    }
  }

  _emit(event) {
    if (this.onChange) {
      try { this.onChange(event); } catch { /* UI callbacks must not break the cache */ }
    }
  }

  // ---- teardown ----------------------------------------------------------

  // Scene destruction: no new requests are accepted, all identities are
  // dropped, and the host is asked to release the GPU texture once in-flight
  // work reaches its completion boundary.
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    const indices = [...this.slots.keys()];
    this.identities.clear();
    this.tasks.clear();
    this.slots.clear();
    this.layoutEpoch++;
    this._emit({ type: 'destroy', indices });
    return this.uploader.destroy?.();
  }
}

function safeChar(cp) {
  try { return String.fromCodePoint(cp); } catch { return '?'; }
}

// Frame-scoped layout cache. The layout engine asks for a glyph resolution once
// per frame per identity; this memo keeps the answer (including placeholder
// states) for the frame and validates every entry against the cache's
// layoutEpoch, so a recycled coordinate can never survive into a later frame.
export class FrameLayoutCache {
  constructor(glyphCache) {
    this.glyphCache = glyphCache;
    this.entries = new Map();
  }

  resolve(faceId, cp, generator) {
    const key = this.glyphCache.key(faceId, cp);
    const cached = this.entries.get(key);
    // Reuse the memo only while the underlying slot identity is still live.
    // A recycled slot gets a new epoch, which invalidates the cached coordinate
    // even within the same frame.
    if (cached) {
      const identity = this.glyphCache.identities.get(key);
      const slot = identity && this.glyphCache.slots.get(identity.slotIndex);
      if (slot && slot.epoch === cached.epoch) return cached;
      this.entries.delete(key);
    }
    const entry = this.glyphCache.request(faceId, cp, generator);
    entry.key = key;
    this.entries.set(key, entry);
    return entry;
  }

  // Release every request this frame made (refs were counted on the cache).
  releaseAll() {
    for (const entry of this.entries.values()) {
      if (entry.slotIndex >= 0) this.glyphCache.release(entry.faceId, entry.cp);
    }
    this.entries.clear();
  }
}
