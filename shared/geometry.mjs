// Shared geometry kernel: outline commands -> flattened contours in font units.
// Used by the CLI atlas builder, the browser editor, and the tests.

// Max chord deviation when flattening, in em. 0.0015 em is ~3 font units at
// upm 2048 and ~1.5 at upm 1000: below one atlas texel at 256 texels/em, so
// flattening never becomes the dominant error term in the distance field.
const CURVE_TOLERANCE = 0.0015;

function quadPoint(p0, c, p1, t) {
  const mt = 1 - t;
  return [mt * mt * p0[0] + 2 * mt * t * c[0] + t * t * p1[0], mt * mt * p0[1] + 2 * mt * t * c[1] + t * t * p1[1]];
}

function cubicPoint(p0, c0, c1, p1, t) {
  const mt = 1 - t;
  const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
  return [a * p0[0] + b * c0[0] + c * c1[0] + d * p1[0], a * p0[1] + b * c0[1] + c * c1[1] + d * p1[1]];
}

// Adaptive subdivision count from chord deviation. For a quadratic, max
// deviation <= |p0 - 2c + p1| / 4; for a cubic, <= (|p0-2c0+c1| + |c0-2c1+p1|) * 3/16.
function quadSteps(p0, c, p1, tol) {
  const ddx = p0[0] - 2 * c[0] + p1[0], ddy = p0[1] - 2 * c[1] + p1[1];
  const dev = Math.hypot(ddx, ddy) / 4;
  if (dev <= tol) return 1;
  return Math.max(1, Math.ceil(Math.sqrt(dev / tol) * 2));
}

function cubicSteps(p0, c0, c1, p1, tol) {
  const d1 = Math.hypot(p0[0] - 2 * c0[0] + c1[0], p0[1] - 2 * c0[1] + c1[1]);
  const d2 = Math.hypot(c0[0] - 2 * c1[0] + p1[0], c0[1] - 2 * c1[1] + p1[1]);
  const dev = (d1 + d2) * 3 / 16;
  if (dev <= tol) return 1;
  return Math.max(1, Math.ceil(Math.sqrt(dev / tol) * 3));
}

// Convert fontkit path commands into closed polygonal contours.
// Returns [{ points:[[x,y],...], closed:true }]
export function flattenOutline(commands, tolerance = CURVE_TOLERANCE) {
  const contours = [];
  let current = null;
  let cursor = [0, 0];
  let start = [0, 0];

  const begin = (pt) => {
    if (current && current.points.length > 1) contours.push(current);
    current = { points: [pt.slice()], closed: true };
    start = pt.slice();
    cursor = pt.slice();
  };
  const push = (pt) => {
    if (!current) begin(pt);
    else {
      const last = current.points[current.points.length - 1];
      if (Math.hypot(last[0] - pt[0], last[1] - pt[1]) > 1e-7) current.points.push(pt.slice());
      cursor = pt.slice();
    }
  };

  for (const cmd of commands) {
    switch (cmd.command) {
      case 'moveTo':
        begin(cmd.args);
        break;
      case 'lineTo':
        push(cmd.args);
        break;
      case 'quadraticCurveTo': {
        const [cx, cy, x, y] = cmd.args;
        const c = [cx, cy], p1 = [x, y];
        const n = quadSteps(cursor, c, p1, tolerance);
        for (let i = 1; i <= n; i++) push(quadPoint(cursor, c, p1, i / n));
        break;
      }
      case 'bezierCurveTo': {
        const [c1x, c1y, c2x, c2y, x, y] = cmd.args;
        const c0 = [c1x, c1y], c1 = [c2x, c2y], p1 = [x, y];
        const n = cubicSteps(cursor, c0, c1, p1, tolerance);
        for (let i = 1; i <= n; i++) push(cubicPoint(cursor, c0, c1, p1, i / n));
        break;
      }
      case 'closePath':
        if (current) {
          const first = current.points[0], last = current.points[current.points.length - 1];
          if (Math.hypot(last[0] - first[0], last[1] - first[1]) < 1e-7) current.points.pop();
          if (current.points.length > 1) contours.push(current);
          current = null;
        }
        break;
      default:
        throw new Error(`unsupported outline command: ${cmd.command}`);
    }
  }
  if (current && current.points.length > 1) contours.push(current);
  for (const c of contours) {
    // drop consecutive duplicates and sub-epsilon slivers
    const out = [];
    for (const p of c.points) {
      const q = out[out.length - 1];
      if (!q || Math.abs(q[0] - p[0]) > 1e-7 || Math.abs(q[1] - p[1]) > 1e-7) out.push(p);
    }
    if (out.length > 1 && Math.abs(out[0][0] - out[out.length - 1][0]) < 1e-7 && Math.abs(out[0][1] - out[out.length - 1][1]) < 1e-7) out.pop();
    c.points = out;
  }
  return contours.filter((c) => c.points.length >= 3);
}

// Signed area (positive for CCW in y-up coords).
export function contourArea(points) {
  let a = 0;
  for (let i = 0, n = points.length; i < n; i++) {
    const p = points[i], q = points[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function bboxOf(contours) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of contours) for (const [x, y] of c.points) {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

// Point inside test using the nonzero winding rule, which is what TTF uses.
export function windingAt(contours, x, y) {
  let w = 0;
  for (const c of contours) {
    const pts = c.points;
    for (let i = 0, n = pts.length; i < n; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % n];
      if (y0 <= y) {
        if (y1 > y) {
          const cross = (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0);
          if (cross > 0) w++;
        }
      } else if (y1 <= y) {
        const cross = (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0);
        if (cross < 0) w--;
      }
    }
  }
  return w;
}
