// Accuracy test: the atlas field, decoded and sampled exactly like the shader,
// must agree with an independent exact outline rasteriser within a measured
// bound. The algorithms are different (distance field vs sub-scanline coverage),
// so this is evidence rather than a tautology.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { sampleTileBilinear, decodeDistance, coverageFromPixels } from '../shared/sdf.mjs';
import { rasterizeCoverage, compareCoverage } from '../shared/raster.mjs';
import { flattenOutline } from '../shared/geometry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ATLAS = path.join(ROOT, 'web', 'atlas');

function loadAtlas(faceId) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ATLAS, `${faceId}.json`), 'utf8'));
  const png = PNG.sync.read(fs.readFileSync(path.join(ATLAS, `${faceId}.png`)));
  const data = new Uint8Array(png.width * png.height);
  if (png.data.length === data.length) data.set(png.data);
  else for (let i = 0; i < data.length; i++) data[i] = png.data[i * (png.data.length / data.length)];
  return { manifest, width: png.width, height: png.height, data };
}

function glyphTile(atlas, g) {
  const buf = new Uint8Array(g.w * g.h);
  for (let y = 0; y < g.h; y++) {
    const src = (g.y + y) * atlas.width + g.x;
    buf.set(atlas.data.subarray(src, src + g.w), y * g.w);
  }
  return { width: g.w, height: g.h, data: buf };
}

// Render the glyph tile at `sizePx` the way the fragment shader does: one
// sample per pixel at the centre, bilinear over bytes, then decode and apply
// the 1 px coverage ramp.
function sdfAt(g, tile, sizePx, W, H, originX, originY, manifest) {
  const out = new Float32Array(W * H);
  const scale = sizePx / manifest.settings.texelsPerEm;
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const u = (px + 0.5 - originX) / scale;
      const v = (py + 0.5 - originY) / scale;
      const byte = sampleTileBilinear(tile, u, v);
      const dPx = (decodeDistance(byte, manifest.settings.rangeTexels) / manifest.settings.texelsPerEm) * sizePx;
      out[py * W + px] = coverageFromPixels(dPx, 1);
    }
  }
  return out;
}

function runSample(faceId, cp, sizePx) {
  const atlas = loadAtlas(faceId);
  const g = atlas.manifest.glyphs[cp];
  assert.ok(g, `glyph U+${cp.toString(16)} exported`);
  const tile = glyphTile(atlas, g);
  const pad = 4;
  const W = Math.ceil(g.w * (sizePx / atlas.manifest.settings.texelsPerEm)) + pad * 2;
  const H = Math.ceil(g.h * (sizePx / atlas.manifest.settings.texelsPerEm)) + pad * 2;

  const outlines = JSON.parse(fs.readFileSync(path.join(ATLAS, 'outlines.json'), 'utf8'));
  const entry = outlines.faces[faceId][cp];
  const contours = flattenOutline(entry.cmds.map((c) => ({ command: c.c, args: c.a })), 0.002);

  // Reference: exact coverage. The tile's em rect maps to the bitmap so that
  // the glyph's ink sits in the same place as the SDF sampling.
  const ref = rasterizeCoverage(contours, {
    width: W, height: H,
    ox: pad - g.left * sizePx,
    oy: pad + g.top * sizePx,
    scale: sizePx,
    subsamples: 8,
  });
  const sdf = sdfAt(g, tile, sizePx, W, H, pad, pad, atlas.manifest);
  return compareCoverage(sdf, ref, W, H);
}

const CASES = [
  ['sans-thin', 0x41], ['sans-thin', 0x69], ['sans-thin', 0x2e],
  ['sans-book', 0x41], ['sans-book', 0x61], ['sans-book', 0x40],
  ['sans-bold', 0x41], ['sans-bold', 0x57],
  ['cjk-regular', 0x5c71], ['cjk-regular', 0x3001],
];

test('field vs exact outline: thin / bold / punctuation agree within bound', () => {
  const rows = [];
  for (const [face, cp] of CASES) {
    for (const size of [12, 24, 48, 96, 192]) {
      const m = runSample(face, cp, size);
      rows.push({ face, cp, size, ...m });
    }
  }
  // Reported means for the shipped atlas (see docs/report/metrics.json).
  const meanMae = rows.reduce((s, r) => s + r.mae, 0) / rows.length;
  const meanIou = rows.reduce((s, r) => s + r.iou, 0) / rows.length;
  assert.ok(meanMae < 0.01, `mean MAE ${meanMae.toFixed(5)} < 0.01`);
  assert.ok(meanIou > 0.85, `mean IoU ${meanIou.toFixed(3)} > 0.85`);

  // At the small size the extra-light face is the worst case; assert a hard
  // ceiling on any single sample rather than hiding it in the mean.
  const worst = rows.reduce((a, b) => (b.mae > a.mae ? b : a));
  assert.ok(worst.mae < 0.05, `worst MAE ${worst.mae.toFixed(4)} at ${worst.face} U+${worst.cp.toString(16)} ${worst.size}px`);
});

test('error stays bounded as size increases (no catastrophic blow-up)', () => {
  for (const [face, cp] of [['sans-book', 0x41], ['cjk-regular', 0x5c71]]) {
    const small = runSample(face, cp, 24);
    const large = runSample(face, cp, 192);
    assert.ok(large.mae <= small.mae + 0.01, `${face}: large MAE ${large.mae} vs small ${small.mae}`);
  }
});

test('pad ring is provably not contaminated by the neighbour tile', () => {
  // Build the tile from its own atlas rect and compare its border bytes to the
  // saturated value. With pad > range every border texel is 0 (far outside).
  const atlas = loadAtlas('cjk-regular');
  for (const cp of [0x5c71, 0x5c55, 0x95f4]) {
    const g = atlas.manifest.glyphs[cp];
    const tile = glyphTile(atlas, g);
    const at = (x, y) => tile.data[y * tile.width + x];
    for (let x = 0; x < tile.width; x++) {
      assert.equal(at(x, 0), 0, `U+${cp.toString(16)} top border x=${x}`);
      assert.equal(at(x, tile.height - 1), 0, `U+${cp.toString(16)} bottom border x=${x}`);
    }
    for (let y = 0; y < tile.height; y++) {
      assert.equal(at(0, y), 0, `U+${cp.toString(16)} left border y=${y}`);
      assert.equal(at(tile.width - 1, y), 0, `U+${cp.toString(16)} right border y=${y}`);
    }
  }
});
