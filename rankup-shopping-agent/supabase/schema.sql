-- ShopSmart — chat history schema.
-- Paste this into the Supabase SQL editor (Dashboard → SQL → New query → Run).
-- The app accesses these tables with the SERVICE ROLE key from server-side API
-- routes only (it bypasses RLS); ownership is enforced in the route handlers by
-- the next-auth user id. RLS is enabled with no policies so a leaked anon key
-- still grants no access.

create extension if not exists "pgcrypto";

create table if not exists public.conversations (
  id          uuid primary key default gen_random_uuid(),
  user_id     text not null,                       -- next-auth session.user.id (Google sub)
  title       text not null default 'New chat',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists conversations_user_updated_idx
  on public.conversations (user_id, updated_at desc);

create table if not exists public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  role            text not null,                   -- 'user' | 'assistant' | 'system'
  parts           jsonb not null default '[]'::jsonb,  -- AI SDK UIMessage.parts
  position        int  not null default 0,
  created_at      timestamptz not null default now()
);

create index if not exists messages_conversation_position_idx
  on public.messages (conversation_id, position);

-- RLS on, NO policies: the anon/publishable key gets zero access. The app uses
-- the SERVICE-ROLE / SECRET key (SUPABASE_SECRET_KEY) server-side, which bypasses
-- RLS; ownership is enforced in the API routes by the next-auth user id.
alter table public.conversations enable row level security;
alter table public.messages      enable row level security;

-- If you previously ran an earlier version that created permissive anon
-- policies, drop them now (safe to run even if they don't exist):
drop policy if exists "app access conversations" on public.conversations;
drop policy if exists "app access messages"      on public.messages;
