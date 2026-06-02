import { auth } from "@/auth";
import {
  getConversation,
  saveMessages,
  deleteConversation,
  type StoredMessage,
} from "@agent/_lib/conversations";

type Ctx = { params: Promise<{ id: string }> };

// GET /api/conversations/:id — fetch a conversation and its messages.
export async function GET(_req: Request, { params }: Ctx) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    const result = await getConversation(userId, id);
    if (!result) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json(result);
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "error" }, { status: 500 });
  }
}

// POST /api/conversations/:id — save the full transcript. Body: { messages, title? }
export async function POST(req: Request, { params }: Ctx) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as {
    messages?: StoredMessage[];
    title?: string;
  };
  try {
    await saveMessages(userId, id, body.messages ?? [], body.title);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "error" }, { status: 500 });
  }
}

// DELETE /api/conversations/:id
export async function DELETE(_req: Request, { params }: Ctx) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    await deleteConversation(userId, id);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "error" }, { status: 500 });
  }
}
