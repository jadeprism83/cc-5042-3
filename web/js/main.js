// Application controller: atlas loading, tab routing, tour rendering, remote
// controls that drive the renderer and the editor through the same kernel.
import { SdfTextRenderer, hexToRgba } from './renderer.js';
import { loadIndex, loadManifest, loadPixels } from './atlas-loader.js';
import { makeManifests } from '../../shared/layout.mjs';
import { buildTourScene, groupBatches } from './tour.js';
import { initField } from './field.js';
import { initEditor } from './editor.js';
import { initAudit } from './audit.js';
import { initDynamicView } from './dynamic-view.js';
import { createDynamicSystem, DYNAMIC_GRID } from './dynamic-system.js';

const $ = (sel) => document.querySelector(sel);
const state = {
  base: './atlas',
  index: null,
  manifests: null,
  renderer: null,
  view: 'tour',
  size: 28,
  weight: 'sans-book',
  tracking: 0,
  guides: false,
  debugField: false,
  pixels: new Map(),
  bootError: null,
  dynamic: null,
  dynamicText: '',
  dynamicDestroyed: false,
};

function setStatus(kind, text) {
  const el = $('#status');
  el.dataset.state = kind;
  $('#status-text').textContent = text;
}

let toastTimer = null;
export function toast(message, kind = 'info') {
  const el = $('#toast');
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4200);
}

export function showError(err) {
  const detail = err && err.detail ? `\n${JSON.stringify(err.detail)}` : '';
  console.error(err);
  toast(`${err.code ? '[' + err.code + '] ' : ''}${err.message}${detail}`, 'error');
}

async function boot() {
  try {
    const index = await loadIndex(state.base);
    state.index = index;
    const byId = new Map();
    const pixels = new Map();
    for (const face of index.faces) {
      const manifest = await loadManifest(state.base, face);
      byId.set(face.id, manifest);
      const p = await loadPixels(state.base, face, manifest);
      pixels.set(face.id, p);
    }
    state.pixels = pixels;
    state.manifests = makeManifests(index, byId, { latinFace: state.weight });
    state.manifests.latinFace = state.weight;

    const canvas = $('#tour-canvas');
    state.renderer = new SdfTextRenderer(canvas);
    for (const [faceId, p] of pixels) state.renderer.uploadAtlas(faceId, p.width, p.height, p.data);

    await bootDynamic();

    const sources = [...pixels.values()].map((p) => p.source);
    const unique = [...new Set(sources)];
    const totalR8 = index.faces.reduce((s, f) => s + f.atlas.pixels, 0);
    setStatus('ready', `已就绪 · ${index.faces.length} 个字体 · ${(totalR8 / 1048576).toFixed(2)} MB R8 · ${unique.join(' / ')}`);

    $('#weight').value = state.weight;
    initTour();
    initField({ state, toast, showError });
    initEditor({ state, toast, showError });
    initDynamicView({ state, toast, showError });
    await initAudit({ state, showError });
    bindTabs();
    window.__pavilion = { state, toast, showError };
  } catch (err) {
    state.bootError = err;
    setStatus('error', `加载失败：${err.message}`);
    showError(err);
    window.__pavilion = { state, error: err };
  }
}

async function bootDynamic() {
  const sys = await createDynamicSystem(state.renderer.gl, { grid: DYNAMIC_GRID });
  sys.attachManifests(state.manifests);
  state.renderer.registerDynamicAtlas({
    texture: sys.texture, width: sys.glAtlas.width, height: sys.glAtlas.height,
    cache: sys.cache, glAtlas: sys.glAtlas,
  });
  state.dynamic = sys;
  state.rebuildDynamic = rebuildDynamic;
  populateLanguages(sys);
  bindDynamicTour();
}

async function rebuildDynamic() {
  state.dynamicDestroyed = false;
  await bootDynamic();
  state.renderer.registerDynamicAtlas({
    texture: state.dynamic.texture,
    width: state.dynamic.glAtlas.width, height: state.dynamic.glAtlas.height,
    cache: state.dynamic.cache, glAtlas: state.dynamic.glAtlas,
  });
  drawDynamicTour();
  if (state.view === 'dynamic') state.dynamicView.redraw();
}

function populateLanguages(sys) {
  const sel = $('#dyn-language');
  const presets = sys.provider.presets || {};
  sel.innerHTML = '<option value="">（自定义）</option>' +
    Object.entries(presets).map(([id, p]) => `<option value="${id}">${p.label}</option>`).join('');
}

function bindDynamicTour() {
  const textEl = $('#dyn-text');
  const langEl = $('#dyn-language');
  const apply = () => {
    if (state.dynamicDestroyed || !state.dynamic) {
      showError(Object.assign(new Error('动态场景已销毁，请先重建场景'), { code: 'CACHE_DESTROYED' }));
      return;
    }
    state.dynamicText = textEl.value;
    drawDynamicTour();
  };
  $('#dyn-apply').addEventListener('click', apply);
  textEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
  $('#dyn-clear').addEventListener('click', () => {
    state.dynamicText = '';
    textEl.value = '';
    drawDynamicTour();
  });
  langEl.addEventListener('change', () => {
    const id = langEl.value;
    const preset = id ? state.dynamic?.provider.presets[id] : null;
    if (preset) {
      textEl.value = preset.samples.join('　');
      apply();
    }
  });
}

// Shape the current dynamic text and draw it on the shared tour GL canvas in a
// reserved bottom band. Pending glyphs render as placeholders on the first
// pass; when generator tasks resolve we redraw, so the transition
// pending -> uploaded is visible without any user action.
async function drawDynamicTour() {
  const sys = state.dynamic;
  if (!sys || state.dynamicDestroyed) return;
  // Build the fixed tour frame first (it owns begin/clear), then append the
  // dynamic band before the single shared flush.
  const frame = drawTourFrame();
  if (!frame) return;
  const { rect } = frame;
  sys.pump();

  const text = state.dynamicText;
  let dynamicCount = 0;
  let placeholderCount = 0;
  if (text) {
    const bandTop = rect.height - 150;
    const lines = wrapDynamic(sys, text, rect.width - 48, 26);
    let y = bandTop + 34;
    for (const line of lines.slice(0, 3)) {
      const { placements } = sys.shaper.shapeLine(line, { sizePx: 26, x: 24, y });
      const fixed = placements.filter((p) => p.atlas === 'fixed');
      const dyn = placements.filter((p) => p.atlas !== 'fixed');
      for (const p of placements) if (p.placeholder) placeholderCount++;
      if (fixed.length) {
        const byFace = new Map();
        for (const p of fixed) {
          if (!byFace.has(p.faceId)) byFace.set(p.faceId, []);
          byFace.get(p.faceId).push(p);
        }
        for (const [faceId, items] of byFace) {
          state.renderer.push(state.manifests.byId.get(faceId), items, hexToRgba('#efe7d7'));
        }
      }
      if (dyn.length) {
        state.renderer.pushDynamic(dyn, hexToRgba('#d9a05b'), sys.provider.settings);
        dynamicCount += dyn.length;
      }
      y += 26 * 1.5;
    }
  }
  const count = state.renderer.flush();
  sys.shaper.endFrame();
  drawOverlay(rect, frame.scene, count);
  state.lastTour = { scene: frame.scene, batches: frame.batches, count, rect };
  window.__pavilionStats = { instances: count, faces: frame.batches.length };
  $('#dyn-caption').textContent =
    `动态实例 ${dynamicCount} · 占位/缺字 ${placeholderCount} · 布局代次 ${sys.cache.layoutEpoch}`;
  window.__pavilionDynamic = {
    dynamicCount, placeholderCount,
    snapshot: sys.cache.snapshot(),
    vramBytes: sys.glAtlas.vramBytes(),
    textureSize: [sys.glAtlas.width, sys.glAtlas.height],
    droppedStale: state.renderer.droppedStale,
  };

  // Redraw once pending generation settles, then refresh both surfaces.
  if (sys.cache.tasks.size) {
    await sys.cache.settled();
    if (state.dynamic === sys && !state.dynamicDestroyed) {
      drawDynamicTour();
      if (state.view === 'dynamic') state.dynamicView.redraw();
    }
  } else if (state.view === 'dynamic') {
    state.dynamicView.redraw();
  }
}

// Simple width-based wrapping using advances from both fixed and dynamic
// resolutions. CJK breaks per character; Latin breaks at spaces.
function wrapDynamic(sys, text, maxWidthPx, sizePx) {
  const lines = [];
  let cur = '';
  const widthOf = (s) => sys.shaper.shapeLine(s, { sizePx }).advancePx;
  const tokens = tokenizeForWrap(text);
  for (const tok of tokens) {
    if (tok === '\n') { lines.push(cur); cur = ''; continue; }
    const candidate = cur + tok;
    if (widthOf(candidate) > maxWidthPx && cur) {
      lines.push(cur);
      cur = /^\s+$/.test(tok) ? '' : tok;
    } else {
      cur = candidate;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function tokenizeForWrap(text) {
  const out = [];
  let buf = '';
  for (const ch of text) {
    if (ch === '\n') { if (buf) { out.push(buf); buf = ''; } out.push('\n'); continue; }
    if (/\s/.test(ch)) { if (buf) { out.push(buf); buf = ''; } out.push(ch); continue; }
    const cp = ch.codePointAt(0);
    const cjk = (cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0x3000 && cp <= 0x30ff) || (cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0xff00 && cp <= 0xffef);
    if (cjk) { if (buf) { out.push(buf); buf = ''; } out.push(ch); }
    else buf += ch;
  }
  if (buf) out.push(buf);
  return out;
}

function bindTabs() {
  const tabs = [...document.querySelectorAll('.tabs button')];
  const views = [...document.querySelectorAll('.view')];
  const show = (view) => {
    state.view = view;
    for (const t of tabs) t.setAttribute('aria-selected', String(t.dataset.view === view));
    for (const v of views) v.hidden = v.dataset.view !== view;
    if (view === 'tour') drawTour();
    if (view === 'dynamic') state.dynamicView?.redraw();
    if (view === 'field') state.field?.redraw();
    if (view === 'editor') { state.editor?.refresh?.(); state.editor?.redraw(); }
  };
  for (const t of tabs) t.addEventListener('click', () => show(t.dataset.view));
  state.showView = show;
  show('tour');
}

function initTour() {
  const canvas = $('#tour-canvas');
  const sizeEl = $('#size');
  const sizeOut = $('#size-out');
  const trackEl = $('#tracking');
  const trackOut = $('#tracking-out');
  const weightEl = $('#weight');

  const sync = () => {
    state.size = Number(sizeEl.value);
    state.tracking = Number(trackEl.value) / 1000;
    state.weight = weightEl.value;
    state.manifests.latinFace = state.weight;
    sizeOut.textContent = `${state.size} px`;
    trackOut.textContent = `${Number(trackEl.value)} /1000 em`;
    drawTour();
  };
  sizeEl.addEventListener('input', sync);
  trackEl.addEventListener('input', sync);
  weightEl.addEventListener('change', sync);
  $('#guides').addEventListener('change', (e) => { state.guides = e.target.checked; drawTour(); });
  $('#debugfield').addEventListener('change', (e) => { state.debugField = e.target.checked; drawTour(); });

  const ro = new ResizeObserver(() => drawTour());
  ro.observe(canvas);
  window.addEventListener('resize', drawTour);
  sync();
}

function drawTour() {
  if (!state.renderer || state.view !== 'tour') return;
  // When dynamic text is active, drawDynamicTour owns the whole frame: it builds
  // the fixed batches itself, appends the dynamic band and does the single flush.
  // Otherwise this is a fixed-only frame.
  if (state.dynamicText && state.dynamic && !state.dynamicDestroyed) {
    drawDynamicTour();
    return;
  }
  const frame = drawTourFrame();
  if (!frame) return;
  const { rect, scene, batches } = frame;
  const count = state.renderer.flush();

  // Vector rules and guides are drawn with the 2D context of a sibling canvas
  // so they never touch the glyph pipeline. Simplest: draw on the same canvas
  // is impossible for WebGL; we render rules as thin SDF-free DOM lines instead.
  drawOverlay(rect, scene, count);
  state.lastTour = { scene, batches, count, rect };
  window.__pavilionStats = { instances: count, faces: batches.length };
}

// Builds the fixed-tour GL frame: resize, clear and push all fixed-atlas
// batches, but does not flush. The dynamic band appends its own batches before
// the shared flush when present.
function drawTourFrame() {
  if (!state.renderer) return null;
  const canvas = $('#tour-canvas');
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  state.renderer.resize({ widthPx: rect.width, heightPx: rect.height, dpr });
  state.renderer.edgeWidthPx = 1.0 * dpr;

  const scene = buildTourScene(state.manifests, rect.width, rect.height, {
    sizeScale: state.size / 28,
    tracking: state.tracking,
  });
  state.renderer.begin(state.debugField ? 1 : 0);
  const colorMain = hexToRgba('#efe7d7');
  const colorMuted = hexToRgba('#a99e8b');
  const colorAccent = hexToRgba('#d9a05b');
  const batches = groupBatches(state.manifests, scene.items, (g) => {
    if (g.sizePx >= 80) return colorAccent;
    if (g.sizePx <= 14) return colorMuted;
    return colorMain;
  });
  for (const b of batches) {
    state.renderer.push(b.manifest, b.items, b.color);
  }
  return { rect, scene, batches };
}

// Rules and guides as an absolutely-positioned SVG overlay, so the WebGL pass
// stays purely glyphs. The overlay carries no text.
function drawOverlay(rect, scene, count) {
  let svg = document.getElementById('tour-overlay');
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'tour-overlay';
    svg.setAttribute('aria-hidden', 'true');
    svg.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
    const host = $('#view-tour');
    host.style.position = 'relative';
    host.insertBefore(svg, host.firstChild);
  }
  svg.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
  svg.setAttribute('width', rect.width);
  svg.setAttribute('height', rect.height);
  const parts = [];
  for (const r of scene.rules) {
    parts.push(`<line x1="${r.x1}" y1="${r.y1}" x2="${r.x2}" y2="${r.y2}" stroke="#5b5245" stroke-width="1"/>`);
  }
  if (state.guides) {
    for (const it of scene.items) {
      parts.push(`<rect x="${it.x.toFixed(1)}" y="${it.y.toFixed(1)}" width="${it.w.toFixed(1)}" height="${it.h.toFixed(1)}" fill="none" stroke="#2a4f8f" stroke-width="0.4" opacity="0.5"/>`);
      parts.push(`<line x1="${it.penPx.toFixed(1)}" y1="${it.y.toFixed(1)}" x2="${it.penPx.toFixed(1)}" y2="${(it.y + it.h).toFixed(1)}" stroke="#b0472e" stroke-width="0.4" opacity="0.6"/>`);
    }
  }
  svg.innerHTML = parts.join('');
  svg.dataset.instances = String(count);
}

boot();
