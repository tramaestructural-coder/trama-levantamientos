"use client";

import { polygonArea, samePoint } from "@/lib/geometry";
import type { AreaZone, MeasureLine, NoteStroke } from "@/lib/types";

function connectionsFor(line: MeasureLine, all: MeasureLine[], indexOf: Map<string, number>): number[] {
  const ends = [
    { x: line.x1, y: line.y1 },
    { x: line.x2, y: line.y2 },
  ];
  const result = new Set<number>();
  for (const other of all) {
    if (other.id === line.id) continue;
    const otherEnds = [
      { x: other.x1, y: other.y1 },
      { x: other.x2, y: other.y2 },
    ];
    const connects = ends.some((e) => otherEnds.some((oe) => samePoint(e, oe)));
    if (connects) result.add(indexOf.get(other.id)! + 1);
  }
  return Array.from(result).sort((a, b) => a - b);
}

export default function LayersPanel({
  open,
  onClose,
  lines,
  notes,
  areas,
  totalMl,
  totalM2,
  onUpdateValue,
  onDeleteLine,
  onDeleteNote,
  onDeleteArea,
}: {
  open: boolean;
  onClose: () => void;
  lines: MeasureLine[];
  notes: NoteStroke[];
  areas: AreaZone[];
  totalMl: number;
  totalM2: number;
  onUpdateValue: (id: string, value: string) => void;
  onDeleteLine: (id: string) => void;
  onDeleteNote: (id: string) => void;
  onDeleteArea: (id: string) => void;
}) {
  const indexOf = new Map(lines.map((l, i) => [l.id, i]));

  return (
    <div
      className={`absolute right-0 top-0 z-20 flex h-full w-72 max-w-[85vw] flex-col border-l border-line bg-card shadow-xl transition-transform ${
        open ? "translate-x-0" : "translate-x-full"
      }`}
    >
      <div className="flex items-center justify-between border-b border-line px-3 py-2.5">
        <h2 className="font-display text-sm font-semibold text-ink">Capas</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar panel de capas"
          className="text-ink-faint hover:text-ink"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="border-b border-line px-3 py-2 font-mono text-xs text-ink-soft">
          Total: <span className="font-semibold text-ink">{totalMl.toFixed(2)} ml</span>
          {totalM2 > 0 && (
            <>
              {" · "}
              <span className="font-semibold text-ink">{totalM2.toFixed(2)} m²</span>
            </>
          )}
        </div>

        {lines.length === 0 && notes.length === 0 && areas.length === 0 && (
          <p className="px-3 py-4 text-sm text-ink-faint">Todavía no hay líneas dibujadas.</p>
        )}

        <ul>
          {lines.map((line, i) => {
            const conns = connectionsFor(line, lines, indexOf);
            return (
              <li key={line.id} className="flex items-center gap-2 border-b border-line px-3 py-2">
                <span className="h-3 w-3 flex-shrink-0 rounded-full" style={{ backgroundColor: line.color }} />
                <span className="w-7 flex-shrink-0 font-mono text-xs text-ink-faint">L{i + 1}</span>
                <input
                  value={line.value}
                  onChange={(e) => onUpdateValue(line.id, e.target.value)}
                  placeholder="—"
                  inputMode="decimal"
                  // text-base, not text-xs — under 16px, iOS auto-zooms the
                  // page on focus (see CanvasBoard.tsx's editingValue input).
                  className="w-20 flex-shrink-0 rounded border border-line bg-paper px-1.5 py-1 text-center font-mono text-base text-ink outline-none focus:border-accent"
                />
                <span className="flex-1 truncate font-mono text-[11px] text-ink-faint">
                  {conns.length ? `conecta L${conns.join(", L")}` : ""}
                </span>
                <button
                  type="button"
                  onClick={() => onDeleteLine(line.id)}
                  aria-label={`Borrar línea ${i + 1}`}
                  className="flex-shrink-0 text-ink-faint hover:text-red-600"
                >
                  ✕
                </button>
              </li>
            );
          })}

          {notes.map((note, i) => (
            <li key={note.id} className="flex items-center gap-2 border-b border-line px-3 py-2">
              <span className="h-3 w-3 flex-shrink-0 rounded-full" style={{ backgroundColor: note.color }} />
              <span className="flex-1 font-mono text-xs text-ink-soft">Nota {i + 1}</span>
              <button
                type="button"
                onClick={() => onDeleteNote(note.id)}
                aria-label={`Borrar nota ${i + 1}`}
                className="flex-shrink-0 text-ink-faint hover:text-red-600"
              >
                ✕
              </button>
            </li>
          ))}

          {areas.map((area, i) => (
            <li key={area.id} className="flex items-center gap-2 border-b border-line px-3 py-2">
              <span className="h-3 w-3 flex-shrink-0 rounded-full" style={{ backgroundColor: area.color }} />
              <span className="flex-1 font-mono text-xs text-ink-soft">
                Área {i + 1} · {polygonArea(area.points).toFixed(2)} m²
              </span>
              <button
                type="button"
                onClick={() => onDeleteArea(area.id)}
                aria-label={`Borrar área ${i + 1}`}
                className="flex-shrink-0 text-ink-faint hover:text-red-600"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
