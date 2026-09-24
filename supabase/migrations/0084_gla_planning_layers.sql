-- 0084 · London Plan designations from the GLA planning data map.
--
-- Three map layers the London sites sifter also tests against:
--
--   gla_opportunity_area  London Plan Opportunity Areas (layer 103) — London's
--                         main brownfield growth locations, each with an
--                         indicative homes/jobs capacity and a planning
--                         framework (OAPF / AAP / SPD).
--   gla_sil               Strategic Industrial Locations (layer 206) — the
--                         London Plan protects these for industrial and
--                         logistics use (Policy E5); residential and office
--                         schemes inside them face a strong presumption against.
--   gla_mol               Metropolitan Open Land (layer 211) — given the same
--                         protection as Green Belt (Policy G3).
--
-- Source: GLA planning data map, gis.london.gov.uk ArcGIS service
-- apps/planning_data_map_02 (London Datastore, OGL v2). Boroughs define the
-- boundaries; the GLA compiles them.
--
-- load_gla_planning_layer() pulls a layer straight from the service as
-- WGS84 GeoJSON through the http extension and replaces that dataset's rows
-- in map_features. Service role only. Refresh with:
--   select load_gla_planning_layer('gla_opportunity_area', 103);
--   select load_gla_planning_layer('gla_sil', 206);
--   select load_gla_planning_layer('gla_mol', 211);
-- then rebuild_london_sites('policy') to re-test the sites.

create or replace function public.load_gla_planning_layer(p_dataset text, p_layer int)
returns int
language plpgsql
set search_path = public, extensions
set statement_timeout = '10min'
as $$
declare
  j jsonb;
  n int;
begin
  if p_dataset !~ '^gla_[a-z_]+$' then
    raise exception 'dataset name must start with gla_: %', p_dataset;
  end if;
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '120000');
  select content::jsonb into j from extensions.http_get(
    'https://gis.london.gov.uk/arcgis/rest/services/apps/planning_data_map_02/MapServer/'
    || p_layer || '/query?where=1%3D1&outFields=*&outSR=4326&geometryPrecision=6&f=geojson');
  if j is null or jsonb_typeof(j->'features') <> 'array' or jsonb_array_length(j->'features') = 0 then
    raise exception 'GLA layer % returned no features', p_layer;
  end if;
  if coalesce((j->'properties'->>'exceededTransferLimit')::boolean, false) then
    raise exception 'GLA layer % exceeded the service record limit; page it', p_layer;
  end if;

  delete from map_features where dataset = p_dataset;

  insert into map_features (dataset, source_id, name, props, geom)
  select p_dataset,
         coalesce(nullif(p->>'layerreference', ''), 'obj') || ':' || coalesce(f->>'id', p->>'objectid'),
         nullif(trim(p->>'sitename'), ''),
         jsonb_strip_nulls(jsonb_build_object(
           'borough',    nullif(p->>'borough', ''),
           'hectares',   (nullif(p->>'hectares', ''))::numeric,
           'status',     nullif(p->>'status', ''),
           'type',       nullif(p->>'boroughdesignation', ''),
           'ref',        nullif(p->>'sitereference', ''),
           'doc_type',   nullif(regexp_replace(coalesce(p->>'extrainfo1', ''), '^Document type:\s*', ''), ''),
           'designated', nullif(regexp_replace(coalesce(p->>'extrainfo2', ''), '^London Plan designation year:\s*', ''), ''),
           'documents',  nullif(regexp_replace(coalesce(p->>'extrainfo3', ''), '^Relevant documents:\s*', ''), ''),
           'url',        nullif(p->>'source', ''))),
         st_multi(st_collectionextract(st_makevalid(
           st_setsrid(st_geomfromgeojson(f->>'geometry'), 4326)), 3))
  from jsonb_array_elements(j->'features') f,
       lateral (select f->'properties' p) q
  where jsonb_typeof(f->'geometry') = 'object';
  get diagnostics n = row_count;

  insert into dataset_meta (dataset, loaded_at, n_rows)
  values (p_dataset, now(), n)
  on conflict (dataset) do update set loaded_at = excluded.loaded_at, n_rows = excluded.n_rows;
  return n;
end $$;

revoke execute on function public.load_gla_planning_layer(text, int) from public, anon, authenticated;
grant execute on function public.load_gla_planning_layer(text, int) to service_role;

-- The London sites columns these layers feed (0083 declares them too; this
-- covers a database that ran an earlier 0083).
alter table public.london_sites add column if not exists in_oa  boolean;
alter table public.london_sites add column if not exists oa_name text;
alter table public.london_sites add column if not exists in_sil boolean;
alter table public.london_sites add column if not exists in_mol boolean;
