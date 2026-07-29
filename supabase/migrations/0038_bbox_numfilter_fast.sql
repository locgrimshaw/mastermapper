-- 0038_bbox_numfilter_fast.sql
-- features_in_bbox spent more time validating numbers than fetching them.
-- The numeric prop filter ran a REGEX per row per bound (twice), so a dense
-- dataset (building_height: 1.5M points, ~12k in a city bbox) cost ~1.5 s
-- where the same rows serialise in ~0.2 s.
--
-- Two fixes, both dataset-agnostic:
--   1. jsonb_typeof(props->key) = 'number' short-circuits the regex — the
--      loader writes real JSON numbers, so the regex is now the FALLBACK for
--      string-typed values (kv, voltage) rather than the default path.
--   2. the value is extracted ONCE into a subquery column and both bounds
--      filter on that, instead of re-parsing per bound.
-- Behaviour is unchanged: non-numeric values still fail the min bound and
-- still pass the max bound (so "no value" never hides a feature at close
-- zooms), and the geometry/simplify logic is untouched.

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
      select dataset, name, props, g
      from (
        select dataset, name, props, size_metric,
               case when $7 >= 0.003
                         and geometrytype(geom_simple) not in ('POINT','MULTIPOINT')
                    then st_simplify(geom_simple, $7)
                    when $7 > 0
                         and geometrytype(geom_simple) not in ('POINT','MULTIPOINT')
                    then st_simplifypreservetopology(geom, $7)
                    else geom end as g,
               -- One extraction per row: cheap type check first, regex only
               -- for string-typed numerics.
               case when $9::text is null then null
                    when jsonb_typeof(props -> $9) = 'number'
                         then (props ->> $9)::double precision
                    when props ->> $9 ~ '^-?[0-9]+(\.[0-9]+)?$'
                         then (props ->> $9)::double precision
               end as numval
        from public.map_features
        where dataset = $1
          and geom && st_makeenvelope($2, $3, $4, $5, 4326)
          and (geometrytype(geom_simple) in ('POINT','MULTIPOINT','LINESTRING','MULTILINESTRING')
               or size_metric > $8)
      ) q
      where ($9::text is null or $10::double precision is null or numval >= $10)
        and ($9::text is null or $11::double precision is null
             or numval < $11 or numval is null)
      order by size_metric desc
      limit $6
    ) f
    where f.g is not null and not st_isempty(f.g)
  $q$ into res using p_dataset, w, s, e, n, lim, t, thr, p_num_key, p_num_min, p_num_max;
  return res;
end $function$;
alter function public.features_in_bbox(text, double precision, double precision,
  double precision, double precision, integer, double precision, text,
  double precision, double precision) set plan_cache_mode = force_custom_plan;
grant execute on function public.features_in_bbox(text, double precision, double precision,
  double precision, double precision, integer, double precision, text,
  double precision, double precision) to anon, authenticated;
