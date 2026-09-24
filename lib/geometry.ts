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
