-- 0025_size_columns.sql
-- Post-incident fix (2026-07-24): the national-scale bbox RPCs ranked and
-- filtered by st_area(geom) computed AT QUERY TIME over every row in the
-- viewport — cheap at station-clip scale, but over 741k national flood
-- polygons a regional pan meant tens of thousands of st_area() calls per
-- request. Queries stacked up past the statement timeout and starved the
-- connection pool (the 12:49 UTC error burst).
--
-- Fix: STORED GENERATED size columns (auto-maintained on every insert/update,
-- so the loaders never need to know) + composite indexes, and the RPCs
-- rewritten to use them. The ADD COLUMN rewrites each table once — run this
-- when the database is quiet.

alter table public.planning_constraints
  add column if not exists area_deg2 double precision
  generated always as (st_area(geom)) stored;
create index if not exists planning_constraints_kind_area_idx
  on public.planning_constraints (kind, area_deg2 desc);

alter table public.map_features
  add column if not exists size_metric double precision
  generated always as (st_area(geom) + st_length(geom)) stored;
create index if not exists map_features_dataset_size_idx
  on public.map_features (dataset, size_metric desc);

alter table public.land_ownership
  add column if not exists area_deg2 double precision
  generated always as (st_area(geom)) stored;
create index if not exists land_ownership_body_area_idx
  on public.land_ownership (body, area_deg2 desc);

alter table public.brownfield
  add column if not exists area_deg2 double precision
  generated always as (st_area(area::geometry)) stored;
create index if not exists brownfield_area_idx
  on public.brownfield (area_deg2 desc);

-- RPCs: same signatures, but every st_area()/st_length() in WHERE and ORDER BY
-- becomes a column reference the indexes can serve.

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
                then st_makevalid(st_simplifypreservetopology(geom, (select t from tol)))
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
                then st_makevalid(st_simplifypreservetopology(area::geometry, (select t from tol)))
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
                  then st_makevalid(st_simplifypreservetopology(lo.geom, (select t from tol)))
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

create or replace function public.features_in_bbox(
  p_dataset text, w double precision, s double precision,
  e double precision, n double precision,
  lim integer default 4000, p_zoom double precision default null,
  p_num_key text default null, p_num_min double precision default null)
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
    order by size_metric desc
    limit lim
  ) f
  where f.g is not null and not st_isempty(f.g);
$function$;
