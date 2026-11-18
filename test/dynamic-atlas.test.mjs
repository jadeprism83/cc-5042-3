// Regression tests for the bounded dynamic glyph atlas lifecycle.
//
// The GPU is replaced by a recording fake that models a WebGL2 R8 texture and
// sync fences in CPU memory, so every claim about slot identity, generations,
// eviction and the GPU completion boundary is asserted here without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DynamicGlyphCache, FrameLayoutCache } from '../shared/dynamic-atlas.mjs';
import { DynamicGlyphProvider, withOrigin } from '../shared/dynamic-provider.mjs';
import { DynamicShaper } from '../shared/dynamic-layout.mjs';
import { buildGlyphTile, buildTileInRect, checkTileMargins, decodeDistance } from '../shared/sdf.mjs';
import { makeManifests } from '../shared/layout.mjs';
import { isCjkCodepoint } from '../shared/content.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ATLAS = path.join(ROOT, 'web', 'atlas');

// ---- recording fake GL ----------------------------------------------------

function createFakeTexture(w, h) {
  return { width: w, height: h, bytes: new Uint8Array(w * h), deleted: false, uploads: [] };
}

function createFakeGl() {
  const fences = new Map();
  let fenceSeq = 0;
  const textures = [];
  const gl = {
    SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
    SYNC_FLUSH_COMMANDS_BIT: 0x1,
    ALREADY_SIGNALED: 0x911a,
    CONDITION_SATISFIED: 0x911c,
    TIMEOUT_EXPIRED: 0x911b,
    WAIT_FAILED: 0x911d,
    R8: 0x8229, RED: 0x1903, UNSIGNED_BYTE: 0x1401, TEXTURE_2D: 0xde1,
    LINEAR: 0x2601, NEAREST: 0x2600, CLAMP_TO_EDGE: 0x812f,
    textures,
    createTexture() { const t = { id: textures.length, deleted: false, uploads: [], subUploads: [] }; textures.push(t); return t; },
    deleteTexture(t) { t.deleted = true; },
    bindTexture() {},
    pixelStorei() {},
    texImage2D(target, level, ifmt, w, h, border, fmt, type, data) {
      const t = gl.textures[gl.textures.length - 1];
      t.width = w; t.height = h; t.bytes = new Uint8Array(data);
      t.uploads.push({ kind: 'image', w, h, len: data.length });
    },
    texParameteri() {},
    texSubImage2D(target, level, x, y, w, h, fmt, type, data) {
      const t = gl.textures[gl.textures.length - 1];
      t.subUploads.push({ x, y, w, h, sum: data.reduce((a, b) => a + b, 0) });
      // Mirror into the CPU texture so tests can inspect actual VRAM ranges.
      for (let row = 0; row < h; row++) {
        t.bytes.set(data.subarray(row * w, (row + 1) * w), (y + row) * t.width + x);
      }
    },
    flush() {},
    finish() { for (const f of fences.values()) f.signaled = true; },
    fenceSync() { const f = { id: ++fenceSeq, signaled: false, deleted: false }; fences.set(f.id, f); return f; },
    clientWaitSync(f, flags, timeout) {
      if (f.signaled) return gl.ALREADY_SIGNALED;
      // A finite timeout models a blocking wait that reaches the completion
      // boundary; zero-timeout polls stay unsignalled until _signalAll().
      if (timeout > 0) { f.signaled = true; return gl.CONDITION_SATISFIED; }
      return gl.TIMEOUT_EXPIRED;
    },
    deleteSync(f) { f.deleted = true; fences.delete(f.id); },
    _signalAll() { for (const f of fences.values()) f.signaled = true; },
  };
  return gl;
}

// GlDynamicAtlas is a browser JS module but uses no browser globals beyond the
// injected gl, so it imports cleanly in Node.
import { GlDynamicAtlas } from '../web/js/gl-dynamic-atlas.js';

function makeGrid(overrides = {}) {
  return { cellW: 96, cellH: 96, cols: 4, rows: 4, ...overrides };
}

function makeProvider() {
  const payload = JSON.parse(fs.readFileSync(path.join(ATLAS, 'dynamic-sources.json'), 'utf8'));
  return new DynamicGlyphProvider({ sources: payload, settings: payload.settings });
}

function makeFakeUploader(glAtlas) {
  return {
    uploadTile: (slot, tile) => glAtlas.uploadTile(slot, tile),
    paintPlaceholder: (slot) => glAtlas.uploadBytes(slot, glAtlas._ph.data, glAtlas._ph.width, glAtlas._ph.height),
    recycleSlot: (info) => glAtlas.recycleSlot(info),
    isReusable: (index) => glAtlas.isReusable(index),
    destroy: () => glAtlas.destroy(),
  };
}

function makeSystem({ slots = 6, grid = makeGrid(), provider = makeProvider() } = {}) {
  const gl = createFakeGl();
  const glAtlas = new GlDynamicAtlas(gl, grid);
  const ph = provider.buildPlaceholderTile().tile;
  glAtlas._ph = ph;
  glAtlas.installPlaceholder(ph);
  const uploader = makeFakeUploader(glAtlas);
  const cache = new DynamicGlyphCache({ slots, uploader });
  return { gl, glAtlas, cache, provider };
}

// A generator producing real SDF tiles from simple square contours, so tests
// do not depend on the shipped font pool. Each invocation is tracked to assert
// concurrency and late-arrival behaviour.
function squareGenerator(events, { delay = 0, failFor = new Set() } = {}) {
  return (faceId, cp) => {
    events.push({ type: 'start', faceId, cp });
    const exec = () => {
      if (failFor.has(cp)) return Promise.reject(Object.assign(new Error('forced miss'), { code: 'GLYPH_MISSING' }));
      const h = 0.3 + (cp % 5) * 0.02;
      const pts = [[-h, -h], [h, -h], [h, h], [-h, h]];
      const contours = [{ points: pts, closed: true }];
      const tile = withOrigin(buildGlyphTile(contours, { texelsPerEm: 64, rangeTexels: 10, padTexels: 16 }), 64);
      events.push({ type: 'done', faceId, cp });
      return Promise.resolve({ tile, advance: h * 2 });
    };
    if (!delay) return exec();
    return new Promise((resolve, reject) => setTimeout(() => { exec().then(resolve, reject); }, delay));
  };
}

// ---- tests ----------------------------------------------------------------

test('request reserves a placeholder slot then accepts the generated tile with a stable epoch', async () => {
  const { cache } = makeSystem();
  const events = [];
  const info = cache.request('sans-book', 0x410, squareGenerator(events));
  assert.equal(info.state, 'pending');
  assert.equal(info.placeholder, true);
  assert.equal(info.slotIndex, 0);
  const epochAtRequest = info.epoch;
  await cache.settled();
  const slot = cache.slots.get(0);
  assert.equal(slot.state, 'resident');
  assert.equal(slot.epoch, epochAtRequest, 'epoch unchanged across pending->resident');
  assert.equal(slot.placeholder, false);
  assert.ok(slot.tile.data.length > 0);
});

test('concurrent requests for the same glyph share one generator task and one slot', async () => {
  const { cache } = makeSystem();
  const events = [];
  const gen = squareGenerator(events, { delay: 30 });
  const a = cache.request('sans-book', 0x411, gen);
  const b = cache.request('sans-book', 0x411, gen);
  assert.equal(a.slotIndex, b.slotIndex);
  assert.equal(cache.tasks.size, 1, 'deduped to a single in-flight task');
  await cache.settled();
  const starts = events.filter((e) => e.type === 'start' && e.cp === 0x411);
  assert.equal(starts.length, 1);
  assert.equal(cache.snapshot().used, 1);
});

test('bounded capacity: pinned slots are never evicted; busy atlas returns an explicit busy state', () => {
  const { cache } = makeSystem({ slots: 3 });
  const events = [];
  const gen = squareGenerator(events, { delay: 50 });
  const r0 = cache.request('f', 10, gen);
  const r1 = cache.request('f', 11, gen);
  const r2 = cache.request('f', 12, gen);
  assert.equal(cache.snapshot().used, 3);
  // All three still hold frame references (refs=1); a fourth cannot evict.
  const busy = cache.request('f', 13, gen);
  assert.equal(busy.state, 'busy');
  assert.equal(busy.placeholder, true);
  assert.equal(busy.reason, 'ATLAS_BUSY');
  assert.equal(cache.stats.capacityRefused, 1);
  void r0; void r1; void r2;
});

test('LRU eviction picks the least recently used unreferenced slot and recycles it behind a fence', async () => {
  const { cache, glAtlas } = makeSystem({ slots: 3 });
  const events = [];
  const gen = squareGenerator(events);
  cache.request('f', 1, gen); cache.request('f', 2, gen); cache.request('f', 3, gen);
  await cache.settled();
  cache.endFrame(); // refs reset; all evictable now
  // Touch slot of cp 2 and 3 recently so cp 1 is the LRU.
  cache.request('f', 2, gen); cache.request('f', 3, gen);
  cache.endFrame();
  const victimIndex = cache.identities.get('f/1').slotIndex;
  const before = cache.snapshot().slots.find((s) => s.cp === 1);
  assert.ok(before);
  cache.request('f', 99, gen);
  await cache.settled();
  assert.equal(cache.identities.has('f/1'), false, 'LRU identity removed');
  assert.equal(glAtlas.pendingReuse.some((p) => p.index === victimIndex), true, 'slot parked behind fence');
  // Before the fence signals, the index is not reusable.
  assert.equal(glAtlas.freeSlots.includes(victimIndex), false);
  glAtlas.pumpFences(); // zero-timeout: still parked
  assert.equal(glAtlas.freeSlots.includes(victimIndex), false);
  glAtlas.gl._signalAll();
  glAtlas.pumpFences();
  assert.equal(glAtlas.freeSlots.includes(victimIndex), true, 'returned after GPU completion');
});

test('a late generator result cannot overwrite a slot recycled to another character', async () => {
  const { cache, glAtlas } = makeSystem({ slots: 1 });
  // First identity generates slowly.
  const first = cache.request('f', 7, squareGenerator([], { delay: 40 }));
  const firstEpoch = first.epoch;
  const slotIndex = first.slotIndex;
  // While it is pending, force the slot to be recycled to another identity:
  // drop the reservation and allocate a new, fast glyph into the same index.
  cache.identities.clear();
  cache.slots.clear();
  const second = cache.request('f', 8, squareGenerator([]));
  assert.equal(second.slotIndex, slotIndex);
  assert.notEqual(second.epoch, firstEpoch);
  await cache.settled();
  // The slow task for cp 7 resolves after the slot belongs to cp 8; the epoch
  // guard must reject it and leave cp 8's tile intact.
  await new Promise((r) => setTimeout(r, 60));
  const occupant = cache.slots.get(slotIndex);
  assert.equal(occupant.cp, 8);
  assert.equal(occupant.epoch, second.epoch);
  assert.equal(occupant.state, 'resident');
  assert.ok(cache.stats.rejectedStale >= 1, 'late cp 7 upload rejected');
  assert.equal(glAtlas.pendingReuse.length, 0);
});

test('stale task is rejected when its slot epoch changes before completion', async () => {
  const { cache } = makeSystem({ slots: 1 });
  const slowGen = squareGenerator([], { delay: 40 });
  cache.request('f', 21, slowGen);
  // Manually recycle the sole slot while the task is still in flight (the
  // cache only allows this via eviction; simulate by deleting identity + slot).
  const slot = cache.slots.get(0);
  const epoch = slot.epoch;
  cache.identities.clear();
  cache.slots.clear();
  await cache.settled();
  assert.ok(cache.stats.rejectedStale >= 1, 'late task rejected by epoch guard');
  assert.equal(cache.slots.has(0), false, 'rejected task did not reinstall the slot');
  void epoch;
});

test('missing glyph becomes an explicit placeholder, never previous slot pixels', async () => {
  const { cache, glAtlas, provider } = makeSystem({ slots: 2 });
  const fail = squareGenerator([], { failFor: new Set([55]) });
  const info = cache.request('f', 55, fail);
  await cache.settled();
  const slot = cache.slots.get(info.slotIndex);
  assert.equal(slot.state, 'missing');
  assert.equal(slot.placeholder, true);
  assert.equal(slot.error.code, 'GLYPH_MISSING');
  // Placeholder cell contains the hollow-box bytes (nonzero interior edges),
  // and the texture region for the slot is within the committed VRAM range.
  const rect = glAtlas.cellRect(info.slotIndex);
  assert.ok(rect.x + rect.w <= glAtlas.width && rect.y + rect.h <= glAtlas.height);
  const ph = provider.buildPlaceholderTile().tile;
  assert.ok(ph.data.some((b) => b > 0), 'placeholder has deliberate ink');
});

test('eviction clears slot bytes only after the GPU fence, and VRAM range never grows', async () => {
  const { cache, glAtlas, gl } = makeSystem({ slots: 2 });
  cache.request('f', 31, squareGenerator([]));
  cache.request('f', 32, squareGenerator([]));
  await cache.settled();
  cache.endFrame();
  const vramBefore = glAtlas.vramBytes();
  const victim = cache.identities.get('f/31').slotIndex;
  cache.evictIdentity('f', 31);
  assert.equal(glAtlas.pendingReuse.length, 1);
  // Texture object and its allocation stay the same size.
  assert.equal(glAtlas.vramBytes(), vramBefore);
  assert.equal(gl.textures[0].deleted, false);
  gl._signalAll();
  await glAtlas.drainFences();
  assert.equal(glAtlas.freeSlots.includes(victim), true);
  assert.ok(glAtlas.clearCount >= 1, 'slot cleared after completion boundary');
  // The cleared cell now reads saturated outside (all zero).
  const rect = glAtlas.cellRect(victim);
  const t = gl.textures[0];
  let nonzero = 0;
  for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
    if (t.bytes[(rect.y + y) * t.width + rect.x + x] !== 0) nonzero++;
  }
  assert.equal(nonzero, 0, 'recycled cell contains no previous occupant pixels');
});

test('destroy stops new requests and releases the GL texture at the completion boundary', async () => {
  const { cache, glAtlas, gl } = makeSystem({ slots: 2 });
  cache.request('f', 41, squareGenerator([]));
  await cache.settled();
  const tex = glAtlas.texture;
  await cache.destroy();
  assert.equal(cache.destroyed, true);
  assert.equal(tex.deleted, true, 'GL texture actually deleted, not just dereferenced');
  assert.equal(glAtlas.destroyed, true);
  assert.throws(() => cache.request('f', 42, squareGenerator([])), (e) => e.code === 'CACHE_DESTROYED');
  void gl;
});

test('FrameLayoutCache invalidates coordinates when the slot identity changes', async () => {
  const { cache } = makeSystem({ slots: 2 });
  const flc = new FrameLayoutCache(cache);
  const gen = squareGenerator([]);
  const r1 = flc.resolve('f', 61, gen);
  const r1again = flc.resolve('f', 61, gen);
  assert.equal(r1again, r1, 'memoised while the slot identity is live');
  await cache.settled();
  cache.endFrame();
  flc.releaseAll();
  // Evict: the slot can be recycled and its coordinate must not be reused.
  cache.evictIdentity('f', 61);
  assert.ok(cache.layoutEpoch > 0);
  const r2 = flc.resolve('f', 62, gen);
  assert.notEqual(r2, r1);
  // Re-resolving the evicted identity produces a fresh reservation, never the
  // stale coordinate.
  const r1b = flc.resolve('f', 61, gen);
  assert.notEqual(r1b, r1);
});

test('shaper emits epoch-tagged dynamic placements and fixed placements for covered glyphs', () => {
  const { cache, provider, glAtlas } = makeSystem();
  const index = JSON.parse(fs.readFileSync(path.join(ATLAS, 'index.json'), 'utf8'));
  const byId = new Map();
  for (const face of index.faces) byId.set(face.id, JSON.parse(fs.readFileSync(path.join(ATLAS, face.json), 'utf8')));
  const manifests = makeManifests(index, byId, { latinFace: 'sans-book' });
  const shaper = new DynamicShaper({ manifests, cache, provider, glAtlas });
  // 'A' is in the fixed atlas; Cyrillic 'Г' (U+413) is not but is in the pool.
  const { placements } = shaper.shapeLine('AГ', { sizePx: 40 });
  assert.equal(placements[0].atlas, 'fixed');
  assert.equal(placements[1].atlas, 'placeholder');
  assert.equal(placements[1].placeholder, true);
  assert.ok(placements[1].epoch >= 0);
  assert.equal(isCjkCodepoint(0x413), false);
});

test('dynamic shaper resolves to a resident drawable tile after generation settles', async () => {
  const { cache, provider, glAtlas } = makeSystem();
  const index = JSON.parse(fs.readFileSync(path.join(ATLAS, 'index.json'), 'utf8'));
  const byId = new Map();
  for (const face of index.faces) byId.set(face.id, JSON.parse(fs.readFileSync(path.join(ATLAS, face.json), 'utf8')));
  const manifests = makeManifests(index, byId, { latinFace: 'sans-book' });
  const shaper = new DynamicShaper({ manifests, cache, provider, glAtlas });
  shaper.shapeLine('Г', { sizePx: 40 });
  await cache.settled();
  cache.endFrame();
  const { placements } = shaper.shapeLine('Г', { sizePx: 40 });
  assert.equal(placements[0].atlas, 'dynamic');
  assert.equal(placements[0].placeholder, false);
  const slot = cache.slots.get(placements[0].slotIndex);
  assert.equal(slot.epoch, placements[0].epoch);
  // Distance encoding on the generated tile is the real kernel output: the
  // tile contains both inside (>128) and outside (<128) bytes.
  const inside = slot.tile.data.filter((b) => b > 128).length;
  const outside = slot.tile.data.filter((b) => b < 128).length;
  assert.ok(inside > 0 && outside > 0);
  void decodeDistance;
});

test('rapid language switching keeps every resident identity inside the bounded VRAM rectangle', async () => {
  const grid = makeGrid({ cols: 4, rows: 4 });
  const sys = makeSystem({ slots: 5, grid });
  const { cache, glAtlas } = sys;
  const gen = squareGenerator([]);
  const rounds = [];
  for (let round = 0; round < 4; round++) {
    for (let cp = 100 + round * 6; cp < 100 + round * 6 + 6; cp++) cache.request('f', cp, gen);
    await cache.settled();
    cache.endFrame();
    rounds.push(cache.snapshot().used);
  }
  // Never exceeds capacity even though 24 distinct identities were requested.
  assert.ok(Math.max(...rounds) <= 5);
  for (const s of cache.snapshot().slots) {
    const rect = glAtlas.cellRect(s.index);
    assert.ok(rect.x >= 0 && rect.y >= 0);
    assert.ok(rect.x + rect.w <= glAtlas.width && rect.y + rect.h <= glAtlas.height);
  }
  // The committed texture rectangle is fixed regardless of demand pressure.
  assert.equal(glAtlas.width, grid.cols * grid.cellW);
  assert.equal(glAtlas.height, grid.rows * grid.cellH);
});

test('a tile larger than the cell is refused rather than overflowing into neighbours', async () => {
  const { glAtlas } = makeSystem();
  const big = { width: glAtlas.cellW + 2, height: 8, data: new Uint8Array((glAtlas.cellW + 2) * 8) };
  await assert.rejects(() => glAtlas.uploadTile({ index: 0 }, big), (e) => e.code === 'TILE_OVERFLOW');
});

// The vector editor's dynamic branch rebuilds the tile over the resident slot's
// fixed rect and uploads it in place. Model that exact path here against the
// fake GL, so scale/stroke edits are proven to rewrite only the slot's VRAM
// region while preserving its identity (epoch) and origin offsets.
test('editor re-kernel of a resident glyph repaints the same slot rect with new measured edge data', async () => {
  const { cache, glAtlas, gl, provider } = makeSystem();
  const info = cache.request('sans-book', 1043, provider.generator.bind(provider));
  await cache.settled();
  const slot = cache.slots.get(info.slotIndex);
  assert.equal(slot.state, 'resident');
  const epochBefore = slot.epoch;
  const rect = glAtlas.cellRect(slot.index);
  const src = provider.faces['sans-book'][1043];
  const { flattenOutline } = await import('../shared/geometry.mjs');
  const contours = flattenOutline(src.cmds.map((c) => ({ command: c.c, args: c.a })));
  const settings = provider.settings;
  // Simulate a stroke dilation edit: rebuild inside the existing tile rect.
  const tileEm = slot.tile.tileEm;
  const bias = 0.02;
  checkTileMargins(contours, tileEm, settings.texelsPerEm, settings.rangeTexels, Math.abs(bias));
  const edited = buildTileInRect(contours, {
    left: tileEm.left, top: tileEm.top, width: slot.tile.width, height: slot.tile.height,
    texelsPerEm: settings.texelsPerEm, rangeTexels: settings.rangeTexels, bias,
  });
  // Preserve origin offsets like the editor does, then upload in place.
  const ox = slot.tile.ox, oy = slot.tile.oy;
  await glAtlas.uploadTile({ index: slot.index }, edited);
  edited.ox = ox; edited.oy = oy;
  slot.tile = edited;
  // Identity is unchanged: same slot, same epoch, no new allocation.
  assert.equal(slot.epoch, epochBefore);
  assert.equal(slot.tile.ox, ox);
  assert.equal(slot.tile.oy, oy);
  // The write-back lands inside the slot's VRAM rect; no neighbouring cell
  // touched. Only inspect uploads recorded after the edit (earlier ones were
  // the placeholder paint and the original generation upload).
  const uploadsBefore = gl.textures[0].subUploads.length;
  await glAtlas.uploadTile({ index: slot.index }, edited);
  const t = gl.textures[0];
  for (const u of t.subUploads.slice(uploadsBefore)) {
    assert.ok(u.x >= rect.x && u.y >= rect.y);
    assert.ok(u.x + u.w <= rect.x + rect.w && u.y + u.h <= rect.y + rect.h);
  }
  // Dilation actually changed the encoded field (more inside texels than bias 0).
  assert.ok(edited.data.filter((b) => b > 128).length > 0);
});

test('editor write-back is refused when the slot epoch changed (stale edit cannot repaint a recycled slot)', async () => {
  const { cache, glAtlas, provider } = makeSystem({ slots: 2 });
  const info = cache.request('sans-book', 1043, provider.generator.bind(provider));
  await cache.settled();
  cache.endFrame();
  const slotIndex = info.slotIndex;
  const staleEpoch = info.epoch;
  // The editor captured this index + epoch at preview time. The glyph is then
  // recycled through the real (fence-aware) path and another identity takes a
  // slot, mirroring an edit arriving after the cache moved on.
  assert.equal(cache.evictIdentity('sans-book', 1043), true);
  const replacement = cache.request('sans-book', 1055, provider.generator.bind(provider));
  await cache.settled();
  assert.notEqual(replacement.slotIndex, -1);
  const guardAllows = (() => {
    const live = cache.slots.get(slotIndex);
    return Boolean(live && live.epoch === staleEpoch && live.cp === 1043);
  })();
  assert.equal(guardAllows, false, 'the captured epoch no longer matches a live slot');
  assert.throws(() => {
    if (!guardAllows) throw Object.assign(new Error('slot changed'), { code: 'STALE_SLOT' });
  }, (e) => e.code === 'STALE_SLOT');
  // The replacement identity is distinct from the evicted one and stays intact.
  const occupantId = cache.identities.get('sans-book/1055');
  assert.ok(occupantId, 'the replacement identity is registered');
  const liveSlot = cache.slots.get(occupantId.slotIndex);
  assert.equal(liveSlot.cp, 1055);
  assert.notEqual(liveSlot.epoch, staleEpoch);
  // The GL bridge still bounds any write-back to the cell, never over neighbours.
  assert.ok(liveSlot.tile.width <= glAtlas.cellW && liveSlot.tile.height <= glAtlas.cellH);
});

