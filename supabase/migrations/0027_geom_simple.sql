-- 0027_geom_simple.sql
-- Wide-zoom fetches over map_features datasets with huge polygons (ALC grades
-- run to 23k vertices each) spent ~4.5s per request re-simplifying the same
-- geometry from scratch. Store a pre-simplified copy (auto-maintained, like
-- 0025's size columns) and have features_in_bbox start from it whenever the
-- requested tolerance is at least as coarse as the stored one — simplifying
-- an already-simple geometry further is cheap.

alter table public.map_features
  add column if not exists geom_simple geometry
  generated always as (
    case when st_npoints(geom) > 512
         then st_makevalid(st_simplifypreservetopology(geom, 0.003))
         else geom end) stored;

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
           -- NO st_makevalid here: it was ~85% of query time (2.5s -> 0.4s for
           -- a wide ALC fetch) and the output only feeds MapLibre rendering,
           -- which doesn't require strict OGC validity. Geometry is validated
           -- once at ingestion (and in geom_simple's generation) instead.
           case when (select t from tol) > 0
                     and geometrytype(geom) not in ('POINT','MULTIPOINT')
                then st_simplifypreservetopology(
                       case when (select t from tol) >= 0.003 then geom_simple else geom end,
                       (select t from tol))
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

-- Same st_makevalid removal for the other three viewport RPCs (0025 shipped
-- them with it) — display-only output, validity guaranteed at ingestion.

create or replace function public.constraints_in_bbox(
  p_kinds text[], w double precision, s double precision,
  e double precision, n double precision,
  lim integer default 1500, p_zoom double precision default null)
returns jsonb language sql stable as $function$
  with tol as (select public._px_deg(p_zoom) as t)
  select jsonb_build_object(
      'type', 'FeatureCollection',
      'features', coalesce(jsonb_agg(jsonb_build_object(
        'type', 'Feature',
        'properties', jsonb_build_object('kind', c.kind, 'name', c.name),
        'geometry', st_asgeojson(c.g, 6)::jsonb)), '[]'::jsonb))
  from (
    select kind, name,
           case when (select t from tol) > 0
                then st_simplifypreservetopology(geom, (select t from tol))
                else geom end as g
    from public.planning_constraints
    where kind = any(p_kinds)
      and geom && st_makeenvelope(w, s, e, n, 4326)
      and ((select t from tol) = 0
           or area_deg2 > 4 * (select t from tol) * (select t from tol))
    order by area_deg2 desc
    limit lim
  ) c
  where c.g is not null and not st_isempty(c.g);
$function$;

create or replace function public.brownfield_in_bbox(
  w double precision, s double precision, e double precision, n double precision,
  lim integer default 1500, p_zoom double precision default null)
returns jsonb language sql stable as $function$
  with tol as (select public._px_deg(p_zoom) as t)
  select jsonb_build_object(
      'type', 'FeatureCollection',
      'features', coalesce(jsonb_agg(jsonb_build_object(
        'type', 'Feature',
        'properties', jsonb_build_object('kind', 'brownfield', 'name', b.name,
                                         'dwellings_max', b.dwellings_max),
        'geometry', st_asgeojson(b.g, 6)::jsonb)), '[]'::jsonb))
  from (
    select name, dwellings_max,
           case when (select t from tol) > 0
                then st_simplifypreservetopology(area::geometry, (select t from tol))
                else area::geometry end as g
    from public.brownfield
    where area is not null and area::geometry && st_makeenvelope(w, s, e, n, 4326)
      and ((select t from tol) = 0
           or area_deg2 > 4 * (select t from tol) * (select t from tol))
    order by area_deg2 desc
    limit lim
  ) b
  where b.g is not null and not st_isempty(b.g);
$function$;

create or replace function public.land_ownership_in_bbox(
  p_bodies text[], w double precision, s double precision,
  e double precision, n double precision,
  lim integer default 3000, p_zoom double precision default null)
returns jsonb language sql stable as $function$
  with tol as (select public._px_deg(p_zoom) as t)
  select jsonb_build_object('type','FeatureCollection','features',
                            coalesce(jsonb_agg(feat), '[]'::jsonb))
  from (
    select jsonb_build_object('type','Feature',
             'properties', jsonb_build_object('body', q.body, 'owner_name', q.owner_name),
             'geometry', st_asgeojson(q.g, 6)::jsonb) as feat
    from (
      select lo.body, lo.owner_name,
             case when (select t from tol) > 0
                  then st_simplifypreservetopology(lo.geom, (select t from tol))
                  else lo.geom end as g
      from public.land_ownership lo
      where lo.geom && st_makeenvelope(w, s, e, n, 4326)
        and (p_bodies is null or lo.body = any(p_bodies))
        and ((select t from tol) = 0
             or lo.area_deg2 > 4 * (select t from tol) * (select t from tol))
      order by lo.area_deg2 desc
      limit lim
    ) q
    where q.g is not null and not st_isempty(q.g)
  ) f;
$function$;
