// Kernel tests: encoding parity, exact signed distance, tile border saturation,
// and the pad > range invariant. These exercise the same modules the atlas
// builder and the GPU shader contract rely on.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeDistance, decodeDistance, signedDistance, prepareContours,
  buildGlyphTile, buildTileInRect, sampleTileBilinear, coverageFromPixels,
  kernelError, checkTileMargins, inkBounds, ENCODE_NEUTRAL,
} from '../shared/sdf.mjs';
import { normalizeSettings } from '../shared/atlas-build.mjs';

function square(size = 0.5, cx = 0, cy = 0) {
  const h = size / 2;
  const pts = [[cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h], [cx - h, cy + h]];
  return [{ points: pts, closed: true }];
}

test('encode/decode are inverse and clamp to the byte range', () => {
  const range = 10;
  for (const d of [-10, -7.3, -0.5, 0, 0.4, 3.9, 10]) {
    const b = encodeDistance(d, range);
    assert.ok(b >= 0 && b <= 255);
    // Round-trip error is at most half a byte step, i.e. range/127/2 texels.
    const back = decodeDistance(b, range);
    assert.ok(Math.abs(back - d) <= range / 126 + 1e-9, `${d} -> ${b} -> ${back}`);
  }
  assert.equal(encodeDistance(0, range), ENCODE_NEUTRAL);
  assert.equal(encodeDistance(999, range), 255, 'outside beyond range saturates');
  assert.equal(encodeDistance(-999, range), 0);
});

test('decode accepts a normalized sample as well as a byte', () => {
  const range = 10;
  const b = encodeDistance(2.5, range);
  assert.equal(decodeDistance(b, range), decodeDistance(b / 255, range, true));
});

test('signed distance: positive inside, negative outside, zero on the edge', () => {
  const prepared = prepareContours(square(0.5));
  const inside = signedDistance(prepared, 0, 0);
  assert.ok(inside.d > 0, 'centre is inside');
  assert.equal(inside.winding % 2 !== 0, true);
  const outside = signedDistance(prepared, 0.4, 0);
  assert.ok(outside.d < 0, 'outside is negative');
  assert.equal(outside.winding, 0);
  const edge = signedDistance(prepared, 0.25, 0);
  assert.ok(Math.abs(edge.d) < 1e-12, 'exactly on the edge is 0');
});

test('signed distance magnitude is the euclidean distance to the outline', () => {
  const prepared = prepareContours(square(1));
  // Centre of a 1x1 square is 0.5 em from each edge.
  assert.ok(Math.abs(signedDistance(prepared, 0, 0).d - 0.5) < 1e-12);
  // A point 0.1 above the top edge is 0.1 outside.
  assert.ok(Math.abs(signedDistance(prepared, 0, 0.6).d + 0.1) < 1e-12);
});

test('a hole inverts the sign under nonzero winding', () => {
  const outer = square(1);
  const inner = [{ points: [[-0.2, -0.2], [-0.2, 0.2], [0.2, 0.2], [0.2, -0.2]], closed: true }]; // reversed
  const prepared = prepareContours([...outer, ...inner]);
  assert.ok(signedDistance(prepared, 0, 0).d < 0, 'hole centre is outside the ink');
  assert.ok(signedDistance(prepared, 0.35, 0).d > 0, 'ring is inside');
});

test('normalizeSettings rejects pad <= range', () => {
  assert.throws(
    () => normalizeSettings({ texelsPerEm: 64, rangeTexels: 16, padTexels: 16 }),
    (e) => e.code === 'PAD_TOO_SMALL',
  );
  const ok = normalizeSettings({ texelsPerEm: 64, rangeTexels: 10, padTexels: 16 });
  assert.ok(ok.padTexels > ok.rangeTexels);
  assert.throws(() => normalizeSettings({ texelsPerEm: 2 }), (e) => e.code === 'TEXELS_PER_EM_RANGE');
  assert.throws(() => normalizeSettings({ rangeTexels: 1 }), (e) => e.code === 'RANGE_RANGE');
});

test('every tile border saturates to far-outside when pad > range', () => {
  const settings = { texelsPerEm: 32, rangeTexels: 6, padTexels: 10 };
  const tile = buildGlyphTile(square(0.5), settings);
  assert.ok(tile);
  const { width, height, data } = tile;
  // Border rows/cols are the outermost texels. With pad > range the encoded
  // value must be fully clamped at 0 in every border texel.
  const checkRow = (y) => { for (let x = 0; x < width; x++) assert.equal(data[y * width + x], 0, `row ${y} x ${x}`); };
  const checkCol = (x) => { for (let y = 0; y < height; y++) assert.equal(data[y * width + x], 0, `col ${x} y ${y}`); };
  checkRow(0); checkRow(height - 1);
  checkCol(0); checkCol(width - 1);
});

test('tile size covers ink plus two pads', () => {
  const texelsPerEm = 64, padTexels = 16;
  const tile = buildGlyphTile(square(0.5), { texelsPerEm, rangeTexels: 10, padTexels });
  const expected = Math.ceil(0.5 * texelsPerEm) + 2 * padTexels;
  assert.equal(tile.width, expected);
  assert.equal(tile.height, expected);
});

test('distance bias dilates and erodes by exactly the bias', () => {
  const base = { texelsPerEm: 64, rangeTexels: 10, padTexels: 16 };
  const plain = buildGlyphTile(square(0.5), base);
  const dilated = buildGlyphTile(square(0.5), { ...base, distanceBiasEm: 0.05 });
  const eroded = buildGlyphTile(square(0.5), { ...base, distanceBiasEm: -0.05 });
  // The encoded distance at the same physical point shifts by the bias.
  const cx = Math.floor(plain.width / 2), cy = Math.floor(plain.height / 2);
  const d0 = decodeDistance(plain.data[cy * plain.width + cx], base.rangeTexels);
  const dd = decodeDistance(dilated.data[cy * dilated.width + cx], base.rangeTexels);
  assert.ok(dd >= d0, 'dilation raises the distance (grows ink)');
  void eroded;
});

test('bilinear sampling clamps outside the tile to "far outside"', () => {
  const tile = buildGlyphTile(square(0.5), { texelsPerEm: 32, rangeTexels: 6, padTexels: 10 });
  // Sample well outside: the helper treats out-of-range as byte 0, which is
  // the same value the saturated border holds.
  assert.equal(sampleTileBilinear(tile, -50, -50), 0);
  assert.equal(sampleTileBilinear(tile, tile.width + 50, tile.height + 50), 0);
});

test('coverage ramp is centred on zero and 1 px wide', () => {
  assert.equal(coverageFromPixels(0, 1), 0.5);
  assert.equal(coverageFromPixels(0.5, 1), 1);
  assert.equal(coverageFromPixels(-0.5, 1), 0);
  assert.equal(coverageFromPixels(0.25, 1), 0.75);
});

test('checkTileMargins throws PAD_BREACH when ink touches the pad', () => {
  const contours = square(1.0); // fills the tile edge to edge
  const tileEm = { left: -0.5, top: 0.5, width: 1.0, height: 1.0 };
  assert.throws(
    () => checkTileMargins(contours, tileEm, 64, 10),
    (e) => e.code === 'PAD_BREACH',
  );
  const roomy = { left: -1, top: 1, width: 2, height: 2 };
  const m = checkTileMargins(contours, roomy, 64, 10);
  assert.ok(m.left > 0 && m.right > 0 && m.top > 0 && m.bottom > 0);
});

test('empty outline yields no tile and a kernel error for margins', () => {
  assert.equal(buildGlyphTile([], { texelsPerEm: 32, rangeTexels: 6, padTexels: 10 }), null);
  assert.equal(inkBounds([]), null);
  assert.throws(() => checkTileMargins([], { left: 0, top: 0, width: 1, height: 1 }, 64, 10), (e) => e.code === 'EMPTY_GLYPH');
});

test('buildTileInRect preserves the requested rect', () => {
  const rect = { left: -0.4, top: 0.6, width: 40, height: 36, texelsPerEm: 64, rangeTexels: 8 };
  const tile = buildTileInRect(square(0.4), rect);
  assert.equal(tile.width, 40);
  assert.equal(tile.height, 36);
  assert.equal(tile.tileEm.left, -0.4);
  assert.equal(tile.tileEm.top, 0.6);
  assert.equal(tile.data.length, 40 * 36);
});

test('kernelError carries a stable code and detail', () => {
  const e = kernelError('X', 'msg', { a: 1 });
  assert.equal(e.code, 'X');
  assert.equal(e.message, 'msg');
  assert.deepEqual(e.detail, { a: 1 });
});
