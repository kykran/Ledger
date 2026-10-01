-- Monthly sign-off: a linked trainer confirms or disputes the studio's statement for a month.
-- The studio sees only the answer, the note and the trainer's session count.
create table if not exists public.statement_confirmations (
  studio_id uuid not null references public.studios(id) on delete cascade,
  trainer_id text not null,
  month text not null,                         -- YYYY-MM
  status text not null check (status in ('confirmed','disputed')),
  studio_n int, studio_rent numeric,           -- the statement as the trainer saw it
  trainer_n int,                               -- the trainer's own count of studio sessions
  note text,
  user_id uuid not null references auth.users(id) on delete cascade,
  updated_at timestamptz not null default now(),
  primary key (studio_id, trainer_id, month)
);
alter table public.statement_confirmations enable row level security;
drop policy if exists "trainer reads own signoff" on public.statement_confirmations;
create policy "trainer reads own signoff" on public.statement_confirmations for select to authenticated
  using (trainer_id = private.my_trainer_id(studio_id) or private.is_studio_owner(studio_id));
drop policy if exists "trainer signs off" on public.statement_confirmations;
create policy "trainer signs off" on public.statement_confirmations for insert to authenticated
  with check (user_id = (select auth.uid()) and trainer_id = private.my_trainer_id(studio_id));
-- A dispute can be changed; a confirmed month is locked until the studio reopens it.
drop policy if exists "trainer updates dispute" on public.statement_confirmations;
create policy "trainer updates dispute" on public.statement_confirmations for update to authenticated
  using (status = 'disputed' and user_id = (select auth.uid()) and trainer_id = private.my_trainer_id(studio_id))
  with check (user_id = (select auth.uid()) and trainer_id = private.my_trainer_id(studio_id));
drop policy if exists "studio reopens" on public.statement_confirmations;
create policy "studio reopens" on public.statement_confirmations for delete to authenticated
  using (private.is_studio_owner(studio_id));
