-- Trainer Tally · Programs (exercise library, client programs, homework logs, measurements)
-- Applied as a migration. Every table is private to the trainer who owns the rows (user_id).
-- Clients never sign in: their private link (program_links.token) is checked by /api/program
-- with the service role, which only lets them log sets on sessions marked as homework.

-- Exercise library. data: {name, videoUrl, videoPath, cues, muscle, equipment, sets, reps}
create table if not exists public.exercises (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

-- One program per document. data: {name, clientId, status, startDate,
--   weeks:[{id, label, sessions:[{id, name, homework, notes, rows:[{id, exId, name, group, sets, reps, weight, note}]}]}]}
create table if not exists public.programs (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  client_id text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
create index if not exists programs_client on public.programs (user_id, client_id);

-- What was actually done: one row per set. ex_name is a snapshot so lift history survives program edits.
create table if not exists public.program_logs (
  user_id uuid not null references auth.users(id) on delete cascade,
  program_id text not null,
  session_id text not null,
  row_id text not null,
  set_no int not null,
  client_id text not null,
  ex_name text not null default '',
  reps numeric,
  weight numeric,
  done boolean not null default false,
  logged_on date not null default current_date,
  source text not null default 'trainer' check (source in ('trainer','client')),
  updated_at timestamptz not null default now(),
  primary key (user_id, program_id, session_id, row_id, set_no)
);
create index if not exists program_logs_client on public.program_logs (user_id, client_id, logged_on);

-- Bodyweight and 4-site skinfolds (mm): triceps, abdomen, suprailiac, thigh. body_fat is computed by the app.
create table if not exists public.measurements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id text not null,
  taken_on date not null default current_date,
  weight numeric,
  triceps numeric, abdomen numeric, suprailiac numeric, thigh numeric,
  body_fat numeric,
  source text not null default 'trainer' check (source in ('trainer','client')),
  note text,
  created_at timestamptz not null default now()
);
create index if not exists measurements_client on public.measurements (user_id, client_id, taken_on);

-- Private no-login links to a client's program page.
create table if not exists public.program_links (
  token text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_viewed_at timestamptz
);
create index if not exists program_links_user on public.program_links (user_id, client_id);

alter table public.exercises enable row level security;
alter table public.programs enable row level security;
alter table public.program_logs enable row level security;
alter table public.measurements enable row level security;
alter table public.program_links enable row level security;

drop policy if exists "own exercises" on public.exercises;
create policy "own exercises" on public.exercises for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "own programs" on public.programs;
create policy "own programs" on public.programs for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "own program logs" on public.program_logs;
create policy "own program logs" on public.program_logs for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "own measurements" on public.measurements;
create policy "own measurements" on public.measurements for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "own program links" on public.program_links;
create policy "own program links" on public.program_links for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Exercise videos: private bucket, one folder per trainer (<user_id>/<file>). Clients get short-lived signed links from the server.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('exercise-videos', 'exercise-videos', false, 52428800, array['video/mp4','video/quicktime','video/webm','video/x-m4v'])
on conflict (id) do nothing;

drop policy if exists "trainer reads own videos" on storage.objects;
create policy "trainer reads own videos" on storage.objects for select to authenticated
  using (bucket_id = 'exercise-videos' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "trainer uploads own videos" on storage.objects;
create policy "trainer uploads own videos" on storage.objects for insert to authenticated
  with check (bucket_id = 'exercise-videos' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "trainer updates own videos" on storage.objects;
create policy "trainer updates own videos" on storage.objects for update to authenticated
  using (bucket_id = 'exercise-videos' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "trainer deletes own videos" on storage.objects;
create policy "trainer deletes own videos" on storage.objects for delete to authenticated
  using (bucket_id = 'exercise-videos' and (storage.foldername(name))[1] = (select auth.uid())::text);
