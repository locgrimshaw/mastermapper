-- 0009_stations_and_assessments.sql
-- Phase 1 of the site-sifting funnel. A lightweight `stations` table + a numeric
-- per-station `station_assessments` table that precomputes:
--   Assessment 1 (Tier): in-settlement (Tier A, 40 dph) vs well-connected
--     out-of-settlement (Tier B, 50 dph, green-belt-permitted) vs ineligible.
--   Assessment 2 (Developable land): developable ha + dwelling yield, via the
--     existing developable_land_near_station() RPC.
-- No geometry is stored here (kept tiny); the developable polygon is fetched on
-- demand from the RPC for single-station detail. The frontend sift reads these
-- tables directly (RLS: public read) and filters/ranks instantly.
--
-- Tiering is fully server-side using the already-loaded (clipped) built_land:
-- a station is in-settlement iff its point falls inside a built_land polygon.
-- Verified: Clapham Junction/Oxford/Didcot/Bicester -> in; Sandling/Bramley -> out.

create table if not exists public.stations (
  crs             text primary key,
  name            text,
  lng             double precision not null,
  lat             double precision not null,
  region          text,
  usage           bigint,
  well_connected  boolean,
  meets_frequency boolean,
  rural_urban     text,
  ruc_name        text,
  ttwa_name       text,
  ttwa_gva_rank   integer
);

create table if not exists public.station_assessments (
  crs            text primary key references public.stations(crs) on delete cascade,
  in_settlement  boolean,
  tier           text,        -- 'A' | 'B' | 'ineligible'
  density_floor  integer,     -- 40 (A) | 50 (B) | null
  catchment_ha   numeric,
  developable_ha numeric,
  inner_ha       numeric,
  outer_ha       numeric,
  dwelling_yield integer,     -- developable_ha * density_floor
  updated_at     timestamptz not null default now()
);

-- Rebuild the assessment table (optionally just a crs-prefix batch — the
-- developable RPC runs a spatial difference per station, so the full national
-- run takes a few minutes; run per-letter/prefix to stay under statement/client
-- timeouts). Returns rows written.
create or replace function public.rebuild_station_assessments(
  crs_prefix text default '',
  radius_m   double precision default 800
)
returns integer
language plpgsql
as $$
declare n integer;
begin
  delete from public.station_assessments a
    using public.stations s
    where a.crs = s.crs and s.crs like crs_prefix || '%';

  insert into public.station_assessments
    (crs, in_settlement, tier, density_floor,
     catchment_ha, developable_ha, inner_ha, outer_ha, dwelling_yield)
  select s.crs,
         inset.v,
         case when inset.v then 'A' when s.well_connected then 'B' else 'ineligible' end,
         case when inset.v then 40 when s.well_connected then 50 else null end,
         r.catchment_ha, r.developable_ha, r.inner_ha, r.outer_ha,
         round(r.developable_ha
               * (case when inset.v then 40 when s.well_connected then 50 else 0 end))::int
  from public.stations s
  cross join lateral (
    select exists(
      select 1 from public.planning_constraints c
      where c.kind = 'built_land'
        and st_contains(c.geom, st_setsrid(st_makepoint(s.lng, s.lat), 4326))
    ) as v
  ) inset
  cross join lateral public.developable_land_near_station(s.lng, s.lat, radius_m) r
  where s.crs like crs_prefix || '%';

  get diagnostics n = row_count;
  return n;
end
$$;

alter table public.stations enable row level security;
alter table public.station_assessments enable row level security;
drop policy if exists "stations readable" on public.stations;
create policy "stations readable" on public.stations for select to anon, authenticated using (true);
drop policy if exists "station_assessments readable" on public.station_assessments;
create policy "station_assessments readable" on public.station_assessments for select to anon, authenticated using (true);

-- ---------------------------------------------------------------------------
-- ONE-OFF DATA OPS (re-runnable; not schema). Run after the tables exist.
--
-- 1) Load station points straight from the published GeoJSON using the `http`
--    extension (avoids a giant client-side INSERT):
--
--   create extension if not exists http with schema extensions;
--   insert into public.stations
--     (crs,name,lng,lat,region,usage,well_connected,meets_frequency,rural_urban,ruc_name,ttwa_name,ttwa_gva_rank)
--   select distinct on (crs)
--     crs,name,lng,lat,region,usage,well_connected,meets_frequency,rural_urban,ruc_name,ttwa_name,ttwa_gva_rank
--   from (
--     select f->'properties'->>'crs' as crs, f->'properties'->>'name' as name,
--            (f->'geometry'->'coordinates'->>0)::float as lng,
--            (f->'geometry'->'coordinates'->>1)::float as lat,
--            f->'properties'->>'region' as region,
--            nullif(f->'properties'->>'usage','')::bigint as usage,
--            (f->'properties'->>'well_connected')::boolean as well_connected,
--            (nullif(f->'properties'->>'meets_frequency','')::int = 1) as meets_frequency,
--            f->'properties'->>'rural_urban' as rural_urban, f->'properties'->>'ruc_name' as ruc_name,
--            f->'properties'->>'ttwa_name' as ttwa_name,
--            nullif(f->'properties'->>'ttwa_gva_rank','')::int as ttwa_gva_rank
--     from (select jsonb_array_elements(
--             (extensions.http_get('https://locgrimshaw.github.io/mastermapper/data/stations.geojson')).content::jsonb -> 'features'
--           ) as f) feats
--     where f->'properties'->>'crs' is not null and f->'geometry'->'coordinates'->>0 is not null
--   ) rows
--   order by crs
--   on conflict (crs) do update set name=excluded.name, lng=excluded.lng, lat=excluded.lat,
--     region=excluded.region, usage=excluded.usage, well_connected=excluded.well_connected,
--     meets_frequency=excluded.meets_frequency, rural_urban=excluded.rural_urban,
--     ruc_name=excluded.ruc_name, ttwa_name=excluded.ttwa_name, ttwa_gva_rank=excluded.ttwa_gva_rank;
--
-- 2) Populate assessments. The full run exceeds a 60s client timeout (but keeps
--    running server-side), so drive it per letter-prefix, e.g.:
--       select public.rebuild_station_assessments('A');  -- 88 rows
--       select public.rebuild_station_assessments('B');  -- ...
--    or, from a longer-lived connection, select public.rebuild_station_assessments();
--    (A CI loader that calls rebuild in prefix batches is the durable path.)
-- ---------------------------------------------------------------------------
