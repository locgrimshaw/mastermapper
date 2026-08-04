-- 0043_dataset_features_page.sql
-- Stream one dataset out of map_features as GeoJSON Features, in keyset pages,
-- so a tile build can read the whole thing without a database password.
--
-- WHY. PTAL is a 100 m grid over London: 159,451 cells. Serving it per viewport
-- from Postgres does not work at a London-wide zoom — measured, the z12
-- viewport is 52,301 cells, 14 MB and 20.8 seconds, and it is not the geometry
-- simplification (the same query without simplify takes the same 20.8 s), it is
-- ~400 us per feature spent assembling the JSON. No row cap fixes that. So PTAL
-- moves to PMTiles, the route buildings (1.5M) and parcels (26M) already take,
-- and this is how the tile build reads the source rows.
--
-- KEYSET, not OFFSET: paging 159k rows with OFFSET re-scans from the start on
-- every page. The primary key is (dataset, source_id), so "where dataset = ?
-- and source_id > ? order by source_id" walks the index once across the whole
-- export.
--
-- p_props trims the properties to just the keys the map needs. That matters
-- more than it looks: tippecanoe can only coalesce adjacent features when their
-- attributes are IDENTICAL, and PTAL carries a unique float ('ai') per cell
-- that would block every merge. Dropping it lets neighbouring same-grade cells
-- combine into one polygon.

create or replace function public.dataset_features_page(
  p_dataset text,
  p_limit integer default 5000,
  p_after text default null,
  p_props text[] default null)
returns jsonb
language sql stable as $function$
  -- Returns {features: [...], last: "<source_id>"}. `last` is what the caller
  -- passes back as p_after: without it the client has no cursor, because
  -- source_id is deliberately NOT copied into each feature's properties (it
  -- would be dead weight in every tile, and would block coalescing).
  select jsonb_build_object(
    'features', coalesce(jsonb_agg(jsonb_build_object(
        'type', 'Feature',
        'properties', case
          when p_props is null then f.props
          else (select coalesce(jsonb_object_agg(k, f.props -> k), '{}'::jsonb)
                  from unnest(p_props) k where f.props ? k)
        end,
        'geometry', st_asgeojson(f.geom, 6)::jsonb)
      order by f.source_id), '[]'::jsonb),
    'last', max(f.source_id))
  from (
    select source_id, props, geom
    from public.map_features
    where dataset = p_dataset
      and (p_after is null or source_id > p_after)
    order by source_id
    limit greatest(1, least(p_limit, 20000))
  ) f;
$function$;

-- Read-only, but it is an export path rather than a map query: the tile build
-- authenticates with the service key.
revoke all on function public.dataset_features_page(text, integer, text, text[]) from public;
revoke all on function public.dataset_features_page(text, integer, text, text[]) from anon;
revoke all on function public.dataset_features_page(text, integer, text, text[]) from authenticated;
grant execute on function public.dataset_features_page(text, integer, text, text[]) to service_role;
