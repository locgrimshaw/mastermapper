-- 0028_perf_hardening.sql
-- The 2026-07-24 "constant errs" audit. Applied live during the session;
-- recorded here so the repo matches the database. Four findings:
--
-- 1. The anon role (the public map) ran with statement_timeout=3s while the
--    heavier viewport queries legitimately take 1-3s — every tail-latency
--    request died as an error. 15s gives honest headroom.
--
-- 2. planning_constraints (971 MB) had NEVER been analyzed — the planner had
--    no statistics for the biggest table in the system.
--
-- 3. planning_constraints lacked the stored pre-simplified geometry that
--    map_features got in 0027. At wide zooms the biggest-first ordering
--    selects exactly the most vertex-heavy polygons, and re-simplifying them
--    from raw detail ran to tens of seconds for regional flood fetches.
--
-- 4. THE BIG ONE: the viewport RPCs were LANGUAGE SQL, whose parameterized
--    plans could not use the (kind, area_deg2) index bound — a regional
--    flood fetch walked all 215k flood rows detoasting every geometry (51s).
--    The same query with literal values: ~50ms. Rewritten as plpgsql with
--    EXECUTE ... USING, which builds a one-shot custom plan from the REAL
--    argument values on every call. The "no zoom" escape is folded into a
--    single threshold value (thr = -1 passes everything) instead of an OR,
--    which would also have defeated the index.

alter role anon set statement_timeout = '15s';

analyze public.planning_constraints;
analyze public.map_features;
analyze public.land_ownership;
analyze public.brownfield;
analyze public.station_links;
analyze public.stations;

alter table public.planning_constraints
  add column if not exists geom_simple geometry
  generated always as (
    case when st_npoints(geom) > 512
         then st_makevalid(st_simplifypreservetopology(geom, 0.003))
         else geom end) stored;

create or replace function public.constraints_in_bbox(
  p_kinds text[], w double precision, s double precision,
  e double precision, n double precision,
  lim integer default 1500, p_zoom double precision default null)
returns jsonb language plpgsql stable as $function$
declare
  t double precision := coalesce(public._px_deg(p_zoom), 0);
  thr double precision;
  res jsonb;
begin
  thr := case when t > 0 then 4 * t * t else -1 end;
  execute $q$
    select jsonb_build_object(
        'type', 'FeatureCollection',
        'features', coalesce(jsonb_agg(jsonb_build_object(
          'type', 'Feature',
          'properties', jsonb_build_object('kind', c.kind, 'name', c.name),
          'geometry', st_asgeojson(c.g, 6)::jsonb)), '[]'::jsonb))
    from (
      select s2.kind, s2.name,
             case when $7 >= 0.003 then st_simplify(s2.geom_simple, $7)
                  when $7 > 0 then st_simplifypreservetopology(s2.geom, $7)
                  else s2.geom end as g
      from unnest($1) as k(kind)
      cross join lateral (
        select pc.kind, pc.name, pc.geom, pc.geom_simple, pc.area_deg2
        from public.planning_constraints pc
        where pc.kind = k.kind
          and pc.area_deg2 > $8
          and pc.geom && st_makeenvelope($2, $3, $4, $5, 4326)
        order by pc.area_deg2 desc
        limit $6
      ) s2
      order by s2.area_deg2 desc
      limit $6
    ) c
    where c.g is not null and not st_isempty(c.g)
  $q$ into res using p_kinds, w, s, e, n, lim, t, thr;
  return res;
end $function$;

create or replace function public.features_in_bbox(
  p_dataset text, w double precision, s double precision,
  e double precision, n double precision,
  lim integer default 4000, p_zoom double precision default null,
  p_num_key text default null, p_num_min double precision default null,
  p_num_max double precision default null)
returns jsonb language plpgsql stable as $function$
declare
  t double precision := coalesce(public._px_deg(p_zoom), 0);
  thr double precision;
  res jsonb;
begin
  thr := case when t > 0 then 4 * t * t else -1 end;
  execute $q$
    select jsonb_build_object(
        'type', 'FeatureCollection',
        'features', coalesce(jsonb_agg(jsonb_build_object(
          'type', 'Feature',
          'properties', f.props || jsonb_build_object('name', f.name, 'dataset', f.dataset),
          'geometry', st_asgeojson(f.g, 6)::jsonb)), '[]'::jsonb))
    from (
      select dataset, name, props,
             case when $7 >= 0.003
                       and geometrytype(geom_simple) not in ('POINT','MULTIPOINT')
                  then st_simplify(geom_simple, $7)
                  when $7 > 0
                       and geometrytype(geom_simple) not in ('POINT','MULTIPOINT')
                  then st_simplifypreservetopology(geom, $7)
                  else geom end as g
      from public.map_features
      where dataset = $1
        and geom && st_makeenvelope($2, $3, $4, $5, 4326)
        and (geometrytype(geom_simple) in ('POINT','MULTIPOINT','LINESTRING','MULTILINESTRING')
             or size_metric > $8)
        and ($9::text is null or $10::double precision is null
             or (case when props->>$9 ~ '^-?[0-9]+(\.[0-9]+)?$'
                      then (props->>$9)::double precision end) >= $10)
        and ($9::text is null or $11::double precision is null
             or (case when props->>$9 ~ '^-?[0-9]+(\.[0-9]+)?$'
                      then (props->>$9)::double precision end) < $11
             or not (props->>$9 ~ '^-?[0-9]+(\.[0-9]+)?$'))
      order by size_metric desc
      limit $6
    ) f
    where f.g is not null and not st_isempty(f.g)
  $q$ into res using p_dataset, w, s, e, n, lim, t, thr, p_num_key, p_num_min, p_num_max;
  return res;
end $function$;
