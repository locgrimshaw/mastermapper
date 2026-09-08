-- 0076_he_land.sql
--
-- Homes England Land Hub sites: the agency's land being marketed or prepared
-- for disposal — name, authority, acreage, disposal route, proposed use,
-- marketing status, housing capacity and planning status, with boundary
-- polygons. Fetched server-side straight from Homes England's public ArcGIS
-- FeatureServer via the http extension (~98 sites, one page), served as the
-- ordinary 'he_land' map_features dataset. Refresh = one function call
-- (docs/MANUAL_TASKS.md); the Land Hub updates as sites come to market.
create or replace function public.rebuild_he_land()
returns integer language plpgsql as $$
declare resp text; j jsonb; n integer;
begin
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '120000');
  select content into resp from extensions.http_get(
    'https://services-eu1.arcgis.com/yo0w4PgP4XL49bfF/arcgis/rest/services/Homes_England_Land_Hub_Sites/FeatureServer/0/query?where=1%3D1&outFields=Parcel_Name,Local_Authority,Postcode,Gross_Area__Acres_,Disposal_Route,Proposed_Use,Marketing_Status,Housing_Capacity,Planning_Status,Site_Reference&outSR=4326&f=geojson');
  j := resp::jsonb;
  delete from public.map_features where dataset = 'he_land';
  insert into public.map_features (dataset, source_id, name, props, geom)
  select 'he_land',
         coalesce(f->'properties'->>'Site_Reference', (f->>'id')),
         f->'properties'->>'Parcel_Name',
         jsonb_build_object(
           'authority', f->'properties'->>'Local_Authority',
           'postcode', f->'properties'->>'Postcode',
           'acres', (f->'properties'->>'Gross_Area__Acres_'),
           'ha', round(((f->'properties'->>'Gross_Area__Acres_')::numeric * 0.404686), 1),
           'route', f->'properties'->>'Disposal_Route',
           'use', f->'properties'->>'Proposed_Use',
           'status', f->'properties'->>'Marketing_Status',
           'capacity', f->'properties'->>'Housing_Capacity',
           'planning', f->'properties'->>'Planning_Status'),
         st_multi(st_makevalid(st_setsrid(st_geomfromgeojson(f->'geometry'), 4326)))
    from jsonb_array_elements(j->'features') f
   where f->'geometry' is not null
  on conflict (dataset, source_id) do nothing;
  get diagnostics n = row_count;
  analyze public.map_features;
  return n;
end $$;
revoke execute on function public.rebuild_he_land()
  from public, anon, authenticated;
