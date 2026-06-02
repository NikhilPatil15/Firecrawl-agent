import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import WebSocket from "ws";

// Server-side Supabase client. Prefers the service-role/secret key (bypasses
// RLS, fully secure). Falls back to the publishable/anon key when that's all
// that's configured — in that case the DB is protected by (a) our API routes
// enforcing ownership by next-auth user id and (b) the RLS policies in
// supabase/schema.sql. For production, add SUPABASE_SERVICE_ROLE_KEY.
//
// Never import this into a client component.

let client: SupabaseClient | null = null;

function supabaseUrl(): string | undefined {
  return process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
}

function supabaseKey(): string | undefined {
  return (
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}

export function isSupabaseConfigured(): boolean {
  return Boolean(supabaseUrl() && supabaseKey());
}

export function getSupabaseAdmin(): SupabaseClient {
  const url = supabaseUrl();
  const key = supabaseKey();
  if (!url || !key) {
    throw new Error(
      "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and a key " +
        "(SUPABASE_SERVICE_ROLE_KEY preferred, or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) in .env.local.",
    );
  }
  if (!client) {
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      // We only do REST CRUD — no realtime. Node 20 has no native WebSocket,
      // so supabase-js's eager realtime init would throw; give it `ws`.
      realtime: { transport: WebSocket as unknown as never },
    });
  }
  return client;
}
