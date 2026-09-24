import { openDB, type IDBPDatabase } from "idb";
import type { BoardMeta, BoardState } from "./types";

const DB_NAME = "trama-levantamientos";
const STORE = "boards";

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE);
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
