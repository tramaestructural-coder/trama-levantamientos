import { makeId, type Point } from "./geometry";
import type { LineColor, MeasureLine, SymbolInstance } from "./types";

export const WINDOW_DEFAULT_DEPTH = 0.12; // full thickness, meters — adjustable per instance via `depth`
export const DOOR_DEFAULT_FRAME_DEPTH = 0.15; // wall-thickness fit for the frame ticks, meters

function line(a: Point, b: Point, color: LineColor, value = "", groupId?: string): MeasureLine {
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
    groupId,
  };
}

// The 4 edges share a groupId so they drag as one rigid rectangle instead
// of 4 separate lines — erasing one edge clears it on the rest (see
// MeasureLine.groupId), and they fall back to independent lines.
export function makeRectLines(p0: Point, p1: Point, color: LineColor): MeasureLine[] {
  const groupId = makeId("grp");
  const corners = [
    { x: p0.x, y: p0.y },
    { x: p1.x, y: p0.y },
    { x: p1.x, y: p1.y },
    { x: p0.x, y: p1.y },
  ];
  return corners.map((a, i) => {
    const b = corners[(i + 1) % 4];
    return line(a, b, color, Math.hypot(b.x - a.x, b.y - a.y).toFixed(2), groupId);
  });
}

// --- door / window "dynamic blocks" ----------------------------------------
//
// Unlike the other symbols above, door and window are stored as a single
// SymbolInstance (anchor point + angle + length) and their geometry below is
// derived from that each render. That's what lets a resize handle change
// `length` and have the whole shape scale from it instead of just
// stretching one independent line.

function toWorld(s: SymbolInstance, localX: number, localY: number): Point {
  const cos = Math.cos(s.angle);
  const sin = Math.sin(s.angle);
  const lx = localX * s.length;
  const ly = localY * s.length;
  return { x: s.x + lx * cos - ly * sin, y: s.y + lx * sin + ly * cos };
}

// hinge->openEnd is "la puerta" — the leaf drawn OPEN, perpendicular to the
// wall (matching the reference drawing, not drawn closed-along-the-wall).
// hinge->arcMid->closedEnd is "la proyección" — the dashed sweep back to
// where the leaf would sit flush in the wall. hingeTick/closedEndTick are
// the frame: each runs from its point into the wall by `frameDepth`,
// symbolizing the opening cut through the wall's thickness. `mirror`
// (1 | -1) flips which side of the hinge the frame/opening extends to
// (along the wall) — not which way the leaf swings (that stays fixed).
export function doorGeometry(s: SymbolInstance) {
  const cos = Math.cos(s.angle);
  const sin = Math.sin(s.angle);
  const perp = { x: -sin, y: cos };
  const mirror = s.mirror ?? 1;
  const frameDepth = s.frameDepth ?? DOOR_DEFAULT_FRAME_DEPTH;
  const hinge = { x: s.x, y: s.y };
  const closedEnd = toWorld(s, mirror, 0);
  const openEnd = toWorld(s, 0, -1);
  const arcMid = toWorld(s, 0.68 * mirror, -0.28);
  const tickVec = { x: perp.x * frameDepth, y: perp.y * frameDepth };
  return {
    hinge,
    closedEnd,
    openEnd,
    arcMid,
    perp,
    mirror,
    frameDepth,
    hingeTick: { a: hinge, b: { x: hinge.x + tickVec.x, y: hinge.y + tickVec.y } },
    closedEndTick: { a: closedEnd, b: { x: closedEnd.x + tickVec.x, y: closedEnd.y + tickVec.y } },
  };
}

// A window is a plain rectangle (length x depth) with a line through its
// middle. `length` is the long, wall-parallel dimension (what gets
// measured); `depth` is the short one, only there to fit the wall's
// thickness — each of the 4 corners can stretch either dimension
// independently (never diagonally), and alignment snaps a long EDGE (not
// the centerline) onto a nearby wall face.
export function windowGeometry(s: SymbolInstance) {
  const cos = Math.cos(s.angle);
  const sin = Math.sin(s.angle);
  const dir = { x: cos, y: sin };
  const perp = { x: -sin, y: cos };
  const p1 = { x: s.x, y: s.y };
  const p2 = { x: s.x + dir.x * s.length, y: s.y + dir.y * s.length };
  const hd = (s.depth ?? WINDOW_DEFAULT_DEPTH) / 2;
  // Corner order/index is load-bearing for the resize handles in
  // CanvasBoard: [ (p1,+face), (p2,+face), (p2,-face), (p1,-face) ].
  const corners = [
    { x: p1.x + perp.x * hd, y: p1.y + perp.y * hd },
    { x: p2.x + perp.x * hd, y: p2.y + perp.y * hd },
    { x: p2.x - perp.x * hd, y: p2.y - perp.y * hd },
    { x: p1.x - perp.x * hd, y: p1.y - perp.y * hd },
  ];
  return { p1, p2, dir, perp, hd, corners };
}

// For each window corner index: which end (p1/p2) and which face (+1/-1)
// it belongs to, and the partner corner index sharing its long edge
// (length-axis stretch) vs. its short edge (depth-axis stretch).
export const WINDOW_CORNERS = [
  { end: "p1" as const, face: 1, lengthPartner: 1, depthPartner: 3 },
  { end: "p2" as const, face: 1, lengthPartner: 0, depthPartner: 2 },
  { end: "p2" as const, face: -1, lengthPartner: 3, depthPartner: 1 },
  { end: "p1" as const, face: -1, lengthPartner: 2, depthPartner: 0 },
];

export function newDoor(anchor: Point, color: LineColor): SymbolInstance {
  return {
    id: makeId("sym"),
    kind: "door",
    x: anchor.x,
    y: anchor.y,
    angle: 0,
    length: 0.8,
    frameDepth: DOOR_DEFAULT_FRAME_DEPTH,
    mirror: 1,
    color,
  };
}

export function newWindow(anchor: Point, color: LineColor): SymbolInstance {
  return {
    id: makeId("sym"),
    kind: "window",
    x: anchor.x,
    y: anchor.y,
    angle: 0,
    length: 1.2,
    depth: WINDOW_DEFAULT_DEPTH,
    color,
  };
}
