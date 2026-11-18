// WebGL2 instanced SDF text renderer.
//
// Colour-space / blending contract (also in docs/RENDER-CONTRACT.md):
//   - The atlas is R8 linear data (a distance field, not a colour texture),
//     uploaded as internalFormat R8 / format RED / UNSIGNED_BYTE, so it is
//     never sRGB-decoded. Decoding to distance happens in the shader.
//   - The canvas is composited by the browser as an sRGB display surface
//     (alpha:false). Text colour and coverage are both in sRGB display space.
//   - Blending is straight alpha: SRC_ALPHA / ONE_MINUS_SRC_ALPHA. The shader
//     never premultiplies, and the context is created with
//     premultipliedAlpha:false. Antialiased edges are a coverage blend, not a
//     lighting blend, so no linear-light conversion is applied to the colour;
//     this is stated so downstream compositing is unambiguous.
//   - The AA ramp is a fixed screen-space width (u_edgeWidthPx, default 1).
//     The field is decoded to screen pixels via rangeTexels / texelsPerEm *
//     pxPerEm, so the ramp is 1 px at every size. Larger sizes interpolate a
//     denser field (smoother), and the threshold never changes. "Edge
//     consistency" therefore means one threshold/ramp at all sizes, not
//     identical rasterisation; tools/compare-report.mjs measures the gap.
import { TEXT_VERT, TEXT_FRAG, INSPECT_VERT, INSPECT_FRAG } from '../../shared/shaders.mjs';

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw Object.assign(new Error('着色器编译失败：' + log), { code: 'SHADER_COMPILE' });
  }
  return sh;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw Object.assign(new Error('着色器链接失败：' + gl.getProgramInfoLog(p)), { code: 'SHADER_LINK' });
  }
  return p;
}

// 16 floats per instance: rect(x,y,w,h) uv(u0,v0,du,dv) rgba screen(w,h) debug
const FLOATS_PER_INSTANCE = 17;

export class SdfTextRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      premultipliedAlpha: false,
      antialias: false,
      preserveDrawingBuffer: true,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw Object.assign(new Error('WebGL2 不可用：无法运行 GPU 距离场渲染器'), { code: 'NO_WEBGL2' });
    this.gl = gl;
    this.textProg = program(gl, TEXT_VERT, TEXT_FRAG);
    this.inspectProg = program(gl, INSPECT_VERT, INSPECT_FRAG);
    this.atlas = new Map();
    // Bounded runtime texture for glyphs missing from the fixed atlases.
    // Registered via registerDynamicAtlas(); batches tagged atlas:'dynamic'
    // sample it, and every draw is re-validated against the slot epoch first.
    this.dynamicAtlas = null;
    this.dynamicCache = null;
    this.batches = null;
    this.edgeWidthPx = 1.0;
    this.dpr = 1;
    this.cssWidth = canvas.clientWidth || canvas.width;
    this.cssHeight = canvas.clientHeight || canvas.height;
    this.instCount = 0;
    this.droppedStale = 0;

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const quad = new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    const loc = {
      corner: gl.getAttribLocation(this.textProg, 'a_corner'),
      rect: gl.getAttribLocation(this.textProg, 'a_rect'),
      uvrect: gl.getAttribLocation(this.textProg, 'a_uvrect'),
      color: gl.getAttribLocation(this.textProg, 'a_color'),
      screen: gl.getAttribLocation(this.textProg, 'a_screen'),
      glyph: gl.getAttribLocation(this.textProg, 'a_glyph'),
    };
    gl.enableVertexAttribArray(loc.corner);
    gl.vertexAttribPointer(loc.corner, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(loc.corner, 0);

    this.instBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    const stride = FLOATS_PER_INSTANCE * 4;
    const attach = (idx, size, offset) => {
      gl.enableVertexAttribArray(idx);
      gl.vertexAttribPointer(idx, size, gl.FLOAT, false, stride, offset * 4);
      gl.vertexAttribDivisor(idx, 1);
    };
    attach(loc.rect, 4, 0);
    attach(loc.uvrect, 4, 4);
    attach(loc.color, 4, 8);
    attach(loc.screen, 2, 12);
    attach(loc.glyph, 3, 14);   // rangeTexels, texelsPerEm, pxPerEm
    this.attrLoc = loc;
    gl.bindVertexArray(null);

    const U = (n) => gl.getUniformLocation(this.textProg, n);
    this.uniforms = {
      proj: U('u_proj'), atlas: U('u_atlas'), atlasSize: U('u_atlasSize'),
      edge: U('u_edgeWidthPx'), debug: U('u_debug'),
    };
    this.bg = [0.039, 0.035, 0.031];
    gl.clearColor(this.bg[0], this.bg[1], this.bg[2], 1);
  }

  resize(opts) {
    const dpr = opts.dpr ?? (window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(opts.widthPx * dpr));
    const h = Math.max(1, Math.round(opts.heightPx * dpr));
    this.dpr = dpr;
    this.cssWidth = opts.widthPx;
    this.cssHeight = opts.heightPx;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.gl.viewport(0, 0, w, h);
  }

  uploadAtlas(faceId, width, height, data) {
    const gl = this.gl;
    const prev = this.atlas.get(faceId);
    if (prev) gl.deleteTexture(prev.tex);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    // R8: linear distance data. Never SRGB8_ALPHA8.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.atlas.set(faceId, { tex, width, height });
    return tex;
  }

  // In-place sub-rect upload used by the editor: the tile position and size
  // must not change, only the distance values inside it.
  updateAtlasRect(faceId, x, y, w, h, data) {
    const entry = this.atlas.get(faceId);
    if (!entry) throw Object.assign(new Error('图集尚未上传该字体'), { code: 'NO_ATLAS' });
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, entry.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RED, gl.UNSIGNED_BYTE, data);
  }

  hasAtlas(faceId) { return this.atlas.has(faceId); }

  // Register the bounded runtime texture. `cache` is the DynamicGlyphCache the
  // shaper resolves identities through; flush() re-validates each dynamic
  // placement's epoch against it so recycled coordinates are never drawn.
  registerDynamicAtlas({ texture, width, height, cache, glAtlas }) {
    this.dynamicAtlas = { tex: texture, width, height };
    this.dynamicCache = cache;
    this.dynamicGlAtlas = glAtlas;
  }

  begin(debug = 0) {
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    this.batches = [];
    this.dynamicBatches = [];
    this.debug = debug;
    this.instCount = 0;
    this.droppedStale = 0;
  }

  // placements: [{x,y,w,h,u0,v0,du,dv, sizePx}], colour [r,g,b,a] in sRGB.
  // The manifest supplies rangeTexels and texelsPerEm for the decode.
  push(manifest, placements, color) {
    if (!placements.length) return;
    let b = this.batches.find((x) => x.face === manifest.face);
    if (!b) {
      b = { face: manifest.face, manifest, floats: [], count: 0 };
      this.batches.push(b);
    }
    const s = manifest.settings;
    for (const p of placements) {
      b.floats.push(
        p.x, p.y, p.w, p.h,
        p.u0, p.v0, p.du, p.dv,
        color[0], color[1], color[2], color[3],
        this.cssWidth, this.cssHeight,
        s.rangeTexels, s.texelsPerEm, p.sizePx,
      );
    }
    b.count = b.floats.length / FLOATS_PER_INSTANCE;
  }

  // Dynamic placements carry their own decode settings (the runtime cache uses
  // the dynamic provider's settings, not a face manifest). Entries whose slot
  // epoch no longer matches the cache are dropped here, not drawn.
  pushDynamic(placements, color, settings) {
    if (!placements.length || !this.dynamicCache) return;
    const floats = [];
    for (const p of placements) {
      if (p.atlas === 'dynamic') {
        const slot = this.dynamicCache.slots.get(p.slotIndex);
        if (!slot || slot.epoch !== p.epoch) {
          this.droppedStale++;
          continue;
        }
      }
      floats.push(
        p.x, p.y, p.w, p.h,
        p.u0, p.v0, p.du, p.dv,
        color[0], color[1], color[2], color[3],
        this.cssWidth, this.cssHeight,
        settings.rangeTexels, settings.texelsPerEm, p.sizePx,
      );
    }
    if (floats.length) this.dynamicBatches.push({ floats, count: floats.length / FLOATS_PER_INSTANCE });
  }

  // Stroke-only glyph outlines (vector reference), drawn as thin lines.
  // Used by the editor to show the original contour next to the field.
  flush() {
    const gl = this.gl;
    if (!this.batches) return;
    gl.useProgram(this.textProg);
    gl.bindVertexArray(this.vao);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniformMatrix4fv(this.uniforms.proj, false, new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
    gl.uniform1f(this.uniforms.edge, this.edgeWidthPx);
    gl.uniform1i(this.uniforms.debug, this.debug);
    for (const b of this.batches) {
      const tex = this.atlas.get(b.face);
      if (!tex) continue;
      this._drawBatch(tex.tex, tex.width, tex.height, b.floats, b.count);
      this.instCount += b.count;
    }
    for (const b of this.dynamicBatches) {
      if (!this.dynamicAtlas) continue;
      this._drawBatch(
        this.dynamicAtlas.tex, this.dynamicAtlas.width, this.dynamicAtlas.height,
        b.floats, b.count,
      );
      this.instCount += b.count;
    }
    gl.bindVertexArray(null);
    this.batches = null;
    this.dynamicBatches = null;
    // Insert a completion fence after the frame's draws. Eviction paths wait on
    // this boundary before reusing a slot, so a recycled cell cannot be
    // overwritten while the GPU is still sampling it.
    this._frameFence = this.insertFence();
    return this.instCount;
  }

  _drawBatch(tex, width, height, floats, count) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(this.uniforms.atlas, 0);
    gl.uniform2f(this.uniforms.atlasSize, width, height);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(floats), gl.DYNAMIC_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
  }

  insertFence() {
    const gl = this.gl;
    if (typeof gl.fenceSync !== 'function') return null;
    gl.flush();
    return gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  }

  // GPU completion boundary for teardown and tests. Waiting here is what makes
  // texture deletion a real release rather than just dropping a JS reference.
  async waitGpuDone(timeoutNs = 2_000_000_000) {
    const gl = this.gl;
    if (this._frameFence && typeof gl.clientWaitSync === 'function') {
      gl.clientWaitSync(this._frameFence, gl.SYNC_FLUSH_COMMANDS_BIT, timeoutNs);
      gl.deleteSync(this._frameFence);
      this._frameFence = null;
    } else {
      gl.finish?.();
    }
  }

  // True release path: wait for in-flight draws, then delete every texture and
  // sync. Called on scene destruction; the JS objects becoming unreachable on
  // their own would not reclaim the committed VRAM.
  async dispose() {
    await this.waitGpuDone();
    const gl = this.gl;
    for (const entry of this.atlas.values()) gl.deleteTexture(entry.tex);
    this.atlas.clear();
    if (this.dynamicGlAtlas) this.dynamicGlAtlas.destroy();
    this.dynamicAtlas = null;
    this.dynamicCache = null;
  }
}

export function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// CSS hex -> normalised [0,1] sRGB components (no conversion; the contract
// above keeps blending in display space).
export function hexToRgba(hex, alpha = 1) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, alpha];
}
