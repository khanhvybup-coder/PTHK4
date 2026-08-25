-- KTHS online data model.
-- Run this in Supabase SQL Editor before importing workflow-state.json.

create extension if not exists pgcrypto;

-- Authoritative state used by the Netlify API. The service-role key is kept
-- inside Netlify Functions; browsers never receive direct write access.
create table if not exists public.kths_app_state (
  id text primary key,
  version bigint not null default 0 check (version >= 0),
  document jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.kths_app_state enable row level security;
revoke all on table public.kths_app_state from anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'kths-uploads',
  'kths-uploads',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  staff_key text,
  full_name text not null,
  title text not null default 'GV',
  access_role text not null check (access_role in ('manager', 'approver', 'teacher')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles add column if not exists staff_key text;
create unique index if not exists profiles_staff_key_unique_idx
  on public.profiles (staff_key) where staff_key is not null;

-- Browsers subscribe only to this small signal row. The authoritative JSON
-- document remains private and is read through the authenticated Function.
create table if not exists public.kths_state_signal (
  id text primary key,
  version bigint not null default 0 check (version >= 0),
  updated_at timestamptz not null default now()
);

alter table public.kths_state_signal enable row level security;
revoke all on table public.kths_state_signal from anon;
revoke insert, update, delete on table public.kths_state_signal from authenticated;
grant select on table public.kths_state_signal to authenticated;

drop policy if exists kths_state_signal_read_authenticated on public.kths_state_signal;
create policy kths_state_signal_read_authenticated
  on public.kths_state_signal
  for select
  to authenticated
  using (true);

create or replace function public.notify_kths_state_version()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.kths_state_signal(id, version, updated_at)
  values (new.id, new.version, coalesce(new.updated_at, now()))
  on conflict (id) do update
    set version = excluded.version,
        updated_at = excluded.updated_at;
  return new;
end;
$$;

drop trigger if exists kths_app_state_signal_trigger on public.kths_app_state;
create trigger kths_app_state_signal_trigger
after insert or update of version on public.kths_app_state
for each row execute function public.notify_kths_state_version();

insert into public.kths_state_signal(id, version, updated_at)
select id, version, updated_at from public.kths_app_state
on conflict (id) do update
set version = excluded.version,
    updated_at = excluded.updated_at;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'kths_state_signal'
  ) then
    alter publication supabase_realtime add table public.kths_state_signal;
  end if;
end
$$;

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  purpose text not null default '',
  capacity integer not null default 0 check (capacity >= 0),
  status text not null default 'Tốt' check (status in ('Tốt', 'Đang bảo trì', 'Ngừng hoạt động')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.equipment (
  id text primary key,
  name text not null,
  model text not null default '',
  room_id uuid references public.rooms(id) on delete set null,
  total_qty integer not null check (total_qty >= 0),
  status text not null default 'Tốt',
  note text not null default '',
  image_path text,
  custom boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.loan_sequences (
  year integer primary key check (year between 2000 and 9999),
  last_number integer not null default 0 check (last_number >= 0)
);

create table if not exists public.loans (
  id uuid primary key default gen_random_uuid(),
  display_code text not null unique,
  year integer not null,
  sequence integer not null,
  borrower_id uuid not null references public.profiles(id),
  external_organization text,
  external_borrower_name text,
  room_id uuid references public.rooms(id),
  purpose text not null,
  note text not null default '',
  borrow_date date not null,
  expected_return_date date not null,
  status text not null default 'pending_manager',
  requested_leader_id uuid references public.profiles(id),
  manager_decision text,
  manager_note text not null default '',
  leader_decision text,
  leader_note text not null default '',
  handoff jsonb,
  return_request jsonb,
  return_confirmation jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (year, sequence)
);

alter table public.loans add column if not exists external_organization text;
alter table public.loans add column if not exists external_borrower_name text;

create table if not exists public.loan_items (
  id uuid primary key default gen_random_uuid(),
  loan_id uuid not null references public.loans(id) on delete cascade,
  equipment_id text not null references public.equipment(id),
  equipment_name_snapshot text not null,
  quantity integer not null check (quantity > 0),
  note text not null default '',
  unique (loan_id, equipment_id)
);

create table if not exists public.loan_events (
  id bigint generated always as identity primary key,
  loan_id uuid references public.loans(id) on delete set null,
  actor_id uuid references public.profiles(id),
  action text not null,
  from_status text,
  to_status text,
  note text not null default '',
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function public.next_loan_code(p_year integer)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_number integer;
begin
  if p_year < 2000 or p_year > 9999 then
    raise exception 'Năm không hợp lệ';
  end if;

  insert into public.loan_sequences(year, last_number)
  values (p_year, 1)
  on conflict (year) do update
    set last_number = public.loan_sequences.last_number + 1
  returning last_number into v_number;

  return format('PM-%s-%s', p_year, lpad(v_number::text, 2, '0'));
end;
$$;

revoke all on function public.next_loan_code(integer) from public;

-- Enable RLS. Add project-specific policies after mapping auth.users to profiles.
alter table public.profiles enable row level security;
alter table public.rooms enable row level security;
alter table public.equipment enable row level security;
alter table public.loans enable row level security;
alter table public.loan_items enable row level security;
alter table public.loan_events enable row level security;

grant select on table public.profiles to authenticated;
drop policy if exists profiles_read_own on public.profiles;
create policy profiles_read_own
  on public.profiles
  for select
  to authenticated
  using ((select auth.uid()) = id);

create index if not exists loan_events_loan_id_created_at_idx
  on public.loan_events (loan_id, created_at desc);
create index if not exists loans_status_updated_at_idx
  on public.loans (status, updated_at desc);
