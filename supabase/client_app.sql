-- Trainer Tally · Client app
-- Clients sign in once with a 4-digit code on their own link (/c/<key>) and stay signed in on that device.
-- They can flag a session date ("canceled early", "never happened") and the trainer sees it.
-- Run once in Supabase → SQL Editor. Safe to run again.

-- One row per client: the link key, and the current code (4 digits, works for 30 days, on any number of devices).
-- Wrong codes are counted; 5 in a row locks the link for 15 minutes.
create table if not exists public.client_access (
  key text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id text not null,
  code text,
  code_expires_at timestamptz,
  code_emailed_at timestamptz,
  fails int not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_login_at timestamptz,
  unique (user_id, client_id)
);
alter table public.client_access enable row level security;
drop policy if exists "own client access" on public.client_access;
create policy "own client access" on public.client_access for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Signed-in devices. Only a hash of the cookie is stored. Server only (no policies).
create table if not exists public.client_devices (
  token_hash text primary key,
  key text not null references public.client_access(key) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists client_devices_key on public.client_devices (key);
alter table public.client_devices enable row level security;

-- A client's question about one session date. The trainer marks it sorted.
create table if not exists public.session_flags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id text not null,
  session_at timestamptz not null,
  reason text not null,
  note text not null default '',
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  reply text not null default ''
);
create index if not exists session_flags_user on public.session_flags (user_id, resolved_at);
alter table public.session_flags enable row level security;
drop policy if exists "own session flags" on public.session_flags;
create policy "own session flags" on public.session_flags for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
