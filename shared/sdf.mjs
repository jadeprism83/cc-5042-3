// Signed distance field kernel. This is the single source of truth for:
//   - signed distance of a point to flattened contours (nonzero winding)
//   - turning outlines into R8 distance tiles
//   - decoding/encoding the distance values used by the GPU shader
//   - evaluating a distance tile with bilinear filtering (used by the
//     comparative report and the GPU parity probe)
// All geometry is in em units (font units / unitsPerEm). Tiles are sized in
// texels; distance values are encoded in texels of the tile grid.

export const ENCODE_NEUTRAL = 128; // value at distance 0
export const ENCODE_SCALE = 127;   // full swing per range

export function encodeDistance(dTexels, rangeTexels) {
  const v = ENCODE_NEUTRAL + ENCODE_SCALE * (dTexels / rangeTexels);
  return Math.max(0, Math.min(255, Math.round(v)));
}

// v may be a normalized [0,1] texture sample or a raw 0..255 byte.
export function decodeDistance(v, rangeTexels, normalized = false) {
  const byte = normalized ? v * 255 : v;
  return ((byte - ENCODE_NEUTRAL) / ENCODE_SCALE) * rangeTexels;
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const qx = ax + t * dx, qy = ay + t * dy;
  const ex = px - qx, ey = py - qy;
  return { d2: ex * ex + ey * ey, t };
}

export function prepareContours(contours) {
  const segments = [];
  for (const c of contours) {
    const pts = c.points;
    for (let i = 0, n = pts.length; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      if (a[0] === b[0] && a[1] === b[1]) continue;
      segments.push([a[0], a[1], b[0], b[1]]);
    }
  }
  return { contours, segments };
}

// Exact signed distance in em, positive inside. Nonzero winding, matching the
// TrueType fill rule. Returns { d, winding }.
export function signedDistance(prepared, x, y) {
  const segs = prepared.segments;
  let best = Infinity;
  let winding = 0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const ax = s[0], ay = s[1], bx = s[2], by = s[3];
    const { d2 } = distanceToSegment(x, y, ax, ay, bx, by);
    if (d2 < best) best = d2;
    if (ay <= y) {
      if (by > y) {
        const xint = ax + ((y - ay) * (bx - ax)) / (by - ay);
        if (xint > x) winding++;
      }
    } else if (by <= y) {
      const xint = ax + ((y - ay) * (bx - ax)) / (by - ay);
      if (xint > x) winding--;
    }
  }
  const d = Math.sqrt(best);
  return { d: winding !== 0 ? d : -d, winding };
}

export function inkBounds(contours) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of contours) for (const [x, y] of c.points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

// Build a distance tile covering the ink bounds plus padTexels of blank margin.
// The encoded range is rangeTexels; pad must be > range so every tile border
// saturates to "far outside" and can never bleed into a neighbouring tile.
// distanceBiasEm shifts the field (positive dilates, negative erodes); it is
// exact because the field is a true distance function, and it widens the ink
// bounds used for the tile so the dilated edge still has pad margin.
export function buildGlyphTile(contours, opts) {
  const { texelsPerEm, rangeTexels, padTexels } = opts;
  const bias = opts.distanceBiasEm ?? 0;
  if (!(padTexels > rangeTexels)) throw kernelError('PAD_TOO_SMALL', '图集边距必须大于距离编码范围', { padTexels, rangeTexels });
  const ink = inkBounds(contours);
  if (!ink) return null;
  const prepared = prepareContours(contours);
  const grown = {
    minX: ink.minX - bias, maxX: ink.maxX + bias,
    minY: ink.minY - bias, maxY: ink.maxY + bias,
  };
  const left = grown.minX - padTexels / texelsPerEm;
  const top = grown.maxY + padTexels / texelsPerEm;
  const width = Math.max(1, Math.ceil((grown.maxX - grown.minX) * texelsPerEm) + 2 * padTexels);
  const height = Math.max(1, Math.ceil((grown.maxY - grown.minY) * texelsPerEm) + 2 * padTexels);
  return buildTileInRect(prepared, { left, top, width, height, texelsPerEm, rangeTexels, ink, bias });
}

// Rebuild a tile over an existing atlas rect (used by the GUI editor patch
// path, where the tile geometry must stay fixed so it can be uploaded in place).
export function buildTileInRect(preparedOrContours, opts) {
  const { left, top, width, height, texelsPerEm, rangeTexels } = opts;
  const bias = opts.bias ?? 0;
  const prepared = preparedOrContours.segments ? preparedOrContours : prepareContours(preparedOrContours);
  const texelsPerEmSafe = texelsPerEm;
  const data = new Uint8Array(width * height);
  let minD = Infinity, maxD = -Infinity;
  for (let py = 0; py < height; py++) {
    const y = top - (py + 0.5) / texelsPerEmSafe;
    const row = py * width;
    for (let px = 0; px < width; px++) {
      const x = left + (px + 0.5) / texelsPerEmSafe;
      const { d } = signedDistance(prepared, x, y);
      const shifted = d + bias;
      if (shifted < minD) minD = shifted;
      if (shifted > maxD) maxD = shifted;
      data[row + px] = encodeDistance(shifted * texelsPerEmSafe, rangeTexels);
    }
  }
  return {
    width, height, data,
    tileEm: { left, top, width: width / texelsPerEmSafe, height: height / texelsPerEmSafe },
    texelsPerEm: texelsPerEmSafe,
    rangeTexels,
    bias,
    stats: { minDistanceEm: minD, maxDistanceEm: maxD },
  };
}

// Bilinear sample of a raw R8 tile. u,v are in tile pixel units, with the
// texel centers at integer+0.5. Values outside the tile are treated as 0
// ("far outside"), matching the guaranteed saturated border.
export function sampleTileBilinear(tile, u, v) {
  const { width, height, data } = tile;
  const x = u - 0.5, y = v - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const at = (ix, iy) => {
    if (ix < 0 || iy < 0 || ix >= width || iy >= height) return 0;
    return data[iy * width + ix];
  };
  const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

// Convert signed distance in screen pixels into antialiased coverage.
// `edgeWidthPx` is the width of the linear ramp, expressed in screen pixels.
// This is the same formula the fragment shader implements.
export function coverageFromPixels(dPx, edgeWidthPx = 1) {
  return Math.max(0, Math.min(1, dPx / edgeWidthPx + 0.5));
}

export function kernelError(code, message, detail = null) {
  const e = new Error(message);
  e.code = code;
  e.detail = detail;
  return e;
}

// Check that an edited outline still leaves the required saturated margin
// between ink and the fixed tile border. `strokeEm` expands ink by strokeEm.
export function checkTileMargins(contours, tileEm, texelsPerEm, rangeTexels, strokeEm = 0) {
  const ink = inkBounds(contours);
  if (!ink) throw kernelError('EMPTY_GLYPH', '编辑后的字形没有轮廓', {});
  if (strokeEm !== 0) {
    ink.minX -= strokeEm; ink.maxX += strokeEm;
    ink.minY -= strokeEm; ink.maxY += strokeEm;
  }
  const req = (rangeTexels + 0.5) / texelsPerEm;
  const margins = {
    left: ink.minX - tileEm.left,
    right: tileEm.left + tileEm.width - ink.maxX,
    bottom: ink.minY - (tileEm.top - tileEm.height),
    top: tileEm.top - ink.maxY,
  };
  const worst = Math.min(margins.left, margins.right, margins.top, margins.bottom);
  if (worst < req) {
    throw kernelError('PAD_BREACH', '字形超出图块保留边距，会污染相邻图块', {
      requiredEm: req, worstEm: worst, marginsEm: margins,
    });
  }
  return margins;
}

// Marching squares iso-contour extraction, used only by the editor to draw the
// effective outline of an SDF-offset stroke (visual reference, not the atlas).
export function extractIsoPolylines(tile, isoValue) {
  const { width, height, data } = tile;
  const val = (x, y) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : data[y * width + x]);
  const segs = [];
  const interp = (x0, y0, v0, x1, y1, v1) => {
    const t = (isoValue - v0) / (v1 - v0 || 1e-9);
    return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
  };
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const v00 = val(x, y), v10 = val(x + 1, y), v01 = val(x, y + 1), v11 = val(x + 1, y + 1);
      const idx = (v00 >= isoValue ? 8 : 0) | (v10 >= isoValue ? 4 : 0) | (v11 >= isoValue ? 2 : 0) | (v01 >= isoValue ? 1 : 0);
      if (idx === 0 || idx === 15) continue;
      const p = {
        t: interp(x + 0.5, y + 0.5, v00, x + 1.5, y + 0.5, v10),
        r: interp(x + 1.5, y + 0.5, v10, x + 1.5, y + 1.5, v11),
        b: interp(x + 0.5, y + 1.5, v01, x + 1.5, y + 1.5, v11),
        l: interp(x + 0.5, y + 0.5, v00, x + 0.5, y + 1.5, v01),
      };
      const push = (a, b) => segs.push([a, b]);
      switch (idx) {
        case 1: case 14: push(p.l, p.b); break;
        case 2: case 13: push(p.b, p.r); break;
        case 3: case 12: push(p.l, p.r); break;
        case 4: case 11: push(p.t, p.r); break;
        case 6: case 9: push(p.t, p.b); break;
        case 7: case 8: push(p.t, p.l); break;
        case 5: push(p.t, p.l); push(p.b, p.r); break;
        case 10: push(p.t, p.r); push(p.l, p.b); break;
      }
    }
  }
  return segs;
}
