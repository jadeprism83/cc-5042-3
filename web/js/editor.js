// Vector glyph editor. The canvas shows the outline as a vector path with
// draggable control points (and an outline-overlay stroke). Every change runs
// the real atlas kernel (shared/atlas-build.mjs buildGlyphTile) over the edited
// contours; the resulting distance field is drawn in the result area and, on
// commit, uploaded into the live GPU atlas in place.
//
// Failure feedback is returned to the kernel: if the edit would leave
// insufficient saturated margin (PAD_BREACH) or exceeds the encoding range, the
// kernel raises an error with a code, which is shown in the editor and the
// commit is refused.
import { flattenOutline } from '../../shared/geometry.mjs';
import {
  buildTileInRect, checkTileMargins, decodeDistance, coverageFromPixels, extractIsoPolylines,
  ENCODE_NEUTRAL,
} from '../../shared/sdf.mjs';

const $ = (s) => document.querySelector(s);

export function initEditor({ state, toast, showError }) {
  const canvas = $('#editor-canvas');
  const resultCanvas = $('#editor-result');
  const ctx = canvas.getContext('2d');
  const rctx = resultCanvas.getContext('2d');
  const ui = {
    glyph: $('#glyph-select'), sx: $('#scale-x'), sy: $('#scale-y'), stroke: $('#stroke'),
    sxOut: $('#scale-x-out'), syOut: $('#scale-y-out'), strokeOut: $('#stroke-out'),
    reset: $('#reset-glyph'), commit: $('#commit-glyph'), facts: $('#editor-facts'), errors: $('#editor-errors'),
    hint: $('#editor-hint'),
  };

  const ed = {
    faceId: 'sans-book',
    glyphs: [],           // [{cp, glyphId, cmds, contours, advance}]
    index: 0,
    scale: { x: 1, y: 1 },
    strokeEm: 0,
    view: { zoom: 1, panX: 0, panY: 0 },
    drag: null,
    preview: null,        // {tile, contours, ms}
    dirty: false,
  };
  state.editor = { redraw, get ed() { return ed; }, commit };

  let outlines = state.outlines || null;

  function buildGlyphList() {
    const face = ed.faceId;
    const faceOutlines = outlines.faces[face] || {};
    const manifest = state.manifests.byId.get(face);
    const list = [];
    for (const [cpStr, g] of Object.entries(manifest.glyphs)) {
      const cp = Number(cpStr);
      // Focus on glyphs with curves / interesting thin parts.
      if (!faceOutlines[cp]) continue;
      list.push({ cp, glyphId: g.glyphId });
    }
    list.sort((a, b) => a.cp - b.cp);
    ed.glyphs = list;
    ui.glyph.innerHTML = list.map((g, i) => {
      const ch = String.fromCodePoint(g.cp);
      const label = g.cp > 0x3000 ? ch : `${ch}  (U+${g.cp.toString(16).toUpperCase()})`;
      return `<option value="${i}">${label}</option>`;
    }).join('');
    // Choose a glyph with curves (e.g. 'a' 0x61, 'W' 0x57) if present.
    const prefer = [0x61, 0x57, 0x52, 0x40, 0x26];
    let idx = list.findIndex((g) => prefer.includes(g.cp));
    if (idx < 0) idx = 0;
    ed.index = idx;
    ui.glyph.value = String(idx);
  }

  function currentGlyphs() {
    const meta = ed.glyphs[ed.index];
    if (!meta) return null;
    const entry = outlines.faces[ed.faceId][meta.cp];
    if (!entry) return null;
    // Cache the flattened base contours per glyph.
    if (!entry._contours) {
      entry._contours = flattenOutline(entry.cmds.map((c) => ({ command: c.c, args: c.a })), 0.0015);
    }
    return { meta, entry };
  }

  function transformedContours(base) {
    const { x: sx, y: sy } = ed.scale;
    return base.map((c) => ({ points: c.points.map(([x, y]) => [x * sx, y * sy]), closed: true }));
  }

  // ---- kernel call ----
  function runKernel(reason) {
    const cur = currentGlyphs();
    if (!cur) { ed.preview = null; return null; }
    const manifest = state.manifests.byId.get(ed.faceId);
    const g = manifest.glyphs[cur.meta.cp];
    const contours = transformedContours(cur.entry._contours);
    const t0 = performance.now();
    try {
      // The tile rect is fixed to the published one: the editor may not move a
      // glyph's tile, only change its contents. So we build over that rect and
      // check margins against it.
      const tileEm = { left: g.left, top: g.top, width: g.tileEmW, height: g.tileEmH };
      const width = g.w, height = g.h;
      const bias = ed.strokeEm;
      // Margin check first: the transformed ink (plus stroke) must stay inside
      // the fixed tile with a saturated border.
      const margins = checkTileMargins(contours, tileEm, manifest.settings.texelsPerEm, manifest.settings.rangeTexels, Math.abs(bias));
      const tile = buildTileInRect(contours, {
        left: tileEm.left, top: tileEm.top, width, height,
        texelsPerEm: manifest.settings.texelsPerEm,
        rangeTexels: manifest.settings.rangeTexels,
        bias,
      });
      const ms = performance.now() - t0;
      ed.preview = { tile, contours, ms, margins, glyph: g, manifest };
      setErrors([]);
      ed.dirty = true;
      return ed.preview;
    } catch (err) {
      ed.preview = null;
      ed.dirty = true;
      setErrors([{ code: err.code || 'KERNEL', message: err.message, detail: err.detail }]);
      return null;
    }
  }

  function setErrors(list) {
    if (!list.length) { ui.errors.hidden = true; ui.errors.innerHTML = ''; return; }
    ui.errors.hidden = false;
    ui.errors.innerHTML = list.map((e) =>
      `<div><b>${e.code}</b> ${escapeHtml(e.message)}</div>` +
      (e.detail ? `<div style="margin-top:4px"><code>${escapeHtml(JSON.stringify(e.detail))}</code></div>` : '')).join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---- drawing ----
  function redraw() {
    if (state.view !== 'editor') return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 10) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const cur = currentGlyphs();
    if (!cur) return;
    const manifest = state.manifests.byId.get(ed.faceId);
    const g = manifest.glyphs[cur.meta.cp];
    const contours = transformedContours(cur.entry._contours);
    const preview = ed.preview;

    // Fit the glyph tile to the canvas with room for handles.
    const pad = 70;
    const fit = Math.min((rect.width - pad * 2) / g.tileEmW, (rect.height - pad * 2) / g.tileEmH);
    const zoom = fit * ed.view.zoom;
    // Place the tile's own centre at the canvas centre. The tile spans em
    // [left, left+width] and [top-height, top], which is not centred on the pen
    // origin for glyphs with side bearings, so centring on the origin shifts
    // the glyph visibly off-centre.
    const tileCenterX = g.left + g.tileEmW / 2;
    const tileCenterY = g.top - g.tileEmH / 2;
    const originX = rect.width / 2 + ed.view.panX - tileCenterX * zoom;
    const originY = rect.height / 2 + ed.view.panY + tileCenterY * zoom;
    const tileLeftPx = originX + g.left * zoom;
    const tileTopPx = originY - g.top * zoom;
    ed._xform = { zoom, originX, originY, tileLeftPx, tileTopPx, g };
    const toScreen = (x, y) => [originX + x * zoom, originY - y * zoom];

    // tile bounds
    ctx.save();
    ctx.strokeStyle = '#3a3f46';
    ctx.lineWidth = 1;
    ctx.strokeRect(tileLeftPx, tileTopPx, g.tileEmW * zoom, g.tileEmH * zoom);
    // pad band (saturated margin)
    const padEm = manifest.settings.padTexels / manifest.settings.texelsPerEm;
    ctx.strokeStyle = '#2a2f36';
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(tileLeftPx + padEm * zoom, tileTopPx + padEm * zoom, (g.tileEmW - padEm * 2) * zoom, (g.tileEmH - padEm * 2) * zoom);
    ctx.setLineDash([]);
    // baseline + origin
    ctx.strokeStyle = '#404650';
    ctx.beginPath();
    ctx.moveTo(tileLeftPx, originY); ctx.lineTo(tileLeftPx + g.tileEmW * zoom, originY);
    ctx.moveTo(originX, tileTopPx); ctx.lineTo(originX, tileTopPx + g.tileEmH * zoom);
    ctx.stroke();
    ctx.restore();

    // Ink fill of the transformed outline.
    ctx.beginPath();
    for (const c of contours) {
      const p0 = toScreen(c.points[0][0], c.points[0][1]);
      ctx.moveTo(p0[0], p0[1]);
      for (let i = 1; i < c.points.length; i++) { const p = toScreen(c.points[i][0], c.points[i][1]); ctx.lineTo(p[0], p[1]); }
      ctx.closePath();
    }
    ctx.fillStyle = 'rgba(217,160,91,0.10)';
    ctx.fill('nonzero');

    // Outline stroke (this is the "vector editor" reference edge).
    ctx.beginPath();
    for (const c of contours) {
      const p0 = toScreen(c.points[0][0], c.points[0][1]);
      ctx.moveTo(p0[0], p0[1]);
      for (let i = 1; i < c.points.length; i++) { const p = toScreen(c.points[i][0], c.points[i][1]); ctx.lineTo(p[0], p[1]); }
      ctx.closePath();
    }
    ctx.strokeStyle = '#d9a05b';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // Stroke offset visual: the SDF iso-contour at -strokeEm (if nonzero) is
    // drawn in the result area; here show a dashed guide ring around handles.

    // Control points: the original curve/line endpoints, mapped through the
    // glyph transform. Flattened points are not shown: hundreds of handles
    // would be noise, and the flattening points are not editable.
    ed._handles = [];
    const cmds = cur.entry._editedCmds || cur.entry.cmds;
    let lastMove = [0, 0];
    for (const c of cmds) {
      let end = null;
      if (c.c === 'moveTo') { lastMove = [c.a[0], c.a[1]]; }
      else if (c.c === 'lineTo') end = [c.a[0], c.a[1]];
      else if (c.c === 'quadraticCurveTo') end = [c.a[2], c.a[3]];
      else if (c.c === 'bezierCurveTo') end = [c.a[4], c.a[5]];
      else if (c.c === 'closePath') end = [lastMove[0], lastMove[1]];
      if (end && (c.c === 'lineTo' || c.c === 'quadraticCurveTo' || c.c === 'bezierCurveTo')) {
        ed._handles.push({ cmd: c, x: end[0] * ed.scale.x, y: end[1] * ed.scale.y });
      }
    }
    for (const h of ed._handles) {
      const [sx, sy] = toScreen(h.x, h.y);
      ctx.beginPath();
      ctx.rect(sx - 3.2, sy - 3.2, 6.4, 6.4);
      ctx.fillStyle = '#f4f1ea';
      ctx.fill();
      ctx.strokeStyle = '#0f0e0d';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Result area: the actual distance field, thresholded, plus iso-contour of
    // the stroke offset.
    drawResult(g, preview, manifest);
    updateFacts(g, preview, manifest);
    ui.hint.textContent = `拖拽控制点移动；滚轮缩放；右键拖拽平移。图块固定，改动只重算场内像素。`;
  }

  function drawResult(g, preview, manifest) {
    const rect = resultCanvas.getBoundingClientRect();
    if (rect.width < 10) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    resultCanvas.width = Math.round(rect.width * dpr);
    resultCanvas.height = Math.round(rect.height * dpr);
    rctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    rctx.fillStyle = '#0d0c0b';
    rctx.fillRect(0, 0, rect.width, rect.height);
    const empty = $('#editor-result-empty');
    if (!preview) {
      if (empty) { empty.hidden = false; empty.textContent = '无有效结果 — 见下方内核错误'; }
      return;
    }
    const { tile } = preview;
    // An erosion larger than the glyph's maximum inscribed radius removes it
    // entirely; the kernel result is correct but indistinguishable from a
    // failure on screen, so name the cause and the limit.
    const hollow = !tile.data.some((b) => b > ENCODE_NEUTRAL);
    if (empty) {
      empty.hidden = !hollow;
      if (hollow) {
        const insetEm = tile.stats.maxDistanceEm - tile.bias;
        empty.textContent = `描边后无实心区域 — 此字最大内接半径 ${insetEm.toFixed(3)} em，侵蚀超过它会把字形整个去掉`;
      }
    }
    // Preview at a fixed size derived from the result area (e.g. 72 px).
    const pxSize = Math.min(rect.height - 30, 96);
    const scale = pxSize / manifest.settings.texelsPerEm;
    const W = tile.width, H = tile.height;
    const off = document.createElement('canvas');
    off.width = W; off.height = H;
    const octx = off.getContext('2d');
    const img = octx.createImageData(W, H);
    for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
      const byte = tile.data[py * W + px];
      const dPx = (decodeDistance(byte, manifest.settings.rangeTexels) / manifest.settings.texelsPerEm) * pxSize;
      const a = Math.round(coverageFromPixels(dPx, 1) * 255);
      const o = (py * W + px) * 4;
      img.data[o] = 239; img.data[o + 1] = 231; img.data[o + 2] = 215; img.data[o + 3] = a;
    }
    octx.putImageData(img, 0, 0);
    const drawW = W * scale, drawH = H * scale;
    const dx = (rect.width - drawW) / 2;
    const dy = (rect.height - drawH) / 2;
    rctx.imageSmoothingEnabled = false;
    rctx.drawImage(off, dx, dy, drawW, drawH);

    // Overlay the zero iso-contour of the *edited* field in the stroke colour.
    // When a stroke bias is applied, the encoded neutral byte (128) sits on the
    // dilated/eroded edge, not on the original outline, so this ring is the
    // actual edge the GPU will show after committing.
    const iso = extractIsoPolylines(tile, 128);
    if (iso.length) {
      rctx.save();
      rctx.strokeStyle = '#d9a05b';
      rctx.lineWidth = 1;
      rctx.beginPath();
      for (const [a, b] of iso) {
        rctx.moveTo(dx + a[0] * scale, dy + a[1] * scale);
        rctx.lineTo(dx + b[0] * scale, dy + b[1] * scale);
      }
      rctx.stroke();
      rctx.restore();
    }
  }

  function updateFacts(g, preview, manifest) {
    const rows = [
      ['字形', `${String.fromCodePoint(g.cp)} U+${g.cp.toString(16).toUpperCase()}`],
      ['读数', `${manifest.settings.texelsPerEm} texel/em · ±${manifest.settings.rangeTexels}`],
      ['缩放', `${ed.scale.x.toFixed(2)} × ${ed.scale.y.toFixed(2)}`],
      ['描边', `${ed.strokeEm >= 0 ? '+' : ''}${ed.strokeEm.toFixed(3)} em`],
      ['内核耗时', preview ? `${preview.ms.toFixed(1)} ms` : '—'],
      ['描边后边距', preview ? `${Math.min(preview.margins.left, preview.margins.right, preview.margins.top, preview.margins.bottom).toFixed(3)} em` : '—'],
      ['状态', !preview ? '内核拒绝，未提交' : ed.dirty ? '已改，未提交' : '与图集一致'],
    ];
    ui.facts.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  }

  // ---- interaction ----
  function pickHandle(mx, my) {
    if (!ed._handles) return -1;
    for (let i = ed._handles.length - 1; i >= 0; i--) {
      const h = ed._handles[i];
      const { zoom, originX, originY } = ed._xform;
      const sx = originX + h.x * zoom, sy = originY - h.y * zoom;
      if (Math.hypot(mx - sx, my - sy) < 9) return i;
    }
    return -1;
  }

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    if (e.button === 2) {
      ed.drag = { type: 'pan', start: [mx, my], panX: ed.view.panX, panY: ed.view.panY };
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    const idx = pickHandle(mx, my);
    if (idx >= 0) {
      ed.drag = { type: 'handle', idx };
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = 'grabbing';
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!ed.drag) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    if (ed.drag.type === 'pan') {
      ed.view.panX = ed.drag.panX + (mx - ed.drag.start[0]);
      ed.view.panY = ed.drag.panY + (my - ed.drag.start[1]);
      redraw();
      return;
    }
    if (ed.drag.type === 'handle') {
      const h = ed._handles[ed.drag.idx];
      const { zoom, originX, originY } = ed._xform;
      const emX = (mx - originX) / zoom;
      const emY = (originY - my) / zoom;
      // The handle's drawn position includes the current glyph scale; convert
      // the pointer back to unscaled glyph space before editing the command.
      const dxUnscaled = emX / ed.scale.x - h.x / ed.scale.x;
      const dyUnscaled = emY / ed.scale.y - h.y / ed.scale.y;
      const cur = currentGlyphs();
      const entry = cur.entry;
      if (!entry._editedCmds) entry._editedCmds = entry.cmds.map((c) => ({ c: c.c, a: c.a.slice() }));
      const ec = entry._editedCmds;
      // Identify the command by object identity where possible, else by value.
      let idx = ec.indexOf(h.cmd);
      if (idx < 0) idx = ec.findIndex((c) => c.c === h.cmd.c && c.a.every((v, i) => Math.abs(v - h.cmd.a[i]) < 1e-6));
      if (idx >= 0) {
        const c = ec[idx];
        if (c.c === 'lineTo') { c.a[0] += dxUnscaled; c.a[1] += dyUnscaled; }
        else if (c.c === 'quadraticCurveTo') { c.a[2] += dxUnscaled; c.a[3] += dyUnscaled; }
        else if (c.c === 'bezierCurveTo') { c.a[4] += dxUnscaled; c.a[5] += dyUnscaled; }
        entry._contours = flattenOutline(ec.map((cc) => ({ command: cc.c, args: cc.a })), 0.0015);
        ed.dirty = true;
        scheduleKernel();
        redraw();
      }
    }
  });
  const endDrag = () => { ed.drag = null; canvas.style.cursor = 'grab'; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    ed.view.zoom = Math.min(6, Math.max(0.4, ed.view.zoom * (e.deltaY > 0 ? 0.92 : 1.08)));
    redraw();
  }, { passive: false });

  let kernelTimer = null;
  function scheduleKernel() {
    clearTimeout(kernelTimer);
    kernelTimer = setTimeout(() => { runKernel('drag'); redraw(); }, 40);
  }

  // ---- controls ----
  function syncControls() {
    ui.sxOut.textContent = ed.scale.x.toFixed(2);
    ui.syOut.textContent = ed.scale.y.toFixed(2);
    ui.strokeOut.textContent = `${ed.strokeEm >= 0 ? '+' : ''}${ed.strokeEm.toFixed(3)} em`;
  }
  ui.sx.addEventListener('input', () => { ed.scale.x = Number(ui.sx.value); syncControls(); runKernel('scale'); redraw(); });
  ui.sy.addEventListener('input', () => { ed.scale.y = Number(ui.sy.value); syncControls(); runKernel('scale'); redraw(); });
  ui.stroke.addEventListener('input', () => { ed.strokeEm = Number(ui.stroke.value); syncControls(); runKernel('stroke'); redraw(); });
  ui.glyph.addEventListener('change', () => {
    ed.index = Number(ui.glyph.value);
    ed.scale = { x: 1, y: 1 };
    ed.strokeEm = 0;
    ui.sx.value = '1'; ui.sy.value = '1'; ui.stroke.value = '0';
    syncControls();
    const entry = currentGlyphs();
    if (entry) entry.entry._editedCmds = null;
    runKernel('select');
    redraw();
  });
  ui.reset.addEventListener('click', () => {
    const cur = currentGlyphs();
    if (cur) { cur.entry._editedCmds = null; cur.entry._contours = flattenOutline(cur.entry.cmds.map((c) => ({ command: c.c, args: c.a })), 0.0015); }
    ed.scale = { x: 1, y: 1 };
    ed.strokeEm = 0;
    ui.sx.value = '1'; ui.sy.value = '1'; ui.stroke.value = '0';
    syncControls();
    ed.dirty = false;
    setErrors([]);
    runKernel('reset');
    redraw();
  });
  ui.commit.addEventListener('click', () => commit());

  function commit() {
    const preview = ed.preview || runKernel('commit');
    if (!preview) { toast('提交被拒绝：请先修正图块边距', 'error'); return; }
    const { tile, glyph, manifest } = preview;
    // In-place upload of the tile's pixel rect. The tile's position did not
    // change, so the atlas and every existing instanced draw stays valid.
    try {
      state.renderer.updateAtlasRect(manifest.face, glyph.x, glyph.y, tile.width, tile.height, tile.data);
      // Keep the CPU-side payload in sync so the inspector and glyph copies agree.
      const px = state.pixels.get(manifest.face);
      for (let y = 0; y < tile.height; y++) {
        px.data.set(tile.data.subarray(y * tile.width, (y + 1) * tile.width), (glyph.y + y) * px.width + glyph.x);
      }
      // Update the manifest so re-layout uses the same tile origin (unchanged)
      // and the strokeEm used by any future report.
      glyph.strokeEm = ed.strokeEm;
      ed.dirty = false;
      toast(`已提交 ${String.fromCodePoint(glyph.cp)} 到 ${manifest.faceLabel} 图集（${tile.width}×${tile.height} texel）`);
      updateFacts(glyph, preview, manifest);
      if (state.view === 'field') state.field?.redraw();
    } catch (err) {
      setErrors([{ code: err.code || 'UPLOAD', message: err.message, detail: err.detail }]);
      showError(err);
    }
  }

  // expose for tests
  ed.kernel = runKernel;

  (async function start() {
    // Load outlines (vector source) once.
    if (!outlines) {
      const res = await fetch('./atlas/outlines.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error('无法读取 outlines.json');
      outlines = await res.json();
      state.outlines = outlines;
    }
    buildGlyphList();
    syncControls();
    runKernel('init');
    redraw();
  })().catch((err) => showError(err));
}
