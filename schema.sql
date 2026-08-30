-- ============================================================
-- Booking site schema for Supabase (Postgres)
-- Run this in the Supabase SQL Editor (Dashboard > SQL Editor)
-- ============================================================

-- Services you offer, each with its own duration
create table services (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  duration_minutes int not null check (duration_minutes > 0),
  price_pence int, -- optional, store in pence/cents to avoid float issues
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Your working hours, per day of week (0 = Sunday ... 6 = Saturday)
create table working_hours (
  id uuid primary key default gen_random_uuid(),
  day_of_week int not null check (day_of_week between 0 and 6),
  start_time time not null,
  end_time time not null,
  unique (day_of_week)
);

-- Specific dates you're closed (holidays, days off) — overrides working_hours
create table closed_dates (
  id uuid primary key default gen_random_uuid(),
  date date not null unique,
  reason text
);

-- Bookings
create table bookings (
  id uuid primary key default gen_random_uuid(),
  service_id uuid not null references services(id),
  customer_name text not null,
  customer_email text not null,
  customer_phone text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
  notes text,
  created_at timestamptz not null default now(),
  -- Prevent overlapping confirmed bookings at the database level.
  -- This is belt-and-braces on top of the function below.
  constraint no_overlap exclude using gist (
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (status = 'confirmed')
);

-- Needed for the exclusion constraint above
create extension if not exists btree_gist;

-- ============================================================
-- Atomic booking function.
-- This is what the frontend calls (via RPC) instead of inserting
-- directly, so the availability check and the insert happen in
-- one transaction — no race condition between two people booking
-- the same slot at the same time.
-- ============================================================
create or replace function create_booking(
  p_service_id uuid,
  p_customer_name text,
  p_customer_email text,
  p_customer_phone text,
  p_starts_at timestamptz,
  p_notes text
) returns bookings
language plpgsql
security definer
as $$
declare
  v_duration int;
  v_ends_at timestamptz;
  v_booking bookings;
begin
  select duration_minutes into v_duration from services where id = p_service_id and active = true;
  if v_duration is null then
    raise exception 'Service not found or inactive';
  end if;

  v_ends_at := p_starts_at + (v_duration || ' minutes')::interval;

  -- The exclusion constraint on the table will reject this insert
  -- with a unique_violation-style error if it overlaps an existing
  -- confirmed booking. We catch that and raise a friendlier message.
  begin
    insert into bookings (service_id, customer_name, customer_email, customer_phone, starts_at, ends_at, notes)
    values (p_service_id, p_customer_name, p_customer_email, p_customer_phone, p_starts_at, v_ends_at, p_notes)
    returning * into v_booking;
  exception when exclusion_violation then
    raise exception 'That slot was just booked by someone else — please pick another time.';
  end;

  return v_booking;
end;
$$;

-- ============================================================
-- Row Level Security
-- ============================================================
alter table services enable row level security;
alter table working_hours enable row level security;
alter table closed_dates enable row level security;
alter table bookings enable row level security;

-- Public (anon) can read active services and hours/closures — needed to show availability
create policy "public can read active services" on services
  for select using (active = true);

create policy "public can read working hours" on working_hours
  for select using (true);

create policy "public can read closed dates" on closed_dates
  for select using (true);

-- No public select policy on `bookings` itself — anon users cannot read
-- customer names/emails/phone numbers/notes at the database level, full stop.
--
-- To compute free slots, the frontend instead queries this view, which
-- exposes ONLY the timing info needed to grey out taken slots:
create view public_booked_slots as
  select id, service_id, starts_at, ends_at
  from bookings
  where status = 'confirmed';

alter view public_booked_slots set (security_invoker = off);
grant select on public_booked_slots to anon;

-- No public insert policy on bookings — inserts must go through
-- create_booking(), which runs as security definer and bypasses RLS
-- for the insert itself while still being safely scoped.

-- Admin (authenticated) access — full read/write on everything.
-- You'll create yourself a Supabase Auth user and log into /admin.html with it.
create policy "admin full access services" on services
  for all using (auth.role() = 'authenticated');

create policy "admin full access hours" on working_hours
  for all using (auth.role() = 'authenticated');

create policy "admin full access closed" on closed_dates
  for all using (auth.role() = 'authenticated');

create policy "admin full access bookings" on bookings
  for all using (auth.role() = 'authenticated');

-- ============================================================
-- Seed data — edit to match your business, then run
-- ============================================================
insert into working_hours (day_of_week, start_time, end_time) values
  (1, '09:00', '17:00'), -- Monday
  (2, '09:00', '17:00'), -- Tuesday
  (3, '09:00', '17:00'), -- Wednesday
  (4, '09:00', '17:00'), -- Thursday
  (5, '09:00', '17:00'); -- Friday

insert into services (name, duration_minutes, price_pence) values
  ('Consultation', 30, 3000),
  ('Full Session', 60, 6000);
