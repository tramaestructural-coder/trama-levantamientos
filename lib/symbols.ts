import { makeId, type Point } from "./geometry";
import type { LineColor, MeasureLine, SymbolInstance } from "./types";

export const WINDOW_DEPTH = 0.06; // half-depth, meters — fixed regardless of length

function line(a: Point, b: Point, color: LineColor, value = ""): MeasureLine {
  return {
    id: makeId("l"),
    kind: "measure",
    x1: a.x,
    y1: a.y,
    x2: b.x,
    y2: b.y,
    mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    color,
    value,
  };
}

export function makeRectLines(p0: Point, p1: Point, color: LineColor): MeasureLine[] {
  const corners = [
    { x: p0.x, y: p0.y },
    { x: p1.x, y: p0.y },
    { x: p1.x, y: p1.y },
    { x: p0.x, y: p1.y },
  ];
  return corners.map((a, i) => {
    const b = corners[(i + 1) % 4];
    return line(a, b, color, Math.hypot(b.x - a.x, b.y - a.y).toFixed(2));
  });
}

// Approximates an ellipse with 4 curved lines (top/right/bottom/left arcs),
// bowing each segment's control point outward — not a true ellipse, but
// close enough for a floor-plan sketch.
export function makeEllipseLines(p0: Point, p1: Point, color: LineColor): MeasureLine[] {
  const cx = (p0.x + p1.x) / 2;
  const cy = (p0.y + p1.y) / 2;
  const rx = Math.abs(p1.x - p0.x) / 2;
  const ry = Math.abs(p1.y - p0.y) / 2;
  const pts = [
    { x: cx, y: cy - ry },
    { x: cx + rx, y: cy },
    { x: cx, y: cy + ry },
    { x: cx - rx, y: cy },
  ];
  const bow = 0.55;
  return pts.map((a, i) => {
    const b = pts[(i + 1) % 4];
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    const l = line(a, b, color);
    l.mid = { x: cx + (midX - cx) * (1 + bow), y: cy + (midY - cy) * (1 + bow) };
    return l;
  });
}

// --- door / window "dynamic blocks" ----------------------------------------
//
// Unlike the other symbols above, door and window are stored as a single
// SymbolInstance (anchor point + angle + length) and their geometry below is
// derived from that each render. That's what lets a resize handle change
// `length` and have the whole shape (swing arc included) scale from it
// instead of just stretching one independent line.

function toWorld(s: SymbolInstance, localX: number, localY: number): Point {
  const cos = Math.cos(s.angle);
  const sin = Math.sin(s.angle);
  const lx = localX * s.length;
  const ly = localY * s.length;
  return { x: s.x + lx * cos - ly * sin, y: s.y + lx * sin + ly * cos };
}

export function doorGeometry(s: SymbolInstance) {
  const hinge = { x: s.x, y: s.y };
  const leafEnd = toWorld(s, 1, 0);
  const swingEnd = toWorld(s, 0, -1);
  const arcMid = toWorld(s, 0.68, -0.28);
  return { hinge, leafEnd, swingEnd, arcMid };
}

export function windowGeometry(s: SymbolInstance) {
  const cos = Math.cos(s.angle);
  const sin = Math.sin(s.angle);
  const dir = { x: cos, y: sin };
  const perp = { x: -sin, y: cos };
  const p1 = { x: s.x, y: s.y };
  const p2 = { x: s.x + dir.x * s.length, y: s.y + dir.y * s.length };
  const hd = WINDOW_DEPTH;
  const corners = [
    { x: p1.x + perp.x * hd, y: p1.y + perp.y * hd },
    { x: p2.x + perp.x * hd, y: p2.y + perp.y * hd },
    { x: p2.x - perp.x * hd, y: p2.y - perp.y * hd },
    { x: p1.x - perp.x * hd, y: p1.y - perp.y * hd },
  ];
  return { p1, p2, corners };
}

export function newDoor(anchor: Point, color: LineColor): SymbolInstance {
  return { id: makeId("sym"), kind: "door", x: anchor.x, y: anchor.y, angle: 0, length: 0.9, color };
}

export function newWindow(anchor: Point, color: LineColor): SymbolInstance {
  return { id: makeId("sym"), kind: "window", x: anchor.x, y: anchor.y, angle: 0, length: 1.2, color };
}
