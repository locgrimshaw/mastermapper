-- 0026_point_summary.sql
-- 1. features_in_bbox gains p_num_max so the frontend can fetch a numeric BAND
--    (voltage tiers: transmission >= 200 kV, grid 50-200, local < 50). The min
--    filter keeps excluding rows without a parseable value (a substation with
--    no voltage tag must not appear in the ">= 200 kV" tier); the max filter
--    INCLUDES them (an untagged substation belongs in the local/unknown tier).
--    Signature changes, so drop the old function first — CREATE OR REPLACE
--    with a new arg list would leave an ambiguous overload behind.
-- 2. point_summary(lon, lat): everything we know about one spot, for the
--    right-click "Spot summary" card. Server-side because most layers are only
--    fetched client-side for the current viewport (or not at all when toggled
--    off) — this answers from the full national tables.

drop function if exists public.features_in_bbox(
  text, double precision, double precision, double precision, double precision,
  integer, double precision, text, double precision);

create or replace function public.features_in_bbox(
  p_dataset text, w double precision, s double precision,
  e double precision, n double precision,
  lim integer default 4000, p_zoom double precision default null,
  p_num_key text default null, p_num_min double precision default null,
  p_num_max double precision default null)
returns jsonb language sql stable as $function$
  with tol as (select public._px_deg(p_zoom) as t)
  select jsonb_build_object(
      'type', 'FeatureCollection',
      'features', coalesce(jsonb_agg(jsonb_build_object(
        'type', 'Feature',
        'properties', f.props || jsonb_build_object('name', f.name, 'dataset', f.dataset),
        'geometry', st_asgeojson(f.g, 6)::jsonb)), '[]'::jsonb))
  from (
    select dataset, name, props,
           case when (select t from tol) > 0
                     and geometrytype(geom) not in ('POINT','MULTIPOINT')
                then st_makevalid(st_simplifypreservetopology(geom, (select t from tol)))
                else geom end as g
    from public.map_features
    where dataset = p_dataset
      and geom && st_makeenvelope(w, s, e, n, 4326)
      and ((select t from tol) = 0
           or geometrytype(geom) in ('POINT','MULTIPOINT','LINESTRING','MULTILINESTRING')
           or size_metric > 4 * (select t from tol) * (select t from tol))
      and (p_num_key is null or p_num_min is null
           or (case when props->>p_num_key ~ '^-?[0-9]+(\.[0-9]+)?$'
                    then (props->>p_num_key)::double precision end) >= p_num_min)
      and (p_num_key is null or p_num_max is null
           or (case when props->>p_num_key ~ '^-?[0-9]+(\.[0-9]+)?$'
                    then (props->>p_num_key)::double precision end) < p_num_max
           or not (props->>p_num_key ~ '^-?[0-9]+(\.[0-9]+)?$'))
    order by size_metric desc
    limit lim
  ) f
  where f.g is not null and not st_isempty(f.g);
$function$;

-- Everything about one point. Each block is an independent indexed lookup
-- (&& + st_intersects on gist, KNN <-> for nearest); the card renders only
-- the non-empty sections.
create or replace function public.point_summary(
  p_lon double precision, p_lat double precision)
returns jsonb language sql stable as $function$
  select jsonb_build_object(
    -- Statutory / policy designations covering the point: one row per kind
    -- (the largest polygon of that kind names it). Internal analysis masks
    -- (transport corridors, built land, waterbodies) are noise here.
    'constraints', (
      select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'name', name)
                                order by kind), '[]'::jsonb)
      from (
        select distinct on (kind) kind, name
        from public.planning_constraints
        where kind not in ('transport', 'built_land', 'water')
          and geom && st_setsrid(st_makepoint(p_lon, p_lat), 4326)
          and st_intersects(geom, st_setsrid(st_makepoint(p_lon, p_lat), 4326))
        order by kind, area_deg2 desc
      ) c),
    -- Polygon datasets covering the point, keyed by dataset. distinct-on with
    -- size ASC picks the smallest (most specific) containing polygon.
    'areas', (
      select coalesce(jsonb_object_agg(dataset,
               props || jsonb_build_object('name', name)), '{}'::jsonb)
      from (
        select distinct on (dataset) dataset, name, props
        from public.map_features
        where dataset in ('alc','water_availability','gsp_boundary','lad_boundary',
                          'lpa_boundary','local_plan_boundary','article4','tpo_zone',
                          'design_code_area','la_rents','ptal','uni_campus_site')
          and geometrytype(geom) in ('POLYGON','MULTIPOLYGON')
          and geom && st_setsrid(st_makepoint(p_lon, p_lat), 4326)
          and st_intersects(geom, st_setsrid(st_makepoint(p_lon, p_lat), 4326))
        order by dataset, size_metric asc
      ) a),
    'ownership', (
      select coalesce(jsonb_agg(jsonb_build_object('body', body, 'owner', owner_name)), '[]'::jsonb)
      from (
        select body, owner_name from public.land_ownership
        where geom && st_setsrid(st_makepoint(p_lon, p_lat), 4326)
          and st_intersects(geom, st_setsrid(st_makepoint(p_lon, p_lat), 4326))
        limit 4
      ) o),
    'nearest_substation', (
      select to_jsonb(x) from (
        select name, props->>'kv' as kv, props->>'operator' as operator,
               round(st_distancesphere(geom,
                 st_setsrid(st_makepoint(p_lon, p_lat), 4326)))::int as dist_m
        from public.map_features
        where dataset = 'power_substation'
        order by geom <-> st_setsrid(st_makepoint(p_lon, p_lat), 4326)
        limit 1
      ) x),
    -- The nearest substation of ANY size answers "how built-up is the local
    -- network here"; the nearest GRID-scale one (>= 50 kV) answers "where
    -- would a serious connection actually plug in".
    'nearest_grid_substation', (
      select to_jsonb(x) from (
        select name, props->>'kv' as kv, props->>'operator' as operator,
               round(st_distancesphere(geom,
                 st_setsrid(st_makepoint(p_lon, p_lat), 4326)))::int as dist_m
        from public.map_features
        where dataset = 'power_substation'
          and props->>'kv' ~ '^[0-9.]+$' and (props->>'kv')::float >= 50
        order by geom <-> st_setsrid(st_makepoint(p_lon, p_lat), 4326)
        limit 1
      ) x),
    'nearest_tec', (
      select to_jsonb(x) from (
        select name, props->>'mw' as mw, props->>'status' as status,
               props->>'plant' as plant,
               round(st_distancesphere(geom,
                 st_setsrid(st_makepoint(p_lon, p_lat), 4326)))::int as dist_m
        from public.map_features
        where dataset = 'tec_register'
        order by geom <-> st_setsrid(st_makepoint(p_lon, p_lat), 4326)
        limit 1
      ) x),
    'brownfield_nearby', (
      select count(*) from public.brownfield
      where area is not null
        and area::geometry && st_expand(st_setsrid(st_makepoint(p_lon, p_lat), 4326), 0.012)
        and st_dwithin(area, st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography, 800)
    )
  );
$function$;
