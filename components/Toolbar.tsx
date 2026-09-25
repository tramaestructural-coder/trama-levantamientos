"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PEN_COLORS, type LineColor } from "@/lib/types";

type Tool = "line" | "curve" | "stretch" | "select" | "rect" | "ellipse" | "note" | "text" | "eraser" | "pan" | "area" | "ruler" | "lasso" | "scale" | "move";

const COLOR_NAMES: Record<LineColor, string> = {
  "#1c1b1a": "Negro",
  "#dc2626": "Rojo",
  "#16a34a": "Verde",
  "#2563eb": "Azul",
  "#ea580c": "Naranjo",
};

function IconLine() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M3 15L15 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
function IconNote() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path
        d="M2.5 13.5c2-1 3-4 4-7s3-4.5 5-4 2 3-1 5-6 4.5-6 4.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function IconEraser() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect
        x="3.5"
        y="8"
        width="11"
        height="6"
        rx="1.2"
        transform="rotate(-20 3.5 8)"
        stroke="currentColor"
        strokeWidth="1.6"
      />
    </svg>
  );
}
function IconHand() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path
        d="M6 9.5V4a1 1 0 0 1 2 0v4.5M8 8.5V3a1 1 0 0 1 2 0v5.5M10 8.7V4.2a1 1 0 0 1 2 0V10M12 6.2a1 1 0 0 1 2 0V11c0 2.8-1.8 5-4.5 5-2 0-3-.7-4-2l-2-3.3c-.4-.7 0-1.7.9-1.8.5-.1 1 .1 1.3.6l1.3 2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function IconCurve() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path
        d="M2.5 13.5c3-8 10-8.5 13-5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="9.3" cy="9.6" r="1.4" fill="currentColor" />
    </svg>
  );
}
function IconStretch() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path
        d="M2.5 9h13M2.5 9l3-3M2.5 9l3 3M15.5 9l-3-3M15.5 9l-3 3"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function IconSelect() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path
        d="M3 2.5 3 14.5 6.5 11.5 8.7 15.7 10.4 14.8 8.2 10.6 12.5 10.2 3 2.5Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
        fill="currentColor"
        fillOpacity="0.15"
      />
    </svg>
  );
}
function IconLasso() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path
        d="M9.2 2.8c-3.6 0-6.2 2.3-6.2 5 0 2.2 1.7 4 4.2 4.6-.5.5-.8 1-.8 1.5 0 1 1 1.6 2.1 1.6.8 0 1.5-.3 1.9-.8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray="2.2 2"
      />
      <circle cx="9.6" cy="14" r="1.3" fill="currentColor" />
    </svg>
  );
}
function IconScale() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path
        d="M3 11v4h4M15 7V3h-4M15 3 10 8M3 15l5-5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function IconMove() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path
        d="M9 2.5v13M2.5 9h13M9 2.5 6.8 4.7M9 2.5l2.2 2.2M9 15.5l-2.2-2.2M9 15.5l2.2-2.2M2.5 9l2.2-2.2M2.5 9l2.2 2.2M15.5 9l-2.2-2.2M15.5 9l-2.2 2.2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function IconTrash() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
      <path
        d="M4 5.5h10M7.5 5.5V4a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M5.5 5.5 6.2 14a1 1 0 0 0 1 .9h3.6a1 1 0 0 0 1-.9l.7-8.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function IconRect() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="3" y="4.5" width="12" height="9" rx="0.5" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}
function IconEllipse() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <ellipse cx="9" cy="9" rx="6.5" ry="4.5" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}
function IconText() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M4 4.5h10M9 4.5V14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
function IconRuler() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="2.5" y="6.5" width="13" height="5" rx="0.8" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5 6.5V9M8 6.5V9M11 6.5V9M14 6.5V9" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}
function IconMeasureTool() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M3 15L15 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="3" cy="15" r="1.6" fill="currentColor" />
      <circle cx="15" cy="3" r="1.6" fill="currentColor" />
      <path d="M8 10l1.5-1.5M10 8l1.5-1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}
function IconFavorite() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path
        d="M9 2.7 10.9 6.7 15.2 7.3 12.1 10.3 12.9 14.6 9 12.6 5.1 14.6 5.9 10.3 2.8 7.3 7.1 6.7 9 2.7Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function IconUndo() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path
        d="M4 8h7a3.5 3.5 0 0 1 0 7H8.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M6.5 5 4 8l2.5 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconRedo() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path
        d="M14 8H7a3.5 3.5 0 0 0 0 7h2.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M11.5 5 14 8l-2.5 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconArea() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path
        d="M3 4 9 2.5 15 5 13.5 12 8 15.5 2.5 11 3 4Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        fill="currentColor"
        fillOpacity="0.12"
      />
    </svg>
  );
}
function IconBack() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
      <path d="M11 3.5 5 9l6 5.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconLayers() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path
        d="M9 2.5 15.5 6 9 9.5 2.5 6 9 2.5Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M2.5 9.5 9 13l6.5-3.5" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M2.5 13 9 16.5 15.5 13" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

function ToolButton({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`flex h-9 w-9 items-center justify-center rounded-md border transition-colors ${
        active
          ? "border-accent bg-accent-bg text-accent"
          : "border-line bg-card text-ink-soft hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

export default function Toolbar({
  boardName,
  onRenameBoard,
  tool,
  setTool,
  color,
  setColor,
  ortho,
  setOrtho,
  showDimensions,
  setShowDimensions,
  onExportPdf,
  onNewBoard,
  panelOpen,
  setPanelOpen,
  favoritesOpen,
  setFavoritesOpen,
  totalMl,
  totalM2,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  hasSelection,
  onSelectionColor,
  onSelectionDelete,
  onSelectionClear,
}: {
  boardName: string;
  onRenameBoard: (name: string) => void;
  tool: Tool;
  setTool: (t: Tool) => void;
  color: LineColor;
  setColor: (c: LineColor) => void;
  ortho: boolean;
  setOrtho: (v: boolean) => void;
  showDimensions: boolean;
  setShowDimensions: (v: boolean) => void;
  onExportPdf: () => void;
  onNewBoard: () => void | Promise<void>;
  panelOpen: boolean;
  setPanelOpen: (v: boolean) => void;
  favoritesOpen: boolean;
  setFavoritesOpen: (v: boolean) => void;
  totalMl: number;
  totalM2: number;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  hasSelection: boolean;
  onSelectionColor: (c: LineColor) => void;
  onSelectionDelete: () => void;
  onSelectionClear: () => void;
}) {
  const [name, setName] = useState(boardName);

  useEffect(() => {
    setName(boardName);
  }, [boardName]);

  return (
    <div className="z-30 border-b border-line bg-card">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
      <Link
        href="/"
        aria-label="Volver a Levantamientos"
        title="Volver a Levantamientos"
        className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md border border-line bg-card text-ink-soft hover:text-ink"
      >
        <IconBack />
      </Link>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => onRenameBoard(name.trim() || "Levantamiento sin nombre")}
        className="min-w-0 flex-shrink basis-36 rounded-md border border-transparent bg-transparent px-1.5 py-1 font-display text-base font-semibold text-ink outline-none hover:border-line focus:border-line"
        placeholder="Nombre del levantamiento"
      />

      <div className="flex items-center gap-1">
        <ToolButton active={tool === "line"} onClick={() => setTool("line")} label="Línea de medida">
          <IconLine />
        </ToolButton>
        <ToolButton active={tool === "ruler"} onClick={() => setTool("ruler")} label="Regla (mide sin dejar muro)">
          <IconMeasureTool />
        </ToolButton>
        <ToolButton active={tool === "rect"} onClick={() => setTool("rect")} label="Rectángulo">
          <IconRect />
        </ToolButton>
        <ToolButton active={tool === "ellipse"} onClick={() => setTool("ellipse")} label="Elipse">
          <IconEllipse />
        </ToolButton>
        <ToolButton active={tool === "curve"} onClick={() => setTool("curve")} label="Curvar línea (arrastra el punto medio)">
          <IconCurve />
        </ToolButton>
        <ToolButton active={tool === "note"} onClick={() => setTool("note")} label="Nota a mano alzada">
          <IconNote />
        </ToolButton>
        <ToolButton active={tool === "text"} onClick={() => setTool("text")} label="Texto">
          <IconText />
        </ToolButton>
      </div>

      <div className="flex items-center gap-1">
        <ToolButton active={tool === "select"} onClick={() => setTool("select")} label="Seleccionar línea">
          <IconSelect />
        </ToolButton>
        <ToolButton active={tool === "lasso"} onClick={() => setTool("lasso")} label="Lazo (selecciona varios y agranda/achica con dos dedos)">
          <IconLasso />
        </ToolButton>
        <ToolButton active={tool === "stretch"} onClick={() => setTool("stretch")} label="Estirar (arrastra un punto o una línea)">
          <IconStretch />
        </ToolButton>
        <ToolButton active={tool === "eraser"} onClick={() => setTool("eraser")} label="Goma">
          <IconEraser />
        </ToolButton>
        <ToolButton active={tool === "area"} onClick={() => setTool("area")} label="Sacar área (puntos o líneas)">
          <IconArea />
        </ToolButton>
        <ToolButton active={tool === "pan"} onClick={() => setTool("pan")} label="Mover lienzo">
          <IconHand />
        </ToolButton>
        <ToolButton active={favoritesOpen} onClick={() => setFavoritesOpen(!favoritesOpen)} label="Favoritos (puerta, ventana)">
          <IconFavorite />
        </ToolButton>
      </div>

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onUndo}
          disabled={!canUndo}
          aria-label="Deshacer"
          title="Deshacer"
          className="flex h-9 w-9 items-center justify-center rounded-md border border-line bg-card text-ink-soft hover:text-ink disabled:opacity-30"
        >
          <IconUndo />
        </button>
        <button
          type="button"
          onClick={onRedo}
          disabled={!canRedo}
          aria-label="Rehacer"
          title="Rehacer"
          className="flex h-9 w-9 items-center justify-center rounded-md border border-line bg-card text-ink-soft hover:text-ink disabled:opacity-30"
        >
          <IconRedo />
        </button>
      </div>

      {(tool === "line" || tool === "rect" || tool === "ellipse" || tool === "note" || tool === "text") && (
        <div className="flex items-center gap-1">
          {PEN_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              aria-label={COLOR_NAMES[c]}
              title={COLOR_NAMES[c]}
              className={`h-6 w-6 rounded-full border-2 ${color === c ? "border-ink" : "border-transparent"}`}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
      )}

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setOrtho(!ortho)}
          aria-pressed={ortho}
          className={`rounded-md border px-2.5 py-1.5 font-mono text-xs ${
            ortho ? "border-accent bg-accent-bg text-accent" : "border-line bg-card text-ink-soft"
          }`}
          title="Fuerza las líneas y el estirado a quedar horizontales o verticales"
        >
          Guía recta
        </button>
        <button
          type="button"
          onClick={() => setShowDimensions(!showDimensions)}
          aria-pressed={showDimensions}
          className={`flex h-9 items-center gap-1 rounded-md border px-2.5 font-mono text-xs ${
            showDimensions ? "border-line bg-card text-ink-soft" : "border-accent bg-accent-bg text-accent"
          }`}
          title="Mostrar u ocultar las medidas mientras dibujas"
        >
          <IconRuler />
          Medidas
        </button>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <span className="hidden font-mono text-xs text-ink-soft sm:inline">
          {totalMl.toFixed(2)} ml{totalM2 > 0 ? ` · ${totalM2.toFixed(2)} m²` : ""}
        </span>
        <button
          type="button"
          onClick={() => setPanelOpen(!panelOpen)}
          className={`flex h-9 items-center gap-1.5 rounded-md border px-2.5 font-mono text-xs ${
            panelOpen ? "border-accent bg-accent-bg text-accent" : "border-line bg-card text-ink-soft"
          }`}
        >
          <IconLayers />
          Capas
        </button>
        <button
          type="button"
          onClick={onExportPdf}
          className="h-9 rounded-md border border-line bg-card px-2.5 font-mono text-xs text-ink-soft hover:text-ink"
        >
          Exportar PDF
        </button>
        <button
          type="button"
          onClick={onNewBoard}
          className="h-9 rounded-md bg-accent px-2.5 font-mono text-xs font-medium text-white"
        >
          Nuevo
        </button>
      </div>
    </div>

      {hasSelection && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line px-3 py-2">
          <span className="font-mono text-[11px] uppercase tracking-wide text-ink-faint">Selección</span>
          <div className="flex items-center gap-1">
            <ToolButton active={tool === "scale"} onClick={() => setTool("scale")} label="Escalar la selección (arrastrá o pellizcá con dos dedos)">
              <IconScale />
            </ToolButton>
            <ToolButton active={tool === "move"} onClick={() => setTool("move")} label="Mover la selección (arrastrá)">
              <IconMove />
            </ToolButton>
          </div>
          <div className="flex items-center gap-1">
            {PEN_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => onSelectionColor(c)}
                aria-label={`Color ${COLOR_NAMES[c]}`}
                title={COLOR_NAMES[c]}
                className="h-6 w-6 rounded-full border-2 border-transparent"
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={onSelectionDelete}
            className="flex h-9 items-center gap-1.5 rounded-md border border-line bg-card px-2.5 font-mono text-xs text-red-600"
          >
            <IconTrash />
            Eliminar
          </button>
          <button
            type="button"
            onClick={onSelectionClear}
            className="ml-auto h-9 rounded-md border border-line bg-card px-2.5 font-mono text-xs text-ink-soft hover:text-ink"
          >
            Listo
          </button>
        </div>
      )}
    </div>
  );
}
