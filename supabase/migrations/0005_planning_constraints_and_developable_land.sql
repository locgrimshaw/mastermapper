-- 0005_planning_constraints_and_developable_land.sql
-- Station developable-land analysis backend (Workstream: developable capacity).
--
-- Design mirrors the amenities single-table pattern: ONE polygon table keyed by
-- `kind`, holding every "erase"/overlay layer (built land, public green space,
-- transport corridors, flood zones, green belt, ...). A single RPC buffers a
-- catchment around a station, erases the selected constraint kinds, and returns
-- the developable polygon plus the inner/outer area split the dwelling
-- calculator needs.
--
-- Geometry (not geography) so ST_Difference / ST_Intersection / ST_Union work
-- directly; areas are measured by casting the result to geography (=> metres).
--
-- NOTE: 0006 supersedes the RPC body (smoother catchment circle). This file is
-- kept as the historical first cut so the migration history matches the DB.

-- 1. Constraints table -------------------------------------------------------
create table if not exists public.planning_constraints (
  id         bigint generated always as identity primary key,
  kind       text not null,            -- 'built_land'|'green_space'|'transport'
                                        -- |'flood_zone_2'|'flood_zone_3'
                                        -- |'green_belt'|...
  source_id  text,                     -- source feature id (for clean upserts)
  name       text,
  props      jsonb not null default '{}'::jsonb,
  geom       geometry(MultiPolygon, 4326) not null,
  updated_at timestamptz not null default now()
);

create unique index if not exists planning_constraints_kind_source_uidx
  on public.planning_constraints (kind, source_id)
  where source_id is not null;

create index if not exists planning_constraints_geom_gix
  on public.planning_constraints using gist (geom);

create index if not exists planning_constraints_kind_idx
  on public.planning_constraints (kind);

-- 2. Developable-land RPC ----------------------------------------------------
create or replace function public.developable_land_near_station(
  centre_lng     double precision,
  centre_lat     double precision,
  radius_m       double precision default 800,
  inner_radius_m double precision default 200,
  subtract       text[] default array['built_land','green_space','transport','flood_zone_3']
)
returns table (
  developable_geojson jsonb,
  blockers_geojson    jsonb,
  catchment_ha        numeric,
  developable_ha      numeric,
  inner_ha            numeric,
  outer_ha            numeric
)
language sql
stable
as $$
  with centre as (
    select st_makepoint(centre_lng, centre_lat)::geography as g
  ),
  rings as (
    select
      st_buffer((select g from centre), radius_m)::geometry       as catchment,
      st_buffer((select g from centre), inner_radius_m)::geometry as inner_ring
  ),
  blockers as (
    select st_makevalid(
             st_union(st_intersection(st_makevalid(c.geom), r.catchment))
           ) as geom
    from public.planning_constraints c
    cross join rings r
    where c.kind = any(subtract)
      and st_intersects(c.geom, r.catchment)
  ),
  dev as (
    select
      case
        when b.geom is null or st_isempty(b.geom) then r.catchment
        else st_collectionextract(st_makevalid(st_difference(r.catchment, b.geom)), 3)
      end        as geom,
      r.inner_ring,
      r.catchment,
      b.geom     as blockers
    from rings r
    left join blockers b on true
  )
  select
    st_asgeojson(dev.geom)::jsonb,
    case when dev.blockers is null or st_isempty(dev.blockers)
         then null else st_asgeojson(dev.blockers)::jsonb end,
    round((st_area(dev.catchment::geography) / 10000.0)::numeric, 2),
    round((coalesce(st_area(dev.geom::geography), 0) / 10000.0)::numeric, 2),
    round((coalesce(st_area(st_intersection(dev.geom, dev.inner_ring)::geography), 0) / 10000.0)::numeric, 2),
    round((coalesce(st_area(st_difference(dev.geom, dev.inner_ring)::geography), 0) / 10000.0)::numeric, 2)
  from dev;
$$;

-- 3. Public read access (open OGL data, public map) --------------------------
alter table public.planning_constraints enable row level security;

drop policy if exists "planning_constraints are publicly readable" on public.planning_constraints;
create policy "planning_constraints are publicly readable"
  on public.planning_constraints for select
  to anon, authenticated
  using (true);

grant execute on function public.developable_land_near_station(
  double precision, double precision, double precision, double precision, text[]
) to anon, authenticated;
