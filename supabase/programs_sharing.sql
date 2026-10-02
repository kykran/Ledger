-- Trainer Tally · Programs sharing
-- Lets a trainer share one client's program with another trainer (by Google email).
-- The other trainer can open, edit and log that program, and see the exercises and videos it uses.
-- Nothing else is shared: clients, billing, measurements and other programs stay private.
-- Run once in Supabase → SQL Editor. Safe to run again.

create table if not exists public.program_shares (
  owner_id uuid not null references auth.users(id) on delete cascade,
  program_id text not null,
  shared_email text not null,
  client_id text not null,
  client_name text not null default '',
  program_name text not null default '',
  owner_name text not null default '',
  created_at timestamptz not null default now(),
  primary key (owner_id, program_id, shared_email)
);
create index if not exists program_shares_email on public.program_shares (lower(shared_email));
alter table public.program_shares enable row level security;

create schema if not exists private;

-- Is this program shared with the signed-in trainer?
create or replace function private.program_shared_with_me(owner uuid, pid text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.program_shares s
    where s.owner_id = owner and s.program_id = pid
      and lower(s.shared_email) = lower(coalesce((select auth.jwt() ->> 'email'), '')));
$$;
-- Has this owner shared any program with the signed-in trainer?
create or replace function private.owner_shares_with_me(owner uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.program_shares s
    where s.owner_id = owner and lower(s.shared_email) = lower(coalesce((select auth.jwt() ->> 'email'), '')));
$$;
revoke execute on function private.program_shared_with_me(uuid, text) from public, anon;
revoke execute on function private.owner_shares_with_me(uuid) from public, anon;
grant usage on schema private to authenticated;
grant execute on function private.program_shared_with_me(uuid, text) to authenticated;
grant execute on function private.owner_shares_with_me(uuid) to authenticated;

drop policy if exists "owner manages shares" on public.program_shares;
create policy "owner manages shares" on public.program_shares for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
drop policy if exists "recipient sees shares" on public.program_shares;
create policy "recipient sees shares" on public.program_shares for select to authenticated
  using (lower(shared_email) = lower(coalesce((select auth.jwt() ->> 'email'), '')));
drop policy if exists "recipient leaves share" on public.program_shares;
create policy "recipient leaves share" on public.program_shares for delete to authenticated
  using (lower(shared_email) = lower(coalesce((select auth.jwt() ->> 'email'), '')));

drop policy if exists "shared programs read" on public.programs;
create policy "shared programs read" on public.programs for select to authenticated
  using (private.program_shared_with_me(user_id, id));
drop policy if exists "shared programs edit" on public.programs;
create policy "shared programs edit" on public.programs for update to authenticated
  using (private.program_shared_with_me(user_id, id)) with check (private.program_shared_with_me(user_id, id));

drop policy if exists "shared program logs read" on public.program_logs;
create policy "shared program logs read" on public.program_logs for select to authenticated
  using (private.program_shared_with_me(user_id, program_id));
drop policy if exists "shared program logs add" on public.program_logs;
create policy "shared program logs add" on public.program_logs for insert to authenticated
  with check (private.program_shared_with_me(user_id, program_id));
drop policy if exists "shared program logs edit" on public.program_logs;
create policy "shared program logs edit" on public.program_logs for update to authenticated
  using (private.program_shared_with_me(user_id, program_id)) with check (private.program_shared_with_me(user_id, program_id));

drop policy if exists "shared exercises read" on public.exercises;
create policy "shared exercises read" on public.exercises for select to authenticated
  using (private.owner_shares_with_me(user_id));

drop policy if exists "shared videos read" on storage.objects;
create policy "shared videos read" on storage.objects for select to authenticated
  using (bucket_id = 'exercise-videos' and private.owner_shares_with_me(((storage.foldername(name))[1])::uuid));
