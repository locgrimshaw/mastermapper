-- 0021_national_bbox_rpcs.sql
-- Country-wide data support for the viewport overlay RPCs.
--
-- The DB now holds NATIONAL layers (CLIP_MODE=none pipeline builds), so the
-- bbox RPCs must stay fast when the viewport is a whole region or country:
--   1. an optional p_zoom argument: when set, geometry is simplified to
--      ~1 screen pixel (ST_SimplifyPreserveTopology) before serialising;
--   2. sub-pixel features are dropped entirely at low zoom (a listed building
--      polygon at zoom 7 is invisible anyway);
--   3. results are ordered biggest-first so the row cap keeps what reads.
-- All params added with defaults, and the old signatures DROPPED (not
-- overloaded) so PostgREST dispatch stays unambiguous; already-deployed
-- frontends that don't pass p_zoom keep working via the default.

-- Degrees-per-pixel at a web-mercator zoom (256px tiles): 360 / (256 * 2^z).
create or replace function public._px_deg(p_zoom double precision)
returns double precision language sql immutable as $$
  select case when p_zoom is null then 0.0
              else 360.0 / (256.0 * power(2.0, p_zoom)) end;
$$;

drop function if exists public.constraints_in_bbox(text[], double precision, double precision, double precision, double precision, integer);

create function public.constraints_in_bbox(
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
      -- Drop features smaller than ~2px² once a zoom is supplied.
      and ((select t from tol) = 0
           or st_area(geom) > 4 * (select t from tol) * (select t from tol))
    order by st_area(geom) desc
    limit lim
  ) c
  where c.g is not null and not st_isempty(c.g);
$function$;

drop function if exists public.brownfield_in_bbox(double precision, double precision, double precision, double precision, integer);

create function public.brownfield_in_bbox(
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
    -- brownfield.area is GEOGRAPHY: cast to geometry for the planar
    -- simplify/area maths (st_area(geography) is m², not deg²).
    select name, dwellings_max,
           case when (select t from tol) > 0
                then st_makevalid(st_simplifypreservetopology(area::geometry, (select t from tol)))
                else area::geometry end as g
    from public.brownfield
    where area is not null and area::geometry && st_makeenvelope(w, s, e, n, 4326)
      and ((select t from tol) = 0
           or st_area(area::geometry) > 4 * (select t from tol) * (select t from tol))
    order by st_area(area::geometry) desc
    limit lim
  ) b
  where b.g is not null and not st_isempty(b.g);
$function$;

drop function if exists public.land_ownership_in_bbox(text[], double precision, double precision, double precision, double precision);

create function public.land_ownership_in_bbox(
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
             or st_area(lo.geom) > 4 * (select t from tol) * (select t from tol))
      order by st_area(lo.geom) desc
      limit lim
    ) q
    where q.g is not null and not st_isempty(q.g)
  ) f;
$function$;

grant execute on function public._px_deg(double precision) to anon, authenticated;
grant execute on function public.constraints_in_bbox(text[], double precision, double precision, double precision, double precision, integer, double precision) to anon, authenticated;
grant execute on function public.brownfield_in_bbox(double precision, double precision, double precision, double precision, integer, double precision) to anon, authenticated;
grant execute on function public.land_ownership_in_bbox(text[], double precision, double precision, double precision, double precision, integer, double precision) to anon, authenticated;
