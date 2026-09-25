"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Stage, Layer, Line, Circle, Text, Rect, Ellipse, Shape, Group, Image as KonvaImage } from "react-konva";
import type Konva from "konva";
import type { KonvaEventObject } from "konva/lib/Node";
import { jsPDF } from "jspdf";
import {
  clamp,
  distance,
  findAxisAlignment,
  findPerpendicularSnap,
  findSnapPoint,
  findWallAlignment,
  makeId,
  pointInPolygon,
  polygonArea,
  projectOntoSegment,
  resizeEndpointTarget,
  samePoint,
  sampleCurvePoints,
  snapToAxis,
  snapToGrid,
  type AxisGuide,
  type Point,
} from "@/lib/geometry";
import { touchCenter, touchDistance } from "@/lib/pinch";
import { getBoard, saveBoard, savePdfExport } from "@/lib/storage";
import {
  doorGeometry,
  DOOR_DEFAULT_FRAME_DEPTH,
  makeRectLines,
  newDoor,
  newWindow,
  WINDOW_CORNERS,
  WINDOW_DEFAULT_DEPTH,
  windowGeometry,
} from "@/lib/symbols";
import {
  emptyBoard,
  moveLineEndpoint,
  newBoardId,
  PEN_COLORS,
  resizeLineToValue,
  type AreaZone,
  type BoardState,
  type EllipseZone,
  type LineColor,
  type MeasureLine,
  type NoteStroke,
  type SymbolInstance,
  type TextLabel,
} from "@/lib/types";
import Toolbar from "./Toolbar";
import LayersPanel from "./LayersPanel";

// World units are meters: a 150x150 m bounded canvas with a 1m reference grid
// (plus a subtler 50cm grid that fades in once you're zoomed in enough).
const WORLD_W = 150;
const WORLD_H = 150;
const MIN_SCALE = 5; // px per meter, zoomed out
const MAX_SCALE = 400; // px per meter, zoomed in
const DEFAULT_SCALE = 50; // px per meter, initial view
const SNAP_PX = 16; // vertex magnet radius, screen px
const GRID_SNAP_PX = 10; // grid magnet radius, screen px — lighter than the vertex snap
const FINE_GRID_STEP = 0.5; // meters
const FINE_GRID_MIN_SCALE = 70; // px per meter — below this the 50cm grid is too dense to show
const ULTRA_FINE_GRID_STEP = 0.1; // meters
const ULTRA_FINE_GRID_MIN_SCALE = 150; // px per meter — below this the 10cm grid is too dense to show
const LABEL_MIN_SCALE = 15; // px per meter — below this, value labels hide to avoid crossing lines
const TAP_THRESHOLD_PX = 8;
const HISTORY_LIMIT = 50;
const WALL_ALIGN_DIST = 0.5; // meters — how close a door/window has to get to a wall to snap onto it

// Dimension text sized in WORLD units (constant / DEFAULT_SCALE) instead of
// screen px (constant / current scale) — it grows and shrinks along with
// the drawing itself as you zoom, instead of staying a fixed size that
// overwhelms a zoomed-out plan or looks tiny against a zoomed-in one. Kept
// small so tightly-packed dimensions (e.g. several short wall segments)
// don't crowd each other out.
const DIM_FONT_SIZE = 7 / DEFAULT_SCALE;
const DIM_FONT_SIZE_SMALL = 6.5 / DEFAULT_SCALE;

// This app measures in centimeters — world units stay meters internally
// (geometry, grid, snapping), but every linear measurement is shown/typed
// as a bare whole-number cm value ("un muro de 1 metro" reads as "100").
function formatCm(meters: number): string {
  return Math.round(meters * 100).toString();
}

// Konva's Text `align` prop only centers within an explicit `width` box, so
// a plain anchored Text is left-aligned at its x, not centered on it — for
// a short bare number that reads as visibly off-center from the thing it's
// measuring. These are all set in the monospace font stack, so every
// character has the same width; approximate it to compute an offsetX that
// puts the text's actual center on the anchor point instead.
const DIM_CHAR_WIDTH_RATIO = 0.6;
function dimOffsetX(text: string, fontSize: number): number {
  return (text.length * fontSize * DIM_CHAR_WIDTH_RATIO) / 2;
}

// Free-text labels' size, in the same world-scaled units as the dimension
// constants above — at the default zoom this renders identically to the old
// fixed 16px, but now it's a real stored number the "escalar" tool can change.
const DEFAULT_TEXT_FONT_SIZE = 16 / DEFAULT_SCALE;
const PINCH_SCALE_MIN = 0.15;
const PINCH_SCALE_MAX = 8;
const ERASER_CURSOR_RADIUS = 15; // screen px — matches roughly the hitStrokeWidth erasable shapes use

// Ids of everything a lasso loop (or a text tap) currently has selected,
// grouped by the board array it lives in — an element only ever appears in
// its own array, so "is anything selected" is just "is every array empty".
type LassoSelection = {
  lines: string[];
  areas: string[];
  symbols: string[];
  ellipses: string[];
  texts: string[];
  notes: string[];
};

function emptyLassoSelection(): LassoSelection {
  return { lines: [], areas: [], symbols: [], ellipses: [], texts: [], notes: [] };
}

function lassoSelectionIsEmpty(sel: LassoSelection): boolean {
  return !sel.lines.length && !sel.areas.length && !sel.symbols.length && !sel.ellipses.length && !sel.texts.length && !sel.notes.length;
}

// Which elements a freehand loop captured — tested against a single
// representative point per element (a line's midpoint, a shape's center)
// rather than full containment, so a rough lasso still picks things up.
function computeLassoSelection(board: BoardState, polygon: Point[]): LassoSelection {
  const sel = emptyLassoSelection();
  if (polygon.length < 3) return sel;
  board.lines.forEach((l) => {
    if (pointInPolygon(l.mid, polygon)) sel.lines.push(l.id);
  });
  board.areas.forEach((a) => {
    const cx = a.points.reduce((s, p) => s + p.x, 0) / a.points.length;
    const cy = a.points.reduce((s, p) => s + p.y, 0) / a.points.length;
    if (pointInPolygon({ x: cx, y: cy }, polygon)) sel.areas.push(a.id);
  });
  board.symbols.forEach((s) => {
    if (pointInPolygon({ x: s.x, y: s.y }, polygon)) sel.symbols.push(s.id);
  });
  board.ellipses.forEach((el) => {
    if (pointInPolygon({ x: el.cx, y: el.cy }, polygon)) sel.ellipses.push(el.id);
  });
  board.texts.forEach((t) => {
    if (pointInPolygon({ x: t.x, y: t.y }, polygon)) sel.texts.push(t.id);
  });
  board.notes.forEach((n) => {
    let sx = 0;
    let sy = 0;
    let count = 0;
    for (let i = 0; i < n.points.length; i += 2) {
      sx += n.points[i];
      sy += n.points[i + 1];
      count += 1;
    }
    if (count && pointInPolygon({ x: sx / count, y: sy / count }, polygon)) sel.notes.push(n.id);
  });
  return sel;
}

// The world-space box the selection currently occupies — recomputed from
// live board state each render, so it tracks the elements as they scale.
function computeSelectionBBox(board: BoardState, sel: LassoSelection): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const extend = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  board.lines.forEach((l) => {
    if (!sel.lines.includes(l.id)) return;
    extend(l.x1, l.y1);
    extend(l.x2, l.y2);
  });
  board.areas.forEach((a) => {
    if (!sel.areas.includes(a.id)) return;
    a.points.forEach((p) => extend(p.x, p.y));
  });
  board.symbols.forEach((s) => {
    if (!sel.symbols.includes(s.id)) return;
    if (s.kind === "door") {
      const g = doorGeometry(s);
      extend(g.hinge.x, g.hinge.y);
      extend(g.closedEnd.x, g.closedEnd.y);
      extend(g.openEnd.x, g.openEnd.y);
    } else {
      windowGeometry(s).corners.forEach((c) => extend(c.x, c.y));
    }
  });
  board.ellipses.forEach((el) => {
    if (!sel.ellipses.includes(el.id)) return;
    extend(el.cx - el.rx, el.cy - el.ry);
    extend(el.cx + el.rx, el.cy + el.ry);
  });
  board.texts.forEach((t) => {
    if (!sel.texts.includes(t.id)) return;
    extend(t.x, t.y);
  });
  board.notes.forEach((n) => {
    if (!sel.notes.includes(n.id)) return;
    for (let i = 0; i < n.points.length; i += 2) extend(n.points[i], n.points[i + 1]);
  });
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

function scalePointAround(anchor: Point, p: Point, k: number): Point {
  return { x: anchor.x + (p.x - anchor.x) * k, y: anchor.y + (p.y - anchor.y) * k };
}

// Frozen copies of exactly the selected elements, taken once when a pinch
// gesture starts — every subsequent frame scales from this fixed snapshot
// (not from the previous frame's already-scaled result), so the transform
// is a clean function of the live finger distance instead of compounding
// rounding error over many small steps.
type SelectionSnapshot = {
  lines: Map<string, MeasureLine>;
  areas: Map<string, AreaZone>;
  symbols: Map<string, SymbolInstance>;
  ellipses: Map<string, EllipseZone>;
  texts: Map<string, TextLabel>;
  notes: Map<string, NoteStroke>;
};

function snapshotSelection(board: BoardState, sel: LassoSelection): SelectionSnapshot {
  return {
    lines: new Map(board.lines.filter((l) => sel.lines.includes(l.id)).map((l) => [l.id, l])),
    areas: new Map(board.areas.filter((a) => sel.areas.includes(a.id)).map((a) => [a.id, a])),
    symbols: new Map(board.symbols.filter((s) => sel.symbols.includes(s.id)).map((s) => [s.id, s])),
    ellipses: new Map(board.ellipses.filter((el) => sel.ellipses.includes(el.id)).map((el) => [el.id, el])),
    texts: new Map(board.texts.filter((t) => sel.texts.includes(t.id)).map((t) => [t.id, t])),
    notes: new Map(board.notes.filter((n) => sel.notes.includes(n.id)).map((n) => [n.id, n])),
  };
}

// Applies a uniform scale by `k` around `anchor` (world coords) to every
// element in `snapshot`, writing the result onto the current board. A
// single anchor + uniform k keeps curves and rotated door/window angles
// geometrically consistent — see scalePointAround.
function applyGroupScale(board: BoardState, snapshot: SelectionSnapshot, anchor: Point, k: number): BoardState {
  return {
    ...board,
    lines: board.lines.map((l) => {
      const orig = snapshot.lines.get(l.id);
      if (!orig) return l;
      const p1 = scalePointAround(anchor, { x: orig.x1, y: orig.y1 }, k);
      const p2 = scalePointAround(anchor, { x: orig.x2, y: orig.y2 }, k);
      const mid = scalePointAround(anchor, orig.mid, k);
      const length = distance(p1, p2);
      return { ...l, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, mid, value: length > 0 ? length.toFixed(2) : l.value };
    }),
    areas: board.areas.map((a) => {
      const orig = snapshot.areas.get(a.id);
      if (!orig) return a;
      return { ...a, points: orig.points.map((p) => scalePointAround(anchor, p, k)) };
    }),
    symbols: board.symbols.map((s) => {
      const orig = snapshot.symbols.get(s.id);
      if (!orig) return s;
      const p = scalePointAround(anchor, { x: orig.x, y: orig.y }, k);
      return {
        ...s,
        x: p.x,
        y: p.y,
        length: orig.length * k,
        depth: orig.depth !== undefined ? orig.depth * k : undefined,
        frameDepth: orig.frameDepth !== undefined ? orig.frameDepth * k : undefined,
      };
    }),
    ellipses: board.ellipses.map((el) => {
      const orig = snapshot.ellipses.get(el.id);
      if (!orig) return el;
      const p = scalePointAround(anchor, { x: orig.cx, y: orig.cy }, k);
      return { ...el, cx: p.x, cy: p.y, rx: orig.rx * k, ry: orig.ry * k };
    }),
    texts: board.texts.map((t) => {
      const orig = snapshot.texts.get(t.id);
      if (!orig) return t;
      const p = scalePointAround(anchor, { x: orig.x, y: orig.y }, k);
      return { ...t, x: p.x, y: p.y, fontSize: (orig.fontSize ?? DEFAULT_TEXT_FONT_SIZE) * k };
    }),
    notes: board.notes.map((n) => {
      const orig = snapshot.notes.get(n.id);
      if (!orig) return n;
      const points: number[] = [];
      for (let i = 0; i < orig.points.length; i += 2) {
        const sp = scalePointAround(anchor, { x: orig.points[i], y: orig.points[i + 1] }, k);
        points.push(sp.x, sp.y);
      }
      return { ...n, points };
    }),
    updatedAt: Date.now(),
  };
}

// Rigid translate by `delta` (world units) — the "mover" tool's equivalent
// of applyGroupScale, same snapshot-from-gesture-start pattern.
function applyGroupTranslate(board: BoardState, snapshot: SelectionSnapshot, delta: Point): BoardState {
  return {
    ...board,
    lines: board.lines.map((l) => {
      const orig = snapshot.lines.get(l.id);
      if (!orig) return l;
      return {
        ...l,
        x1: orig.x1 + delta.x,
        y1: orig.y1 + delta.y,
        x2: orig.x2 + delta.x,
        y2: orig.y2 + delta.y,
        mid: { x: orig.mid.x + delta.x, y: orig.mid.y + delta.y },
      };
    }),
    areas: board.areas.map((a) => {
      const orig = snapshot.areas.get(a.id);
      if (!orig) return a;
      return { ...a, points: orig.points.map((p) => ({ x: p.x + delta.x, y: p.y + delta.y })) };
    }),
    symbols: board.symbols.map((s) => {
      const orig = snapshot.symbols.get(s.id);
      if (!orig) return s;
      return { ...s, x: orig.x + delta.x, y: orig.y + delta.y };
    }),
    ellipses: board.ellipses.map((el) => {
      const orig = snapshot.ellipses.get(el.id);
      if (!orig) return el;
      return { ...el, cx: orig.cx + delta.x, cy: orig.cy + delta.y };
    }),
    texts: board.texts.map((t) => {
      const orig = snapshot.texts.get(t.id);
      if (!orig) return t;
      return { ...t, x: orig.x + delta.x, y: orig.y + delta.y };
    }),
    notes: board.notes.map((n) => {
      const orig = snapshot.notes.get(n.id);
      if (!orig) return n;
      const points: number[] = [];
      for (let i = 0; i < orig.points.length; i += 2) points.push(orig.points[i] + delta.x, orig.points[i + 1] + delta.y);
      return { ...n, points };
    }),
    updatedAt: Date.now(),
  };
}

// Recolors every element in `sel`, regardless of type — every board array's
// element has its own `color` field.
function applyRecolorSelection(board: BoardState, sel: LassoSelection, color: LineColor): BoardState {
  return {
    ...board,
    lines: board.lines.map((l) => (sel.lines.includes(l.id) ? { ...l, color } : l)),
    areas: board.areas.map((a) => (sel.areas.includes(a.id) ? { ...a, color } : a)),
    symbols: board.symbols.map((s) => (sel.symbols.includes(s.id) ? { ...s, color } : s)),
    ellipses: board.ellipses.map((el) => (sel.ellipses.includes(el.id) ? { ...el, color } : el)),
    texts: board.texts.map((t) => (sel.texts.includes(t.id) ? { ...t, color } : t)),
    notes: board.notes.map((n) => (sel.notes.includes(n.id) ? { ...n, color } : n)),
    updatedAt: Date.now(),
  };
}

// Deletes every element in `sel` — mirrors handleEraseShape's rectangle
// groupId-breaking rule: an erased edge's surviving groupId siblings fall
// back to independent lines instead of staying linked to a gone edge.
function applyDeleteSelection(board: BoardState, sel: LassoSelection): BoardState {
  const erasedGroupIds = new Set(
    board.lines.filter((l) => sel.lines.includes(l.id) && l.groupId).map((l) => l.groupId as string)
  );
  return {
    ...board,
    lines: board.lines
      .filter((l) => !sel.lines.includes(l.id))
      .map((l) => (l.groupId && erasedGroupIds.has(l.groupId) ? { ...l, groupId: undefined } : l)),
    areas: board.areas.filter((a) => !sel.areas.includes(a.id)),
    symbols: board.symbols.filter((s) => !sel.symbols.includes(s.id)),
    ellipses: board.ellipses.filter((el) => !sel.ellipses.includes(el.id)),
    texts: board.texts.filter((t) => !sel.texts.includes(t.id)),
    notes: board.notes.filter((n) => !sel.notes.includes(n.id)),
    updatedAt: Date.now(),
  };
}

type Tool = "line" | "curve" | "stretch" | "select" | "rect" | "ellipse" | "note" | "text" | "eraser" | "pan" | "area" | "ruler" | "lasso" | "scale" | "move";

// Tools that share ONE selection (lassoSelection): switching between them
// keeps whatever's selected, since "escalar"/"mover" only make sense as a
// second step after "selecciona con select o lazo" — everything else
// (drawing tools, eraser, pan, ...) clears the selection on entry.
const SELECTION_TOOLS: readonly Tool[] = ["select", "lasso", "scale", "move"];

type EditingValue = {
  id: string;
  screenX: number;
  screenY: number;
  value: string;
  original: { x2: number; y2: number; mid: Point };
};

function flatten(points: Point[]): number[] {
  return points.flatMap((p) => [p.x, p.y]);
}

function hasDraggableAncestor(node: Konva.Node): boolean {
  let n: Konva.Node | null = node;
  while (n) {
    if (n.draggable()) return true;
    n = n.getParent();
  }
  return false;
}

// Every point a new line/area/symbol can snap onto: line endpoints plus each
// line's own (possibly curved) midpoint — without the midpoint, a curved
// wall's bend can't be used as an area corner.
function useHtmlImage(src: string | undefined): HTMLImageElement | null {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!src) {
      setImg(null);
      return;
    }
    const image = new window.Image();
    image.onload = () => setImg(image);
    image.src = src;
    return () => {
      image.onload = null;
    };
  }, [src]);
  return img;
}

function allSnapPoints(lines: MeasureLine[]): Point[] {
  const pts: Point[] = [];
  lines.forEach((l) => {
    pts.push({ x: l.x1, y: l.y1 }, { x: l.x2, y: l.y2 }, { x: l.mid.x, y: l.mid.y });
  });
  return pts;
}

export default function CanvasBoard({ boardId }: { boardId: string }) {
  const router = useRouter();
  const [board, setBoard] = useState<BoardState>(() => emptyBoard(boardId));
  const [loaded, setLoaded] = useState(false);
  const [tool, setToolRaw] = useState<Tool>("line");
  const [color, setColor] = useState<LineColor>(PEN_COLORS[0]);
  const [ortho, setOrtho] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [favoritesOpen, setFavoritesOpen] = useState(false);
  const [showDimensions, setShowDimensions] = useState(true);

  const [history, setHistory] = useState<BoardState[]>([]);
  const [future, setFuture] = useState<BoardState[]>([]);

  const [scale, setScale] = useState(DEFAULT_SCALE);
  const [pos, setPos] = useState<Point>({ x: 0, y: 0 });
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });

  const [drawingLine, setDrawingLine] = useState<{ start: Point; end: Point } | null>(null);
  const [lineAlignGuides, setLineAlignGuides] = useState<AxisGuide[] | null>(null);
  const [drawingNote, setDrawingNote] = useState<number[] | null>(null);
  const [drawingArea, setDrawingArea] = useState<Point[] | null>(null);
  const [areaMode, setAreaMode] = useState<"puntos" | "lineas">("puntos");
  const [drawingAreaChain, setDrawingAreaChain] = useState<Point[] | null>(null);
  const [ruler, setRuler] = useState<{ start: Point; end: Point | null; hover: Point | null } | null>(null);
  const [drawingBox, setDrawingBox] = useState<{ start: Point; end: Point } | null>(null);
  const [editingValue, setEditingValue] = useState<EditingValue | null>(null);
  const [editingText, setEditingText] = useState<{ id: string | null; screenX: number; screenY: number; x: number; y: number; value: string } | null>(
    null
  );
  const [editingDoorWidth, setEditingDoorWidth] = useState<{ id: string; screenX: number; screenY: number; value: string } | null>(null);
  const [doorHingeReadout, setDoorHingeReadout] = useState<{ x: number; y: number; text: string } | null>(null);
  const [lassoPoints, setLassoPoints] = useState<Point[] | null>(null);
  const [lassoSelection, setLassoSelection] = useState<LassoSelection | null>(null);
  const [eraserCursor, setEraserCursor] = useState<Point | null>(null);

  const stageRef = useRef<Konva.Stage>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hasFitRef = useRef(false);
  const pinchRef = useRef<{ dist: number; center: Point; scale: number; pos: Point } | null>(null);
  // Drives BOTH the 2-finger pinch and the 1-finger/mouse drag-to-scale
  // paths for the "escalar" tool — same anchor+snapshot+reference-distance
  // shape either way, just populated by a different gesture.
  const objectPinchRef = useRef<{ selection: LassoSelection; anchor: Point; dist: number; snapshot: SelectionSnapshot } | null>(null);
  const moveOriginRef = useRef<{ selection: LassoSelection; snapshot: SelectionSnapshot; startWorld: Point } | null>(null);
  const stretchOriginRef = useRef<Point | null>(null);
  const stretchDragStartRef = useRef<Point | null>(null);
  const stretchConnectionsRef = useRef<{
    lines: { id: string; matchStart: boolean; matchEnd: boolean }[];
    areas: { id: string; pointIndex: number }[];
  }>({ lines: [], areas: [] });
  const lineDragOriginRef = useRef<{ start: Point; end: Point; mid: Point } | null>(null);
  const lineDragConnectionsRef = useRef<
    { id: string; matchStart: boolean; matchEnd: boolean; end: "start" | "end" }[]
  >([]);
  const lineDragAreaConnectionsRef = useRef<{ id: string; pointIndex: number; end: "start" | "end" }[]>([]);
  const lineDragGroupOriginRef = useRef<{ id: string; x1: number; y1: number; x2: number; y2: number; mid: Point }[]>([]);
  const symbolDragOriginRef = useRef<{ x: number; y: number; angle: number; length: number } | null>(null);
  const doorResizeOriginRef = useRef<{ id: string } | null>(null);
  const doorFrameResizeOriginRef = useRef<{ id: string } | null>(null);
  const windowResizeOriginRef = useRef<{
    id: string;
    cornerIndex: number;
    startCorner: Point;
    lengthFixed: Point;
    depthFixed: Point;
    dir: Point;
    perp: Point;
    angle: number;
    length: number;
    depth: number;
  } | null>(null);
  const ellipseDragOriginRef = useRef<{ cx: number; cy: number } | null>(null);
  const ellipseResizeOriginRef = useRef<{ id: string } | null>(null);
  const textDragOriginRef = useRef<{ id: string; x: number; y: number } | null>(null);
  const backgroundDragOriginRef = useRef<{ x: number; y: number } | null>(null);
  const backgroundResizeOriginRef = useRef<{ x: number; y: number; width: number; height: number; aspect: number } | null>(
    null
  );
  const boardRef = useRef(board);

  useEffect(() => {
    boardRef.current = board;
  }, [board]);

  const backgroundImage = useHtmlImage(board.background?.dataUrl);

  const setTool = useCallback((t: Tool) => {
    setDrawingLine(null);
    setDrawingNote(null);
    setDrawingArea(null);
    setDrawingAreaChain(null);
    setDrawingBox(null);
    setFavoritesOpen(false);
    setEditingText(null);
    setEditingDoorWidth(null);
    setDoorHingeReadout(null);
    setLineAlignGuides(null);
    setRuler(null);
    setLassoPoints(null);
    setEraserCursor(null);
    objectPinchRef.current = null;
    moveOriginRef.current = null;
    // "escalar"/"mover" only exist as a second step after selecting with
    // "select" or "lazo" — keep the selection when moving between any of
    // those four tools, drop it for anything else (a new drawing tool,
    // eraser, pan, ...).
    if (!SELECTION_TOOLS.includes(t)) setLassoSelection(null);
    setToolRaw(t);
  }, []);

  // --- undo / redo -----------------------------------------------------------

  const pushHistory = useCallback(() => {
    setHistory((h) => [...h.slice(-(HISTORY_LIMIT - 1)), boardRef.current]);
    setFuture([]);
  }, []);

  const undo = useCallback(() => {
    setHistory((h) => {
      if (!h.length) return h;
      const prev = h[h.length - 1];
      setFuture((f) => [boardRef.current, ...f].slice(0, HISTORY_LIMIT));
      setBoard(prev);
      return h.slice(0, -1);
    });
  }, []);

  const redo = useCallback(() => {
    setFuture((f) => {
      if (!f.length) return f;
      const next = f[0];
      setHistory((h) => [...h.slice(-(HISTORY_LIMIT - 1)), boardRef.current]);
      setBoard(next);
      return f.slice(1);
    });
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === "z" && e.shiftKey) {
        e.preventDefault();
        redo();
      } else if (key === "z") {
        e.preventDefault();
        undo();
      } else if (key === "y") {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [undo, redo]);

  // --- initial load + responsive sizing -----------------------------------

  useEffect(() => {
    let cancelled = false;
    getBoard(boardId).then((saved) => {
      if (cancelled) return;
      // Older saved boards may predate the symbols/ellipses/texts fields.
      setBoard(
        saved
          ? { ...saved, symbols: saved.symbols ?? [], ellipses: saved.ellipses ?? [], texts: saved.texts ?? [] }
          : emptyBoard(boardId)
      );
      setLoaded(true);
      setHistory([]);
      setFuture([]);
    });
    return () => {
      cancelled = true;
    };
  }, [boardId]);

  useEffect(() => {
    if (!loaded) return;
    const timeout = setTimeout(() => {
      saveBoard(board).catch(() => {});
    }, 400);
    return () => clearTimeout(timeout);
  }, [board, loaded]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      setStageSize({ width: rect.width, height: rect.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (hasFitRef.current) return;
    if (stageSize.width === 0 || stageSize.height === 0) return;
    hasFitRef.current = true;
    setScale(DEFAULT_SCALE);
    setPos({
      x: stageSize.width / 2 - (WORLD_W / 2) * DEFAULT_SCALE,
      y: stageSize.height / 2 - (WORLD_H / 2) * DEFAULT_SCALE,
    });
  }, [stageSize]);

  const clampPos = useCallback(
    (p: Point, s: number): Point => {
      const margin = 220;
      const minX = stageSize.width - WORLD_W * s - margin;
      const maxX = margin;
      const minY = stageSize.height - WORLD_H * s - margin;
      const maxY = margin;
      return {
        x: clamp(p.x, Math.min(minX, maxX), Math.max(minX, maxX)),
        y: clamp(p.y, Math.min(minY, maxY), Math.max(minY, maxY)),
      };
    },
    [stageSize]
  );

  // --- coordinate helpers ---------------------------------------------------

  const toWorld = useCallback(
    (screen: Point): Point => ({
      x: (screen.x - pos.x) / scale,
      y: (screen.y - pos.y) / scale,
    }),
    [pos, scale]
  );

  const allEndpoints = useCallback((): Point[] => {
    const pts: Point[] = [];
    board.lines.forEach((l) => {
      pts.push({ x: l.x1, y: l.y1 }, { x: l.x2, y: l.y2 });
    });
    return pts;
  }, [board.lines]);

  const uniqueVertices = useMemo(() => {
    const seen: Point[] = [];
    for (const p of allEndpoints()) {
      if (!seen.some((s) => samePoint(s, p))) seen.push(p);
    }
    return seen;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board.lines]);

  // Snap to whatever grid resolution is currently visible: whole meters when
  // zoomed out, 50cm once the finer grid fades in, 10cm once zoomed in further still.
  const gridStep =
    scale >= ULTRA_FINE_GRID_MIN_SCALE ? ULTRA_FINE_GRID_STEP : scale >= FINE_GRID_MIN_SCALE ? FINE_GRID_STEP : 1;

  // --- pointer drawing -------------------------------------------------------

  const finalizeArea = useCallback(
    (points: Point[]) => {
      if (points.length < 3) return;
      pushHistory();
      const id = makeId("a");
      setBoard((b) => ({
        ...b,
        areas: [...b.areas, { id, points, color } as AreaZone],
        updatedAt: Date.now(),
      }));
    },
    [color, pushHistory]
  );

  // "Líneas" area mode: tap a wall in order instead of tapping vertices —
  // each line's own curve gets sampled into the chain so a curved wall
  // becomes the area's actual boundary instead of a straight approximation
  // through its midpoint (what tapping just its 3 snap points would give).
  const handleAreaLineClick = useCallback(
    (line: MeasureLine) => {
      const threshold = SNAP_PX / scale;
      const p1 = { x: line.x1, y: line.y1 };
      const p2 = { x: line.x2, y: line.y2 };
      const isCurved = !samePoint(line.mid, { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }, 0.03);

      setDrawingAreaChain((prev) => {
        let chain: Point[];
        if (!prev || prev.length === 0) {
          chain = isCurved ? [p1, ...sampleCurvePoints(p1, line.mid, p2, 16)] : [p1, p2];
        } else {
          const last = prev[prev.length - 1];
          if (samePoint(last, p1, threshold)) {
            chain = [...prev, ...(isCurved ? sampleCurvePoints(p1, line.mid, p2, 16) : [p2])];
          } else if (samePoint(last, p2, threshold)) {
            chain = [...prev, ...(isCurved ? sampleCurvePoints(p2, line.mid, p1, 16) : [p1])];
          } else {
            return prev; // this wall doesn't connect to the chain's open end
          }
        }
        if (chain.length >= 4 && samePoint(chain[chain.length - 1], chain[0], threshold)) {
          finalizeArea(chain.slice(0, -1));
          return null;
        }
        return chain;
      });
    },
    [scale, finalizeArea]
  );

  const handlePointerDown = useCallback(
    (e: KonvaEventObject<MouseEvent | TouchEvent>) => {
      const stage = stageRef.current;
      if (!stage) return;
      // A mousedown/touchstart on a draggable child (curve mid-point, stretch
      // vertex/line handle) still bubbles up here — ignore it so we don't
      // also start a phantom line underneath the drag. Non-draggable shapes
      // (lines, labels) are fine to fall through: that's how a new line
      // snaps onto an existing vertex, and plain taps are filtered out below
      // by the tap-distance threshold anyway.
      if (e.target !== stage && hasDraggableAncestor(e.target)) return;
      const pointer = stage.getPointerPosition();
      if (!pointer) return;
      const world = toWorld(pointer);

      if (tool === "line") {
        const threshold = SNAP_PX / scale;
        const snapped =
          findSnapPoint(world, allEndpoints(), threshold) ??
          snapToGrid(world, GRID_SNAP_PX / scale, gridStep) ??
          world;
        setDrawingLine({ start: snapped, end: snapped });
      } else if (tool === "rect" || tool === "ellipse") {
        const threshold = SNAP_PX / scale;
        const snapped =
          findSnapPoint(world, allEndpoints(), threshold) ??
          snapToGrid(world, GRID_SNAP_PX / scale, gridStep) ??
          world;
        setDrawingBox({ start: snapped, end: snapped });
      } else if (tool === "note") {
        setDrawingNote([world.x, world.y]);
      } else if (tool === "area" && areaMode === "puntos") {
        const threshold = SNAP_PX / scale;
        const snapped = findSnapPoint(world, allSnapPoints(board.lines), threshold);
        if (!snapped) return;
        setDrawingArea((prev) => {
          const pts = prev ?? [];
          if (pts.length >= 3 && samePoint(snapped, pts[0], threshold)) {
            finalizeArea(pts);
            return null;
          }
          if (pts.length && samePoint(pts[pts.length - 1], snapped)) return pts;
          return [...pts, snapped];
        });
      } else if (tool === "select") {
        setLassoSelection(null);
      } else if (tool === "ruler") {
        const threshold = SNAP_PX / scale;
        const snapped =
          findSnapPoint(world, allSnapPoints(board.lines), threshold) ??
          snapToGrid(world, GRID_SNAP_PX / scale, gridStep) ??
          world;
        setRuler((prev) => (!prev || prev.end ? { start: snapped, end: null, hover: null } : { start: prev.start, end: snapped, hover: null }));
      } else if (tool === "lasso") {
        // Starting a new loop always clears whatever was selected before —
        // a plain tap (path never grows past this single point) just clears
        // it, which doubles as "tap empty space to deselect".
        setLassoSelection(null);
        setLassoPoints([world]);
      } else if (tool === "scale" && lassoSelection && !lassoSelectionIsEmpty(lassoSelection)) {
        // 1-finger/mouse version of the pinch: distance from the selection's
        // own center to the pointer, tracked the same way a 2-finger pinch
        // tracks the distance between the two touches (see handleTouchMove).
        const bbox = computeSelectionBBox(boardRef.current, lassoSelection);
        if (bbox) {
          const anchor = { x: (bbox.minX + bbox.maxX) / 2, y: (bbox.minY + bbox.maxY) / 2 };
          const anchorScreen = { x: anchor.x * scale + pos.x, y: anchor.y * scale + pos.y };
          pushHistory();
          objectPinchRef.current = {
            selection: lassoSelection,
            anchor,
            dist: Math.max(distance(anchorScreen, pointer), 1),
            snapshot: snapshotSelection(boardRef.current, lassoSelection),
          };
        }
      } else if (tool === "move" && lassoSelection && !lassoSelectionIsEmpty(lassoSelection)) {
        pushHistory();
        moveOriginRef.current = {
          selection: lassoSelection,
          snapshot: snapshotSelection(boardRef.current, lassoSelection),
          startWorld: world,
        };
      }
    },
    [tool, areaMode, scale, pos, toWorld, allEndpoints, board.lines, gridStep, finalizeArea, lassoSelection, pushHistory]
  );

  const handlePointerMove = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;
    const world = toWorld(pointer);

    if (tool === "line" && drawingLine) {
      const threshold = SNAP_PX / scale;
      const candidates = allEndpoints().filter((p) => !samePoint(p, drawingLine.start));
      const vertexSnap = findSnapPoint(world, candidates, threshold);
      const perpSnap = vertexSnap ? null : findPerpendicularSnap(drawingLine.start, world, board.lines, threshold);
      const alignResult = !vertexSnap && !perpSnap && !ortho ? findAxisAlignment(world, candidates, threshold) : null;
      let end = vertexSnap ?? perpSnap ?? alignResult?.point ?? snapToGrid(world, GRID_SNAP_PX / scale, gridStep) ?? world;
      if (ortho) end = snapToAxis(drawingLine.start, end);
      setDrawingLine({ start: drawingLine.start, end });
      setLineAlignGuides(alignResult?.guides ?? null);
    } else if ((tool === "rect" || tool === "ellipse") && drawingBox) {
      const threshold = SNAP_PX / scale;
      const candidates = allEndpoints().filter((p) => !samePoint(p, drawingBox.start));
      const vertexSnap = findSnapPoint(world, candidates, threshold);
      let end = vertexSnap ?? snapToGrid(world, GRID_SNAP_PX / scale, gridStep) ?? world;
      if (ortho) {
        const dx = end.x - drawingBox.start.x;
        const dy = end.y - drawingBox.start.y;
        const m = Math.max(Math.abs(dx), Math.abs(dy));
        end = {
          x: drawingBox.start.x + Math.sign(dx || 1) * m,
          y: drawingBox.start.y + Math.sign(dy || 1) * m,
        };
      }
      setDrawingBox({ start: drawingBox.start, end });
    } else if (tool === "note" && drawingNote) {
      setDrawingNote([...drawingNote, world.x, world.y]);
    } else if (tool === "ruler" && ruler && !ruler.end) {
      const threshold = SNAP_PX / scale;
      const vertexSnap = findSnapPoint(world, allSnapPoints(board.lines), threshold);
      let hover = vertexSnap ?? snapToGrid(world, GRID_SNAP_PX / scale, gridStep) ?? world;
      if (ortho) hover = snapToAxis(ruler.start, hover);
      setRuler({ start: ruler.start, end: null, hover });
    } else if (tool === "lasso" && lassoPoints) {
      setLassoPoints([...lassoPoints, world]);
    } else if (tool === "scale" && objectPinchRef.current) {
      const g = objectPinchRef.current;
      const anchorScreen = { x: g.anchor.x * scale + pos.x, y: g.anchor.y * scale + pos.y };
      const k = clamp(distance(anchorScreen, pointer) / g.dist, PINCH_SCALE_MIN, PINCH_SCALE_MAX);
      setBoard((b) => applyGroupScale(b, g.snapshot, g.anchor, k));
    } else if (tool === "move" && moveOriginRef.current) {
      const g = moveOriginRef.current;
      const delta = { x: world.x - g.startWorld.x, y: world.y - g.startWorld.y };
      setBoard((b) => applyGroupTranslate(b, g.snapshot, delta));
    }

    if (tool === "eraser") setEraserCursor(world);
  }, [tool, drawingLine, drawingBox, drawingNote, ruler, lassoPoints, ortho, scale, pos, toWorld, allEndpoints, board.lines, gridStep]);

  const handlePointerUp = useCallback(() => {
    if (tool === "line" && drawingLine) {
      const { start, end } = drawingLine;
      setLineAlignGuides(null);
      if (distance(start, end) * scale < TAP_THRESHOLD_PX) {
        setDrawingLine(null);
        return;
      }
      pushHistory();
      const id = makeId("l");
      const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
      const len = distance(start, end);
      const newLine: MeasureLine = {
        id,
        kind: "measure",
        x1: start.x,
        y1: start.y,
        x2: end.x,
        y2: end.y,
        mid,
        color,
        // Auto-fill with the length you drew it at — the live readout already
        // told you the number, so just tap it later if you need to correct it.
        value: len.toFixed(2),
      };
      setBoard((b) => ({ ...b, lines: [...b.lines, newLine], updatedAt: Date.now() }));
      setDrawingLine(null);
    } else if (tool === "rect" && drawingBox) {
      const { start, end } = drawingBox;
      if (distance(start, end) * scale < TAP_THRESHOLD_PX) {
        setDrawingBox(null);
        return;
      }
      pushHistory();
      const newLines = makeRectLines(start, end, color);
      setBoard((b) => ({ ...b, lines: [...b.lines, ...newLines], updatedAt: Date.now() }));
      setDrawingBox(null);
    } else if (tool === "ellipse" && drawingBox) {
      const { start, end } = drawingBox;
      if (distance(start, end) * scale < TAP_THRESHOLD_PX) {
        setDrawingBox(null);
        return;
      }
      pushHistory();
      const cx = (start.x + end.x) / 2;
      const cy = (start.y + end.y) / 2;
      const rx = Math.abs(end.x - start.x) / 2;
      const ry = Math.abs(end.y - start.y) / 2;
      const ellipse: EllipseZone = { id: makeId("e"), cx, cy, rx, ry, color };
      setBoard((b) => ({ ...b, ellipses: [...b.ellipses, ellipse], updatedAt: Date.now() }));
      setDrawingBox(null);
    } else if (tool === "note" && drawingNote) {
      if (drawingNote.length >= 4) {
        pushHistory();
        const id = makeId("n");
        setBoard((b) => ({
          ...b,
          notes: [...b.notes, { id, kind: "note", points: drawingNote, color }],
          updatedAt: Date.now(),
        }));
      }
      setDrawingNote(null);
    } else if (tool === "text") {
      // Opened on pointer-up (not down): opening it on mousedown left the
      // trailing native mouseup/click still headed for the canvas, which
      // stole focus back from the freshly-mounted autoFocus input and
      // fired its onBlur (closing it) a moment after it appeared.
      const stage = stageRef.current;
      const pointer = stage?.getPointerPosition();
      if (pointer) {
        const world = toWorld(pointer);
        const screen = { x: world.x * scale + pos.x, y: world.y * scale + pos.y };
        setEditingText({ id: null, screenX: screen.x, screenY: screen.y, x: world.x, y: world.y, value: "" });
      }
    } else if (tool === "lasso" && lassoPoints) {
      if (lassoPoints.length >= 3) {
        const sel = computeLassoSelection(boardRef.current, lassoPoints);
        setLassoSelection(lassoSelectionIsEmpty(sel) ? null : sel);
      }
      setLassoPoints(null);
    } else if (tool === "scale") {
      objectPinchRef.current = null;
    } else if (tool === "move") {
      moveOriginRef.current = null;
    }
  }, [tool, drawingLine, drawingBox, drawingNote, lassoPoints, color, scale, pos, toWorld, pushHistory]);

  const handleEraseShape = useCallback(
    (id: string, kind: "measure" | "note" | "area" | "symbol" | "ellipse" | "text") => {
      if (tool !== "eraser") return;
      pushHistory();
      setBoard((b) => {
        let lines = b.lines;
        if (kind === "measure") {
          // Erasing one edge of a rectangle breaks the group — the rest
          // fall back to independent lines instead of staying rigidly
          // linked to an edge that no longer exists.
          const erased = b.lines.find((l) => l.id === id);
          lines = b.lines
            .filter((l) => l.id !== id)
            .map((l) => (erased?.groupId && l.groupId === erased.groupId ? { ...l, groupId: undefined } : l));
        }
        return {
          ...b,
          lines,
          notes: kind === "note" ? b.notes.filter((n) => n.id !== id) : b.notes,
          areas: kind === "area" ? b.areas.filter((a) => a.id !== id) : b.areas,
          symbols: kind === "symbol" ? b.symbols.filter((s) => s.id !== id) : b.symbols,
          ellipses: kind === "ellipse" ? b.ellipses.filter((e) => e.id !== id) : b.ellipses,
          texts: kind === "text" ? b.texts.filter((t) => t.id !== id) : b.texts,
          updatedAt: Date.now(),
        };
      });
    },
    [tool, pushHistory]
  );

  const openValueEditor = useCallback(
    // `fromLabel`: tapping the value label itself is always meant to edit
    // it, whatever tool happens to be active — only tapping the line's
    // BODY defers to the current tool (erase/select/drag/etc).
    (line: MeasureLine, fromLabel = false) => {
      if (tool === "eraser" || tool === "pan") return;
      if (!fromLabel && (tool === "area" || tool === "curve" || tool === "stretch" || tool === "select" || tool === "text")) return;
      pushHistory();
      const mid = { x: (line.x1 + line.x2) / 2, y: (line.y1 + line.y2) / 2 };
      const meters = parseFloat(line.value.replace(",", "."));
      setEditingValue({
        id: line.id,
        screenX: mid.x * scale + pos.x,
        screenY: mid.y * scale + pos.y,
        value: Number.isFinite(meters) ? formatCm(meters) : "",
        original: { x2: line.x2, y2: line.y2, mid: line.mid },
      });
    },
    [tool, scale, pos, pushHistory]
  );

  const applyLiveValue = useCallback((id: string, value: string) => {
    // Editor input is centimeters (this app's working unit); resizeLineToValue
    // stores/measures in meters internally, so convert at this boundary.
    const cm = parseFloat(value.replace(",", "."));
    const metersStr = Number.isFinite(cm) ? (cm / 100).toString() : value;
    setBoard((b) => ({
      ...b,
      lines: b.lines.map((l) => (l.id === id ? resizeLineToValue(l, metersStr) : l)),
      updatedAt: Date.now(),
    }));
  }, []);

  const commitEditingValue = useCallback(() => {
    setEditingValue(null);
  }, []);

  const cancelEditingValue = useCallback(() => {
    setEditingValue((current) => {
      if (!current) return null;
      setBoard((b) => ({
        ...b,
        lines: b.lines.map((l) =>
          l.id === current.id
            ? { ...l, x2: current.original.x2, y2: current.original.y2, mid: current.original.mid }
            : l
        ),
      }));
      return null;
    });
  }, []);

  const resetMid = useCallback(
    (id: string) => {
      pushHistory();
      setBoard((b) => ({
        ...b,
        lines: b.lines.map((l) =>
          l.id === id ? { ...l, mid: { x: (l.x1 + l.x2) / 2, y: (l.y1 + l.y2) / 2 } } : l
        ),
        updatedAt: Date.now(),
      }));
    },
    [pushHistory]
  );

  // Dragging the curve's mid-point handle also re-measures it live — the
  // straight-line distance no longer matches once it's bent, so we sum the
  // two half-chords (start→mid→end) as a close approximation of the arc.
  const curveMidDragStart = useCallback(() => {
    pushHistory();
  }, [pushHistory]);

  const curveMidDragMove = useCallback((line: MeasureLine, e: KonvaEventObject<DragEvent>) => {
    const p = e.target.position();
    setBoard((b) => ({
      ...b,
      lines: b.lines.map((ln) => {
        if (ln.id !== line.id) return ln;
        const len = distance({ x: ln.x1, y: ln.y1 }, p) + distance(p, { x: ln.x2, y: ln.y2 });
        return { ...ln, mid: { x: p.x, y: p.y }, value: len.toFixed(2) };
      }),
      updatedAt: Date.now(),
    }));
  }, []);

  // --- texto: a free-standing label you tap to place, tap again to edit -----

  const openTextEditor = useCallback(
    (t: TextLabel) => {
      if (tool === "eraser" || tool === "pan") return;
      setEditingText({ id: t.id, screenX: t.x * scale + pos.x, screenY: t.y * scale + pos.y, x: t.x, y: t.y, value: t.text });
    },
    [tool, scale, pos]
  );

  const commitEditingText = useCallback(() => {
    if (!editingText) return;
    const trimmed = editingText.value.trim();
    if (editingText.id) {
      pushHistory();
      const editId = editingText.id;
      if (trimmed) {
        setBoard((b) => ({
          ...b,
          texts: b.texts.map((t) => (t.id === editId ? { ...t, text: trimmed } : t)),
          updatedAt: Date.now(),
        }));
      } else {
        setBoard((b) => ({ ...b, texts: b.texts.filter((t) => t.id !== editId), updatedAt: Date.now() }));
      }
    } else if (trimmed) {
      pushHistory();
      const id = makeId("t");
      setBoard((b) => ({
        ...b,
        texts: [...b.texts, { id, x: editingText.x, y: editingText.y, text: trimmed, color }],
        updatedAt: Date.now(),
      }));
    }
    setEditingText(null);
  }, [editingText, pushHistory, color]);

  const cancelEditingText = useCallback(() => setEditingText(null), []);

  const handleTextDragStart = useCallback(
    (t: TextLabel) => {
      pushHistory();
      textDragOriginRef.current = { id: t.id, x: t.x, y: t.y };
    },
    [pushHistory]
  );

  const handleTextDragMove = useCallback((e: KonvaEventObject<DragEvent>) => {
    const origin = textDragOriginRef.current;
    if (!origin) return;
    const raw = e.target.position();
    setBoard((b) => ({
      ...b,
      texts: b.texts.map((t) => (t.id === origin.id ? { ...t, x: raw.x, y: raw.y } : t)),
      updatedAt: Date.now(),
    }));
  }, []);

  const handleTextDragEnd = useCallback(() => {
    textDragOriginRef.current = null;
  }, []);

  // --- elipse: native shape (not line-approximated), draggable + resizable --

  const handleEllipseDragStart = useCallback(
    (ell: EllipseZone) => {
      pushHistory();
      ellipseDragOriginRef.current = { cx: ell.cx, cy: ell.cy };
    },
    [pushHistory]
  );

  const handleEllipseDragMove = useCallback((id: string, e: KonvaEventObject<DragEvent>) => {
    if (!ellipseDragOriginRef.current) return;
    // The Ellipse node has explicit x/y props (its real cx/cy), so
    // e.target.position() during a drag already IS the new absolute
    // position — adding `origin` on top of it (as if it started at 0,0
    // like a Group) was doubling it and sending the ellipse flying off.
    const pos = e.target.position();
    setBoard((b) => ({
      ...b,
      ellipses: b.ellipses.map((el) => (el.id === id ? { ...el, cx: pos.x, cy: pos.y } : el)),
      updatedAt: Date.now(),
    }));
  }, []);

  const handleEllipseDragEnd = useCallback(() => {
    ellipseDragOriginRef.current = null;
  }, []);

  const handleEllipseResizeStart = useCallback(
    (ell: EllipseZone) => {
      pushHistory();
      ellipseResizeOriginRef.current = { id: ell.id };
    },
    [pushHistory]
  );

  const handleEllipseResizeMove = useCallback(
    (id: string, e: KonvaEventObject<DragEvent>) => {
      if (!ellipseResizeOriginRef.current) return;
      const raw = e.target.position();
      setBoard((b) => ({
        ...b,
        ellipses: b.ellipses.map((el) => {
          if (el.id !== id) return el;
          let rx = Math.max(0.1, Math.abs(raw.x - el.cx));
          let ry = Math.max(0.1, Math.abs(raw.y - el.cy));
          if (ortho) {
            const r = Math.max(rx, ry);
            rx = r;
            ry = r;
          }
          return { ...el, rx, ry };
        }),
        updatedAt: Date.now(),
      }));
    },
    [ortho]
  );

  const handleEllipseResizeEnd = useCallback(() => {
    ellipseResizeOriginRef.current = null;
  }, []);

  // --- fondo de referencia: a traced plan dragged/scaled by eye against the
  // grid, then locked so it stops being grabbed once it's calibrated -------

  const handleBackgroundDragStart = useCallback(() => {
    if (!board.background || board.background.locked) return;
    pushHistory();
    backgroundDragOriginRef.current = { x: board.background.x, y: board.background.y };
  }, [board.background, pushHistory]);

  const handleBackgroundDragMove = useCallback((e: KonvaEventObject<DragEvent>) => {
    if (!backgroundDragOriginRef.current) return;
    const raw = e.target.position();
    setBoard((b) =>
      b.background ? { ...b, background: { ...b.background, x: raw.x, y: raw.y }, updatedAt: Date.now() } : b
    );
  }, []);

  const handleBackgroundDragEnd = useCallback(() => {
    backgroundDragOriginRef.current = null;
  }, []);

  const handleBackgroundResizeStart = useCallback(() => {
    if (!board.background || board.background.locked) return;
    pushHistory();
    const { x, y, width, height } = board.background;
    backgroundResizeOriginRef.current = { x, y, width, height, aspect: height / width };
  }, [board.background, pushHistory]);

  const handleBackgroundResizeMove = useCallback((e: KonvaEventObject<DragEvent>) => {
    const origin = backgroundResizeOriginRef.current;
    if (!origin) return;
    const raw = e.target.position();
    const width = Math.max(0.5, raw.x - origin.x);
    const height = width * origin.aspect;
    setBoard((b) =>
      b.background ? { ...b, background: { ...b.background, width, height }, updatedAt: Date.now() } : b
    );
    e.target.position({ x: origin.x + width, y: origin.y + height });
  }, []);

  const handleBackgroundResizeEnd = useCallback(() => {
    backgroundResizeOriginRef.current = null;
  }, []);

  const handleBackgroundOpacity = useCallback((opacity: number) => {
    setBoard((b) => (b.background ? { ...b, background: { ...b.background, opacity }, updatedAt: Date.now() } : b));
  }, []);

  const handleBackgroundToggleLock = useCallback(() => {
    pushHistory();
    setBoard((b) =>
      b.background ? { ...b, background: { ...b.background, locked: !b.background.locked }, updatedAt: Date.now() } : b
    );
  }, [pushHistory]);

  const handleBackgroundRemove = useCallback(() => {
    if (!window.confirm("¿Quitar el plano de fondo?")) return;
    pushHistory();
    setBoard((b) => ({ ...b, background: undefined, updatedAt: Date.now() }));
  }, [pushHistory]);

  // --- estirar: from a point (a shared vertex) or from a line (translates it,
  // dragging along whatever else is connected at each end) -------------------

  const handleStretchDragStart = useCallback(
    (vertex: Point) => {
      pushHistory();
      stretchOriginRef.current = vertex;
      stretchDragStartRef.current = vertex;
      // Fix the set of lines/area-points this vertex touches ONCE, by id —
      // re-matching by coordinates on every drag tick is what let a line
      // silently drift off the point mid-drag (float rounding across dozens
      // of ticks, or the ortho anchor math nudging things by a hair), which
      // is exactly what made a point occasionally "stop" being stretchable.
      const b = boardRef.current;
      stretchConnectionsRef.current = {
        lines: b.lines
          .filter(
            (l) => samePoint({ x: l.x1, y: l.y1 }, vertex, 0.03) || samePoint({ x: l.x2, y: l.y2 }, vertex, 0.03)
          )
          .map((l) => ({
            id: l.id,
            matchStart: samePoint({ x: l.x1, y: l.y1 }, vertex, 0.03),
            matchEnd: samePoint({ x: l.x2, y: l.y2 }, vertex, 0.03),
          })),
        areas: b.areas.flatMap((a) =>
          a.points
            .map((p, i) => (samePoint(p, vertex, 0.03) ? { id: a.id, pointIndex: i } : null))
            .filter((x): x is { id: string; pointIndex: number } => x !== null)
        ),
      };
    },
    [pushHistory]
  );

  const handleStretchDragMove = useCallback(
    (e: KonvaEventObject<DragEvent>) => {
      const origin = stretchOriginRef.current;
      if (!origin) return;
      const raw = e.target.position();
      const vThreshold = SNAP_PX / scale;
      const others = allEndpoints().filter((p) => !samePoint(p, origin, 0.001));
      const vertexSnap = findSnapPoint(raw, others, vThreshold);
      let snapped = vertexSnap;
      if (!snapped) {
        snapped = snapToGrid(raw, GRID_SNAP_PX / scale, gridStep) ?? raw;
        // Always locked to one axis at a time (X or Y, whichever moved
        // further from where this drag started) — stretching a point should
        // never go diagonal, with or without "Guía recta".
        if (stretchDragStartRef.current) snapped = snapToAxis(stretchDragStartRef.current, snapped);
      }
      e.target.position(snapped);
      const conns = stretchConnectionsRef.current;
      setBoard((b) => ({
        ...b,
        lines: b.lines.map((l) => {
          const conn = conns.lines.find((c) => c.id === l.id);
          if (!conn) return l;
          return moveLineEndpoint(l, conn.matchStart, conn.matchEnd, snapped!, origin);
        }),
        areas: b.areas.map((a) => {
          const hits = conns.areas.filter((c) => c.id === a.id);
          if (!hits.length) return a;
          const points = a.points.slice();
          hits.forEach((h) => {
            points[h.pointIndex] = snapped!;
          });
          return { ...a, points };
        }),
        updatedAt: Date.now(),
      }));
      stretchOriginRef.current = snapped;
    },
    [scale, allEndpoints, gridStep]
  );

  const handleStretchDragEnd = useCallback(() => {
    stretchOriginRef.current = null;
    stretchDragStartRef.current = null;
    stretchConnectionsRef.current = { lines: [], areas: [] };
  }, []);

  const handleLineDragStart = useCallback(
    (line: MeasureLine) => {
      pushHistory();
      lineDragOriginRef.current = {
        start: { x: line.x1, y: line.y1 },
        end: { x: line.x2, y: line.y2 },
        mid: { x: line.mid.x, y: line.mid.y },
      };
      const b = boardRef.current;
      // A rectangle's 4 edges share a groupId — they move as one rigid
      // shape (captured once here), so the generic shared-endpoint cascade
      // below only needs to handle OTHER lines touching this one (e.g. a
      // separate wall that happens to meet a corner).
      const groupMates = line.groupId ? b.lines.filter((l) => l.id !== line.id && l.groupId === line.groupId) : [];
      lineDragGroupOriginRef.current = groupMates.map((l) => ({
        id: l.id,
        x1: l.x1,
        y1: l.y1,
        x2: l.x2,
        y2: l.y2,
        mid: { x: l.mid.x, y: l.mid.y },
      }));
      const groupIds = new Set(groupMates.map((l) => l.id));
      lineDragConnectionsRef.current = b.lines
        .filter((l) => l.id !== line.id && !groupIds.has(l.id))
        .flatMap((l) => {
          const hits: { id: string; matchStart: boolean; matchEnd: boolean; end: "start" | "end" }[] = [];
          const matchStart = samePoint({ x: l.x1, y: l.y1 }, { x: line.x1, y: line.y1 }, 0.03);
          const matchEnd = samePoint({ x: l.x2, y: l.y2 }, { x: line.x1, y: line.y1 }, 0.03);
          if (matchStart || matchEnd) hits.push({ id: l.id, matchStart, matchEnd, end: "start" });
          const matchStart2 = samePoint({ x: l.x1, y: l.y1 }, { x: line.x2, y: line.y2 }, 0.03);
          const matchEnd2 = samePoint({ x: l.x2, y: l.y2 }, { x: line.x2, y: line.y2 }, 0.03);
          if (matchStart2 || matchEnd2) hits.push({ id: l.id, matchStart: matchStart2, matchEnd: matchEnd2, end: "end" });
          return hits;
        });
      // An area whose vertex sits on this line's start/end needs to follow
      // too — otherwise dragging a wall that borders a room leaves its
      // shaded face behind.
      lineDragAreaConnectionsRef.current = b.areas.flatMap((a) =>
        a.points
          .map((p, i) => {
            if (samePoint(p, { x: line.x1, y: line.y1 }, 0.03)) return { id: a.id, pointIndex: i, end: "start" as const };
            if (samePoint(p, { x: line.x2, y: line.y2 }, 0.03)) return { id: a.id, pointIndex: i, end: "end" as const };
            return null;
          })
          .filter((x): x is { id: string; pointIndex: number; end: "start" | "end" } => x !== null)
      );
    },
    [pushHistory]
  );

  const handleLineDragMove = useCallback(
    (lineId: string, e: KonvaEventObject<DragEvent>) => {
      const origin = lineDragOriginRef.current;
      if (!origin) return;
      const rawDelta = e.target.position();
      // Locked to one axis at a time — the wall can only slide along X or Y,
      // whichever the drag has moved further along, never diagonally.
      const axisX = Math.abs(rawDelta.x) >= Math.abs(rawDelta.y);
      const activeRaw = axisX ? origin.start.x + rawDelta.x : origin.start.y + rawDelta.y;
      const activeSnapped = Math.round(activeRaw / gridStep) * gridStep;
      const useSnap = Math.abs(activeSnapped - activeRaw) * scale <= GRID_SNAP_PX;
      const activeFinal = useSnap ? activeSnapped : activeRaw;
      const delta = axisX ? { x: activeFinal - origin.start.x, y: 0 } : { x: 0, y: activeFinal - origin.start.y };
      const newStart = { x: origin.start.x + delta.x, y: origin.start.y + delta.y };
      const newEnd = { x: origin.end.x + delta.x, y: origin.end.y + delta.y };
      const newMid = { x: origin.mid.x + delta.x, y: origin.mid.y + delta.y };

      const conns = lineDragConnectionsRef.current;
      const areaConns = lineDragAreaConnectionsRef.current;
      const groupOrigins = lineDragGroupOriginRef.current;
      setBoard((b) => ({
        ...b,
        lines: b.lines.map((l) => {
          if (l.id === lineId) {
            return { ...l, x1: newStart.x, y1: newStart.y, x2: newEnd.x, y2: newEnd.y, mid: newMid };
          }
          // Rectangle group-mate — translated rigidly by the same delta,
          // so the shape never shears like the generic cascade would.
          const groupOrigin = groupOrigins.find((g) => g.id === l.id);
          if (groupOrigin) {
            return {
              ...l,
              x1: groupOrigin.x1 + delta.x,
              y1: groupOrigin.y1 + delta.y,
              x2: groupOrigin.x2 + delta.x,
              y2: groupOrigin.y2 + delta.y,
              mid: { x: groupOrigin.mid.x + delta.x, y: groupOrigin.mid.y + delta.y },
            };
          }
          const hits = conns.filter((c) => c.id === l.id);
          if (!hits.length) return l;
          let res = l;
          for (const hit of hits) {
            const target = hit.end === "start" ? newStart : newEnd;
            const targetOrigin = hit.end === "start" ? origin.start : origin.end;
            res = moveLineEndpoint(res, hit.matchStart, hit.matchEnd, target, targetOrigin);
          }
          return res;
        }),
        areas: b.areas.map((a) => {
          const hits = areaConns.filter((c) => c.id === a.id);
          if (!hits.length) return a;
          const points = a.points.slice();
          hits.forEach((h) => {
            points[h.pointIndex] = h.end === "start" ? newStart : newEnd;
          });
          return { ...a, points };
        }),
        updatedAt: Date.now(),
      }));
      e.target.position({ x: 0, y: 0 });
    },
    [scale, gridStep]
  );

  const handleLineDragEnd = useCallback(() => {
    lineDragOriginRef.current = null;
    lineDragConnectionsRef.current = [];
    lineDragAreaConnectionsRef.current = [];
    lineDragGroupOriginRef.current = [];
  }, []);

  // --- select/lasso: recolor / delete / scale / move whatever's selected ----

  const handleRecolorSelection = useCallback(
    (c: LineColor) => {
      if (!lassoSelection || lassoSelectionIsEmpty(lassoSelection)) return;
      pushHistory();
      setBoard((b) => applyRecolorSelection(b, lassoSelection, c));
    },
    [lassoSelection, pushHistory]
  );

  const handleDeleteSelection = useCallback(() => {
    if (!lassoSelection || lassoSelectionIsEmpty(lassoSelection)) return;
    pushHistory();
    setBoard((b) => applyDeleteSelection(b, lassoSelection));
    setLassoSelection(null);
  }, [lassoSelection, pushHistory]);

  // --- favoritos: stamp a door/window "dynamic block" at the view's center ---

  const handleStampSymbol = useCallback(
    (kind: "door" | "window") => {
      pushHistory();
      const worldCenter = toWorld({ x: stageSize.width / 2, y: stageSize.height / 2 });
      const symbol = kind === "door" ? newDoor(worldCenter, color) : newWindow(worldCenter, color);
      setBoard((b) => ({ ...b, symbols: [...b.symbols, symbol], updatedAt: Date.now() }));
      setFavoritesOpen(false);
      // Land straight in "estirar" so you can drag it onto a wall and resize
      // it right away, without an extra tool switch.
      setToolRaw("stretch");
    },
    [pushHistory, toWorld, stageSize, color]
  );

  // Dragging a door/window's body moves it and re-aligns it (position +
  // angle) onto whatever wall it lands near — the "dynamic block" behavior.
  // Alignment is judged from the symbol's own center, not its anchor corner,
  // so it snaps naturally no matter which part of it you happened to grab.
  const handleSymbolDragStart = useCallback(
    (s: SymbolInstance) => {
      pushHistory();
      symbolDragOriginRef.current = { x: s.x, y: s.y, angle: s.angle, length: s.length };
    },
    [pushHistory]
  );

  const handleSymbolDragMove = useCallback((id: string, e: KonvaEventObject<DragEvent>) => {
    const origin = symbolDragOriginRef.current;
    if (!origin) return;
    const delta = e.target.position();
    let newX = origin.x + delta.x;
    let newY = origin.y + delta.y;
    let newAngle = origin.angle;
    const cos0 = Math.cos(origin.angle);
    const sin0 = Math.sin(origin.angle);
    const center = { x: newX + (cos0 * origin.length) / 2, y: newY + (sin0 * origin.length) / 2 };
    let best: { dist: number } | null = null;
    for (const l of boardRef.current.lines) {
      const { point, dist } = projectOntoSegment(center, { x: l.x1, y: l.y1 }, { x: l.x2, y: l.y2 });
      if (dist <= WALL_ALIGN_DIST && (!best || dist < best.dist)) {
        best = { dist };
        newAngle = Math.atan2(l.y2 - l.y1, l.x2 - l.x1);
        const cos1 = Math.cos(newAngle);
        const sin1 = Math.sin(newAngle);
        newX = point.x - (cos1 * origin.length) / 2;
        newY = point.y - (sin1 * origin.length) / 2;
      }
    }
    setBoard((b) => ({
      ...b,
      symbols: b.symbols.map((s) => (s.id === id ? { ...s, x: newX, y: newY, angle: newAngle } : s)),
      updatedAt: Date.now(),
    }));
    e.target.position({ x: 0, y: 0 });
  }, []);

  const handleSymbolDragEnd = useCallback(() => {
    symbolDragOriginRef.current = null;
  }, []);

  // Door: the hinge is the one point you move to place/align the door — it
  // snaps onto a wall face like everything else, but ALSO picks up that
  // wall's angle (so bringing it near a wall at a different angle turns
  // the door to match, instead of just sliding). With no wall nearby it
  // falls back to sliding along its own current angle, so it still can't
  // go diagonal. While dragging, a live readout shows the distance from
  // the aligned wall's nearer end — just a placement aid, not stored.
  const handleDoorResizeStart = useCallback(
    (s: SymbolInstance) => {
      pushHistory();
      doorResizeOriginRef.current = { id: s.id };
    },
    [pushHistory]
  );

  const handleDoorResizeMove = useCallback((e: KonvaEventObject<DragEvent>) => {
    const origin = doorResizeOriginRef.current;
    if (!origin) return;
    const raw = e.target.position();
    const s = boardRef.current.symbols.find((sym) => sym.id === origin.id);
    if (!s) return;

    const oldHinge = { x: s.x, y: s.y };
    const target = resizeEndpointTarget(raw, oldHinge, s.angle, boardRef.current.lines, WALL_ALIGN_DIST);
    const wallHit = findWallAlignment(raw, boardRef.current.lines, WALL_ALIGN_DIST);
    const angle = wallHit ? wallHit.angle : s.angle;
    setBoard((b) => ({
      ...b,
      symbols: b.symbols.map((sym) => (sym.id === origin.id ? { ...sym, x: target.x, y: target.y, angle } : sym)),
      updatedAt: Date.now(),
    }));
    e.target.position(target);

    if (wallHit) {
      // Always read toward the nearer wall end — a placement aid for how far
      // the hinge sits from the corner, regardless of which way the door
      // is mirrored.
      const chosen =
        distance(target, wallHit.lineStart) <= distance(target, wallHit.lineEnd)
          ? wallHit.lineStart
          : wallHit.lineEnd;
      setDoorHingeReadout({
        x: (target.x + chosen.x) / 2,
        y: (target.y + chosen.y) / 2,
        text: formatCm(distance(target, chosen)),
      });
    } else {
      setDoorHingeReadout(null);
    }
  }, []);

  const handleDoorResizeEnd = useCallback(() => {
    doorResizeOriginRef.current = null;
    setDoorHingeReadout(null);
  }, []);

  // Frame: the blue control stretches how far the jamb ticks reach into
  // the wall, fitting them to the wall's real thickness — wall-aligned by
  // default, perpendicular-constrained otherwise, same as every other
  // resize in this app.
  const handleDoorFrameResizeStart = useCallback(
    (s: SymbolInstance) => {
      pushHistory();
      doorFrameResizeOriginRef.current = { id: s.id };
    },
    [pushHistory]
  );

  const handleDoorFrameResizeMove = useCallback((e: KonvaEventObject<DragEvent>) => {
    const origin = doorFrameResizeOriginRef.current;
    if (!origin) return;
    const raw = e.target.position();
    const s = boardRef.current.symbols.find((sym) => sym.id === origin.id);
    if (!s) return;
    const g = doorGeometry(s);
    const axisAngle = s.angle + Math.PI / 2;
    // Pure axis lock, no wall search — this circle only ever adjusts the
    // frame's own depth, so it can't jump to an unrelated wall nearby.
    const target = resizeEndpointTarget(raw, g.closedEnd, axisAngle, [], WALL_ALIGN_DIST);
    const d = { x: target.x - g.closedEnd.x, y: target.y - g.closedEnd.y };
    const signed = d.x * g.perp.x + d.y * g.perp.y;
    const frameDepth = Math.sign(signed || 1) * Math.max(0.02, Math.abs(signed));
    setBoard((b) => ({
      ...b,
      symbols: b.symbols.map((sym) => (sym.id === origin.id ? { ...sym, frameDepth } : sym)),
      updatedAt: Date.now(),
    }));
    e.target.position(target);
  }, []);

  const handleDoorFrameResizeEnd = useCallback(() => {
    doorFrameResizeOriginRef.current = null;
  }, []);

  const handleToggleDoorMirror = useCallback(
    (s: SymbolInstance) => {
      pushHistory();
      setBoard((b) => ({
        ...b,
        symbols: b.symbols.map((sym) => (sym.id === s.id ? { ...sym, mirror: (sym.mirror ?? 1) === 1 ? -1 : 1 } : sym)),
        updatedAt: Date.now(),
      }));
    },
    [pushHistory]
  );

  // --- puerta: ancho editable tocando la cota -------------------------------

  const openDoorWidthEditor = useCallback(
    (s: SymbolInstance) => {
      if (tool === "eraser" || tool === "pan") return;
      const mid = { x: s.x + (Math.cos(s.angle) * s.length) / 2, y: s.y + (Math.sin(s.angle) * s.length) / 2 };
      setEditingDoorWidth({
        id: s.id,
        screenX: mid.x * scale + pos.x,
        screenY: mid.y * scale + pos.y,
        value: formatCm(s.length),
      });
    },
    [tool, scale, pos]
  );

  const commitDoorWidth = useCallback(() => {
    setEditingDoorWidth((cur) => {
      if (!cur) return null;
      // Input is centimeters; `length` is stored in meters internally.
      const n = parseFloat(cur.value.replace(",", ".")) / 100;
      if (Number.isFinite(n) && n > 0) {
        pushHistory();
        const length = Math.max(0.2, n);
        setBoard((b) => ({
          ...b,
          symbols: b.symbols.map((sym) => (sym.id === cur.id ? { ...sym, length } : sym)),
          updatedAt: Date.now(),
        }));
      }
      return null;
    });
  }, [pushHistory]);

  const cancelDoorWidth = useCallback(() => setEditingDoorWidth(null), []);

  // Window: 4 corner handles. Each drag is locked to ONE axis — the long
  // (length) edge it sits on, or the short (depth) edge — decided from
  // whichever axis the drag has moved further along, so it can never go
  // diagonal and lose the rectangle's shape. Length-axis drags align a long
  // EDGE (not the centerline) onto a nearby wall face; depth-axis drags do
  // the same for fitting the wall's thickness.
  const handleWindowResizeStart = useCallback(
    (s: SymbolInstance, cornerIndex: number) => {
      pushHistory();
      const g = windowGeometry(s);
      const info = WINDOW_CORNERS[cornerIndex];
      windowResizeOriginRef.current = {
        id: s.id,
        cornerIndex,
        startCorner: g.corners[cornerIndex],
        lengthFixed: g.corners[info.lengthPartner],
        depthFixed: g.corners[info.depthPartner],
        dir: g.dir,
        perp: g.perp,
        angle: s.angle,
        length: s.length,
        depth: s.depth ?? WINDOW_DEFAULT_DEPTH,
      };
    },
    [pushHistory]
  );

  const handleWindowResizeMove = useCallback((e: KonvaEventObject<DragEvent>) => {
    const origin = windowResizeOriginRef.current;
    if (!origin) return;
    const raw = e.target.position();
    const info = WINDOW_CORNERS[origin.cornerIndex];

    const totalDelta = { x: raw.x - origin.startCorner.x, y: raw.y - origin.startCorner.y };
    const lengthComponent = totalDelta.x * origin.dir.x + totalDelta.y * origin.dir.y;
    const depthComponent = totalDelta.x * origin.perp.x + totalDelta.y * origin.perp.y;
    const mode: "length" | "depth" = Math.abs(lengthComponent) >= Math.abs(depthComponent) ? "length" : "depth";

    if (mode === "length") {
      const fixed = origin.lengthFixed;
      const target = resizeEndpointTarget(raw, fixed, origin.angle, boardRef.current.lines, WALL_ALIGN_DIST);
      const newLength = Math.max(0.2, distance(fixed, target));
      // fixed->target runs p1->p2 if the dragged corner is the p2 end,
      // p2->p1 if it's the p1 end — flip so newAngle always means p1->p2.
      const endSign = info.end === "p2" ? 1 : -1;
      const newAngle = Math.atan2(endSign * (target.y - fixed.y), endSign * (target.x - fixed.x));
      const newPerp = { x: -Math.sin(newAngle), y: Math.cos(newAngle) };
      const hd = origin.depth / 2;
      const fixedCenterline = { x: fixed.x - newPerp.x * hd * info.face, y: fixed.y - newPerp.y * hd * info.face };
      const targetCenterline = { x: target.x - newPerp.x * hd * info.face, y: target.y - newPerp.y * hd * info.face };
      const newP1 = info.end === "p1" ? targetCenterline : fixedCenterline;
      setBoard((b) => ({
        ...b,
        symbols: b.symbols.map((sym) =>
          sym.id === origin.id ? { ...sym, x: newP1.x, y: newP1.y, length: newLength, angle: newAngle } : sym
        ),
        updatedAt: Date.now(),
      }));
      e.target.position(target);
    } else {
      const fixed = origin.depthFixed;
      const axisAngle = origin.angle + Math.PI / 2;
      const target = resizeEndpointTarget(raw, fixed, axisAngle, boardRef.current.lines, WALL_ALIGN_DIST);
      const newDepth = Math.max(0.05, distance(fixed, target));
      const thisEndCenterline = { x: (fixed.x + target.x) / 2, y: (fixed.y + target.y) / 2 };
      const newP1 =
        info.end === "p1"
          ? thisEndCenterline
          : { x: thisEndCenterline.x - origin.dir.x * origin.length, y: thisEndCenterline.y - origin.dir.y * origin.length };
      setBoard((b) => ({
        ...b,
        symbols: b.symbols.map((sym) => (sym.id === origin.id ? { ...sym, x: newP1.x, y: newP1.y, depth: newDepth } : sym)),
        updatedAt: Date.now(),
      }));
      e.target.position(target);
    }
  }, []);

  const handleWindowResizeEnd = useCallback(() => {
    windowResizeOriginRef.current = null;
  }, []);

  // --- zoom / pan --------------------------------------------------------

  const handleWheel = useCallback(
    (e: KonvaEventObject<WheelEvent>) => {
      e.evt.preventDefault();
      const stage = stageRef.current;
      if (!stage) return;
      const pointer = stage.getPointerPosition();
      if (!pointer) return;
      const scaleBy = 1.06;
      const direction = e.evt.deltaY > 0 ? -1 : 1;
      const newScale = clamp(
        direction > 0 ? scale * scaleBy : scale / scaleBy,
        MIN_SCALE,
        MAX_SCALE
      );
      const worldAtPointer = toWorld(pointer);
      const newPos = {
        x: pointer.x - worldAtPointer.x * newScale,
        y: pointer.y - worldAtPointer.y * newScale,
      };
      setScale(newScale);
      setPos(clampPos(newPos, newScale));
    },
    [scale, toWorld, clampPos]
  );

  const handleTouchMove = useCallback(
    (e: KonvaEventObject<TouchEvent>) => {
      const touches = e.evt.touches;
      if (touches.length !== 2) return;
      e.evt.preventDefault();
      const stage = stageRef.current;
      if (!stage) return;
      const rect = stage.container().getBoundingClientRect();
      const p1 = { x: touches[0].clientX - rect.left, y: touches[0].clientY - rect.top };
      const p2 = { x: touches[1].clientX - rect.left, y: touches[1].clientY - rect.top };
      const dist = touchDistance(p1, p2);
      const center = touchCenter(p1, p2);

      // A pinch already in progress keeps doing whatever it started as —
      // scaling the lasso selection / a text label, or zooming the canvas —
      // regardless of how the finger center drifts afterward.
      if (objectPinchRef.current) {
        const g = objectPinchRef.current;
        const k = clamp(dist / g.dist, PINCH_SCALE_MIN, PINCH_SCALE_MAX);
        setBoard((b) => applyGroupScale(b, g.snapshot, g.anchor, k));
        return;
      }
      if (pinchRef.current) {
        const start = pinchRef.current;
        const newScale = clamp(start.scale * (dist / start.dist), MIN_SCALE, MAX_SCALE);
        const worldAtCenter = {
          x: (start.center.x - start.pos.x) / start.scale,
          y: (start.center.y - start.pos.y) / start.scale,
        };
        const newPos = {
          x: center.x - worldAtCenter.x * newScale,
          y: center.y - worldAtCenter.y * newScale,
        };
        setScale(newScale);
        setPos(clampPos(newPos, newScale));
        return;
      }

      // First frame of a fresh 2-finger gesture. In the "escalar" tool, with
      // something selected, it's always a scale gesture — no hit-testing:
      // you already told the app what to scale by selecting it. Otherwise
      // it's the default: zoom the whole canvas.
      setDrawingLine(null);
      setDrawingNote(null);
      setLassoPoints(null);

      if (tool === "scale" && lassoSelection && !lassoSelectionIsEmpty(lassoSelection)) {
        const board = boardRef.current;
        const bbox = computeSelectionBBox(board, lassoSelection);
        if (bbox) {
          pushHistory();
          objectPinchRef.current = {
            selection: lassoSelection,
            anchor: { x: (bbox.minX + bbox.maxX) / 2, y: (bbox.minY + bbox.maxY) / 2 },
            dist,
            snapshot: snapshotSelection(board, lassoSelection),
          };
          return;
        }
      }

      pinchRef.current = { dist, center, scale, pos };
    },
    [tool, scale, pos, clampPos, lassoSelection, pushHistory]
  );

  const handleTouchEnd = useCallback((e: KonvaEventObject<TouchEvent>) => {
    if (e.evt.touches.length < 2) {
      pinchRef.current = null;
      objectPinchRef.current = null;
    }
  }, []);

  // --- board actions -------------------------------------------------------

  const handleNewBoard = useCallback(async () => {
    const id = newBoardId();
    await saveBoard(emptyBoard(id));
    router.push(`/board/${id}`);
  }, [router]);

  const handleRenameBoard = useCallback((name: string) => {
    setBoard((b) => ({ ...b, name, updatedAt: Date.now() }));
  }, []);

  const handleUpdateLineValue = useCallback((id: string, value: string) => {
    setBoard((b) => ({
      ...b,
      lines: b.lines.map((l) => (l.id === id ? resizeLineToValue(l, value) : l)),
      updatedAt: Date.now(),
    }));
  }, []);

  const handleDeleteLine = useCallback(
    (id: string) => {
      pushHistory();
      setBoard((b) => ({ ...b, lines: b.lines.filter((l) => l.id !== id), updatedAt: Date.now() }));
    },
    [pushHistory]
  );

  const handleDeleteNote = useCallback(
    (id: string) => {
      pushHistory();
      setBoard((b) => ({ ...b, notes: b.notes.filter((n) => n.id !== id), updatedAt: Date.now() }));
    },
    [pushHistory]
  );

  const handleDeleteArea = useCallback(
    (id: string) => {
      pushHistory();
      setBoard((b) => ({ ...b, areas: b.areas.filter((a) => a.id !== id), updatedAt: Date.now() }));
    },
    [pushHistory]
  );

  const handleExportPdf = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const points: Point[] = [];
    board.lines.forEach((l) => points.push({ x: l.x1, y: l.y1 }, { x: l.x2, y: l.y2 }));
    board.notes.forEach((n) => {
      for (let i = 0; i < n.points.length; i += 2) points.push({ x: n.points[i], y: n.points[i + 1] });
    });
    board.areas.forEach((a) => points.push(...a.points));
    board.symbols.forEach((s) => {
      if (s.kind === "door") {
        const g = doorGeometry(s);
        points.push(g.hinge, g.closedEnd, g.openEnd, g.closedEndTick.b);
      } else {
        const g = windowGeometry(s);
        points.push(...g.corners);
      }
    });
    board.ellipses.forEach((el) => {
      points.push(
        { x: el.cx - el.rx, y: el.cy - el.ry },
        { x: el.cx + el.rx, y: el.cy + el.ry }
      );
    });
    board.texts.forEach((t) => points.push({ x: t.x, y: t.y }));
    if (board.background) {
      const bg = board.background;
      points.push({ x: bg.x, y: bg.y }, { x: bg.x + bg.width, y: bg.y + bg.height });
    }

    const prevScale = stage.scaleX();
    const prevPos = stage.position();
    const prevSize = { width: stage.width(), height: stage.height() };

    if (points.length) {
      const pad = 1.5; // meters
      const xs = points.map((p) => p.x);
      const ys = points.map((p) => p.y);
      const bbox = {
        x: Math.min(...xs) - pad,
        y: Math.min(...ys) - pad,
        width: Math.max(...xs) - Math.min(...xs) + pad * 2,
        height: Math.max(...ys) - Math.min(...ys) + pad * 2,
      };
      const targetW = 1600;
      const fitScale = clamp(targetW / bbox.width, 20, 800);
      stage.size({ width: bbox.width * fitScale, height: bbox.height * fitScale });
      stage.scale({ x: fitScale, y: fitScale });
      stage.position({ x: -bbox.x * fitScale, y: -bbox.y * fitScale });
    }
    stage.batchDraw();

    const dataUrl = stage.toDataURL({ mimeType: "image/png", pixelRatio: 1 });
    const w = stage.width();
    const h = stage.height();

    stage.size(prevSize);
    stage.scale({ x: prevScale, y: prevScale });
    stage.position(prevPos);
    stage.batchDraw();

    const doc = new jsPDF({ orientation: w >= h ? "landscape" : "portrait", unit: "px", format: [w, h] });
    doc.addImage(dataUrl, "PNG", 0, 0, w, h);
    const safeName = (board.name || "levantamiento").replace(/[^a-z0-9-_ ]/gi, "").trim();
    doc.save(`${safeName || "levantamiento"}.pdf`);
    // Keep a copy in the app too — a download can get lost in the device's
    // Files app, but this stays reachable from the home page.
    savePdfExport({
      id: makeId("pdf"),
      boardId: board.id,
      boardName: board.name,
      createdAt: Date.now(),
      blob: doc.output("blob"),
    });
  }, [board]);

  const totalMl = board.lines.reduce((sum, l) => {
    const n = parseFloat(l.value.replace(",", "."));
    return Number.isFinite(n) ? sum + n : sum;
  }, 0);

  const totalM2 = board.areas.reduce((sum, a) => sum + polygonArea(a.points), 0);

  const showLabels = showDimensions && scale >= LABEL_MIN_SCALE;
  const hasSelection = !!lassoSelection && !lassoSelectionIsEmpty(lassoSelection);

  return (
    <div className="h-dvh w-dvw flex flex-col bg-paper overflow-hidden">
      <Toolbar
        boardName={board.name}
        onRenameBoard={handleRenameBoard}
        tool={tool}
        setTool={setTool}
        color={color}
        setColor={setColor}
        ortho={ortho}
        setOrtho={setOrtho}
        showDimensions={showDimensions}
        setShowDimensions={setShowDimensions}
        onExportPdf={handleExportPdf}
        onNewBoard={handleNewBoard}
        panelOpen={panelOpen}
        setPanelOpen={setPanelOpen}
        favoritesOpen={favoritesOpen}
        setFavoritesOpen={setFavoritesOpen}
        totalMl={totalMl}
        totalM2={totalM2}
        onUndo={undo}
        onRedo={redo}
        canUndo={history.length > 0}
        canRedo={future.length > 0}
        hasSelection={hasSelection}
        onSelectionColor={handleRecolorSelection}
        onSelectionDelete={handleDeleteSelection}
        onSelectionClear={() => setLassoSelection(null)}
      />

      <div className="relative flex-1 min-h-0">
        {/* touch-action: none — without this, iOS still treats a single-finger
            drag as a page-scroll/bounce gesture underneath Konva's own touch
            handling, which is what made freehand strokes come out broken. */}
        <div ref={containerRef} className="absolute inset-0" style={{ touchAction: "none" }}>
          {stageSize.width > 0 && (
            <Stage
              ref={stageRef}
              width={stageSize.width}
              height={stageSize.height}
              scaleX={scale}
              scaleY={scale}
              x={pos.x}
              y={pos.y}
              draggable={tool === "pan"}
              dragBoundFunc={(p) => clampPos(p, scale)}
              onDragEnd={(e) => {
                // A child handle's own dragend (curve mid-point, stretch
                // vertex/line) bubbles up here too — only sync pos when the
                // Stage itself was what got dragged (tool === "pan"),
                // otherwise this would stomp the pan offset with that
                // handle's world coordinates.
                if (e.target !== stageRef.current) return;
                setPos({ x: e.target.x(), y: e.target.y() });
              }}
              onMouseDown={handlePointerDown}
              onMouseMove={handlePointerMove}
              onMouseUp={handlePointerUp}
              onTouchStart={(e) => {
                e.evt.preventDefault();
                handlePointerDown(e);
              }}
              onTouchMove={(e) => {
                e.evt.preventDefault();
                if (e.evt.touches.length === 2) handleTouchMove(e);
                else handlePointerMove();
              }}
              onTouchEnd={(e) => {
                e.evt.preventDefault();
                handleTouchEnd(e);
                handlePointerUp();
              }}
              onWheel={handleWheel}
              onMouseLeave={() => setEraserCursor(null)}
              className={tool === "pan" ? "cursor-grab" : tool === "eraser" ? "cursor-cell" : "cursor-crosshair"}
            >
              <Layer listening={false}>
                <Rect
                  x={0}
                  y={0}
                  width={WORLD_W}
                  height={WORLD_H}
                  fill="#ffffff"
                  stroke="#e7e5e4"
                  strokeWidth={1 / scale}
                />
                {scale >= FINE_GRID_MIN_SCALE && (
                  <Shape
                    width={WORLD_W}
                    height={WORLD_H}
                    fill="#e7e5e4"
                    perfectDrawEnabled={false}
                    sceneFunc={(context, shape) => {
                      context.beginPath();
                      const r = 0.03;
                      const steps = WORLD_W / FINE_GRID_STEP;
                      const stepsY = WORLD_H / FINE_GRID_STEP;
                      for (let gx = 0; gx <= steps; gx++) {
                        for (let gy = 0; gy <= stepsY; gy++) {
                          const x = gx * FINE_GRID_STEP;
                          const y = gy * FINE_GRID_STEP;
                          context.moveTo(x + r, y);
                          context.arc(x, y, r, 0, Math.PI * 2, false);
                        }
                      }
                      context.fillStrokeShape(shape);
                    }}
                  />
                )}
                {scale >= ULTRA_FINE_GRID_MIN_SCALE && (
                  <Shape
                    width={WORLD_W}
                    height={WORLD_H}
                    fill="#efeeed"
                    perfectDrawEnabled={false}
                    sceneFunc={(context, shape) => {
                      context.beginPath();
                      const r = 0.02;
                      // Only the visible viewport — at this zoom the full
                      // 150x150m world would be way too many dots.
                      const minGx = clamp(Math.floor(-pos.x / scale / ULTRA_FINE_GRID_STEP), 0, WORLD_W / ULTRA_FINE_GRID_STEP);
                      const maxGx = clamp(
                        Math.ceil((stageSize.width - pos.x) / scale / ULTRA_FINE_GRID_STEP),
                        0,
                        WORLD_W / ULTRA_FINE_GRID_STEP
                      );
                      const minGy = clamp(Math.floor(-pos.y / scale / ULTRA_FINE_GRID_STEP), 0, WORLD_H / ULTRA_FINE_GRID_STEP);
                      const maxGy = clamp(
                        Math.ceil((stageSize.height - pos.y) / scale / ULTRA_FINE_GRID_STEP),
                        0,
                        WORLD_H / ULTRA_FINE_GRID_STEP
                      );
                      for (let gx = minGx; gx <= maxGx; gx++) {
                        for (let gy = minGy; gy <= maxGy; gy++) {
                          const x = gx * ULTRA_FINE_GRID_STEP;
                          const y = gy * ULTRA_FINE_GRID_STEP;
                          context.moveTo(x + r, y);
                          context.arc(x, y, r, 0, Math.PI * 2, false);
                        }
                      }
                      context.fillStrokeShape(shape);
                    }}
                  />
                )}
                <Shape
                  width={WORLD_W}
                  height={WORLD_H}
                  fill="#d6d3d1"
                  perfectDrawEnabled={false}
                  sceneFunc={(context, shape) => {
                    context.beginPath();
                    const r = 0.05;
                    for (let gx = 0; gx <= WORLD_W; gx++) {
                      for (let gy = 0; gy <= WORLD_H; gy++) {
                        context.moveTo(gx + r, gy);
                        context.arc(gx, gy, r, 0, Math.PI * 2, false);
                      }
                    }
                    context.fillStrokeShape(shape);
                  }}
                />
              </Layer>

              <Layer>
                {board.background && backgroundImage && (
                  <KonvaImage
                    image={backgroundImage}
                    x={board.background.x}
                    y={board.background.y}
                    width={board.background.width}
                    height={board.background.height}
                    opacity={board.background.opacity}
                    listening={!board.background.locked && (tool === "stretch" || tool === "select")}
                    draggable={!board.background.locked && (tool === "stretch" || tool === "select")}
                    onDragStart={handleBackgroundDragStart}
                    onDragMove={handleBackgroundDragMove}
                    onDragEnd={handleBackgroundDragEnd}
                  />
                )}

                {board.areas.map((a) => {
                  const area = polygonArea(a.points);
                  const cx = a.points.reduce((s, p) => s + p.x, 0) / a.points.length;
                  const cy = a.points.reduce((s, p) => s + p.y, 0) / a.points.length;
                  return (
                    <Fragment key={a.id}>
                      <Line
                        points={flatten(a.points)}
                        closed
                        fill={a.color}
                        opacity={0.16}
                        stroke={a.color}
                        strokeWidth={1.5 / scale}
                        onClick={() => handleEraseShape(a.id, "area")}
                        onTap={() => handleEraseShape(a.id, "area")}
                      />
                      {showLabels && (
                        <Text
                          x={cx}
                          y={cy}
                          text={`${area.toFixed(2)} m²`}
                          fontSize={DIM_FONT_SIZE}
                          fontFamily="ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace"
                          fill="#1c1b1a"
                          offsetX={dimOffsetX(`${area.toFixed(2)} m²`, DIM_FONT_SIZE)}
                          offsetY={DIM_FONT_SIZE / 2}
                          listening={false}
                        />
                      )}
                    </Fragment>
                  );
                })}

                {drawingArea && drawingArea.length > 0 && (
                  <>
                    <Line
                      points={flatten(drawingArea)}
                      stroke={color}
                      strokeWidth={2 / scale}
                      dash={[6 / scale, 5 / scale]}
                    />
                    {drawingArea.map((p, i) => (
                      <Circle key={i} x={p.x} y={p.y} radius={5 / scale} fill={color} listening={false} />
                    ))}
                  </>
                )}

                {drawingAreaChain && drawingAreaChain.length > 0 && (
                  <>
                    <Line
                      points={flatten(drawingAreaChain)}
                      stroke={color}
                      strokeWidth={3 / scale}
                      dash={[6 / scale, 5 / scale]}
                      lineCap="round"
                      listening={false}
                    />
                    <Circle
                      x={drawingAreaChain[0].x}
                      y={drawingAreaChain[0].y}
                      radius={6 / scale}
                      fill={color}
                      listening={false}
                    />
                  </>
                )}

                {board.ellipses.map((el) => (
                  <Ellipse
                    key={el.id}
                    x={el.cx}
                    y={el.cy}
                    radiusX={el.rx}
                    radiusY={el.ry}
                    stroke={el.color}
                    strokeWidth={2 / scale}
                    hitStrokeWidth={16 / scale}
                    draggable={tool === "stretch" || tool === "select"}
                    onDragStart={() => handleEllipseDragStart(el)}
                    onDragMove={(e) => handleEllipseDragMove(el.id, e)}
                    onDragEnd={handleEllipseDragEnd}
                    onClick={() => handleEraseShape(el.id, "ellipse")}
                    onTap={() => handleEraseShape(el.id, "ellipse")}
                  />
                ))}

                {(tool === "stretch" || tool === "select") &&
                  board.ellipses.map((el) => (
                    <Circle
                      key={`${el.id}-resize`}
                      x={el.cx + el.rx}
                      y={el.cy + el.ry}
                      radius={7 / scale}
                      fill="#ffffff"
                      stroke="#c2410c"
                      strokeWidth={2 / scale}
                      hitStrokeWidth={26 / scale}
                      draggable
                      onDragStart={() => handleEllipseResizeStart(el)}
                      onDragMove={(e) => handleEllipseResizeMove(el.id, e)}
                      onDragEnd={handleEllipseResizeEnd}
                    />
                  ))}

                {board.background && !board.background.locked && (tool === "stretch" || tool === "select") && (
                  <Circle
                    x={board.background.x + board.background.width}
                    y={board.background.y + board.background.height}
                    radius={8 / scale}
                    fill="#ffffff"
                    stroke="#c2410c"
                    strokeWidth={2 / scale}
                    hitStrokeWidth={28 / scale}
                    draggable
                    onDragStart={handleBackgroundResizeStart}
                    onDragMove={handleBackgroundResizeMove}
                    onDragEnd={handleBackgroundResizeEnd}
                  />
                )}

                {board.notes.map((n) => (
                  <Line
                    key={n.id}
                    points={n.points}
                    stroke={n.color}
                    strokeWidth={1.6 / scale}
                    lineCap="round"
                    lineJoin="round"
                    tension={0.15}
                    hitStrokeWidth={16 / scale}
                    onClick={() => handleEraseShape(n.id, "note")}
                    onTap={() => handleEraseShape(n.id, "note")}
                  />
                ))}

                {board.lines.map((l) => (
                  <Line
                    key={l.id}
                    points={[l.x1, l.y1, l.mid.x, l.mid.y, l.x2, l.y2]}
                    tension={0.5}
                    stroke={l.color}
                    strokeWidth={2.5 / scale}
                    lineCap="round"
                    hitStrokeWidth={20 / scale}
                    draggable={tool === "stretch" || tool === "select"}
                    onDragStart={() => handleLineDragStart(l)}
                    onDragMove={(e) => handleLineDragMove(l.id, e)}
                    onDragEnd={handleLineDragEnd}
                    onClick={() => {
                      if (tool === "eraser") handleEraseShape(l.id, "measure");
                      else if (tool === "select") setLassoSelection({ ...emptyLassoSelection(), lines: [l.id] });
                      else if (tool === "area" && areaMode === "lineas") handleAreaLineClick(l);
                      else openValueEditor(l);
                    }}
                    onTap={() => {
                      if (tool === "eraser") handleEraseShape(l.id, "measure");
                      else if (tool === "select") setLassoSelection({ ...emptyLassoSelection(), lines: [l.id] });
                      else if (tool === "area" && areaMode === "lineas") handleAreaLineClick(l);
                      else openValueEditor(l);
                    }}
                  />
                ))}

                {board.symbols.map((s) => {
                  if (s.kind === "door") {
                    const g = doorGeometry(s);
                    // Offset purely along +perp (opposite the fixed swing side) so it
                    // stays clear of the leaf and frame regardless of `mirror`.
                    const mirrorBtn = { x: s.x + g.perp.x * 0.8, y: s.y + g.perp.y * 0.8 };
                    return (
                      <Group
                        key={s.id}
                        draggable={tool === "stretch" || tool === "select"}
                        onDragStart={() => handleSymbolDragStart(s)}
                        onDragMove={(e) => handleSymbolDragMove(s.id, e)}
                        onDragEnd={handleSymbolDragEnd}
                        onClick={() => handleEraseShape(s.id, "symbol")}
                        onTap={() => handleEraseShape(s.id, "symbol")}
                      >
                        {/* "la puerta": the leaf, drawn open (perpendicular to the wall). */}
                        <Line
                          points={[g.hinge.x, g.hinge.y, g.openEnd.x, g.openEnd.y]}
                          stroke={s.color}
                          strokeWidth={2.5 / scale}
                          lineCap="round"
                          hitStrokeWidth={20 / scale}
                        />
                        {/* "la proyección": the swing sweep back to where the leaf sits flush in the wall. */}
                        <Line
                          points={[g.openEnd.x, g.openEnd.y, g.arcMid.x, g.arcMid.y, g.closedEnd.x, g.closedEnd.y]}
                          tension={0.5}
                          stroke={s.color}
                          strokeWidth={1.3 / scale}
                          dash={[4 / scale, 3 / scale]}
                          opacity={0.7}
                          hitStrokeWidth={16 / scale}
                        />
                        {/* "el marco": jamb ticks spanning the wall's thickness — not draggable, just follow hinge/closedEnd. */}
                        <Line
                          points={[g.hingeTick.a.x, g.hingeTick.a.y, g.hingeTick.b.x, g.hingeTick.b.y]}
                          stroke={s.color}
                          strokeWidth={2 / scale}
                          listening={false}
                        />
                        <Line
                          points={[g.closedEndTick.a.x, g.closedEndTick.a.y, g.closedEndTick.b.x, g.closedEndTick.b.y]}
                          stroke={s.color}
                          strokeWidth={2 / scale}
                          listening={false}
                        />
                        {(tool === "stretch" || tool === "select") && (
                          <Group
                            x={mirrorBtn.x}
                            y={mirrorBtn.y}
                            onClick={(e) => {
                              e.cancelBubble = true;
                              handleToggleDoorMirror(s);
                            }}
                            onTap={(e) => {
                              e.cancelBubble = true;
                              handleToggleDoorMirror(s);
                            }}
                          >
                            <Circle radius={8 / scale} fill="#ffffff" stroke="#78716c" strokeWidth={1.3 / scale} hitStrokeWidth={10 / scale} />
                            <Text
                              text="⇋"
                              fontSize={11 / scale}
                              fill="#78716c"
                              width={16 / scale}
                              height={16 / scale}
                              offsetX={8 / scale}
                              offsetY={8 / scale}
                              align="center"
                              verticalAlign="middle"
                              listening={false}
                            />
                          </Group>
                        )}
                      </Group>
                    );
                  }
                  const g = windowGeometry(s);
                  return (
                    <Group
                      key={s.id}
                      draggable={tool === "stretch" || tool === "select"}
                      onDragStart={() => handleSymbolDragStart(s)}
                      onDragMove={(e) => handleSymbolDragMove(s.id, e)}
                      onDragEnd={handleSymbolDragEnd}
                      onClick={() => handleEraseShape(s.id, "symbol")}
                      onTap={() => handleEraseShape(s.id, "symbol")}
                    >
                      <Line
                        points={flatten(g.corners)}
                        closed
                        stroke={s.color}
                        strokeWidth={2 / scale}
                        hitStrokeWidth={18 / scale}
                      />
                      <Line
                        points={[g.p1.x, g.p1.y, g.p2.x, g.p2.y]}
                        stroke={s.color}
                        strokeWidth={1.3 / scale}
                        listening={false}
                      />
                    </Group>
                  );
                })}

                {(tool === "stretch" || tool === "select") &&
                  board.symbols.map((s) => {
                    if (s.kind === "door") {
                      const g = doorGeometry(s);
                      return (
                        <Fragment key={`${s.id}-resize`}>
                          <Circle
                            x={g.hinge.x}
                            y={g.hinge.y}
                            radius={7 / scale}
                            fill="#ffffff"
                            stroke="#1c1b1a"
                            strokeWidth={2 / scale}
                            hitStrokeWidth={26 / scale}
                            draggable
                            onDragStart={() => handleDoorResizeStart(s)}
                            onDragMove={handleDoorResizeMove}
                            onDragEnd={handleDoorResizeEnd}
                          />
                          <Circle
                            x={g.closedEndTick.b.x}
                            y={g.closedEndTick.b.y}
                            radius={7 / scale}
                            fill="#ffffff"
                            stroke="#2563eb"
                            strokeWidth={2 / scale}
                            hitStrokeWidth={26 / scale}
                            draggable
                            onDragStart={() => handleDoorFrameResizeStart(s)}
                            onDragMove={handleDoorFrameResizeMove}
                            onDragEnd={handleDoorFrameResizeEnd}
                          />
                        </Fragment>
                      );
                    }
                    const g = windowGeometry(s);
                    return (
                      <Fragment key={`${s.id}-resize`}>
                        {g.corners.map((c, i) => (
                          <Circle
                            key={i}
                            x={c.x}
                            y={c.y}
                            radius={7 / scale}
                            fill="#ffffff"
                            stroke="#c2410c"
                            strokeWidth={2 / scale}
                            hitStrokeWidth={26 / scale}
                            draggable
                            onDragStart={() => handleWindowResizeStart(s, i)}
                            onDragMove={handleWindowResizeMove}
                            onDragEnd={handleWindowResizeEnd}
                          />
                        ))}
                      </Fragment>
                    );
                  })}

                {doorHingeReadout && (
                  <Text
                    x={doorHingeReadout.x}
                    y={doorHingeReadout.y}
                    text={doorHingeReadout.text}
                    fontSize={DIM_FONT_SIZE_SMALL}
                    fontFamily="ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace"
                    fill="#c2410c"
                    offsetX={dimOffsetX(doorHingeReadout.text, DIM_FONT_SIZE_SMALL)}
                    offsetY={18 / DEFAULT_SCALE}
                    listening={false}
                  />
                )}

                {drawingLine && (
                  <>
                    <Line
                      points={[drawingLine.start.x, drawingLine.start.y, drawingLine.end.x, drawingLine.end.y]}
                      stroke={color}
                      strokeWidth={2.5 / scale}
                      dash={[8 / scale, 6 / scale]}
                      lineCap="round"
                    />
                    <Text
                      x={(drawingLine.start.x + drawingLine.end.x) / 2}
                      y={(drawingLine.start.y + drawingLine.end.y) / 2}
                      text={formatCm(distance(drawingLine.start, drawingLine.end))}
                      fontSize={DIM_FONT_SIZE}
                      fontFamily="ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace"
                      fill="#c2410c"
                      offsetX={dimOffsetX(formatCm(distance(drawingLine.start, drawingLine.end)), DIM_FONT_SIZE)}
                      offsetY={18 / DEFAULT_SCALE}
                      listening={false}
                    />
                  </>
                )}
                {drawingLine &&
                  lineAlignGuides?.map((g, i) => {
                    const margin = 0.3;
                    const points =
                      g.axis === "x"
                        ? [g.from.x, Math.min(g.from.y, drawingLine.end.y) - margin, g.from.x, Math.max(g.from.y, drawingLine.end.y) + margin]
                        : [Math.min(g.from.x, drawingLine.end.x) - margin, g.from.y, Math.max(g.from.x, drawingLine.end.x) + margin, g.from.y];
                    return (
                      <Line
                        key={i}
                        points={points}
                        stroke="#ec4899"
                        strokeWidth={1 / scale}
                        dash={[5 / scale, 4 / scale]}
                        listening={false}
                      />
                    );
                  })}
                {ruler && (
                  <>
                    <Line
                      points={
                        ruler.end
                          ? [ruler.start.x, ruler.start.y, ruler.end.x, ruler.end.y]
                          : ruler.hover
                            ? [ruler.start.x, ruler.start.y, ruler.hover.x, ruler.hover.y]
                            : [ruler.start.x, ruler.start.y]
                      }
                      stroke="#c2410c"
                      strokeWidth={2 / scale}
                      dash={[5 / scale, 4 / scale]}
                      lineCap="round"
                      listening={false}
                    />
                    <Circle x={ruler.start.x} y={ruler.start.y} radius={4 / scale} fill="#c2410c" listening={false} />
                    {(ruler.end ?? ruler.hover) && (
                      <>
                        <Circle
                          x={(ruler.end ?? ruler.hover)!.x}
                          y={(ruler.end ?? ruler.hover)!.y}
                          radius={4 / scale}
                          fill="#c2410c"
                          listening={false}
                        />
                        <Text
                          x={(ruler.start.x + (ruler.end ?? ruler.hover)!.x) / 2}
                          y={(ruler.start.y + (ruler.end ?? ruler.hover)!.y) / 2}
                          text={formatCm(distance(ruler.start, (ruler.end ?? ruler.hover)!))}
                          fontSize={DIM_FONT_SIZE}
                          fontFamily="ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace"
                          fill="#c2410c"
                          offsetX={dimOffsetX(
                            formatCm(distance(ruler.start, (ruler.end ?? ruler.hover)!)),
                            DIM_FONT_SIZE
                          )}
                          offsetY={18 / DEFAULT_SCALE}
                          listening={false}
                        />
                      </>
                    )}
                  </>
                )}
                {drawingBox && (
                  <>
                    {tool === "rect" ? (
                      <Rect
                        x={Math.min(drawingBox.start.x, drawingBox.end.x)}
                        y={Math.min(drawingBox.start.y, drawingBox.end.y)}
                        width={Math.abs(drawingBox.end.x - drawingBox.start.x)}
                        height={Math.abs(drawingBox.end.y - drawingBox.start.y)}
                        stroke={color}
                        strokeWidth={2 / scale}
                        dash={[8 / scale, 6 / scale]}
                      />
                    ) : (
                      <Ellipse
                        x={(drawingBox.start.x + drawingBox.end.x) / 2}
                        y={(drawingBox.start.y + drawingBox.end.y) / 2}
                        radiusX={Math.abs(drawingBox.end.x - drawingBox.start.x) / 2}
                        radiusY={Math.abs(drawingBox.end.y - drawingBox.start.y) / 2}
                        stroke={color}
                        strokeWidth={2 / scale}
                        dash={[8 / scale, 6 / scale]}
                      />
                    )}
                  </>
                )}
                {drawingNote && (
                  <Line
                    points={drawingNote}
                    stroke={color}
                    strokeWidth={1.6 / scale}
                    lineCap="round"
                    lineJoin="round"
                    tension={0.15}
                  />
                )}

                {lassoPoints && lassoPoints.length > 1 && (
                  <Line
                    points={flatten(lassoPoints)}
                    closed
                    stroke="#2563eb"
                    strokeWidth={1.5 / scale}
                    dash={[6 / scale, 5 / scale]}
                    fill="#2563eb"
                    opacity={0.5}
                    fillEnabled
                    listening={false}
                  />
                )}

                {lassoSelection &&
                  !lassoSelectionIsEmpty(lassoSelection) &&
                  (() => {
                    const bbox = computeSelectionBBox(board, lassoSelection);
                    if (!bbox) return null;
                    const padding = 14 / scale;
                    return (
                      <Rect
                        x={bbox.minX - padding}
                        y={bbox.minY - padding}
                        width={bbox.maxX - bbox.minX + padding * 2}
                        height={bbox.maxY - bbox.minY + padding * 2}
                        stroke="#2563eb"
                        strokeWidth={1.5 / scale}
                        dash={[7 / scale, 5 / scale]}
                        listening={false}
                      />
                    );
                  })()}

                {tool === "eraser" && eraserCursor && (
                  <Circle
                    x={eraserCursor.x}
                    y={eraserCursor.y}
                    radius={ERASER_CURSOR_RADIUS / scale}
                    stroke="#1c1b1a"
                    strokeWidth={1.5 / scale}
                    listening={false}
                  />
                )}

                {uniqueVertices.map((v, i) => (
                  <Circle key={i} x={v.x} y={v.y} radius={3 / scale} fill="#78716c" listening={false} />
                ))}

                {tool === "curve" &&
                  board.lines.map((l) => (
                    <Circle
                      key={`${l.id}-mid`}
                      x={l.mid.x}
                      y={l.mid.y}
                      radius={7 / scale}
                      fill="#ffffff"
                      stroke={l.color}
                      strokeWidth={2 / scale}
                      hitStrokeWidth={26 / scale}
                      draggable
                      onDragStart={curveMidDragStart}
                      onDragMove={(e) => curveMidDragMove(l, e)}
                      onDblClick={() => resetMid(l.id)}
                      onDblTap={() => resetMid(l.id)}
                    />
                  ))}

                {(tool === "stretch" || tool === "select") &&
                  uniqueVertices.map((v, i) => (
                    <Circle
                      key={`stretch-${i}`}
                      x={v.x}
                      y={v.y}
                      radius={7 / scale}
                      fill="#ffffff"
                      stroke="#c2410c"
                      strokeWidth={2 / scale}
                      hitStrokeWidth={26 / scale}
                      draggable
                      onDragStart={() => handleStretchDragStart(v)}
                      onDragMove={handleStretchDragMove}
                      onDragEnd={handleStretchDragEnd}
                    />
                  ))}

                {showLabels &&
                  board.lines.map((l) => {
                    // `l.mid` is where the curve actually passes at its
                    // midpoint (see sampleCurvePoints) — for a straight line
                    // it equals the straight midpoint, so this centers the
                    // label on the visible line either way.
                    const mid = l.mid;
                    const text = l.value ? formatCm(parseFloat(l.value)) : "…";
                    return (
                      <Text
                        key={`${l.id}-label`}
                        x={mid.x}
                        y={mid.y}
                        text={text}
                        fontSize={DIM_FONT_SIZE}
                        fontFamily="ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace"
                        fill={l.value ? "#1c1b1a" : "#a8a29e"}
                        padding={3 / DEFAULT_SCALE}
                        offsetX={dimOffsetX(text, DIM_FONT_SIZE)}
                        offsetY={18 / DEFAULT_SCALE}
                        onClick={() => openValueEditor(l, true)}
                        onTap={() => openValueEditor(l, true)}
                      />
                    );
                  })}

                {showLabels &&
                  board.symbols.map((s) => {
                    const cos = Math.cos(s.angle);
                    const sin = Math.sin(s.angle);
                    const perp = { x: -sin, y: cos };
                    const offset = 14 / scale;
                    const mid = { x: s.x + (cos * s.length) / 2, y: s.y + (sin * s.length) / 2 };
                    const isDoor = s.kind === "door";
                    const text = formatCm(s.length);
                    return (
                      <Text
                        key={`${s.id}-label`}
                        x={mid.x + perp.x * offset}
                        y={mid.y + perp.y * offset}
                        text={text}
                        fontSize={DIM_FONT_SIZE_SMALL}
                        fontFamily="ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace"
                        fill={isDoor ? "#1c1b1a" : "#78716c"}
                        padding={isDoor ? 2 / DEFAULT_SCALE : 0}
                        offsetX={dimOffsetX(text, DIM_FONT_SIZE_SMALL)}
                        offsetY={DIM_FONT_SIZE_SMALL / 2}
                        listening={isDoor}
                        onClick={isDoor ? () => openDoorWidthEditor(s) : undefined}
                        onTap={isDoor ? () => openDoorWidthEditor(s) : undefined}
                      />
                    );
                  })}

                {board.texts.map((t) => (
                  <Text
                    key={t.id}
                    x={t.x}
                    y={t.y}
                    text={t.text}
                    fontSize={t.fontSize ?? DEFAULT_TEXT_FONT_SIZE}
                    fontFamily="ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace"
                    fill={t.color}
                    padding={2 / DEFAULT_SCALE}
                    draggable={tool === "stretch" || tool === "select"}
                    onDragStart={() => handleTextDragStart(t)}
                    onDragMove={handleTextDragMove}
                    onDragEnd={handleTextDragEnd}
                    onClick={() => {
                      if (tool === "eraser") handleEraseShape(t.id, "text");
                      else openTextEditor(t);
                    }}
                    onTap={() => {
                      if (tool === "eraser") handleEraseShape(t.id, "text");
                      else openTextEditor(t);
                    }}
                  />
                ))}
              </Layer>
            </Stage>
          )}
        </div>

        {editingValue && (
          <div
            className="absolute z-20 -translate-x-1/2 -translate-y-1/2"
            style={{ left: editingValue.screenX, top: editingValue.screenY }}
          >
            <input
              autoFocus
              inputMode="numeric"
              value={editingValue.value}
              onChange={(e) => {
                const value = e.target.value;
                setEditingValue((cur) => (cur ? { ...cur, value } : cur));
                if (editingValue) applyLiveValue(editingValue.id, value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitEditingValue();
                if (e.key === "Escape") cancelEditingValue();
              }}
              onBlur={commitEditingValue}
              placeholder="cm"
              // text-base (16px), not text-sm — below 16px, iOS Safari
              // auto-zooms the page on focus, and with zoom disabled in the
              // viewport meta it gets stuck partway, desyncing where taps
              // land from what's visually under your finger (this is what
              // made taps land on the Capas button instead of the input).
              className="w-24 rounded-md border-2 border-accent bg-white px-2 py-1 text-center font-mono text-base text-ink shadow-lg outline-none"
            />
          </div>
        )}

        {editingText && (
          <div
            className="absolute z-20 -translate-x-1/2 -translate-y-1/2"
            style={{ left: editingText.screenX, top: editingText.screenY }}
          >
            <input
              autoFocus
              value={editingText.value}
              onChange={(e) => {
                const value = e.target.value;
                setEditingText((cur) => (cur ? { ...cur, value } : cur));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitEditingText();
                if (e.key === "Escape") cancelEditingText();
              }}
              onBlur={commitEditingText}
              placeholder="texto"
              className="min-w-[6rem] rounded-md border-2 border-accent bg-white px-2 py-1 text-base text-ink shadow-lg outline-none"
            />
          </div>
        )}

        {editingDoorWidth && (
          <div
            className="absolute z-20 -translate-x-1/2 -translate-y-1/2"
            style={{ left: editingDoorWidth.screenX, top: editingDoorWidth.screenY }}
          >
            <input
              autoFocus
              inputMode="numeric"
              value={editingDoorWidth.value}
              onChange={(e) => {
                const value = e.target.value;
                setEditingDoorWidth((cur) => (cur ? { ...cur, value } : cur));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitDoorWidth();
                if (e.key === "Escape") cancelDoorWidth();
              }}
              onBlur={commitDoorWidth}
              placeholder="cm"
              className="w-24 rounded-md border-2 border-accent bg-white px-2 py-1 text-center font-mono text-base text-ink shadow-lg outline-none"
            />
          </div>
        )}

        {board.background && (
          <div className="absolute right-4 top-4 z-20 flex items-center gap-2 rounded-lg border border-line bg-card px-3 py-2 shadow-lg">
            <span className="font-mono text-[11px] text-ink-faint">Fondo</span>
            <input
              type="range"
              min={0.1}
              max={1}
              step={0.05}
              value={board.background.opacity}
              onChange={(e) => handleBackgroundOpacity(parseFloat(e.target.value))}
              className="w-20"
            />
            <button
              type="button"
              onClick={handleBackgroundToggleLock}
              className={`rounded-md border px-2 py-1 font-mono text-[11px] ${
                board.background.locked ? "border-accent bg-accent-bg text-accent" : "border-line text-ink-soft"
              }`}
            >
              {board.background.locked ? "Bloqueado" : "Bloquear"}
            </button>
            <button
              type="button"
              onClick={handleBackgroundRemove}
              className="rounded-md border border-line px-2 py-1 font-mono text-[11px] text-ink-soft hover:border-red-300 hover:text-red-600"
            >
              Quitar
            </button>
          </div>
        )}

        {tool === "area" && (
          <div className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-line bg-card px-3 py-2 shadow-lg">
            <div className="flex overflow-hidden rounded-md border border-line font-mono text-xs">
              <button
                type="button"
                onClick={() => {
                  setDrawingAreaChain(null);
                  setAreaMode("puntos");
                }}
                className={`px-2 py-1 ${areaMode === "puntos" ? "bg-accent text-white" : "bg-card text-ink-soft"}`}
              >
                Puntos
              </button>
              <button
                type="button"
                onClick={() => {
                  setDrawingArea(null);
                  setAreaMode("lineas");
                }}
                className={`px-2 py-1 ${areaMode === "lineas" ? "bg-accent text-white" : "bg-card text-ink-soft"}`}
              >
                Líneas
              </button>
            </div>
            {areaMode === "puntos" && drawingArea && (
              <>
                <span className="font-mono text-xs text-ink-soft">{drawingArea.length} pts</span>
                <button
                  type="button"
                  disabled={drawingArea.length < 3}
                  onClick={() => {
                    finalizeArea(drawingArea);
                    setDrawingArea(null);
                  }}
                  className="rounded-md bg-accent px-2.5 py-1 font-mono text-xs font-medium text-white disabled:opacity-40"
                >
                  Cerrar área
                </button>
                <button
                  type="button"
                  onClick={() => setDrawingArea(null)}
                  className="rounded-md border border-line px-2.5 py-1 font-mono text-xs text-ink-soft"
                >
                  Cancelar
                </button>
              </>
            )}
            {areaMode === "lineas" && drawingAreaChain && (
              <>
                <span className="font-mono text-xs text-ink-soft">{drawingAreaChain.length} pts</span>
                <button
                  type="button"
                  disabled={drawingAreaChain.length < 3}
                  onClick={() => {
                    finalizeArea(drawingAreaChain);
                    setDrawingAreaChain(null);
                  }}
                  className="rounded-md bg-accent px-2.5 py-1 font-mono text-xs font-medium text-white disabled:opacity-40"
                >
                  Cerrar área
                </button>
                <button
                  type="button"
                  onClick={() => setDrawingAreaChain(null)}
                  className="rounded-md border border-line px-2.5 py-1 font-mono text-xs text-ink-soft"
                >
                  Cancelar
                </button>
              </>
            )}
          </div>
        )}

        {favoritesOpen && (
          <div className="absolute left-3 top-3 z-20 flex flex-col gap-1.5 rounded-lg border border-line bg-card p-2 shadow-lg">
            <p className="px-1 font-mono text-[11px] uppercase tracking-wide text-ink-faint">Favoritos</p>
            <button
              type="button"
              onClick={() => handleStampSymbol("door")}
              className="rounded-md border border-line px-3 py-1.5 text-left text-sm text-ink hover:border-accent"
            >
              Puerta
            </button>
            <button
              type="button"
              onClick={() => handleStampSymbol("window")}
              className="rounded-md border border-line px-3 py-1.5 text-left text-sm text-ink hover:border-accent"
            >
              Ventana
            </button>
          </div>
        )}

        <LayersPanel
          open={panelOpen}
          onClose={() => setPanelOpen(false)}
          lines={board.lines}
          notes={board.notes}
          areas={board.areas}
          totalMl={totalMl}
          totalM2={totalM2}
          onUpdateValue={handleUpdateLineValue}
          onDeleteLine={handleDeleteLine}
          onDeleteNote={handleDeleteNote}
          onDeleteArea={handleDeleteArea}
        />
      </div>
    </div>
  );
}
