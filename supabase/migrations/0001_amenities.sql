-- 0001_amenities.sql
-- MasterMapper — first Supabase migration.
-- Run this in the Supabase dashboard SQL Editor (one-time setup).
--
-- What it does:
--   1. Enables PostGIS (spatial types + functions + indexes).
--   2. Creates a single `amenities` table that holds point datasets of many
--      kinds (GPs first; pharmacies, schools, bus stops, etc. reuse the same
--      table, distinguished by `kind`). One table keeps things simple and lets
--      the "what's in this catchment" query serve every layer at once.
--   3. Adds a GIST spatial index so in-polygon / radius queries stay fast.
--   4. Defines RPCs the frontend calls:
--        amenities_in_polygon(geojson, kinds)  -> features inside a catchment
--        amenities_in_radius(lng, lat, metres, kinds)
--      Both return GeoJSON-ready rows (lng/lat split out) so the map can plot
--      them without parsing PostGIS binary.
--
-- Re-running is safe: guarded with IF NOT EXISTS / CREATE OR REPLACE.

-- 1. PostGIS -----------------------------------------------------------------
-- In the dashboard you can also enable this via Database > Extensions; doing it
-- in SQL is equivalent. We keep PostGIS in its own `extensions` schema (the
-- Supabase default) rather than public.
create extension if not exists postgis with schema extensions;

-- 2. Table -------------------------------------------------------------------
create table if not exists public.amenities (
  id          bigint generated always as identity primary key,
  kind        text not null,                 -- 'gp' | 'pharmacy' | 'school' | ...
  source_id   text,                          -- the source's own id (e.g. ODS code)
  name        text,
  -- Free-form extra fields per dataset (phone, practice type, capacity, ...).
  -- Keeping these in jsonb means new datasets don't need schema changes.
  props       jsonb not null default '{}'::jsonb,
  -- Geography (not geometry): distances come out in METRES with no projection
  -- faff, which is what we want for "within 800m" and nearest-distance.
  geom        geography(point, 4326) not null,
  updated_at  timestamptz not null default now()
);

-- One row per (kind, source_id) so re-loading a dataset upserts cleanly rather
-- than duplicating. Partial-safe: source_id may be null for sources without ids.
create unique index if not exists amenities_kind_source_uidx
  on public.amenities (kind, source_id)
  where source_id is not null;

-- 3. Spatial index -----------------------------------------------------------
create index if not exists amenities_geom_gix
  on public.amenities using gist (geom);

-- Helps filtering one layer at a time.
create index if not exists amenities_kind_idx
  on public.amenities (kind);

-- 4. RPCs --------------------------------------------------------------------

-- All amenities (optionally limited to certain kinds) whose point falls INSIDE
-- a catchment polygon supplied as GeoJSON. This is the deep-dive workhorse:
-- the frontend draws a circle (or later an isochrone), sends its GeoJSON, and
-- gets back exactly the points to plot + count.
--
-- `kinds` null/empty means "all kinds".
create or replace function public.amenities_in_polygon(
  catchment jsonb,
  kinds text[] default null
)
returns table (
  id bigint,
  kind text,
  name text,
  props jsonb,
  lng double precision,
  lat double precision
)
language sql
stable
as $$
  select a.id, a.kind, a.name, a.props,
         st_x(a.geom::geometry) as lng,
         st_y(a.geom::geometry) as lat
  from public.amenities a
  where (kinds is null or a.kind = any(kinds))
    and st_within(
          a.geom::geometry,
          st_setsrid(st_geomfromgeojson(catchment::text), 4326)
        );
$$;

-- Radius variant (handy for the simplest "circle" catchment without building a
-- polygon client-side; the frontend uses the polygon form, but this is here for
-- convenience and testing). Distance is in metres thanks to geography type.
create or replace function public.amenities_in_radius(
  centre_lng double precision,
  centre_lat double precision,
  radius_m double precision,
  kinds text[] default null
)
returns table (
  id bigint,
  kind text,
  name text,
  props jsonb,
  lng double precision,
  lat double precision,
  distance_m double precision
)
language sql
stable
as $$
  select a.id, a.kind, a.name, a.props,
         st_x(a.geom::geometry) as lng,
         st_y(a.geom::geometry) as lat,
         st_distance(a.geom, st_makepoint(centre_lng, centre_lat)::geography) as distance_m
  from public.amenities a
  where (kinds is null or a.kind = any(kinds))
    and st_dwithin(a.geom, st_makepoint(centre_lng, centre_lat)::geography, radius_m)
  order by distance_m;
$$;

-- Counts by kind inside a catchment — for the stats panel without shipping all
-- the points when you only need the numbers.
create or replace function public.amenity_counts_in_polygon(
  catchment jsonb,
  kinds text[] default null
)
returns table (kind text, n bigint)
language sql
stable
as $$
  select a.kind, count(*) as n
  from public.amenities a
  where (kinds is null or a.kind = any(kinds))
    and st_within(
          a.geom::geometry,
          st_setsrid(st_geomfromgeojson(catchment::text), 4326)
        )
  group by a.kind;
$$;

-- 5. Read-only access for the anon (public) key -----------------------------
-- The map is public, the amenity data is open (OGL), so anonymous read is fine.
-- RLS is enabled so we control access explicitly; we grant SELECT-only and
-- allow the RPCs to run. (User-specific tables added later get stricter RLS.)
alter table public.amenities enable row level security;

drop policy if exists "amenities are publicly readable" on public.amenities;
create policy "amenities are publicly readable"
  on public.amenities for select
  to anon, authenticated
  using (true);

-- Allow the anon role to execute the read-only RPCs.
grant execute on function public.amenities_in_polygon(jsonb, text[]) to anon, authenticated;
grant execute on function public.amenities_in_radius(double precision, double precision, double precision, text[]) to anon, authenticated;
grant execute on function public.amenity_counts_in_polygon(jsonb, text[]) to anon, authenticated;
