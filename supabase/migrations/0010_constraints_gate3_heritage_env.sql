-- 0010_constraints_gate3_heritage_env.sql
-- Assessment 3 (NPPF Policy Compliance & Constraints) — the "Gate 3" sprint.
--
-- Two buckets of designation, both loaded into public.planning_constraints by
-- the extended pipeline/build_constraints.py (planning.data.gov.uk, OGL v3.0):
--   HARD exclusions (remove developable land, folded into the RPC's erase set):
--     sssi, sac, spa, ramsar, ancient_woodland, scheduled_monument
--   SOFT constraints (land is retained but penalised via a friction score):
--     conservation_area, aonb, park_garden, listed_building
--
-- This migration:
--   1. Rebuilds developable_land_near_station() to (a) subtract the hard kinds
--      by default and (b) additionally return per-soft-kind coverage of the
--      developable polygon, the green-belt overlap (tier-aware handling lives in
--      the app), and a single 0..1 friction score for Assessments 5 & 6.
--   2. Adds friction/soft-cover/green-belt columns to station_assessments and
--      teaches rebuild_station_assessments() to persist them.
--
-- Green Belt is deliberately NOT in the hard subtract set: the draft NPPF permits
-- development around well-connected out-of-settlement (Tier B) stations in the
-- Green Belt, so it is returned as an overlap figure (a flag), not an exclusion.
-- Re-runnable.

-- 1. Extended developable RPC ------------------------------------------------
-- Return shape changes (adds soft_cover/green_belt_ha/friction), so the old
-- function must be dropped before recreation. Existing callers select named
-- columns, so the extra return columns are backward-compatible.
drop function if exists public.developable_land_near_station(
  double precision, double precision, double precision, double precision, text[]);

create function public.developable_land_near_station(
  centre_lng     double precision,
  centre_lat     double precision,
  radius_m       double precision default 800,
  inner_radius_m double precision default 200,
  subtract       text[] default array[
    'built_land','green_space','transport','flood_zone_3',
    -- Gate-3 hard environmental exclusions:
    'sssi','sac','spa','ramsar','ancient_woodland','scheduled_monument']
)
returns table (
  developable_geojson jsonb,
  blockers_geojson    jsonb,
  catchment_ha        numeric,
  developable_ha      numeric,
  inner_ha            numeric,
  outer_ha            numeric,
  soft_cover          jsonb,     -- {kind: fraction-of-developable} for soft kinds
  green_belt_ha       numeric,   -- developable ha overlapping Green Belt (a flag)
  friction            numeric    -- 0..1 weighted soft-constraint coverage
)
language sql
stable
as $$
  with centre as (
    select st_makepoint(centre_lng, centre_lat)::geography as g
  ),
  rings as (
    select
      st_buffer((select g from centre), radius_m, 16)::geometry       as catchment,
      st_buffer((select g from centre), inner_radius_m, 16)::geometry as inner_ring
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
  ),
  dev_area as (
    select geom, inner_ring, catchment, blockers,
           coalesce(st_area(geom::geography), 0) as area_m2
    from dev
  ),
  -- Soft-constraint coverage of the (hard-cleared) developable polygon, per kind.
  soft as (
    select c.kind as kind,
           st_area(
             st_intersection(
               st_union(st_makevalid(c.geom)),
               (select geom from dev_area)
             )::geography
           ) as area_m2
    from public.planning_constraints c
    where c.kind in ('conservation_area','aonb','park_garden','listed_building')
      and (select area_m2 from dev_area) > 0
      and st_intersects(c.geom, (select catchment from dev_area))
    group by c.kind
  ),
  soft_frac as (
    select kind,
           case when (select area_m2 from dev_area) > 0
                then coalesce(area_m2, 0) / (select area_m2 from dev_area)
                else 0 end as frac
    from soft
  ),
  -- Green-belt overlap of the developable polygon (returned as a flag, not erased).
  gb as (
    select coalesce(
             st_area(
               st_intersection(
                 st_union(st_makevalid(c.geom)),
                 (select geom from dev_area)
               )::geography
             ), 0) as area_m2
    from public.planning_constraints c
    where c.kind = 'green_belt'
      and (select area_m2 from dev_area) > 0
      and st_intersects(c.geom, (select catchment from dev_area))
  )
  select
    st_asgeojson(da.geom)::jsonb,
    case when da.blockers is null or st_isempty(da.blockers)
         then null else st_asgeojson(da.blockers)::jsonb end,
    round((st_area(da.catchment::geography) / 10000.0)::numeric, 2),
    round((da.area_m2 / 10000.0)::numeric, 2),
    round((coalesce(st_area(st_intersection(da.geom, da.inner_ring)::geography), 0) / 10000.0)::numeric, 2),
    round((coalesce(st_area(st_difference(da.geom, da.inner_ring)::geography), 0) / 10000.0)::numeric, 2),
    coalesce((select jsonb_object_agg(kind, round(frac::numeric, 4)) from soft_frac),
             '{}'::jsonb),
    round((coalesce((select area_m2 from gb), 0) / 10000.0)::numeric, 2),
    -- Weighted soft coverage, clamped to 1. Weights: heritage/landscape designations
    -- that most constrain form/consent count for more (AONB > park&garden >
    -- conservation area > listed-building setting).
    round(least(1.0, coalesce((
      select sum(frac * case kind
                          when 'aonb'              then 0.6
                          when 'park_garden'       then 0.5
                          when 'conservation_area' then 0.4
                          when 'listed_building'   then 0.3
                          else 0.3 end)
      from soft_frac), 0))::numeric, 3)
  from dev_area da;
$$;

grant execute on function public.developable_land_near_station(
  double precision, double precision, double precision, double precision, text[]
) to anon, authenticated;

-- 2. Persist Gate-3 outputs on station_assessments ---------------------------
alter table public.station_assessments
  add column if not exists constraint_friction numeric,
  add column if not exists soft_cover          jsonb,
  add column if not exists green_belt_ha        numeric;

-- rebuild_station_assessments() now also stores friction/soft_cover/green_belt_ha.
-- developable_ha (and hence dwelling_yield) automatically reflects the hard
-- exclusions because the RPC's default `subtract` now includes them.
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
     catchment_ha, developable_ha, inner_ha, outer_ha, dwelling_yield,
     constraint_friction, soft_cover, green_belt_ha)
  select s.crs,
         inset.v,
         case when inset.v then 'A' when s.well_connected then 'B' else 'ineligible' end,
         case when inset.v then 40 when s.well_connected then 50 else null end,
         r.catchment_ha, r.developable_ha, r.inner_ha, r.outer_ha,
         round(r.developable_ha
               * (case when inset.v then 40 when s.well_connected then 50 else 0 end))::int,
         r.friction, r.soft_cover, r.green_belt_ha
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

-- ---------------------------------------------------------------------------
-- ONE-OFF DATA OPS (after the heritage/environmental kinds are loaded):
--   1) Run the "Load constraints into Supabase" Action with kinds =
--        sssi,sac,spa,ramsar,ancient_woodland,scheduled_monument,
--        conservation_area,aonb,park_garden,listed_building
--      (downloads each planning.data.gov.uk dataset, clips to station catchments,
--       upserts into planning_constraints).
--   2) Re-run rebuild_station_assessments() (per letter-prefix under the 60s
--      client timeout, or once from a long-lived connection) so developable_ha /
--      dwelling_yield reflect the hard exclusions and friction/soft_cover/
--      green_belt_ha get populated.
-- ---------------------------------------------------------------------------
