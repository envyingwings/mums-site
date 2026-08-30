-- ============================================================
-- Migration: add day/time blocking for admin availability control.
-- Run this in Supabase SQL Editor. Safe to run once on a database
-- that already has schema.sql applied.
-- ============================================================

create table if not exists blocked_periods (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  start_time time not null,
  end_time time not null,
  reason text,
  check (end_time > start_time)
);
create index if not exists blocked_periods_date_idx on blocked_periods (date);

alter table blocked_periods enable row level security;

create policy "public can read blocked periods" on blocked_periods
  for select using (true);

create policy "admin full access blocked periods" on blocked_periods
  for all using (auth.role() = 'authenticated');

-- Replace create_booking to also reject slots inside a closed_dates day
-- or a blocked_periods range.
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
  v_tz text := 'Europe/London'; -- keep in sync with BUSINESS_TIMEZONE in config.js
  v_local_date date;
begin
  select duration_minutes into v_duration from services where id = p_service_id and active = true;
  if v_duration is null then
    raise exception 'Service not found or inactive';
  end if;

  v_ends_at := p_starts_at + (v_duration || ' minutes')::interval;
  v_local_date := (p_starts_at at time zone v_tz)::date;

  if exists (select 1 from closed_dates where date = v_local_date) then
    raise exception 'That date is not available — please pick another day.';
  end if;

  if exists (
    select 1 from blocked_periods bp
    where bp.date = v_local_date
      and (bp.start_time, bp.end_time) overlaps (
        (p_starts_at at time zone v_tz)::time,
        (v_ends_at at time zone v_tz)::time
      )
  ) then
    raise exception 'That time was just blocked off — please pick another time.';
  end if;

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
