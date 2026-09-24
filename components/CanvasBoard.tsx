"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Stage, Layer, Line, Circle, Text, Rect, Ellipse, Shape, Group } from "react-konva";
import type Konva from "konva";
import type { KonvaEventObject } from "konva/lib/Node";
import { jsPDF } from "jspdf";
import {
  clamp,
  distance,
  findSnapPoint,
  makeId,
  polygonArea,
  projectOntoSegment,
  samePoint,
  snapToAxis,
  snapToGrid,
  type Point,
} from "@/lib/geometry";
import { touchCenter, touchDistance } from "@/lib/pinch";
import { getBoard, saveBoard } from "@/lib/storage";
import { doorGeometry, makeEllipseLines, makeRectLines, newDoor, newWindow, windowGeometry } from "@/lib/symbols";
import {
  emptyBoard,
  moveLineEndpoint,
  newBoardId,
  PEN_COLORS,
  resizeLineToValue,
  type AreaZone,
  type BoardState,
  type LineColor,
  type MeasureLine,
  type SymbolInstance,
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
const LABEL_MIN_SCALE = 15; // px per meter — below this, value labels hide to avoid crossing lines
const TAP_THRESHOLD_PX = 8;
const HISTORY_LIMIT = 50;
const WALL_ALIGN_DIST = 0.5; // meters — how close a door/window has to get to a wall to snap onto it

type Tool = "line" | "curve" | "stretch" | "select" | "rect" | "ellipse" | "note" | "eraser" | "pan" | "area";

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

function findOrthoAnchor(origin: Point, lines: MeasureLine[]): Point | null {
  for (const l of lines) {
    if (samePoint({ x: l.x1, y: l.y1 }, origin, 0.03)) return { x: l.x2, y: l.y2 };
    if (samePoint({ x: l.x2, y: l.y2 }, origin, 0.03)) return { x: l.x1, y: l.y1 };
  }
  return null;
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
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);

  const [history, setHistory] = useState<BoardState[]>([]);
  const [future, setFuture] = useState<BoardState[]>([]);

  const [scale, setScale] = useState(DEFAULT_SCALE);
  const [pos, setPos] = useState<Point>({ x: 0, y: 0 });
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });

  const [drawingLine, setDrawingLine] = useState<{ start: Point; end: Point } | null>(null);
  const [drawingNote, setDrawingNote] = useState<number[] | null>(null);
  const [drawingArea, setDrawingArea] = useState<Point[] | null>(null);
  const [drawingBox, setDrawingBox] = useState<{ start: Point; end: Point } | null>(null);
  const [editingValue, setEditingValue] = useState<EditingValue | null>(null);

  const stageRef = useRef<Konva.Stage>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hasFitRef = useRef(false);
  const pinchRef = useRef<{ dist: number; center: Point; scale: number; pos: Point } | null>(null);
  const stretchOriginRef = useRef<Point | null>(null);
  const stretchConnectionsRef = useRef<{
    lines: { id: string; matchStart: boolean; matchEnd: boolean }[];
    areas: { id: string; pointIndex: number }[];
  }>({ lines: [], areas: [] });
  const lineDragOriginRef = useRef<{ start: Point; end: Point; mid: Point } | null>(null);
  const lineDragConnectionsRef = useRef<
    { id: string; matchStart: boolean; matchEnd: boolean; end: "start" | "end" }[]
  >([]);
  const lineDragAreaConnectionsRef = useRef<{ id: string; pointIndex: number; end: "start" | "end" }[]>([]);
  const symbolDragOriginRef = useRef<{ x: number; y: number; angle: number } | null>(null);
  const doorResizeOriginRef = useRef<{ id: string } | null>(null);
  const windowResizeOriginRef = useRef<{ id: string; end: "p1" | "p2"; fixedPoint: Point } | null>(null);
  const boardRef = useRef(board);

  useEffect(() => {
    boardRef.current = board;
  }, [board]);

  const setTool = useCallback((t: Tool) => {
    setDrawingArea(null);
    setDrawingBox(null);
    setSelectedLineId(null);
    setFavoritesOpen(false);
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
      // Older saved boards may predate the `symbols` field.
      setBoard(saved ? { ...saved, symbols: saved.symbols ?? [] } : emptyBoard(boardId));
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
  // zoomed out, 50cm once the finer grid fades in.
  const gridStep = scale >= FINE_GRID_MIN_SCALE ? FINE_GRID_STEP : 1;

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
      } else if (tool === "area") {
        const threshold = SNAP_PX / scale;
        const snapped = findSnapPoint(world, allEndpoints(), threshold);
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
        setSelectedLineId(null);
      }
    },
    [tool, scale, toWorld, allEndpoints, gridStep, finalizeArea]
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
      let end = vertexSnap ?? snapToGrid(world, GRID_SNAP_PX / scale, gridStep) ?? world;
      if (ortho) end = snapToAxis(drawingLine.start, end);
      setDrawingLine({ start: drawingLine.start, end });
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
    }
  }, [tool, drawingLine, drawingBox, drawingNote, ortho, scale, toWorld, allEndpoints, gridStep]);

  const handlePointerUp = useCallback(() => {
    if (tool === "line" && drawingLine) {
      const { start, end } = drawingLine;
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
    } else if ((tool === "rect" || tool === "ellipse") && drawingBox) {
      const { start, end } = drawingBox;
      if (distance(start, end) * scale < TAP_THRESHOLD_PX) {
        setDrawingBox(null);
        return;
      }
      pushHistory();
      const newLines = tool === "rect" ? makeRectLines(start, end, color) : makeEllipseLines(start, end, color);
      setBoard((b) => ({ ...b, lines: [...b.lines, ...newLines], updatedAt: Date.now() }));
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
    }
  }, [tool, drawingLine, drawingBox, drawingNote, color, scale, pushHistory]);

  const handleEraseShape = useCallback(
    (id: string, kind: "measure" | "note" | "area" | "symbol") => {
      if (tool !== "eraser") return;
      pushHistory();
      setBoard((b) => ({
        ...b,
        lines: kind === "measure" ? b.lines.filter((l) => l.id !== id) : b.lines,
        notes: kind === "note" ? b.notes.filter((n) => n.id !== id) : b.notes,
        areas: kind === "area" ? b.areas.filter((a) => a.id !== id) : b.areas,
        symbols: kind === "symbol" ? b.symbols.filter((s) => s.id !== id) : b.symbols,
        updatedAt: Date.now(),
      }));
    },
    [tool, pushHistory]
  );

  const openValueEditor = useCallback(
    (line: MeasureLine) => {
      if (tool === "eraser" || tool === "pan" || tool === "area" || tool === "curve" || tool === "stretch" || tool === "select")
        return;
      pushHistory();
      const mid = { x: (line.x1 + line.x2) / 2, y: (line.y1 + line.y2) / 2 };
      setEditingValue({
        id: line.id,
        screenX: mid.x * scale + pos.x,
        screenY: mid.y * scale + pos.y,
        value: line.value,
        original: { x2: line.x2, y2: line.y2, mid: line.mid },
      });
    },
    [tool, scale, pos, pushHistory]
  );

  const applyLiveValue = useCallback((id: string, value: string) => {
    setBoard((b) => ({
      ...b,
      lines: b.lines.map((l) => (l.id === id ? resizeLineToValue(l, value) : l)),
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

  // --- estirar: from a point (a shared vertex) or from a line (translates it,
  // dragging along whatever else is connected at each end) -------------------

  const handleStretchDragStart = useCallback(
    (vertex: Point) => {
      pushHistory();
      stretchOriginRef.current = vertex;
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
        if (ortho) {
          const anchor = findOrthoAnchor(origin, board.lines);
          if (anchor) snapped = snapToAxis(anchor, snapped);
        }
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
    [scale, allEndpoints, gridStep, ortho, board.lines]
  );

  const handleStretchDragEnd = useCallback(() => {
    stretchOriginRef.current = null;
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
      lineDragConnectionsRef.current = b.lines
        .filter((l) => l.id !== line.id)
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
      const provisionalStart = { x: origin.start.x + rawDelta.x, y: origin.start.y + rawDelta.y };
      const g = snapToGrid(provisionalStart, GRID_SNAP_PX / scale, gridStep);
      const adj = g ? { x: g.x - provisionalStart.x, y: g.y - provisionalStart.y } : { x: 0, y: 0 };
      const delta = { x: rawDelta.x + adj.x, y: rawDelta.y + adj.y };
      const newStart = { x: origin.start.x + delta.x, y: origin.start.y + delta.y };
      const newEnd = { x: origin.end.x + delta.x, y: origin.end.y + delta.y };
      const newMid = { x: origin.mid.x + delta.x, y: origin.mid.y + delta.y };

      const conns = lineDragConnectionsRef.current;
      const areaConns = lineDragAreaConnectionsRef.current;
      setBoard((b) => ({
        ...b,
        lines: b.lines.map((l) => {
          if (l.id === lineId) {
            return { ...l, x1: newStart.x, y1: newStart.y, x2: newEnd.x, y2: newEnd.y, mid: newMid };
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
  }, []);

  // --- select: recolor / delete the selected line ---------------------------

  const handleRecolorSelected = useCallback(
    (c: LineColor) => {
      if (!selectedLineId) return;
      pushHistory();
      setBoard((b) => ({
        ...b,
        lines: b.lines.map((l) => (l.id === selectedLineId ? { ...l, color: c } : l)),
        updatedAt: Date.now(),
      }));
    },
    [selectedLineId, pushHistory]
  );

  const handleDeleteSelected = useCallback(() => {
    if (!selectedLineId) return;
    pushHistory();
    setBoard((b) => ({ ...b, lines: b.lines.filter((l) => l.id !== selectedLineId), updatedAt: Date.now() }));
    setSelectedLineId(null);
  }, [selectedLineId, pushHistory]);

  // --- favoritos: stamp a door/window "dynamic block" at the view's center ---

  const handleStampSymbol = useCallback(
    (kind: "door" | "window") => {
      pushHistory();
      const worldCenter = toWorld({ x: stageSize.width / 2, y: stageSize.height / 2 });
      const symbol = kind === "door" ? newDoor(worldCenter, color) : newWindow(worldCenter, color);
      setBoard((b) => ({ ...b, symbols: [...b.symbols, symbol], updatedAt: Date.now() }));
      setFavoritesOpen(false);
    },
    [pushHistory, toWorld, stageSize, color]
  );

  // Dragging a door/window's body moves it and re-aligns it (position +
  // angle) onto whatever wall it lands near — the "dynamic block" behavior.
  const handleSymbolDragStart = useCallback(
    (s: SymbolInstance) => {
      pushHistory();
      symbolDragOriginRef.current = { x: s.x, y: s.y, angle: s.angle };
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
    let best: { dist: number } | null = null;
    for (const l of boardRef.current.lines) {
      const { point, dist } = projectOntoSegment({ x: newX, y: newY }, { x: l.x1, y: l.y1 }, { x: l.x2, y: l.y2 });
      if (dist <= WALL_ALIGN_DIST && (!best || dist < best.dist)) {
        best = { dist };
        newX = point.x;
        newY = point.y;
        newAngle = Math.atan2(l.y2 - l.y1, l.x2 - l.x1);
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

  // Door: a single handle at the free end of the leaf — dragging it changes
  // `length`, and the whole shape (leaf + swing arc) scales from that.
  const handleDoorResizeStart = useCallback(
    (s: SymbolInstance) => {
      pushHistory();
      doorResizeOriginRef.current = { id: s.id };
    },
    [pushHistory]
  );

  const handleDoorResizeMove = useCallback((id: string, e: KonvaEventObject<DragEvent>) => {
    if (!doorResizeOriginRef.current) return;
    const raw = e.target.position();
    setBoard((b) => ({
      ...b,
      symbols: b.symbols.map((s) => {
        if (s.id !== id) return s;
        const dx = raw.x - s.x;
        const dy = raw.y - s.y;
        const length = Math.max(0.2, Math.hypot(dx, dy));
        const angle = Math.atan2(dy, dx);
        return { ...s, length, angle };
      }),
      updatedAt: Date.now(),
    }));
  }, []);

  const handleDoorResizeEnd = useCallback(() => {
    doorResizeOriginRef.current = null;
  }, []);

  // Window: a handle at each end — grab either one to extend/shrink from
  // that side, like stretching a line.
  const handleWindowResizeStart = useCallback(
    (s: SymbolInstance, end: "p1" | "p2") => {
      pushHistory();
      const cos = Math.cos(s.angle);
      const sin = Math.sin(s.angle);
      const p2 = { x: s.x + cos * s.length, y: s.y + sin * s.length };
      windowResizeOriginRef.current = { id: s.id, end, fixedPoint: end === "p1" ? p2 : { x: s.x, y: s.y } };
    },
    [pushHistory]
  );

  const handleWindowResizeMove = useCallback((e: KonvaEventObject<DragEvent>) => {
    const origin = windowResizeOriginRef.current;
    if (!origin) return;
    const raw = e.target.position();
    const fixed = origin.fixedPoint;
    setBoard((b) => ({
      ...b,
      symbols: b.symbols.map((s) => {
        if (s.id !== origin.id) return s;
        if (origin.end === "p2") {
          const length = Math.max(0.2, Math.hypot(raw.x - s.x, raw.y - s.y));
          const angle = Math.atan2(raw.y - s.y, raw.x - s.x);
          return { ...s, length, angle };
        }
        const length = Math.max(0.2, Math.hypot(fixed.x - raw.x, fixed.y - raw.y));
        const angle = Math.atan2(fixed.y - raw.y, fixed.x - raw.x);
        return { ...s, x: raw.x, y: raw.y, length, angle };
      }),
      updatedAt: Date.now(),
    }));
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

      if (!pinchRef.current) {
        pinchRef.current = { dist, center, scale, pos };
        setDrawingLine(null);
        setDrawingNote(null);
        return;
      }
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
    },
    [scale, pos, clampPos]
  );

  const handleTouchEnd = useCallback((e: KonvaEventObject<TouchEvent>) => {
    if (e.evt.touches.length < 2) pinchRef.current = null;
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
        points.push(g.hinge, g.leafEnd, g.swingEnd);
      } else {
        const g = windowGeometry(s);
        points.push(...g.corners);
      }
    });

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
  }, [board]);

  const totalMl = board.lines.reduce((sum, l) => {
    const n = parseFloat(l.value.replace(",", "."));
    return Number.isFinite(n) ? sum + n : sum;
  }, 0);

  const totalM2 = board.areas.reduce((sum, a) => sum + polygonArea(a.points), 0);

  const selectedLine = selectedLineId ? board.lines.find((l) => l.id === selectedLineId) ?? null : null;
  const showLabels = scale >= LABEL_MIN_SCALE;

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
      />

      <div className="relative flex-1 min-h-0">
        <div ref={containerRef} className="absolute inset-0">
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
              onTouchStart={handlePointerDown}
              onTouchMove={(e) => {
                if (e.evt.touches.length === 2) handleTouchMove(e);
                else handlePointerMove();
              }}
              onTouchEnd={(e) => {
                handleTouchEnd(e);
                handlePointerUp();
              }}
              onWheel={handleWheel}
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
                          fontSize={13 / scale}
                          fontFamily="ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace"
                          fill="#1c1b1a"
                          align="center"
                          offsetX={30 / scale}
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

                {board.notes.map((n) => (
                  <Line
                    key={n.id}
                    points={n.points}
                    stroke={n.color}
                    strokeWidth={2 / scale}
                    lineCap="round"
                    lineJoin="round"
                    tension={0.4}
                    opacity={0.75}
                    dash={[1, 4]}
                    hitStrokeWidth={16 / scale}
                    onClick={() => handleEraseShape(n.id, "note")}
                    onTap={() => handleEraseShape(n.id, "note")}
                  />
                ))}

                {selectedLine && (
                  <Line
                    points={[selectedLine.x1, selectedLine.y1, selectedLine.mid.x, selectedLine.mid.y, selectedLine.x2, selectedLine.y2]}
                    tension={0.5}
                    stroke="#c2410c"
                    strokeWidth={7 / scale}
                    opacity={0.3}
                    lineCap="round"
                    listening={false}
                  />
                )}

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
                      else if (tool === "select") setSelectedLineId(l.id);
                      else openValueEditor(l);
                    }}
                    onTap={() => {
                      if (tool === "eraser") handleEraseShape(l.id, "measure");
                      else if (tool === "select") setSelectedLineId(l.id);
                      else openValueEditor(l);
                    }}
                  />
                ))}

                {board.symbols.map((s) => {
                  if (s.kind === "door") {
                    const g = doorGeometry(s);
                    return (
                      <Group
                        key={s.id}
                        draggable={tool === "stretch"}
                        onDragStart={() => handleSymbolDragStart(s)}
                        onDragMove={(e) => handleSymbolDragMove(s.id, e)}
                        onDragEnd={handleSymbolDragEnd}
                        onClick={() => handleEraseShape(s.id, "symbol")}
                        onTap={() => handleEraseShape(s.id, "symbol")}
                      >
                        <Line
                          points={[g.hinge.x, g.hinge.y, g.leafEnd.x, g.leafEnd.y]}
                          stroke={s.color}
                          strokeWidth={2.5 / scale}
                          lineCap="round"
                          hitStrokeWidth={20 / scale}
                        />
                        <Line
                          points={[g.leafEnd.x, g.leafEnd.y, g.arcMid.x, g.arcMid.y, g.swingEnd.x, g.swingEnd.y]}
                          tension={0.5}
                          stroke={s.color}
                          strokeWidth={1.3 / scale}
                          dash={[4 / scale, 3 / scale]}
                          opacity={0.7}
                          hitStrokeWidth={16 / scale}
                        />
                      </Group>
                    );
                  }
                  const g = windowGeometry(s);
                  return (
                    <Group
                      key={s.id}
                      draggable={tool === "stretch"}
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

                {tool === "stretch" &&
                  board.symbols.map((s) => {
                    if (s.kind === "door") {
                      const g = doorGeometry(s);
                      return (
                        <Circle
                          key={`${s.id}-resize`}
                          x={g.leafEnd.x}
                          y={g.leafEnd.y}
                          radius={6 / scale}
                          fill="#ffffff"
                          stroke={s.color}
                          strokeWidth={2 / scale}
                          hitStrokeWidth={24 / scale}
                          draggable
                          onDragStart={() => handleDoorResizeStart(s)}
                          onDragMove={(e) => handleDoorResizeMove(s.id, e)}
                          onDragEnd={handleDoorResizeEnd}
                        />
                      );
                    }
                    const g = windowGeometry(s);
                    return (
                      <Fragment key={`${s.id}-resize`}>
                        <Circle
                          x={g.p1.x}
                          y={g.p1.y}
                          radius={6 / scale}
                          fill="#ffffff"
                          stroke={s.color}
                          strokeWidth={2 / scale}
                          hitStrokeWidth={24 / scale}
                          draggable
                          onDragStart={() => handleWindowResizeStart(s, "p1")}
                          onDragMove={handleWindowResizeMove}
                          onDragEnd={handleWindowResizeEnd}
                        />
                        <Circle
                          x={g.p2.x}
                          y={g.p2.y}
                          radius={6 / scale}
                          fill="#ffffff"
                          stroke={s.color}
                          strokeWidth={2 / scale}
                          hitStrokeWidth={24 / scale}
                          draggable
                          onDragStart={() => handleWindowResizeStart(s, "p2")}
                          onDragMove={handleWindowResizeMove}
                          onDragEnd={handleWindowResizeEnd}
                        />
                      </Fragment>
                    );
                  })}

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
                      text={`${distance(drawingLine.start, drawingLine.end).toFixed(2)} m`}
                      fontSize={13 / scale}
                      fontFamily="ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace"
                      fill="#c2410c"
                      offsetY={18 / scale}
                      align="center"
                      listening={false}
                    />
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
                    strokeWidth={2 / scale}
                    lineCap="round"
                    lineJoin="round"
                    tension={0.4}
                    dash={[1, 4]}
                    opacity={0.75}
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
                      onDragStart={pushHistory}
                      onDragMove={(e) => {
                        const p = e.target.position();
                        setBoard((b) => ({
                          ...b,
                          lines: b.lines.map((ln) => (ln.id === l.id ? { ...ln, mid: { x: p.x, y: p.y } } : ln)),
                          updatedAt: Date.now(),
                        }));
                      }}
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
                    const mid = { x: (l.x1 + l.x2) / 2, y: (l.y1 + l.y2) / 2 };
                    return (
                      <Text
                        key={`${l.id}-label`}
                        x={mid.x}
                        y={mid.y}
                        text={l.value ? `${l.value} m` : "…"}
                        fontSize={13 / scale}
                        fontFamily="ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace"
                        fill={l.value ? "#1c1b1a" : "#a8a29e"}
                        padding={3 / scale}
                        offsetY={18 / scale}
                        align="center"
                        onClick={() => openValueEditor(l)}
                        onTap={() => openValueEditor(l)}
                      />
                    );
                  })}
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
              inputMode="decimal"
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
              placeholder="metros"
              className="w-24 rounded-md border-2 border-accent bg-white px-2 py-1 text-center font-mono text-sm text-ink shadow-lg outline-none"
            />
          </div>
        )}

        {drawingArea && (
          <div className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-line bg-card px-3 py-2 shadow-lg">
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
          </div>
        )}

        {selectedLine && (
          <div
            className="absolute z-20 -translate-x-1/2 -translate-y-full flex items-center gap-2 rounded-lg border border-line bg-card px-3 py-2 shadow-lg"
            style={{
              left: ((selectedLine.x1 + selectedLine.x2) / 2) * scale + pos.x,
              top: ((selectedLine.y1 + selectedLine.y2) / 2) * scale + pos.y - 14,
            }}
          >
            {PEN_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => handleRecolorSelected(c)}
                aria-label={`Color ${c}`}
                className={`h-6 w-6 rounded-full border-2 ${selectedLine.color === c ? "border-ink" : "border-transparent"}`}
                style={{ backgroundColor: c }}
              />
            ))}
            <button
              type="button"
              onClick={handleDeleteSelected}
              className="rounded-md border border-line px-2.5 py-1 font-mono text-xs text-red-600"
            >
              Eliminar
            </button>
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
