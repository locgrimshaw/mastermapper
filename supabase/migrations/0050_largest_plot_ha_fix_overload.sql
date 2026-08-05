-- 0050: corrective for 0049. That migration recreated the RETIRED 7-param
-- signature of developable_land_near_station (source: migration 0017; the
-- live function had since gained min_width_m + Scottish soft designations),
-- leaving TWO overloads — short-arg calls, including the 3-arg call inside
-- rebuild_station_assessments, became ambiguous, and the live 8-param
-- function still lacked largest_plot_ha. Drop both overloads and recreate
-- the TRUE live definition with largest_plot_ha appended.

drop function if exists public.developable_land_near_station(double precision, double precision, double precision, double precision, text[], double precision, boolean);
drop function if exists public.developable_land_near_station(double precision, double precision, double precision, double precision, text[], double precision, boolean, double precision);

create function public.developable_land_near_station(
  centre_lng double precision, centre_lat double precision,
  radius_m double precision default 800, inner_radius_m double precision default 200,
  subtract text[] default array['built_land','green_space','transport','water','flood_zone_3',
    'sssi','sac','spa','ramsar','ancient_woodland','scheduled_monument'],
  min_plot_m2 double precision default 0,
  largest_only boolean default false,
  min_width_m double precision default 0)
returns table(developable_geojson jsonb, blockers_geojson jsonb, catchment_ha numeric,
  developable_ha numeric, inner_ha numeric, outer_ha numeric, soft_cover jsonb,
  green_belt_ha numeric, friction numeric, largest_plot_ha numeric)
language sql stable as $function$
  with centre as (select st_makepoint(centre_lng, centre_lat)::geography as g),
  utm as (select (32600 + floor((centre_lng + 180) / 6) + 1)::integer as srid),
  rings as (
    select st_buffer((select g from centre), radius_m, 16)::geometry as catchment,
           st_buffer((select g from centre), inner_radius_m, 16)::geometry as inner_ring),
  blockers as (
    select st_makevalid(st_union(st_intersection(st_makevalid(c.geom), r.catchment))) as geom
    from public.planning_constraints c cross join rings r
    where c.kind = any(subtract) and st_intersects(c.geom, r.catchment)),
  dev0 as (
    select case when b.geom is null or st_isempty(b.geom) then r.catchment
                else st_collectionextract(st_makevalid(st_difference(r.catchment, b.geom)), 3) end as geom,
           r.inner_ring, r.catchment, b.geom as blockers
    from rings r left join blockers b on true),
  dev_open as (
    select case
             when min_width_m is null or min_width_m <= 0
                  or d.geom is null or st_isempty(d.geom) then d.geom
             else st_collectionextract(st_makevalid(st_intersection(
                    st_transform(
                      st_buffer(
                        st_buffer(st_transform(d.geom, (select srid from utm)),
                                  -min_width_m / 2.0, 'quad_segs=4'),
                        min_width_m / 2.0, 'quad_segs=4'),
                      4326),
                    d.geom)), 3)
           end as geom,
           d.inner_ring, d.catchment, d.blockers
    from dev0 d),
  parts as (
    select (st_dump(o.geom)).geom as g, o.inner_ring, o.catchment, o.blockers
    from dev_open o where o.geom is not null and not st_isempty(o.geom)),
  part_area as (select g, inner_ring, catchment, blockers, st_area(g::geography) as a from parts),
  dev as (
    select case
             when largest_only then (select st_collect(g) from (select g from part_area order by a desc limit 1) x)
             when min_plot_m2 > 0 then (select st_collect(g) from part_area where a >= min_plot_m2)
             else (select st_collect(g) from part_area) end as geom,
           (select inner_ring from dev_open) as inner_ring,
           (select catchment from dev_open) as catchment,
           (select blockers from dev_open) as blockers),
  dev_area as (select geom, inner_ring, catchment, blockers,
                      coalesce(st_area(geom::geography), 0) as area_m2 from dev),
  -- Largest single plot of the KEPT set (post min-width / min-plot /
  -- largest-only filtering): max dumped-part area of what survived.
  largest as (
    select coalesce(max(st_area(d.g::geography)), 0) as a
    from (select (st_dump((select geom from dev_area))).geom as g) d),
  soft as (
    select c.kind as kind,
           st_area(st_intersection(st_union(st_makevalid(c.geom)), (select geom from dev_area))::geography) as area_m2
    from public.planning_constraints c
    where c.kind in ('conservation_area','aonb','park_garden','listed_building',
                     'national_scenic_area','national_park')
      and (select area_m2 from dev_area) > 0 and (select geom from dev_area) is not null
      and st_intersects(c.geom, (select catchment from dev_area))
    group by c.kind),
  soft_frac as (
    select kind, case when (select area_m2 from dev_area) > 0
                      then coalesce(area_m2, 0) / (select area_m2 from dev_area) else 0 end as frac
    from soft),
  gb as (
    select coalesce(st_area(st_intersection(st_union(st_makevalid(c.geom)), (select geom from dev_area))::geography), 0) as area_m2
    from public.planning_constraints c
    where c.kind = 'green_belt' and (select area_m2 from dev_area) > 0 and (select geom from dev_area) is not null
      and st_intersects(c.geom, (select catchment from dev_area)))
  select
    case when da.geom is null then null else st_asgeojson(da.geom)::jsonb end,
    case when da.blockers is null or st_isempty(da.blockers) then null else st_asgeojson(da.blockers)::jsonb end,
    round((st_area(da.catchment::geography) / 10000.0)::numeric, 2),
    round((da.area_m2 / 10000.0)::numeric, 2),
    round((coalesce(st_area(st_intersection(da.geom, da.inner_ring)::geography), 0) / 10000.0)::numeric, 2),
    round((coalesce(st_area(st_difference(da.geom, da.inner_ring)::geography), 0) / 10000.0)::numeric, 2),
    coalesce((select jsonb_object_agg(kind, round(frac::numeric, 4)) from soft_frac), '{}'::jsonb),
    round((coalesce((select area_m2 from gb), 0) / 10000.0)::numeric, 2),
    round(least(1.0, coalesce((
      select sum(frac * case kind
                          when 'aonb' then 0.6 when 'national_scenic_area' then 0.6
                          when 'national_park' then 0.5 when 'park_garden' then 0.5
                          when 'conservation_area' then 0.4 when 'listed_building' then 0.3
                          else 0.3 end) from soft_frac), 0))::numeric, 3),
    round(((select a from largest) / 10000.0)::numeric, 2)
  from dev_area da;
$function$;

notify pgrst, 'reload schema';
