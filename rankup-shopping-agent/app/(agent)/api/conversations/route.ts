import { auth } from "@/auth";
import { isSupabaseConfigured } from "@agent/_lib/supabase";
import { listConversations, createConversation } from "@agent/_lib/conversations";

// GET /api/conversations — list the signed-in user's conversations.
export async function GET() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!isSupabaseConfigured()) return Response.json({ conversations: [], configured: false });
  try {
    const conversations = await listConversations(userId);
    return Response.json({ conversations, configured: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "error" }, { status: 500 });
  }
}

// POST /api/conversations — create a new conversation. Body: { title? }
export async function POST(req: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!isSupabaseConfigured()) return Response.json({ error: "Database not configured" }, { status: 503 });
  const body = (await req.json().catch(() => ({}))) as { title?: string };
  try {
    const id = await createConversation(userId, body.title ?? "New chat");
    return Response.json({ id });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "error" }, { status: 500 });
  }
}
