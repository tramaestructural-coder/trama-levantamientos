import BoardEditor from "@/components/BoardEditor";

export default async function BoardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <BoardEditor boardId={id} />;
}
