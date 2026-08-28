-- 0066_developable_standoff.sql
--
-- A standoff from roads and railways in the developable-land model.
--
-- Our transport constraint is a HIGHWAY FOOTPRINT: OS OpenMap Local
-- centrelines buffered by the carriageway half-width (4 m for a local street,
-- 9 m for an A road, 15 m for a motorway, 12 m for rail curtilage). Subtract
-- that and the "developable" polygon runs to the kerb and to the railway
-- fence, which is not a site anyone can build out. Comparing a station against
-- the published NPPF-2026 tools, this is a visible difference: their polygons
-- hold back from the highway, ours do not.
--
-- So: a standoff, applied on top of the footprint at query time. Doing it here
-- rather than in build_constraints.py means it can be changed and compared
-- without reloading a national constraints table, and the deep dive can expose
-- it as a control rather than baking one number in.
--
-- DEFAULT 10 m, which is a conventional allowance for the strip you cannot
-- build on beside an adopted highway — verge, footway, visibility splay,
-- service margin. Measured at Habrough (HAB) it takes the catchment from
-- 138.3 to 132.2 developable hectares.
--
-- The signature gains parameters, so the old function must be dropped rather
-- than replaced: adding defaulted parameters to a CREATE OR REPLACE creates a
-- second overload and every existing call becomes ambiguous.

drop function if exists public.developable_land_near_station(
  double precision, double precision, double precision, double precision,
  text[], double precision, boolean, double precision);

create function public.developable_land_near_station(
  centre_lng double precision,
  centre_lat double precision,
  radius_m double precision default 800,
  inner_radius_m double precision default 200,
  subtract text[] default ARRAY['built_land','green_space','transport','water',
    'flood_zone_3','sssi','sac','spa','ramsar','ancient_woodland','scheduled_monument'],
  min_plot_m2 double precision default 0,
  largest_only boolean default false,
  min_width_m double precision default 0,
  transport_standoff_m double precision default 10,
  built_land_standoff_m double precision default 0
)
RETURNS TABLE(developable_geojson jsonb, blockers_geojson jsonb, catchment_ha numeric,
              developable_ha numeric, inner_ha numeric, outer_ha numeric, soft_cover jsonb,
              green_belt_ha numeric, friction numeric, largest_plot_ha numeric)
LANGUAGE sql STABLE AS $function$
  with centre as (select st_makepoint(centre_lng, centre_lat)::geography as g),
  utm as (select (32600 + floor((centre_lng + 180) / 6) + 1)::integer as srid),
  rings as (
    select st_buffer((select g from centre), radius_m, 16)::geometry as catchment,
           st_buffer((select g from centre), inner_radius_m, 16)::geometry as inner_ring),
  -- Standoff kinds are buffered in the local UTM zone (metres) before being
  -- clipped; everything else is taken as-is. A zero standoff short-circuits to
  -- the plain geometry so the default path costs nothing extra.
  blocker_parts as (
    select st_intersection(
             case
               when c.kind = 'transport' and coalesce(transport_standoff_m, 0) > 0
                 then st_transform(st_buffer(st_transform(st_makevalid(c.geom),
                        (select srid from utm)), transport_standoff_m), 4326)
               when c.kind = 'built_land' and coalesce(built_land_standoff_m, 0) > 0
                 then st_transform(st_buffer(st_transform(st_makevalid(c.geom),
                        (select srid from utm)), built_land_standoff_m), 4326)
               else st_makevalid(c.geom)
             end, r.catchment) as g
    from public.planning_constraints c cross join rings r
    where c.kind = any(subtract) and st_intersects(c.geom, r.catchment)),
  blockers as (
    select st_makevalid(st_union(g)) as geom from blocker_parts
     where g is not null and not st_isempty(g)),
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

comment on function public.developable_land_near_station(
  double precision, double precision, double precision, double precision, text[],
  double precision, boolean, double precision, double precision, double precision) is
  'Developable land in a station catchment. transport_standoff_m (default 10) '
  'widens road/rail footprints to the strip that cannot be built on beside an '
  'adopted highway; built_land_standoff_m does the same for settlement edges '
  '(default 0 — you can normally build up to an existing built edge).';
