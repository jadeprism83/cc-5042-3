// Application controller: atlas loading, tab routing, tour rendering, remote
// controls that drive the renderer and the editor through the same kernel.
import { SdfTextRenderer, hexToRgba } from './renderer.js';
import { loadIndex, loadManifest, loadPixels } from './atlas-loader.js';
import { makeManifests } from '../../shared/layout.mjs';
import { buildTourScene, groupBatches } from './tour.js';
import { initField } from './field.js';
import { initEditor } from './editor.js';
import { initAudit } from './audit.js';

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

    const sources = [...pixels.values()].map((p) => p.source);
    const unique = [...new Set(sources)];
    const totalR8 = index.faces.reduce((s, f) => s + f.atlas.pixels, 0);
    setStatus('ready', `已就绪 · ${index.faces.length} 个字体 · ${(totalR8 / 1048576).toFixed(2)} MB R8 · ${unique.join(' / ')}`);

    $('#weight').value = state.weight;
    initTour();
    initField({ state, toast, showError });
    initEditor({ state, toast, showError });
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

function bindTabs() {
  const tabs = [...document.querySelectorAll('.tabs button')];
  const views = [...document.querySelectorAll('.view')];
  const show = (view) => {
    state.view = view;
    for (const t of tabs) t.setAttribute('aria-selected', String(t.dataset.view === view));
    for (const v of views) v.hidden = v.dataset.view !== view;
    if (view === 'tour') drawTour();
    if (view === 'field') state.field?.redraw();
    if (view === 'editor') state.editor?.redraw();
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
  const canvas = $('#tour-canvas');
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return;
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
  const count = state.renderer.flush();

  // Vector rules and guides are drawn with the 2D context of a sibling canvas
  // so they never touch the glyph pipeline. Simplest: draw on the same canvas
  // is impossible for WebGL; we render rules as thin SDF-free DOM lines instead.
  drawOverlay(rect, scene, count);
  state.lastTour = { scene, batches, count, rect };
  window.__pavilionStats = { instances: count, faces: batches.length };
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
