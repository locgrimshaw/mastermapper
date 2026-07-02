-- 0004_brownfield.sql
-- RECONSTRUCTED from the live database (this migration existed only in the
-- Supabase dashboard and was never committed; build_brownfield_csv.py references
-- it). Committed here so the schema is reproducible from the repo.
--
-- Brownfield Land Register "supply" layer: every English Brownfield Land Register
-- Part 1 site as a POINT (national registers are point-based — polygon footprints
-- are absent for the vast majority of sites; the `area` column exists for the
-- minority that publish one). Loaded from supabase/brownfield_import.csv, built by
-- pipeline/build_brownfield_csv.py.
--
-- ⚠️ SECURITY NOTE: in the live DB this table currently has ROW LEVEL SECURITY
-- DISABLED and no policies, so the public anon key can read AND modify every row.
-- The frontend only ever reads via the RPCs below. The recommended fix (mirrors
-- the amenities table) is to enable RLS with an anon SELECT-only policy — see the
-- commented block at the foot of this file. Not enabled here to keep this file a
-- faithful reconstruction of current live state.

create extension if not exists postgis with schema extensions;

-- Table ----------------------------------------------------------------------
create table if not exists public.brownfield (
  id                bigint generated always as identity primary key,
  reference         text,
  entity            bigint,
  organisation      text,
  name              text,
  site_address      text,
  hectares          double precision,
  dwellings_min     integer,
  dwellings_max     integer,
  ownership_status  text,
  is_public         boolean,
  deliverable       text,
  permission_status text,
  permission_date   date,
  notes             text,
  source_url        text,
  geom              geography(Point, 4326) not null,        -- site location
  area              geography(MultiPolygon, 4326),          -- optional footprint (usually null)
  updated_at        timestamptz not null default now()
);

-- Clean upserts on (organisation, reference).
create unique index if not exists brownfield_org_ref_key
  on public.brownfield (organisation, reference);

create index if not exists brownfield_geom_gix on public.brownfield using gist (geom);
create index if not exists brownfield_public_idx on public.brownfield (is_public);
create index if not exists brownfield_dwellings_idx on public.brownfield (dwellings_max);

-- RPCs -----------------------------------------------------------------------
-- Sites intersecting a catchment (GeoJSON), with the same optional filters the
-- frontend deep-dive exposes. area_geojson is null for point-only sites.
create or replace function public.brownfield_in_polygon(
  catchment jsonb,
  min_dwellings integer default null,
  public_only boolean default false,
  deliverable_only boolean default false
)
returns table (
  id bigint, reference text, entity bigint, name text, site_address text,
  hectares double precision, dwellings_min integer, dwellings_max integer,
  ownership_status text, is_public boolean, deliverable text,
  permission_status text, permission_date date, notes text, source_url text,
  lng double precision, lat double precision, area_geojson text
)
language sql
stable
as $$
  with poly as (
    select st_setsrid(st_geomfromgeojson(catchment::text), 4326)::geography as g
  )
  select b.id, b.reference, b.entity, b.name, b.site_address, b.hectares,
         b.dwellings_min, b.dwellings_max, b.ownership_status, b.is_public,
         b.deliverable, b.permission_status, b.permission_date, b.notes,
         b.source_url,
         st_x(b.geom::geometry) as lng,
         st_y(b.geom::geometry) as lat,
         case when b.area is not null
              then st_asgeojson(b.area::geometry)
              else null end as area_geojson
  from public.brownfield b, poly
  where st_intersects(b.geom, poly.g)
    and (min_dwellings is null or coalesce(b.dwellings_max, 0) >= min_dwellings)
    and (not public_only or b.is_public is true)
    and (not deliverable_only or lower(coalesce(b.deliverable, '')) = 'yes');
$$;

-- Aggregated summary for the stats panel.
create or replace function public.brownfield_summary_in_polygon(
  catchment jsonb,
  min_dwellings integer default null,
  public_only boolean default false,
  deliverable_only boolean default false
)
returns table (
  n_sites bigint, n_public bigint,
  dwellings_min_total bigint, dwellings_max_total bigint,
  hectares_total double precision
)
language sql
stable
as $$
  with poly as (
    select st_setsrid(st_geomfromgeojson(catchment::text), 4326)::geography as g
  )
  select count(*) as n_sites,
         count(*) filter (where b.is_public is true) as n_public,
         coalesce(sum(b.dwellings_min), 0) as dwellings_min_total,
         coalesce(sum(b.dwellings_max), 0) as dwellings_max_total,
         coalesce(sum(b.hectares), 0) as hectares_total
  from public.brownfield b, poly
  where st_intersects(b.geom, poly.g)
    and (min_dwellings is null or coalesce(b.dwellings_max, 0) >= min_dwellings)
    and (not public_only or b.is_public is true)
    and (not deliverable_only or lower(coalesce(b.deliverable, '')) = 'yes');
$$;

grant execute on function public.brownfield_in_polygon(jsonb, integer, boolean, boolean) to anon, authenticated;
grant execute on function public.brownfield_summary_in_polygon(jsonb, integer, boolean, boolean) to anon, authenticated;

-- RECOMMENDED SECURITY FIX (not applied on live yet — review before running):
--   alter table public.brownfield enable row level security;
--   drop policy if exists "brownfield is publicly readable" on public.brownfield;
--   create policy "brownfield is publicly readable"
--     on public.brownfield for select to anon, authenticated using (true);
-- The frontend reads only via the RPCs above, so enabling RLS with a SELECT-only
-- policy keeps the app working while removing anon write access.
