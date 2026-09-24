"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { deleteBoard, listBoards, saveBoard } from "@/lib/storage";
import { emptyBoard, newBoardId, type BoardMeta } from "@/lib/types";

export default function Gallery() {
  const router = useRouter();
  const [boards, setBoards] = useState<BoardMeta[] | null>(null);

  useEffect(() => {
    listBoards().then(setBoards);
  }, []);

  async function handleNew() {
    const id = newBoardId();
    await saveBoard(emptyBoard(id));
    router.push(`/board/${id}`);
  }

  async function handleDelete(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (!window.confirm("¿Borrar este levantamiento? No se puede deshacer.")) return;
    await deleteBoard(id);
    setBoards((prev) => (prev ? prev.filter((b) => b.id !== id) : prev));
  }

  return (
    <div className="min-h-dvh bg-paper">
      <header className="flex items-center justify-between border-b border-line bg-card px-4 py-3">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-widest text-accent">
            Trama Estructural
          </p>
          <h1 className="font-display text-lg font-semibold leading-none text-ink">
            Levantamientos
          </h1>
        </div>
        <button
          type="button"
          onClick={handleNew}
          className="rounded-md bg-accent px-3 py-2 font-mono text-xs font-medium text-white"
        >
          + Nuevo dibujo
        </button>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-6">
        {boards === null && <p className="text-sm text-ink-faint">Cargando…</p>}
        {boards !== null && boards.length === 0 && (
          <div className="rounded-lg border border-dashed border-line px-4 py-10 text-center">
            <p className="text-sm text-ink-soft">Todavía no tienes levantamientos.</p>
            <button
              type="button"
              onClick={handleNew}
              className="mt-3 rounded-md bg-accent px-3 py-2 font-mono text-xs font-medium text-white"
            >
              Crear el primero
            </button>
          </div>
        )}

        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {boards?.map((b) => (
            <li key={b.id}>
              <button
                type="button"
                onClick={() => router.push(`/board/${b.id}`)}
                className="w-full rounded-lg border border-line bg-card p-4 text-left transition-colors hover:border-accent"
              >
                <div className="flex items-start justify-between gap-2">
                  <h2 className="truncate font-display text-sm font-semibold text-ink">{b.name}</h2>
                  <span
                    role="button"
                    onClick={(e) => handleDelete(b.id, e)}
                    className="flex-shrink-0 text-ink-faint hover:text-red-600"
                    aria-label={`Borrar ${b.name}`}
                  >
                    ✕
                  </span>
                </div>
                <p className="mt-1.5 font-mono text-[11px] text-ink-faint">
                  {new Date(b.updatedAt).toLocaleDateString("es-CL", {
                    day: "2-digit",
                    month: "short",
                    year: "numeric",
                  })}
                  {" · "}
                  {b.lineCount} {b.lineCount === 1 ? "línea" : "líneas"}
                  {b.areaCount ? ` · ${b.areaCount} ${b.areaCount === 1 ? "área" : "áreas"}` : ""}
                </p>
              </button>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
