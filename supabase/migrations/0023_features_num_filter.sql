-- 0023_features_num_filter.sql
-- Optional numeric prop filter for features_in_bbox, so dense datasets can be
-- thinned MEANINGFULLY at wide zooms instead of arbitrarily by the row cap:
-- e.g. power lines pass p_num_key='kv', p_num_min=200 at a national view
-- (400/275 kV backbone only) and drop the filter when zoomed in. Works for
-- any numeric prop (kv, mw, ...). Rows lacking the key are excluded while the
-- filter is active — untagged minor features are exactly the ones to hide.
-- The old 7-arg signature is dropped so PostgREST dispatch stays unambiguous;
-- callers not passing the new args keep working via defaults.

drop function if exists public.features_in_bbox(text, double precision, double precision, double precision, double precision, integer, double precision);

create function public.features_in_bbox(
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
           or st_area(geom) > 4 * (select t from tol) * (select t from tol))
      -- Numeric prop floor (safe cast: non-numeric strings never match).
      and (p_num_key is null or p_num_min is null
           or (case when props->>p_num_key ~ '^-?[0-9]+(\.[0-9]+)?$'
                    then (props->>p_num_key)::double precision end) >= p_num_min)
    order by st_area(geom) + st_length(geom) desc
    limit lim
  ) f
  where f.g is not null and not st_isempty(f.g);
$function$;

grant execute on function public.features_in_bbox(text, double precision, double precision, double precision, double precision, integer, double precision, text, double precision) to anon, authenticated;
