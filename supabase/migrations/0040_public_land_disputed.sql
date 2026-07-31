-- 0040_public_land_disputed.sql
-- Keep parcels whose size contradicts their asset register, but stop them
-- counting towards any number the user acts on.
--
-- WHY. The asset-register join (pipeline/build_uprn_parcels.py) attributes a
-- parcel by dropping the owner's published coordinate into whichever INSPIRE
-- title contains it. A title can be far larger than the holding, so of the
-- 16,120 loaded rows whose register states an area, 43.6% disagree with the
-- parcel by more than 5x. One Cabinet Office holding stated at 0.027 ha landed
-- inside a 4,118 ha title. The 3,164 worst rows are under 10% of the layer but
-- 43% of its hectares.
--
-- Those rows stay on the map — a disputed parcel is still a real lead, and the
-- frontend draws them faded with a dashed edge — but total_ha, inner_ha,
-- n_parcels and by_owner now describe CONFIRMED parcels only. That matters
-- because the deep-dive panel turns total_ha into a "~N homes" capacity
-- estimate: a single false 4,118 ha parcel inside a catchment would otherwise
-- inflate a number the user is meant to act on, invisibly.
--
-- The disputed area is returned alongside rather than dropped, so the panel can
-- say how much was set aside instead of quietly showing a smaller number.
--
-- Also adds inner_ha PER FEATURE. The frontend could not previously work out
-- how much of an individual parcel sat inside the inner ring, so it had no way
-- to net a disputed parcel back out of the inner-ring total client-side.

-- The return type gains columns, so this cannot be a plain create-or-replace.
drop function if exists public.public_land_in_catchment(
  double precision, double precision, double precision, double precision);

create function public.public_land_in_catchment(
  centre_lng double precision,
  centre_lat double precision,
  radius_m double precision default 800,
  inner_radius_m double precision default 200)
returns table(parcels_geojson jsonb, total_ha numeric, inner_ha numeric,
              n_parcels integer, by_owner jsonb,
              disputed_ha numeric, disputed_inner_ha numeric,
              n_disputed integer)
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
             (select inner_ring from rings))::geography), 0) as inner_m2,
           -- One definition of "disputed", used for the flag on the feature and
           -- for every total below, so the map and the panel can never disagree.
           coalesce((h.props->>'area_mismatch')::boolean, false) as disputed
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
          'clipped_ha', round((c.area_m2 / 10000.0)::numeric, 3),
          'inner_ha', round((c.inner_m2 / 10000.0)::numeric, 3),
          'disputed', c.disputed),
        'geometry', st_asgeojson(c.geom, 6)::jsonb))),
      jsonb_build_object('type', 'FeatureCollection', 'features', '[]'::jsonb)),
    -- Confirmed only, on all four headline aggregates.
    round((coalesce(sum(c.area_m2)  filter (where not c.disputed), 0) / 10000.0)::numeric, 2),
    round((coalesce(sum(c.inner_m2) filter (where not c.disputed), 0) / 10000.0)::numeric, 2),
    count(*) filter (where not c.disputed)::integer,
    coalesce((select jsonb_object_agg(oc, ha) from (
      select coalesce(c2.props->>'owner_class', 'other') as oc,
             round((sum(c2.area_m2) / 10000.0)::numeric, 2) as ha
      from clipped c2 where not c2.disputed group by 1) o), '{}'::jsonb),
    -- ...and the set-aside reported separately, never silently dropped.
    round((coalesce(sum(c.area_m2)  filter (where c.disputed), 0) / 10000.0)::numeric, 2),
    round((coalesce(sum(c.inner_m2) filter (where c.disputed), 0) / 10000.0)::numeric, 2),
    count(*) filter (where c.disputed)::integer
  from clipped c;
$function$;

grant execute on function public.public_land_in_catchment(
  double precision, double precision, double precision, double precision)
  to anon, authenticated;
