-- 0037_public_land_catchment.sql
-- The station deep dive's public-land answer: which publicly-owned parcels
-- (dataset `public_parcel`, built by pipeline/pair_public_parcels.py) fall
-- inside the catchment circle, their combined area, and a split by owner
-- class. Individual flats are already excluded upstream — every parcel here
-- carries at least one whole-property title (titles_land >= 1).
--
-- Returns the parcels CLIPPED to the catchment so the map can paint them
-- inside the circle without spilling past it, plus totals for the panel.

create or replace function public.public_land_in_catchment(
  centre_lng double precision,
  centre_lat double precision,
  radius_m double precision default 800,
  inner_radius_m double precision default 200)
returns table(parcels_geojson jsonb, total_ha numeric, inner_ha numeric,
              n_parcels integer, by_owner jsonb)
language sql stable as $function$
  with centre as (select st_makepoint(centre_lng, centre_lat)::geography as g),
  rings as (
    select st_buffer((select g from centre), radius_m, 16)::geometry as catchment,
           st_buffer((select g from centre), inner_radius_m, 16)::geometry as inner_ring),
  hit as (
    select mf.source_id,
           mf.name,
           mf.props,
           st_makevalid(st_intersection(st_makevalid(mf.geom), r.catchment)) as geom
    from public.map_features mf cross join rings r
    where mf.dataset = 'public_parcel'
      and mf.geom && r.catchment
      and st_intersects(mf.geom, r.catchment)),
  clipped as (
    select h.*, st_area(h.geom::geography) as area_m2,
           coalesce(st_area(st_intersection(h.geom,
             (select inner_ring from rings))::geography), 0) as inner_m2
    from hit h
    where h.geom is not null and not st_isempty(h.geom)
      and geometrytype(h.geom) in ('POLYGON', 'MULTIPOLYGON'))
  select
    coalesce(jsonb_build_object(
      'type', 'FeatureCollection',
      'features', jsonb_agg(jsonb_build_object(
        'type', 'Feature',
        'properties', c.props || jsonb_build_object(
          'owner', c.name,
          'clipped_ha', round((c.area_m2 / 10000.0)::numeric, 3)),
        'geometry', st_asgeojson(c.geom, 6)::jsonb))),
      jsonb_build_object('type', 'FeatureCollection', 'features', '[]'::jsonb)),
    round((coalesce(sum(c.area_m2), 0) / 10000.0)::numeric, 2),
    round((coalesce(sum(c.inner_m2), 0) / 10000.0)::numeric, 2),
    count(*)::integer,
    coalesce((select jsonb_object_agg(oc, ha) from (
      select coalesce(c2.props->>'owner_class', 'other') as oc,
             round((sum(c2.area_m2) / 10000.0)::numeric, 2) as ha
      from clipped c2 group by 1) o), '{}'::jsonb)
  from clipped c;
$function$;
grant execute on function public.public_land_in_catchment(
  double precision, double precision, double precision, double precision)
  to anon, authenticated;
