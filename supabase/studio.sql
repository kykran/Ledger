-- Trainer Tally · Studio side
-- Run after schema.sql. Adds studios, their trainers, trainer ↔ account links and invite codes.

create table if not exists public.studios (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,      -- name, calendar, rooms, hours, default rent rule
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists studios_owner_idx on public.studios (owner_id);

-- One row per trainer who books at the studio. Statements the owner's app computes are
-- stored in data.statements so a linked trainer sees exactly the same numbers.
create table if not exists public.studio_trainers (
  studio_id uuid not null references public.studios(id) on delete cascade,
  id text not null,
  data jsonb not null default '{}'::jsonb,      -- name, emails[], rent rule, payments[], statements
  updated_at timestamptz not null default now(),
  primary key (studio_id, id)
);

-- A trainer's Trainer Tally account linked to their row at a studio. Created only by /api/studio/join.
create table if not exists public.studio_members (
  studio_id uuid not null references public.studios(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  trainer_id text not null,
  created_at timestamptz not null default now(),
  primary key (studio_id, user_id)
);
create index if not exists studio_members_user_idx on public.studio_members (user_id);

create table if not exists public.studio_invites (
  code text primary key,
  studio_id uuid not null references public.studios(id) on delete cascade,
  trainer_id text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days'
);

-- Helpers live in a private schema (not exposed by the API) and run as definer so policies don't recurse.
create schema if not exists private;
grant usage on schema private to authenticated;
create or replace function private.is_studio_owner(sid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.studios s where s.id = sid and s.owner_id = (select auth.uid()));
$$;
create or replace function private.my_trainer_id(sid uuid) returns text
language sql stable security definer set search_path = public as $$
  select m.trainer_id from public.studio_members m where m.studio_id = sid and m.user_id = (select auth.uid());
$$;
revoke execute on function private.is_studio_owner(uuid) from public, anon;
grant execute on function private.is_studio_owner(uuid) to authenticated;
revoke execute on function private.my_trainer_id(uuid) from public, anon;
grant execute on function private.my_trainer_id(uuid) to authenticated;

alter table public.studios enable row level security;
alter table public.studio_trainers enable row level security;
alter table public.studio_members enable row level security;
alter table public.studio_invites enable row level security;

-- Studios: the owner manages; linked trainers can read the studio's name and settings.
drop policy if exists "studio owner" on public.studios;
create policy "studio owner" on public.studios for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
drop policy if exists "studio member reads" on public.studios;
create policy "studio member reads" on public.studios for select to authenticated
  using (private.my_trainer_id(id) is not null);

-- Studio trainers: the owner manages all rows; a linked trainer reads only their own row.
drop policy if exists "studio trainers owner" on public.studio_trainers;
create policy "studio trainers owner" on public.studio_trainers for all to authenticated
  using (private.is_studio_owner(studio_id)) with check (private.is_studio_owner(studio_id));
drop policy if exists "studio trainer reads own" on public.studio_trainers;
create policy "studio trainer reads own" on public.studio_trainers for select to authenticated
  using (id = private.my_trainer_id(studio_id));

-- Links: a trainer sees and can remove their own link; the owner sees and can remove any link.
drop policy if exists "member reads" on public.studio_members;
create policy "member reads" on public.studio_members for select to authenticated
  using (user_id = (select auth.uid()) or private.is_studio_owner(studio_id));
drop policy if exists "member leaves" on public.studio_members;
create policy "member leaves" on public.studio_members for delete to authenticated
  using (user_id = (select auth.uid()) or private.is_studio_owner(studio_id));

-- Invites: owner only.
drop policy if exists "invites owner" on public.studio_invites;
create policy "invites owner" on public.studio_invites for all to authenticated
  using (private.is_studio_owner(studio_id)) with check (private.is_studio_owner(studio_id));
