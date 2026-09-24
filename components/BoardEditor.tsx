"use client";

import dynamic from "next/dynamic";

const CanvasBoard = dynamic(() => import("./CanvasBoard"), {
  ssr: false,
  loading: () => (
    <div className="h-dvh w-dvw flex items-center justify-center bg-paper text-ink-soft font-mono text-sm">
      Cargando lienzo…
    </div>
  ),
});

export default function BoardEditor({ boardId }: { boardId: string }) {
  return <CanvasBoard boardId={boardId} />;
}
