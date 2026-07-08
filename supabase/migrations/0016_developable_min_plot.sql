-- 0016_developable_min_plot.sql
-- Add two developable-land filters, so the deep dive can drop unusably small
-- fragments and/or focus on the single largest contiguous plot:
--   min_plot_m2   drop any developable polygon smaller than this (0 = keep all).
--   largest_only  keep ONLY the biggest contiguous developable polygon.
-- Both default off, so existing calls (and the precomputed assessments) are
-- unchanged. Filtering happens AFTER the constraint erase, on the component
-- polygons of the developable multipolygon.
--
-- The two new parameters change the function's argument list, so the previous
-- 5-argument overload is dropped first (otherwise a 2-arg call is ambiguous).

drop function if exists public.developable_land_near_station(
  double precision, double precision, double precision, double precision, text[]);

create or replace function public.developable_land_near_station(
  centre_lng double precision,
  centre_lat double precision,
  radius_m double precision default 800,
  inner_radius_m double precision default 200,
  subtract text[] default array['built_land','green_space','transport','flood_zone_3',
    'sssi','sac','spa','ramsar','ancient_woodland','scheduled_monument'],
  min_plot_m2 double precision default 0,
  largest_only boolean default false)
returns table(developable_geojson jsonb, blockers_geojson jsonb, catchment_ha numeric,
  developable_ha numeric, inner_ha numeric, outer_ha numeric, soft_cover jsonb,
  green_belt_ha numeric, friction numeric)
language sql stable as $function$
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
  dev0 as (
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
  -- Split the developable multipolygon into its contiguous plots so we can drop
  -- tiny fragments and/or keep only the largest.
  parts as (
    select (st_dump(d.geom)).geom as g, d.inner_ring, d.catchment, d.blockers
    from dev0 d
    where d.geom is not null and not st_isempty(d.geom)
  ),
  part_area as (
    select g, inner_ring, catchment, blockers, st_area(g::geography) as a from parts
  ),
  dev as (
    select
      case
        when largest_only then
          (select st_collect(g) from (select g from part_area order by a desc limit 1) x)
        when min_plot_m2 > 0 then
          (select st_collect(g) from part_area where a >= min_plot_m2)
        else
          (select st_collect(g) from part_area)
      end as geom,
      (select inner_ring from dev0) as inner_ring,
      (select catchment  from dev0) as catchment,
      (select blockers   from dev0) as blockers
  ),
  dev_area as (
    select geom, inner_ring, catchment, blockers,
           coalesce(st_area(geom::geography), 0) as area_m2
    from dev
  ),
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
      and (select geom from dev_area) is not null
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
      and (select geom from dev_area) is not null
      and st_intersects(c.geom, (select catchment from dev_area))
  )
  select
    case when da.geom is null then null else st_asgeojson(da.geom)::jsonb end,
    case when da.blockers is null or st_isempty(da.blockers)
         then null else st_asgeojson(da.blockers)::jsonb end,
    round((st_area(da.catchment::geography) / 10000.0)::numeric, 2),
    round((da.area_m2 / 10000.0)::numeric, 2),
    round((coalesce(st_area(st_intersection(da.geom, da.inner_ring)::geography), 0) / 10000.0)::numeric, 2),
    round((coalesce(st_area(st_difference(da.geom, da.inner_ring)::geography), 0) / 10000.0)::numeric, 2),
    coalesce((select jsonb_object_agg(kind, round(frac::numeric, 4)) from soft_frac),
             '{}'::jsonb),
    round((coalesce((select area_m2 from gb), 0) / 10000.0)::numeric, 2),
    round(least(1.0, coalesce((
      select sum(frac * case kind
                          when 'aonb'              then 0.6
                          when 'park_garden'       then 0.5
                          when 'conservation_area' then 0.4
                          when 'listed_building'   then 0.3
                          else 0.3 end)
      from soft_frac), 0))::numeric, 3)
  from dev_area da;
$function$;