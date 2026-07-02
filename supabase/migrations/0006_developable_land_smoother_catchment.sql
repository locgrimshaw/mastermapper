-- 0006_developable_land_smoother_catchment.sql
-- Tighten the catchment/inner-ring circles from the default 8 to 16 segments per
-- quarter so the buffered area is within ~0.1% of a true circle (the developable
-- hectares feed a headline dwelling count, so the small under-area matters).
--
-- Verified against a synthetic half-plane blocker on an 800 m catchment:
--   catchment 200.70 ha (true circle 201.06 => 99.8%), developable 100.36 ha
--   (clean half), inner 6.27 ha, outer 94.08 ha.
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
