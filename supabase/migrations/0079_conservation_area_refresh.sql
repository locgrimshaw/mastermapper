-- 0079_conservation_area_refresh.sql
--
-- Conservation-area completeness fix (audit 2026-09-09): 20 of 296 English
-- authorities — Sevenoaks, Tunbridge Wells, Windsor & Maidenhead, Wokingham,
-- Solihull, Wakefield among them — had ZERO conservation areas, because the
-- planning.data.gov.uk conservation-area dataset is LPA-fed and incomplete.
--
-- LESSON BAKED IN HERE: do NOT refresh this kind from the planning.data
-- ENTITY API (entity.geojson). It serves polygons for far fewer entities
-- than the bulk dataset file — a trial reload from it dropped Norwich from
-- 34 conservation areas to 2 and opened new holes (Kensington & Chelsea,
-- Enfield, Maidstone...). The canonical refresh is the "Load planning
-- constraints" GitHub workflow with kinds=conservation_area, which downloads
-- the full bulk file (files.planning.data.gov.uk/dataset/conservation-area
-- .geojson) and replaces the kind wholesale.
--
-- What this migration keeps is the SUPPLEMENT: after a bulk reload, add
-- Historic England's compiled national dataset (their open ArcGIS service,
-- ~8.2k areas, "indicative not definitive") wherever an HE polygon is not
-- already >50%-covered by loaded rows, so the two partial LPA-fed sources
-- patch each other's holes. props.src = 'historic_england' marks the added
-- rows; run it page by page (docs/MANUAL_TASKS.md):
--   select public.conservation_he_page_n(0, 1000);    -- then 1000, 2000, ...
--   ...until it returns -1. Smaller p_n for pages that time out.

create or replace function public.conservation_he_page_n(p_off integer, p_n integer)
returns integer language plpgsql as $$
declare resp text; page jsonb; got integer;
begin
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '45000');
  select content into resp from extensions.http_get(
    'https://services-eu1.arcgis.com/ZOdPfBS3aqqDYPUQ/arcgis/rest/services/'
    || 'Conservation_Areas/FeatureServer/0/query?where=1%3D1'
    || '&outFields=UID,NAME,LPA,DATE_OF_DE&outSR=4326&f=geojson'
    || '&orderByFields=OBJECTID&resultRecordCount=' || p_n || '&resultOffset=' || p_off);
  page := (resp::jsonb)->'features';
  if coalesce(jsonb_array_length(page), 0) = 0 then return -1; end if;
  insert into public.planning_constraints (kind, source_id, name, props, geom)
  select 'conservation_area',
         'he-' || (c.f->'properties'->>'UID'),
         c.f->'properties'->>'NAME',
         jsonb_build_object('uid', c.f->'properties'->>'UID',
                            'lpa', c.f->'properties'->>'LPA',
                            'designated', c.f->'properties'->>'DATE_OF_DE',
                            'src', 'historic_england'),
         c.g
    from (
      select f, st_multi(st_collectionextract(st_makevalid(st_setsrid(st_geomfromgeojson(f->'geometry'), 4326)), 3)) as g
        from jsonb_array_elements(page) f
       where f->'geometry' is not null
    ) c
   where st_area(c.g) > 0
     and coalesce((
       select sum(st_area(st_intersection(e.geom, c.g)))
         from public.planning_constraints e
        where e.kind = 'conservation_area' and e.geom && c.g
          and st_intersects(e.geom, c.g)
     ), 0) < 0.5 * st_area(c.g)
  on conflict do nothing;
  get diagnostics got = row_count;
  return got;
end $$;
revoke execute on function public.conservation_he_page_n(integer, integer)
  from public, anon, authenticated;

-- The entity-API loaders from the trial are dropped — see the lesson above.
drop function if exists public.refresh_conservation_areas_pd();
drop function if exists public.supplement_conservation_areas_he();
drop function if exists public.conservation_pd_page(integer, boolean);
drop function if exists public.conservation_he_page(integer);
