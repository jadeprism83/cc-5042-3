// Reference rasteriser: exact outline coverage via nonzero winding, with
// N sub-scanlines per pixel and exact horizontal coverage per span. Used by the
// comparison report and the editor's outline overlay. This is deliberately a
// different algorithm from the SDF path, so agreement is evidence, not a
// tautology.
export function rasterizeCoverage(contours, opts) {
  const { width, height, ox, oy, scale } = opts;
  const sub = opts.subsamples ?? 8;
  const out = new Float32Array(width * height);

  const segs = [];
  for (const c of contours) {
    const p = c.points;
    for (let i = 0, n = p.length; i < n; i++) {
      const a = p[i], b = p[(i + 1) % n];
      const ax = ox + a[0] * scale, ay = oy - a[1] * scale;
      const bx = ox + b[0] * scale, by = oy - b[1] * scale;
      if (ay === by) continue;
      segs.push({ ax, ay, bx, by });
    }
  }
  if (!segs.length) return out;

  let minY = Infinity, maxY = -Infinity;
  for (const s of segs) { if (s.ay < minY) minY = s.ay; if (s.by < minY) minY = s.by; if (s.ay > maxY) maxY = s.ay; if (s.by > maxY) maxY = s.by; }
  const yStart = Math.max(0, Math.floor(minY));
  const yEnd = Math.min(height, Math.ceil(maxY) + 1);
  const crossings = [];
  const weight = 1 / sub;

  for (let py = yStart; py < yEnd; py++) {
    for (let s = 0; s < sub; s++) {
      const y = py + (s + 0.5) / sub;
      let n = 0;
      for (const sg of segs) {
        const { ax, ay, bx, by } = sg;
        if (ay <= y) {
          if (by > y) {
            crossings[n++] = { x: ax + ((y - ay) * (bx - ax)) / (by - ay), dir: 1 };
          }
        } else if (by <= y) {
          crossings[n++] = { x: ax + ((y - ay) * (bx - ax)) / (by - ay), dir: -1 };
        }
      }
      if (n < 2) continue;
      crossings.length = n;
      crossings.sort((a, b) => a.x - b.x);
      let wind = 0;
      let spanStart = 0;
      for (let i = 0; i < n; i++) {
        const prevWind = wind;
        wind += crossings[i].dir;
        if (prevWind === 0 && wind !== 0) spanStart = crossings[i].x;
        else if (prevWind !== 0 && wind === 0) {
          addSpan(out, width, py, spanStart, crossings[i].x, weight);
        }
      }
    }
  }
  return out;
}

function addSpan(out, width, row, xa, xb, weight) {
  if (xb <= xa) return;
  let c0 = Math.max(0, Math.floor(xa));
  const c1 = Math.min(width - 1, Math.floor(xb));
  const rowOff = row * width;
  for (let c = c0; c <= c1; c++) {
    const l = Math.max(xa, c), r = Math.min(xb, c + 1);
    if (r > l) out[rowOff + c] += (r - l) * weight;
  }
}

// Metrics between two coverage buffers over the union of their ink.
export function compareCoverage(a, b, width, height) {
  let sum = 0, sumSq = 0, max = 0, inter = 0, uni = 0, edgeN = 0, edgeErr = 0, n = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i], bv = b[i];
    const e = Math.abs(av - bv);
    sum += e; sumSq += e * e; n++;
    if (e > max) max = e;
    const ai = av >= 0.5, bi = bv >= 0.5;
    if (ai && bi) inter++;
    if (ai || bi) uni++;
    if ((av > 0.02 && av < 0.98) || (bv > 0.02 && bv < 0.98)) { edgeN++; edgeErr += e; }
  }
  return {
    mae: sum / n,
    rmse: Math.sqrt(sumSq / n),
    maxErr: max,
    iou: uni ? inter / uni : 1,
    edgeMae: edgeN ? edgeErr / edgeN : 0,
    edgePixels: edgeN,
  };
}
