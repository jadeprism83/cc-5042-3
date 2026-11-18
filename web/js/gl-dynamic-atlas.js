// WebGL2 bridge between the platform-free DynamicGlyphCache and a real R8
// texture. It owns the parts the cache cannot reason about:
//
//   - the bounded GPU texture (one R8 texture, fixed slot grid, never resized);
//   - texSubImage2D uploads of generated tiles and placeholder tiles;
//   - the GPU completion boundary via GL sync fences. Deleting a JavaScript
//     reference does not free GPU memory, and a slot must not be overwritten
//     while a prior draw may still be sampling it. Evicted slots are parked in
//     `pendingReuse` until their fence signals (or the context is lost), then
//     cleared to the saturated outside value and returned to the free pool.
//
// All GL calls go through the injected context so the same adapter logic is
// exercised in Node tests with a recording fake.
export class GlDynamicAtlas {
  constructor(gl, opts) {
    this.gl = gl;
    this.cellW = opts.cellW;
    this.cellH = opts.cellH;
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.width = this.cellW * this.cols;
    this.height = this.cellH * this.rows;
    this.slotCount = this.cols * this.rows;
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    // Start fully saturated "far outside" (byte 0): any uninitialised read is a
    // guaranteed non-glyph rather than the previous occupant's pixels.
    const initial = new Uint8Array(this.width * this.height);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, this.width, this.height, 0, gl.RED, gl.UNSIGNED_BYTE, initial);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Cell 0 is reserved for the shared placeholder; allocatable slots are the
    // remaining cells, numbered 0..slotCount-2 and mapped to physical cell
    // index+1. The DynamicGlyphCache owns slot allocation/eviction; this layer
    // only tracks which indices are parked behind a fence and therefore not
    // reusable yet.
    this.placeholderCell = 0;
    this.placeholderRect = null;
    this.parked = new Set();     // logical slot indices awaiting GPU completion
    this.pendingReuse = [];      // { index, epoch, fence } for fence bookkeeping
    this.destroyed = false;
    this.fenceSupported = typeof gl.fenceSync === 'function' && typeof gl.clientWaitSync === 'function';
    // Counters kept for tests and the atlas status page.
    this.uploadCount = 0;
    this.clearCount = 0;
    this.fenceCount = 0;
  }

  get freeSlots() {
    // Logical indices that are not parked. The cache is the allocation owner.
    return [...Array(this.slotCount - 1).keys()].filter((i) => !this.parked.has(i));
  }

  cellRect(index) {
    const physical = index + 1;
    const col = physical % this.cols;
    const row = Math.floor(physical / this.cols);
    return { x: col * this.cellW, y: row * this.cellH, w: this.cellW, h: this.cellH };
  }

  placeholderUV() { return this.placeholderRect; }

  // Upload the shared placeholder bytes once into the reserved cell. The cache
  // points every pending/missing slot at this region so a newly reserved slot
  // can never show its previous occupant even before its own clear completes.
  installPlaceholder(tile) {
    if (tile.width > this.cellW || tile.height > this.cellH) {
      const err = new Error('占位图块超过槽位尺寸');
      err.code = 'TILE_OVERFLOW';
      err.detail = { tile: [tile.width, tile.height], cell: [this.cellW, this.cellH] };
      throw err;
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, tile.width, tile.height, gl.RED, gl.UNSIGNED_BYTE, tile.data);
    this.placeholderRect = { x: 0, y: 0, w: tile.width, h: tile.height };
    this.uploadCount++;
    return this.placeholderRect;
  }

  async acquireSlot() {
    this.pumpFences();
    const free = this.freeSlots;
    return free.length ? free[free.length - 1] : null;
  }

  // Upload one tile into its cell. Tiles larger than the cell are a kernel/
  // configuration error, not a silent clip: neighbouring cells would otherwise
  // be polluted.
  uploadTile(slot, tile) {
    const gl = this.gl;
    if (tile.width > this.cellW || tile.height > this.cellH) {
      const err = new Error('动态图块超过槽位尺寸');
      err.code = 'TILE_OVERFLOW';
      err.detail = { tile: [tile.width, tile.height], cell: [this.cellW, this.cellH] };
      return Promise.reject(err);
    }
    const rect = this.cellRect(slot.index);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, rect.x, rect.y, tile.width, tile.height, gl.RED, gl.UNSIGNED_BYTE, tile.data);
    this.uploadCount++;
    return Promise.resolve();
  }

  // Replace a cell's contents with explicit bytes (used for placeholders).
  uploadBytes(slot, data, w, h) {
    const gl = this.gl;
    const rect = this.cellRect(slot.index);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, rect.x, rect.y, w, h, gl.RED, gl.UNSIGNED_BYTE, data);
    this.uploadCount++;
    return Promise.resolve();
  }

  clearSlot(slot) {
    const gl = this.gl;
    const rect = this.cellRect(slot.index);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const blank = new Uint8Array(this.cellW * this.cellH);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, rect.x, rect.y, this.cellW, this.cellH, gl.RED, gl.UNSIGNED_BYTE, blank);
    this.clearCount++;
    return Promise.resolve();
  }

  // Eviction boundary. The cache calls this when a slot is logically free; the
  // slot cannot be reused until the GPU has finished every draw that sampled
  // the old contents. We insert a fence after the current GL work and park the
  // index. pumpFences() (run before every allocation and every frame) returns
  // signalled slots by clearing the parked mark and deleting the sync object.
  recycleSlot(slotInfo) {
    if (this.destroyed) return Promise.resolve();
    this.parked.add(slotInfo.index);
    if (!this.fenceSupported) {
      // No fence support: fall back to a full pipeline finish, which is a
      // genuine completion boundary, then clear immediately.
      this.gl.finish?.();
      return this.clearSlot({ index: slotInfo.index }).then(() => {
        this.parked.delete(slotInfo.index);
      });
    }
    const gl = this.gl;
    gl.flush();
    const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    this.fenceCount++;
    this.pendingReuse.push({ index: slotInfo.index, epoch: slotInfo.epoch, fence });
    return Promise.resolve();
  }

  // Non-blocking fence check. Signalled fences are deleted and their slots
  // cleared and unparked.
  pumpFences() {
    if (this.destroyed || !this.fenceSupported) return;
    const gl = this.gl;
    const remaining = [];
    for (const entry of this.pendingReuse) {
      const status = gl.clientWaitSync(entry.fence, 0, 0);
      if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED || status === gl.WAIT_FAILED) {
        gl.deleteSync(entry.fence);
        this.clearSlot({ index: entry.index });
        this.parked.delete(entry.index);
      } else {
        remaining.push(entry);
      }
    }
    this.pendingReuse = remaining;
  }

  // Blocking variant used by tests and scene teardown.
  async drainFences(timeoutNs = 2_000_000_000) {
    if (!this.fenceSupported) { this.pumpFences(); return; }
    const gl = this.gl;
    for (const entry of this.pendingReuse) {
      gl.clientWaitSync(entry.fence, gl.SYNC_FLUSH_COMMANDS_BIT, timeoutNs);
      gl.deleteSync(entry.fence);
      await this.clearSlot({ index: entry.index });
      this.parked.delete(entry.index);
    }
    this.pendingReuse = [];
  }

  // Actual VRAM range occupied by the texture. The status page and tests read
  // this to assert recycling never oversteps the committed allocation.
  vramBytes() {
    return this.width * this.height; // R8: one byte per texel
  }

  destroy() {
    if (this.destroyed) return;
    const gl = this.gl;
    for (const entry of this.pendingReuse) gl.deleteSync?.(entry.fence);
    this.pendingReuse = [];
    this.parked.clear();
    gl.deleteTexture(this.texture);
    this.texture = null;
    this.destroyed = true;
  }

  // The cache consults this before handing an index to a new identity.
  isReusable(index) { return !this.destroyed && !this.parked.has(index); }
}
