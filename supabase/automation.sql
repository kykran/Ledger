-- Background calendar sync, automatic emails and client "sessions left" links.
-- Run after schema.sql and studio.sql.

-- Synced calendar events. Written only by the server (service role); trainers can read their own.
create table if not exists public.calendar_events (
  user_id uuid not null references auth.users(id) on delete cascade,
  calendar_id text not null,
  event_id text not null,
  start_at timestamptz not null,
  data jsonb not null,            -- trimmed Google event: id, summary, start, status, creator, organizer
  synced_at timestamptz not null default now(),
  primary key (user_id, calendar_id, event_id)
);
create index if not exists calendar_events_user_start on public.calendar_events (user_id, start_at);
alter table public.calendar_events enable row level security;
drop policy if exists "read own events" on public.calendar_events;
create policy "read own events" on public.calendar_events for select to authenticated using (user_id = (select auth.uid()));

-- What has been synced, per calendar.
create table if not exists public.calendar_sync (
  user_id uuid not null references auth.users(id) on delete cascade,
  calendar_id text not null,
  synced_from timestamptz,        -- earliest date covered by a full sync
  last_synced_at timestamptz,
  last_error text,
  primary key (user_id, calendar_id)
);
alter table public.calendar_sync enable row level security;
drop policy if exists "read own sync" on public.calendar_sync;
create policy "read own sync" on public.calendar_sync for select to authenticated using (user_id = (select auth.uid()));

-- Every automatic email, sent or waiting. dedupe_key stops the same notice going out twice.
create table if not exists public.outbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,             -- weekly | monthly | renewal | test
  client_id text,
  dedupe_key text not null,
  to_email text,
  subject text not null,
  html text not null,
  body_text text not null,
  status text not null default 'queued',  -- queued | held (needs approval) | sent | skipped | failed
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (user_id, dedupe_key)
);
create index if not exists outbox_user_created on public.outbox (user_id, created_at desc);
alter table public.outbox enable row level security;
drop policy if exists "read own outbox" on public.outbox;
create policy "read own outbox" on public.outbox for select to authenticated using (user_id = (select auth.uid()));
-- Trainers can mark a held message skipped from the app; sending goes through /api/outbox.
drop policy if exists "skip own outbox" on public.outbox;
create policy "skip own outbox" on public.outbox for update to authenticated
  using (user_id = (select auth.uid()) and status in ('held','queued','failed'))
  with check (user_id = (select auth.uid()) and status = 'skipped');

-- Private read-only links a trainer can give a client.
create table if not exists public.client_links (
  token text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  client_id text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_viewed_at timestamptz
);
create index if not exists client_links_user on public.client_links (user_id, client_id);
alter table public.client_links enable row level security;
drop policy if exists "manage own links" on public.client_links;
create policy "manage own links" on public.client_links for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Hourly job. pg_cron calls /api/cron/hourly with a secret that never leaves the database:
-- the API reads the same row with the service role to check it. Replace the URL with your app's.
create table if not exists public.app_secrets (name text primary key, value text not null);
alter table public.app_secrets enable row level security;  -- no policies: server only
insert into public.app_secrets (name, value) values ('cron', encode(extensions.gen_random_bytes(32), 'hex')) on conflict (name) do nothing;
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule('trainer-tally-hourly', '2 * * * *', $$
  select net.http_post(
    url := 'https://YOUR-APP.vercel.app/api/cron/hourly',
    headers := jsonb_build_object('authorization', 'Bearer ' || (select value from public.app_secrets where name = 'cron'), 'content-type', 'application/json'),
    body := '{}'::jsonb, timeout_milliseconds := 60000)
$$);
