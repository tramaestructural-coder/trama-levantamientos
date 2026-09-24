import { samePoint, type Point } from "./geometry";

export type LineColor = "#1c1b1a" | "#dc2626" | "#16a34a" | "#2563eb" | "#ea580c";

export type MeasureLine = {
  id: string;
  kind: "measure";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  // Control point for the 3-point tension curve. Equals the straight
  // midpoint until the user drags it to bend the line.
  mid: Point;
  color: LineColor;
  value: string;
};

export type NoteStroke = {
  id: string;
  kind: "note";
  points: number[];
  color: LineColor;
};

export type AreaZone = {
  id: string;
  points: Point[];
  color: LineColor;
};

// A door or window "dynamic block": geometry is computed from x/y (anchor),
// angle and length each render, rather than stored as independent lines —
// that's what lets it resize proportionally and re-align to a wall instead
// of distorting like a plain group of lines would.
export type SymbolKind = "door" | "window";

export type SymbolInstance = {
  id: string;
  kind: SymbolKind;
  x: number;
  y: number;
  angle: number; // radians
  length: number; // meters, along `angle` from (x,y)
  color: LineColor;
};

export type BoardState = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  lines: MeasureLine[];
  notes: NoteStroke[];
  areas: AreaZone[];
  symbols: SymbolInstance[];
};

export type BoardMeta = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  lineCount: number;
  areaCount: number;
};

export const PEN_COLORS: LineColor[] = [
  "#1c1b1a",
  "#dc2626",
  "#16a34a",
  "#2563eb",
  "#ea580c",
];

export function newBoardId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

export function emptyBoard(id: string, name = "Levantamiento sin nombre"): BoardState {
  const now = Date.now();
  return { id, name, createdAt: now, updatedAt: now, lines: [], notes: [], areas: [], symbols: [] };
}

function straightMid(line: Pick<MeasureLine, "x1" | "y1" | "x2" | "y2">): Point {
  return { x: (line.x1 + line.x2) / 2, y: (line.y1 + line.y2) / 2 };
}

// Resizes a line along the direction it was drawn so its length matches the
// typed value exactly, keeping the start point fixed (the end point moves).
// Curved lines (mid dragged away from the straight midpoint) are left alone,
// since a typed straight-line length wouldn't make sense for their geometry.
export function resizeLineToValue(line: MeasureLine, valueStr: string): MeasureLine {
  const n = parseFloat(valueStr.replace(",", "."));
  const isCurved = !samePoint(line.mid, straightMid(line), 0.03);
  if (!Number.isFinite(n) || n <= 0 || isCurved) {
    return { ...line, value: valueStr };
  }
  const dx = line.x2 - line.x1;
  const dy = line.y2 - line.y1;
  const dist = Math.hypot(dx, dy);
  const ux = dist > 1e-6 ? dx / dist : 1;
  const uy = dist > 1e-6 ? dy / dist : 0;
  const x2 = line.x1 + ux * n;
  const y2 = line.y1 + uy * n;
  return { ...line, value: valueStr, x2, y2, mid: { x: (line.x1 + x2) / 2, y: (line.y1 + y2) / 2 } };
}

// Moves one (or both) endpoints of a line to `newPoint` — used by the
// "estirar" tool when dragging a shared vertex. Keeps a curved line's shape
// by shifting its control point along with the endpoint; a straight line's
// control point just tracks the new midpoint. The typed value is replaced
// with the new measured length, since the geometry itself just changed.
export function moveLineEndpoint(
  line: MeasureLine,
  matchStart: boolean,
  matchEnd: boolean,
  newPoint: Point,
  oldPoint: Point
): MeasureLine {
  const wasCurved = !samePoint(line.mid, straightMid(line), 0.03);
  let { x1, y1, x2, y2 } = line;
  if (matchStart) {
    x1 = newPoint.x;
    y1 = newPoint.y;
  }
  if (matchEnd) {
    x2 = newPoint.x;
    y2 = newPoint.y;
  }
  const mid = wasCurved
    ? { x: line.mid.x + (newPoint.x - oldPoint.x) / 2, y: line.mid.y + (newPoint.y - oldPoint.y) / 2 }
    : { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
  const length = Math.hypot(x2 - x1, y2 - y1);
  return { ...line, x1, y1, x2, y2, mid, value: length > 0 ? length.toFixed(2) : line.value };
}
