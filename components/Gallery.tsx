"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  deleteBoard,
  deletePdfExport,
  getPdfExport,
  listBoards,
  listPdfExports,
  saveBoard,
  type PdfExportMeta,
} from "@/lib/storage";
import { emptyBoard, newBoardId, type BoardMeta } from "@/lib/types";

const MAX_IMPORT_BYTES = 15 * 1024 * 1024;

export default function Gallery() {
  const router = useRouter();
  const [boards, setBoards] = useState<BoardMeta[] | null>(null);
  const [pdfExports, setPdfExports] = useState<PdfExportMeta[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    listBoards().then(setBoards);
    listPdfExports().then(setPdfExports);
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

  async function handleOpenPdf(id: string) {
    const record = await getPdfExport(id);
    if (!record) return;
    const url = URL.createObjectURL(record.blob);
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  async function handleDeletePdf(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (!window.confirm("¿Borrar este PDF guardado? No se puede deshacer.")) return;
    await deletePdfExport(id);
    setPdfExports((prev) => (prev ? prev.filter((p) => p.id !== id) : prev));
  }

  function handleImportClick() {
    setImportError(null);
    fileInputRef.current?.click();
  }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setImportError(null);

    if (file.type === "application/pdf") {
      setImportError("Por ahora solo se puede importar una imagen (PNG/JPG) del plano — si tienes un PDF, expórtalo como imagen o toma una captura de pantalla.");
      return;
    }
    if (!file.type.startsWith("image/")) {
      setImportError("Ese archivo no es una imagen. Elige un PNG o JPG del plano a calcar.");
      return;
    }
    if (file.size > MAX_IMPORT_BYTES) {
      setImportError("La imagen es muy pesada (máx. 15 MB). Prueba con una versión más liviana.");
      return;
    }

    setImporting(true);
    try {
      const dataUrl: string = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const { width: naturalW, height: naturalH } = await new Promise<{ width: number; height: number }>(
        (resolve, reject) => {
          const img = new window.Image();
          img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
          img.onerror = () => reject(new Error("No se pudo leer la imagen"));
          img.src = dataUrl;
        }
      );

      const id = newBoardId();
      const worldWidth = 15; // meters — a starting guess; arrastra la esquina para calibrar
      const worldHeight = worldWidth * (naturalH / naturalW || 1);
      const board = {
        ...emptyBoard(id),
        background: {
          dataUrl,
          x: 75 - worldWidth / 2,
          y: 75 - worldHeight / 2,
          width: worldWidth,
          height: worldHeight,
          opacity: 0.6,
          locked: false,
        },
      };
      await saveBoard(board);
      router.push(`/board/${id}`);
    } catch {
      setImportError("No se pudo importar la imagen. Intenta de nuevo.");
    } finally {
      setImporting(false);
    }
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
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,application/pdf"
            className="hidden"
            onChange={handleImportFile}
          />
          <button
            type="button"
            onClick={handleImportClick}
            disabled={importing}
            className="rounded-md border border-line bg-card px-3 py-2 font-mono text-xs font-medium text-ink-soft disabled:opacity-50"
          >
            {importing ? "Importando…" : "Importar plano"}
          </button>
          <button
            type="button"
            onClick={handleNew}
            className="rounded-md bg-accent px-3 py-2 font-mono text-xs font-medium text-white"
          >
            + Nuevo dibujo
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-6">
        {importError && (
          <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {importError}
          </div>
        )}
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

        {pdfExports !== null && pdfExports.length > 0 && (
          <section className="mt-8">
            <h2 className="mb-2 font-mono text-[11px] uppercase tracking-widest text-ink-faint">
              PDF exportados
            </h2>
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {pdfExports.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => handleOpenPdf(p.id)}
                    className="flex w-full items-center justify-between gap-2 rounded-lg border border-line bg-card px-3 py-2.5 text-left transition-colors hover:border-accent"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-mono text-xs font-medium text-ink">{p.boardName}</p>
                      <p className="mt-0.5 font-mono text-[11px] text-ink-faint">
                        {new Date(p.createdAt).toLocaleDateString("es-CL", {
                          day: "2-digit",
                          month: "short",
                          year: "numeric",
                        })}
                      </p>
                    </div>
                    <span
                      role="button"
                      onClick={(e) => handleDeletePdf(p.id, e)}
                      className="flex-shrink-0 text-ink-faint hover:text-red-600"
                      aria-label={`Borrar PDF de ${p.boardName}`}
                    >
                      ✕
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </div>
  );
}
