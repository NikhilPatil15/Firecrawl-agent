import { getSupabaseAdmin } from "./supabase";

export interface ConversationRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface StoredMessage {
  id?: string;
  role: string;
  parts: unknown;
}

export async function listConversations(userId: string): Promise<ConversationRow[]> {
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("conversations")
    .select("id,title,created_at,updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []) as ConversationRow[];
}

export async function createConversation(userId: string, title: string): Promise<string> {
  const db = getSupabaseAdmin();
  const clean = (title || "New chat").trim().slice(0, 120) || "New chat";
  const { data, error } = await db
    .from("conversations")
    .insert({ user_id: userId, title: clean })
    .select("id")
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

export async function getConversation(
  userId: string,
  id: string,
): Promise<{ conversation: ConversationRow; messages: StoredMessage[] } | null> {
  const db = getSupabaseAdmin();
  const { data: conversation, error: e1 } = await db
    .from("conversations")
    .select("id,title,created_at,updated_at")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (e1) throw e1;
  if (!conversation) return null;

  const { data: msgs, error: e2 } = await db
    .from("messages")
    .select("id,role,parts,position")
    .eq("conversation_id", id)
    .order("position", { ascending: true });
  if (e2) throw e2;

  const messages: StoredMessage[] = (msgs ?? []).map((m) => ({
    id: (m as { id: string }).id,
    role: (m as { role: string }).role,
    parts: (m as { parts: unknown }).parts,
  }));
  return { conversation: conversation as ConversationRow, messages };
}

/**
 * Replace strategy: rewrite the whole message list for a conversation. Simple
 * and idempotent — the client posts the full current transcript after each turn.
 */
export async function saveMessages(
  userId: string,
  id: string,
  messages: StoredMessage[],
  title?: string,
): Promise<void> {
  const db = getSupabaseAdmin();
  const { data: owned, error: ownErr } = await db
    .from("conversations")
    .select("id")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (ownErr) throw ownErr;
  if (!owned) throw new Error("Conversation not found");

  await db.from("messages").delete().eq("conversation_id", id);
  if (messages.length > 0) {
    const rows = messages.map((m, i) => ({
      conversation_id: id,
      role: m.role,
      parts: m.parts ?? [],
      position: i,
    }));
    const { error } = await db.from("messages").insert(rows);
    if (error) throw error;
  }

  await db
    .from("conversations")
    .update({
      updated_at: new Date().toISOString(),
      ...(title ? { title: title.trim().slice(0, 120) } : {}),
    })
    .eq("id", id);
}

export async function deleteConversation(userId: string, id: string): Promise<void> {
  const db = getSupabaseAdmin();
  const { error } = await db
    .from("conversations")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);
  if (error) throw error;
}
