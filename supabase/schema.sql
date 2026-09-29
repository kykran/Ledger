-- Trainer Tally · Supabase schema
-- Run this once in the Supabase SQL editor (Database → SQL Editor → New query).

-- One settings document per trainer (same shape as the claude.ai version's profile).
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- One row per client; the client's packages and payments live inside `data`.
create table if not exists public.clients (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

-- Google refresh tokens. Only the server (service role) can read or write these.
create table if not exists public.google_tokens (
  user_id uuid primary key references auth.users(id) on delete cascade,
  refresh_token text not null,
  updated_at timestamptz not null default now()
);

-- Stripe subscription state, written by the webhook.
create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id text,
  stripe_subscription_id text,
  status text,                      -- trialing | active | past_due | canceled | unpaid | ...
  cancel_at_period_end boolean not null default false,
  current_period_end timestamptz,
  access_until timestamptz,         -- end of paid period + 2 days; the app is unlocked until then
  updated_at timestamptz not null default now()
);

-- Safe to re-run on an existing project:
alter table public.subscriptions add column if not exists cancel_at_period_end boolean not null default false;
alter table public.subscriptions add column if not exists access_until timestamptz;

alter table public.profiles enable row level security;
alter table public.clients enable row level security;
alter table public.google_tokens enable row level security;
alter table public.subscriptions enable row level security;

-- Each trainer sees and changes only their own rows.
drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles for all
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists "own clients" on public.clients;
create policy "own clients" on public.clients for all
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists "read own subscription" on public.subscriptions;
create policy "read own subscription" on public.subscriptions for select
  using ((select auth.uid()) = user_id);
-- google_tokens: no policies on purpose. Browsers can never read refresh tokens.

-- Live updates across a trainer's devices.
alter publication supabase_realtime add table public.profiles;
alter publication supabase_realtime add table public.clients;
