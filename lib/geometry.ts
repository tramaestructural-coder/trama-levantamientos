export type Point = { x: number; y: number };

let counter = 0;
export function makeId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter}`;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

// Snaps `to` onto the nearest 0/90/180/270 axis through `from`, keeping the
// same distance from `from` (used by the "guía recta" ortho toggle).
export function snapToAxis(from: Point, to: Point): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return { x: to.x, y: from.y };
  }
  return { x: from.x, y: to.y };
}

// Finds the nearest existing vertex within `threshold` px, if any (the
// "imán" behavior that lets new lines connect exactly to earlier ones).
export function findSnapPoint(
  target: Point,
  candidates: Point[],
  threshold: number
): Point | null {
  let best: Point | null = null;
  let bestDist = threshold;
  for (const c of candidates) {
    const d = distance(target, c);
    if (d <= bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

export function samePoint(a: Point, b: Point, epsilon = 0.01): boolean {
  return Math.abs(a.x - b.x) < epsilon && Math.abs(a.y - b.y) < epsilon;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// Snaps a point onto the nearest grid intersection (at `step` spacing) when
// within `thresholdWorld` of it — the grid's light "imantación".
export function snapToGrid(point: Point, thresholdWorld: number, step: number): Point | null {
  const snapped = { x: Math.round(point.x / step) * step, y: Math.round(point.y / step) * step };
  return distance(point, snapped) <= thresholdWorld ? snapped : null;
}

// Projects `p` onto the segment a-b, clamped to the segment's ends. Used to
// snap a door/window symbol onto the nearest wall as you drag it.
export function projectOntoSegment(p: Point, a: Point, b: Point): { point: Point; dist: number } {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  if (lenSq < 1e-9) return { point: a, dist: distance(p, a) };
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq;
  t = clamp(t, 0, 1);
  const proj = { x: a.x + abx * t, y: a.y + aby * t };
  return { point: proj, dist: distance(p, proj) };
}

// Samples a curved edge (start -> mid -> end, where `mid` is a point the
// curve passes THROUGH at its midpoint, not a Bezier control point) into a
// polyline. Solves for the quadratic Bezier control point that makes the
// curve pass through `mid` at t=0.5, then samples it. Returns `segments`
// points spanning (start, end] — `start` itself is left out since callers
// already have it as the previous point in their chain.
export function sampleCurvePoints(start: Point, mid: Point, end: Point, segments = 16): Point[] {
  const cx = 2 * mid.x - 0.5 * (start.x + end.x);
  const cy = 2 * mid.y - 0.5 * (start.y + end.y);
  const pts: Point[] = [];
  for (let i = 1; i <= segments; i++) {
    const t = i / segments;
    const it = 1 - t;
    const x = it * it * start.x + 2 * it * t * cx + t * t * end.x;
    const y = it * it * start.y + 2 * it * t * cy + t * t * end.y;
    pts.push({ x, y });
  }
  return pts;
}

// Where a door/window resize handle should land: snapped onto the nearest
// wall face within range (so each end can align to a different face of a
// thick wall), or — with nothing nearby — projected onto the ray through
// `fixed` at `axisAngle` so the resize stays parallel instead of skewing.
export function resizeEndpointTarget(
  raw: Point,
  fixed: Point,
  axisAngle: number,
  lines: { x1: number; y1: number; x2: number; y2: number }[],
  alignDist: number
): Point {
  let best: { point: Point; dist: number } | null = null;
  for (const l of lines) {
    const { point, dist } = projectOntoSegment(raw, { x: l.x1, y: l.y1 }, { x: l.x2, y: l.y2 });
    if (dist <= alignDist && (!best || dist < best.dist)) best = { point, dist };
  }
  if (best) return best.point;
  const dx = Math.cos(axisAngle);
  const dy = Math.sin(axisAngle);
  const t = (raw.x - fixed.x) * dx + (raw.y - fixed.y) * dy;
  return { x: fixed.x + dx * t, y: fixed.y + dy * t };
}

// The only "touches another line" magnet besides vertices: snaps onto a
// line when the segment being dragged (from `from` to `target`) meets it
// close to perpendicular — this is AutoCAD's "perpendicular" osnap, not
// "nearest" (a plain near-miss next to a line should NOT magnetize).
export function findPerpendicularSnap(
  from: Point,
  target: Point,
  lines: { x1: number; y1: number; x2: number; y2: number }[],
  thresholdWorld: number
): Point | null {
  const dx = target.x - from.x;
  const dy = target.y - from.y;
  const dragLen = Math.hypot(dx, dy);
  if (dragLen < 1e-6) return null;
  const dragDir = { x: dx / dragLen, y: dy / dragLen };
  let best: { point: Point; dist: number } | null = null;
  for (const l of lines) {
    const lx = l.x2 - l.x1;
    const ly = l.y2 - l.y1;
    const lineLen = Math.hypot(lx, ly);
    if (lineLen < 1e-6) continue;
    const lineDir = { x: lx / lineLen, y: ly / lineLen };
    // |dot| close to 0 means the drag is close to perpendicular to this
    // line (dot = cos of the angle between them); ~10° tolerance.
    const dot = Math.abs(dragDir.x * lineDir.x + dragDir.y * lineDir.y);
    if (dot > 0.17) continue;
    const { point, dist } = projectOntoSegment(target, { x: l.x1, y: l.y1 }, { x: l.x2, y: l.y2 });
    if (dist <= thresholdWorld && (!best || dist < best.dist)) best = { point, dist };
  }
  return best?.point ?? null;
}

// Like `resizeEndpointTarget`'s wall search, but also hands back the
// matched wall's angle and endpoints — for a control point whose rotation
// should follow the wall it just snapped onto (e.g. a door hinge), not
// just its position.
export function findWallAlignment(
  point: Point,
  lines: { x1: number; y1: number; x2: number; y2: number }[],
  alignDist: number
): { point: Point; angle: number; lineStart: Point; lineEnd: Point } | null {
  let best: { point: Point; angle: number; lineStart: Point; lineEnd: Point; dist: number } | null = null;
  for (const l of lines) {
    const lineStart = { x: l.x1, y: l.y1 };
    const lineEnd = { x: l.x2, y: l.y2 };
    const { point: proj, dist } = projectOntoSegment(point, lineStart, lineEnd);
    if (dist <= alignDist && (!best || dist < best.dist)) {
      best = { point: proj, angle: Math.atan2(l.y2 - l.y1, l.x2 - l.x1), lineStart, lineEnd, dist };
    }
  }
  return best ? { point: best.point, angle: best.angle, lineStart: best.lineStart, lineEnd: best.lineEnd } : null;
}

// Smart-guide alignment, like Figma/Illustrator: snaps `target` onto the
// same X and/or Y as any nearby existing vertex (independently on each
// axis — a corner can pick up both at once), and hands back a guide line
// per axis for drawing the dashed alignment indicator.
export type AxisGuide = { from: Point; axis: "x" | "y" };

export function findAxisAlignment(
  target: Point,
  candidates: Point[],
  thresholdWorld: number
): { point: Point; guides: AxisGuide[] } | null {
  let bestX: { c: Point; d: number } | null = null;
  let bestY: { c: Point; d: number } | null = null;
  for (const c of candidates) {
    const dx = Math.abs(c.x - target.x);
    const dy = Math.abs(c.y - target.y);
    if (dx <= thresholdWorld && (!bestX || dx < bestX.d)) bestX = { c, d: dx };
    if (dy <= thresholdWorld && (!bestY || dy < bestY.d)) bestY = { c, d: dy };
  }
  if (!bestX && !bestY) return null;
  const point = { ...target };
  const guides: AxisGuide[] = [];
  if (bestX) {
    point.x = bestX.c.x;
    guides.push({ from: bestX.c, axis: "x" });
  }
  if (bestY) {
    point.y = bestY.c.y;
    guides.push({ from: bestY.c, axis: "y" });
  }
  return { point, guides };
}

// Ray-casting point-in-polygon test — used by the lasso select tool to
// decide which elements a freehand loop captured (tested against each
// element's own representative point: a line's midpoint, a shape's center).
export function pointInPolygon(point: Point, polygon: Point[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersect = yi > point.y !== yj > point.y && point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// Shoelace formula. World units are meters, so this returns m² directly.
export function polygonArea(points: Point[]): number {
  if (points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}
