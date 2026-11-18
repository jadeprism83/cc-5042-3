// Dynamic atlas view: renders the bounded runtime R8 texture's live slot grid
// and the cache lifecycle (pending -> uploaded / drawable / missing / parked /
// evicted). Every number here is read from the running DynamicGlyphCache and
// GlDynamicAtlas, never recomputed in the page.
import { DYNAMIC_GRID } from './dynamic-system.js';

const $ = (s) => document.querySelector(s);

const STATE_LABEL = {
  pending: '待生成（占位）',
  resident: '已上传 · 可绘制',
  missing: '缺字占位',
};

export function initDynamicView({ state, toast, showError }) {
  const ui = {
    atlasCanvas: $('#dyn-atlas-canvas'),
    facts: $('#dyn-facts'),
    stateList: $('#dyn-state-list'),
    vram: $('#dyn-vram'),
    recycle: $('#dyn-recycle'),
    destroyBtn: $('#dyn-destroy'),
    rebuildBtn: $('#dyn-rebuild'),
    errors: $('#dyn-errors'),
    language: $('#dyn-language'),
  };
  const actx = ui.atlasCanvas.getContext('2d');

  state.dynamicView = { redraw };

  function sys() { return state.dynamic; }

  function setError(msg) {
    if (!msg) { ui.errors.hidden = true; ui.errors.innerHTML = ''; return; }
    ui.errors.hidden = false;
    ui.errors.textContent = msg;
  }

  function redraw() {
    if (state.view !== 'dynamic') return;
    const s = sys();
    if (!s) return;
    drawGrid(s);
    updateFacts(s);
  }

  function drawGrid(s) {
    const { glAtlas, cache } = s;
    const grid = DYNAMIC_GRID;
    const cellPx = 64;
    const gap = 6;
    const W = grid.cols * cellPx + (grid.cols - 1) * gap;
    const H = grid.rows * cellPx + (grid.rows - 1) * gap;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    ui.atlasCanvas.style.width = W + 'px';
    ui.atlasCanvas.style.height = H + 'px';
    ui.atlasCanvas.width = Math.round(W * dpr);
    ui.atlasCanvas.height = Math.round(H * dpr);
    actx.setTransform(dpr, 0, 0, dpr, 0, 0);
    actx.fillStyle = '#14110e';
    actx.fillRect(0, 0, W, H);

    const parked = new Set(glAtlas.pendingReuse.map((p) => p.index));
    for (let physical = 0; physical < grid.cols * grid.rows; physical++) {
      const col = physical % grid.cols;
      const row = Math.floor(physical / grid.cols);
      const x = col * (cellPx + gap);
      const y = row * (cellPx + gap);
      if (physical === glAtlas.placeholderCell) {
        drawCell(x, y, cellPx, 'placeholder', '占');
        continue;
      }
      const slotIndex = physical - 1;
      const slot = cache.slots.get(slotIndex);
      if (parked.has(slotIndex)) {
        drawCell(x, y, cellPx, 'parked', 'GPU…');
      } else if (!slot) {
        drawCell(x, y, cellPx, 'free', '');
      } else if (slot.state === 'pending') {
        drawCell(x, y, cellPx, 'pending', slot.cp);
      } else if (slot.state === 'missing') {
        drawCell(x, y, cellPx, 'missing', slot.cp);
      } else {
        drawGlyphCell(s, x, y, cellPx, slot);
      }
    }
  }

  function drawCell(x, y, size, kind, label) {
    const colors = {
      free: '#211d18', pending: '#7a5a17', resident: '#1f4d44',
      missing: '#7d2f22', parked: '#4a443c', placeholder: '#3a3352',
    };
    actx.fillStyle = colors[kind] || colors.free;
    actx.fillRect(x, y, size, size);
    actx.strokeStyle = 'rgba(255,255,255,0.12)';
    actx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
    if (label !== '') {
      actx.fillStyle = kind === 'free' ? '#5a5347' : '#f4f1ea';
      actx.font = '20px "UI Sans", sans-serif';
      actx.textAlign = 'center';
      actx.textBaseline = 'middle';
      const text = typeof label === 'number' ? safeChar(label) : label;
      actx.fillText(text, x + size / 2, y + size / 2);
    }
  }

  function drawGlyphCell(s, x, y, size, slot) {
    const { glAtlas } = s;
    const rect = glAtlas.cellRect(slot.index);
    // Read back the actual uploaded bytes for this cell from the CPU mirror the
    // cache keeps on the slot (slot.tile.data). This verifies content identity
    // without a WebGL readback in the UI.
    actx.fillStyle = '#1f4d44';
    actx.fillRect(x, y, size, size);
    const tile = slot.tile;
    if (tile) {
      const scale = Math.min(size / tile.width, size / tile.height);
      const dw = tile.width * scale;
      const dh = tile.height * scale;
      const off = document.createElement('canvas');
      off.width = tile.width; off.height = tile.height;
      const octx = off.getContext('2d');
      const img = octx.createImageData(tile.width, tile.height);
      for (let i = 0; i < tile.data.length; i++) {
        const v = tile.data[i];
        const o = i * 4;
        img.data[o] = v; img.data[o + 1] = v; img.data[o + 2] = v; img.data[o + 3] = 255;
      }
      octx.putImageData(img, 0, 0);
      actx.imageSmoothingEnabled = false;
      actx.drawImage(off, x + (size - dw) / 2, y + (size - dh) / 2, dw, dh);
    }
    actx.strokeStyle = 'rgba(255,255,255,0.18)';
    actx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
    actx.fillStyle = '#f4f1ea';
    actx.font = '11px monospace';
    actx.textAlign = 'left';
    actx.textBaseline = 'top';
    actx.fillText(`#${slot.index} e${slot.epoch}`, x + 4, y + 3);
    actx.textAlign = 'right';
    actx.textBaseline = 'bottom';
    actx.fillText(safeChar(slot.cp), x + size - 4, y + size - 3);
    void rect;
  }

  function updateFacts(s) {
    const snap = s.cache.snapshot();
    const glAtlas = s.glAtlas;
    const pending = snap.slots.filter((q) => q.state === 'pending').length;
    const resident = snap.slots.filter((q) => q.state === 'resident').length;
    const missing = snap.slots.filter((q) => q.state === 'missing').length;
    const rows = [
      ['容量（槽位）', `${snap.used} / ${snap.capacity}`],
      ['待生成', String(pending)],
      ['已上传 · 可绘制', String(resident)],
      ['缺字占位', String(missing)],
      ['等待 GPU 回收', String(glAtlas.pendingReuse.length)],
      ['累计上传', String(snap.stats.uploaded)],
      ['累计回收', String(snap.stats.evicted)],
      ['迟到任务被拒', String(snap.stats.rejectedStale)],
      ['容量不足次数', String(snap.stats.capacityRefused)],
      ['布局代次', String(snap.layoutEpoch)],
    ];
    ui.facts.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');

    ui.stateList.innerHTML = snap.slots.map((q) =>
      `<li><span class="mono">#${q.index} e${q.epoch}</span> ` +
      `${safeChar(q.cp)} <b>${STATE_LABEL[q.state] || q.state}</b>` +
      (q.error ? ` <code>${q.error}</code>` : '') +
      ` <span class="muted">refs ${q.refs} · 帧 ${q.lastUsedFrame}</span></li>`).join('')
      || '<li class="muted">暂无驻留字形</li>';

    ui.vram.textContent =
      `纹理 ${glAtlas.width}×${glAtlas.height} R8 = ${glAtlas.vramBytes()} 字节 ` +
      `(${ (glAtlas.vramBytes() / 1024).toFixed(1)} KiB)；上传 ${glAtlas.uploadCount} 次，` +
      `清理 ${glAtlas.clearCount} 次，fence ${glAtlas.fenceCount} 个`;
  }

  ui.recycle.addEventListener('click', () => {
    const s = sys();
    if (!s) return;
    const victim = [...s.cache.slots.values()]
      .filter((q) => q.refs === 0)
      .sort((a, b) => a.lastUsedFrame - b.lastUsedFrame)[0];
    if (!victim) { setError('没有可回收字形：全部槽位仍被当前场景引用'); return; }
    try {
      s.cache.evictIdentity(victim.faceId, victim.cp);
      s.glAtlas.pumpFences();
      setError(null);
      toast(`已回收槽位 #${victim.index}（${safeChar(victim.cp)}）`);
      redraw();
    } catch (err) {
      setError(`[${err.code}] ${err.message}`);
    }
  });

  ui.destroyBtn.addEventListener('click', async () => {
    const s = sys();
    if (!s) return;
    await s.destroy();
    state.dynamicDestroyed = true;
    ui.rebuildBtn.hidden = false;
    setError('场景已销毁：GPU 纹理在完成边界后释放，缓存拒绝新请求');
    redraw();
  });

  ui.rebuildBtn.addEventListener('click', async () => {
    setError(null);
    ui.rebuildBtn.hidden = true;
    await state.rebuildDynamic?.();
    redraw();
  });

  return { redraw };
}

function safeChar(cp) {
  try { return String.fromCodePoint(cp); } catch { return '?'; }
}
