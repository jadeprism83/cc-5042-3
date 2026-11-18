// Distance-field inspector. Renders the actual atlas (whole, or one glyph's
// tile magnified) with three decodings, plus a below-strip that rebuilds the
// glyph at the chosen size from the same bytes using the shader's formula.
import { INSPECT_VERT, INSPECT_FRAG } from '../../shared/shaders.mjs';
import { sampleTileBilinear, decodeDistance, coverageFromPixels } from '../../shared/sdf.mjs';

const $ = (s) => document.querySelector(s);

function program(gl, vs, fs) {
  const mk = (t, s) => {
    const sh = gl.createShader(t); gl.shaderSource(sh, s); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

export function initField({ state, toast, showError }) {
  const canvas = $('#field-canvas');
  const strip = $('#field-strip');
  const gl = canvas.getContext('webgl2', { alpha: false, preserveDrawingBuffer: true, antialias: false });
  if (!gl) { showError(new Error('WebGL2 不可用：距离场检查器无法启动')); return; }
  const prog = program(gl, INSPECT_VERT, INSPECT_FRAG);
  const vao = gl.createVertexArray();
  const tex = gl.createTexture();
  const off = document.createElement('canvas');
  const offCtx = off.getContext('2d', { willReadFrequently: false });

  const ui = {
    face: $('#field-face'), mode: $('#field-mode'), zoom: $('#field-zoom'),
    px: $('#field-px'), facts: $('#field-facts'), zoomOut: $('#field-zoom-out'), pxOut: $('#field-px-out'),
  };
  if (!ui.face) { showError(new Error('距离场检查器的界面元素缺失')); return; }

  state.field = { redraw };

  function currentManifest() {
    return state.manifests.byId.get(ui.face.value);
  }

  function redraw() {
    if (state.view !== 'field') return;
    const manifest = currentManifest();
    const px = state.pixels.get(ui.face.value);
    if (!manifest || !px) return;

    // Pick a representative glyph (first non-blank) and show its tile zoomed,
    // or the whole atlas at 1x when zoom == 1.
    const zoom = Number(ui.zoom.value);
    ui.zoomOut.textContent = zoom.toFixed(2) + '×';
    const pxSize = Number(ui.px.value);
    ui.pxOut.textContent = pxSize + ' px';

    // The inspector always shows one glyph's tile, ringed by two texels of the
    // atlas so the pad band and the saturating border are visible. The zoom
    // slider magnifies from "fit the panel" upward; the panel scrolls.
    const g = manifest.glyphs[65] || manifest.glyphs[Object.keys(manifest.glyphs)[0]];
    let srcX = 0, srcY = 0, srcW = px.width, srcH = px.height;
    if (g) {
      srcX = Math.max(0, g.x - 2);
      srcY = Math.max(0, g.y - 2);
      srcW = Math.min(px.width - srcX, g.w + 4);
      srcH = Math.min(px.height - srcY, g.h + 4);
    }

    const host = $('#view-field .field-main');
    const hostW = Math.max(160, host.clientWidth - 48);
    const hostH = Math.max(160, host.clientHeight - 48);
    const fit = Math.min(hostW / srcW, hostH / srcH);
    const dispScale = Math.max(0.25, fit * zoom);
    const cw = Math.round(srcW * dispScale);
    const chh = Math.round(srcH * dispScale);
    canvas.style.width = cw + 'px';
    canvas.style.height = chh + 'px';
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(chh * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);

    // Copy just the sub-rect into a temporary texture so the inspector sees the
    // exact bytes with nearest sampling (no cross-tile filtering).
    const sub = new Uint8Array(srcW * srcH);
    for (let y = 0; y < srcH; y++) sub.set(px.data.subarray((srcY + y) * px.width + srcX, (srcY + y) * px.width + srcX + srcW), y * srcW);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, srcW, srcH, 0, gl.RED, gl.UNSIGNED_BYTE, sub);
    // Raw bytes and the thresholded view must show the stored values, so they
    // sample nearest. The signed view is an isoline rendering and samples
    // linearly so the zero crossing becomes a continuous contour.
    const filter = Number(ui.mode.value) === 1 ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.useProgram(prog);
    gl.bindVertexArray(vao);
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const U = (n) => gl.getUniformLocation(prog, n);
    gl.uniform1i(U('u_atlas'), 0);
    gl.uniform1i(U('u_mode'), Number(ui.mode.value));
    gl.uniform1f(U('u_rangeTexels'), manifest.settings.rangeTexels);
    gl.uniform1f(U('u_texelsPerEm'), manifest.settings.texelsPerEm);
    // The inspector image is magnified, so pixels-per-em of what is on screen
    // is texelsPerEm * dispScale. Passing the preview size here instead would
    // evaluate the 1 px AA ramp at a totally different scale and turn the
    // threshold view into a gradient.
    gl.uniform1f(U('u_pxPerEm'), manifest.settings.texelsPerEm * dispScale);
    gl.uniform3f(U('u_bg'), 0.05, 0.05, 0.06);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Below-strip rebuild at chosen size with shader-identical decode.
    drawStrip(manifest, px, pxSize);
    updateFacts(manifest, px, srcW, srcH, zoom, pxSize, dispScale);
  }

  function drawStrip(manifest, px, pxSize) {
    const g = manifest.glyphs[65] || manifest.glyphs[Object.keys(manifest.glyphs)[0]];
    if (!g) return;
    const tile = { width: g.w, height: g.h, data: new Uint8Array(g.w * g.h) };
    for (let y = 0; y < g.h; y++) tile.data.set(px.data.subarray((g.y + y) * px.width + g.x, (g.y + y) * px.width + g.x + g.w), y * g.w);

    const scale = pxSize / manifest.settings.texelsPerEm;
    const margin = 6;
    const W = Math.ceil(g.w * scale) + margin * 2;
    const H = Math.ceil(g.h * scale) + margin * 2;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    strip.width = Math.round($('#field-strip').clientWidth * dpr);
    strip.height = Math.round($('#field-strip').clientHeight * dpr);
    strip.style.width = '100%';
    if (!strip.width || !strip.height) return;
    off.width = W; off.height = H;
    const img = offCtx.createImageData(W, H);
    for (let py = 0; py < H; py++) for (let pxx = 0; pxx < W; pxx++) {
      const u = (pxx + 0.5 - margin) / scale;
      const v = (py + 0.5 - margin) / scale;
      const byte = sampleTileBilinear(tile, u, v);
      const dPx = (decodeDistance(byte, manifest.settings.rangeTexels) / manifest.settings.texelsPerEm) * pxSize;
      const a = Math.round(coverageFromPixels(dPx, 1) * 255);
      const o = (py * W + pxx) * 4;
      img.data[o] = 239; img.data[o + 1] = 231; img.data[o + 2] = 215; img.data[o + 3] = a;
    }
    offCtx.putImageData(img, 0, 0);
    // blit into visible strip canvas with 2D context scaled
    const ctx = strip.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#0d0c0b';
    ctx.fillRect(0, 0, strip.width, strip.height);
    const drawScale = Math.min(strip.width / W, strip.height / H);
    const dx = (strip.width - W * drawScale) / 2;
    const dy = (strip.height - H * drawScale) / 2;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(off, dx, dy, W * drawScale, H * drawScale);
  }

  function updateFacts(manifest, px, srcW, srcH, zoom, pxSize, dispScale) {
    const g = manifest.glyphs[65] || manifest.glyphs[Object.keys(manifest.glyphs)[0]];
    const rows = [
      ['字体', manifest.faceLabel],
      ['字重', manifest.faceMeta.requestedWeight],
      ['每 em 采样', `${manifest.settings.texelsPerEm} texel`],
      ['编码范围', `±${manifest.settings.rangeTexels} texel`],
      ['图块边距', `${manifest.settings.padTexels} texel`],
      ['图集尺寸', `${manifest.atlas.width}×${manifest.atlas.height}`],
      ['显示区域', `${srcW}×${srcH} texel`],
      ['检查器倍率', `${dispScale.toFixed(2)} screen px / texel`],
      ['重建字号', `${pxSize} px → ${(pxSize / manifest.settings.texelsPerEm).toFixed(2)} px/texel`],
      ['预览字形', g ? `${String.fromCodePoint(g.cp)} (U+${g.cp.toString(16).toUpperCase()})` : '—'],
    ];
    ui.facts.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    $('#fact-pad').textContent = manifest.settings.padTexels;
    $('#fact-range').textContent = manifest.settings.rangeTexels;
  }

  for (const el of [ui.face, ui.mode, ui.zoom, ui.px]) {
    el.addEventListener('input', redraw);
    el.addEventListener('change', redraw);
  }
  redraw();
}
