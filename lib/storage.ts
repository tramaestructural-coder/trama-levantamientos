import { openDB, type IDBPDatabase } from "idb";
import type { BoardMeta, BoardState } from "./types";

const DB_NAME = "trama-levantamientos";
const STORE = "boards";
const PDF_STORE = "pdfs";

export type PdfExportMeta = {
  id: string;
  boardId: string;
  boardName: string;
  createdAt: number;
};

export type PdfExport = PdfExportMeta & { blob: Blob };

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, 2, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE);
        }
        if (!db.objectStoreNames.contains(PDF_STORE)) {
          db.createObjectStore(PDF_STORE);
        }
      },
    });
  }
  return dbPromise;
}

export async function listBoards(): Promise<BoardMeta[]> {
  const db = await getDb();
  const all: BoardState[] = await db.getAll(STORE);
  return all
    .map((b) => ({
      id: b.id,
      name: b.name,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
      lineCount: b.lines.length,
      areaCount: b.areas?.length ?? 0,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getBoard(id: string): Promise<BoardState | undefined> {
  const db = await getDb();
  return db.get(STORE, id);
}

export async function saveBoard(board: BoardState): Promise<void> {
  const db = await getDb();
  await db.put(STORE, board, board.id);
}

export async function deleteBoard(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORE, id);
}

export async function savePdfExport(record: PdfExport): Promise<void> {
  const db = await getDb();
  await db.put(PDF_STORE, record, record.id);
}

export async function listPdfExports(): Promise<PdfExportMeta[]> {
  const db = await getDb();
  const all: PdfExport[] = await db.getAll(PDF_STORE);
  return all
    .map(({ id, boardId, boardName, createdAt }) => ({ id, boardId, boardName, createdAt }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function getPdfExport(id: string): Promise<PdfExport | undefined> {
  const db = await getDb();
  return db.get(PDF_STORE, id);
}

export async function deletePdfExport(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(PDF_STORE, id);
}
