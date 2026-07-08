-- 0015_fast_builtfrac.sql
-- Make the robust in-settlement rule (0014) fast AND reproducible.
--
-- The built-up fraction of a station's 800 m catchment is what decides Tier A
-- (in-settlement). Computing it against the raw OS Built-Up Area polygons (SRID
-- 4326, up to ~3,200 vertices, avg 2.25 km²) with per-station ST_Union +
-- geography intersection is far too slow (a 300-station batch exceeded 60 s).
--
-- Fix: precompute a projected (EPSG:27700), validated, SIMPLIFIED and SUBDIVIDED
-- copy of built_land once (public.built_land_bng, GiST-indexed). Small tiles let
-- the index prune each 800 m circle to a handful of ~20-vertex pieces, so the
-- area fraction is a fast planar intersection. This is the EXACT formulation used
-- to populate station_assessments, so a future rebuild reproduces the same tiers.

-- Helper: (re)build the projected/simplified/subdivided built-up-area tiles.
create or replace function public.refresh_built_land_bng()
returns integer
language plpgsql
as $$
declare n integer;
begin
  drop table if exists public.built_land_bng;
  create table public.built_land_bng as
    select st_subdivide(g, 48) as geom from (
      select st_makevalid(st_simplifypreservetopology(
               st_makevalid(st_transform(geom, 27700)), 12)) as g
      from public.planning_constraints where kind = 'built_land'
    ) s where not st_isempty(g);
  create index built_land_bng_gix on public.built_land_bng using gist(geom);
  analyze public.built_land_bng;
  get diagnostics n = row_count;
  return n;
end
$$;

-- Ensure the helper exists now (idempotent).
select public.refresh_built_land_bng();

-- Redefine the assessment rebuild to use the fast planar built_frac.
create or replace function public.rebuild_station_assessments(
  crs_prefix text default '', radius_m double precision default 800)
returns integer
language plpgsql
as $$
declare n integer;
begin
  -- Keep the fast built-up tiles current (cheap; a few seconds).
  perform public.refresh_built_land_bng();

  delete from public.station_assessments a
    using public.stations s
    where a.crs = s.crs and s.crs like crs_prefix || '%';

  insert into public.station_assessments
    (crs, in_settlement, tier, density_floor,
     catchment_ha, developable_ha, inner_ha, outer_ha, dwelling_yield,
     constraint_friction, soft_cover, green_belt_ha, built_frac)
  select s.crs,
         inset.v,
         case when inset.v then 'A' when s.well_connected then 'B' else 'ineligible' end,
         case when s.well_connected then 50 when inset.v then 40 else null end,
         r.catchment_ha, r.developable_ha, r.inner_ha, r.outer_ha,
         round(r.developable_ha
               * (case when s.well_connected then 50 when inset.v then 40 else 0 end))::int,
         r.friction, r.soft_cover, r.green_belt_ha, bf.frac
  from public.stations s
  cross join lateral (
    select st_buffer(st_transform(st_setsrid(st_makepoint(s.lng, s.lat), 4326), 27700), radius_m) as c,
           st_transform(st_setsrid(st_makepoint(s.lng, s.lat), 4326), 27700) as p
  ) cat
  cross join lateral (
    -- built-up fraction of the catchment (planar, index-pruned tiles)
    select coalesce(sum(st_area(st_intersection(bl.geom, cat.c))), 0)
             / nullif(st_area(cat.c), 0) as frac
    from public.built_land_bng bl where bl.geom && cat.c
  ) af
  cross join lateral (
    select af.frac as frac,
           exists(select 1 from public.built_land_bng bl
                  where st_dwithin(bl.geom, cat.p, 100)) as near
  ) bf
  cross join lateral (select (bf.frac >= 0.40 or (bf.frac >= 0.20 and bf.near)) as v) inset
  cross join lateral public.developable_land_near_station(s.lng, s.lat, radius_m) r
  where s.crs like crs_prefix || '%';

  get diagnostics n = row_count;
  return n;
end
$$;
