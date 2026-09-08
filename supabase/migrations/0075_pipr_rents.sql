-- 0075_pipr_rents.sql
--
-- The backable rental evidence base: ONS Price Index of Private Rents (PIPR)
-- average advertised-stock rents per local authority — overall and split by
-- bedroom count (1/2/3/4+) and property type (detached/semi/terraced/flat).
-- Accredited official statistics, refreshed MONTHLY at a stable ONS URL, so
-- this is a live public dataset rather than a scrape: the loader re-derives
-- the latest month from each release (pipeline/build_pipr_rents.py; see
-- docs/MANUAL_TASKS.md). Values are £/calendar month, rounded to £1.
--
-- station_assessments gains lad_code (point-in-polygon against the
-- lad_boundary dataset) so every sift row and deep dive can join straight to
-- its authority's rents — the same join the BTR viability mode uses.

create table if not exists public.pipr_rents (
  code text primary key,          -- ONS area code (LAD / region / country)
  name text not null,
  rent integer,                   -- all properties, £/month
  b1 integer, b2 integer, b3 integer, b4 integer,   -- by bedrooms (4 = 4+)
  det integer, semi integer, terr integer, flat integer,  -- by type
  asof text not null              -- data month, YYYY-MM
);
grant select on public.pipr_rents to anon, authenticated;
alter table public.pipr_rents enable row level security;
do $$ begin
  create policy pipr_rents_read on public.pipr_rents for select using (true);
exception when duplicate_object then null; end $$;

alter table public.station_assessments add column if not exists lad_code text;

-- Backfill: each station's LAD by point-in-polygon. Re-run after a full
-- station_assessments rebuild (the rebuild function does not repopulate it).
create or replace function public.backfill_station_lad()
returns integer language plpgsql as $$
declare n integer;
begin
  update public.station_assessments a
     set lad_code = f.props->>'lad_code'
    from public.stations s, public.map_features f
   where s.crs = a.crs
     and f.dataset = 'lad_boundary'
     and st_contains(f.geom, st_setsrid(st_makepoint(s.lng, s.lat), 4326));
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.backfill_station_lad()
  from public, anon, authenticated;
