-- 0022_map_features.sql
-- Generic dataset store for the Data layers roadmap (docs/DATA_LAYERS_ROADMAP.md).
--
-- One table holds every "display" dataset (planning.data.gov.uk sweep,
-- university campuses, PTAL, OSM power network, NESO GSP boundaries, TEC
-- register points, DNO headroom, rents, ALC, water availability, ...), keyed
-- by (dataset, source_id). One RPC serves any of them by viewport bbox with
-- the same zoom-aware simplification as the constraint layers, so adding a
-- dataset needs NO new SQL — just pipeline rows + a frontend registry entry.

create table if not exists public.map_features (
  dataset   text not null,
  source_id text not null,
  name      text,
  props     jsonb not null default '{}'::jsonb,
  geom      geometry(Geometry, 4326) not null,
  primary key (dataset, source_id)
);

create index if not exists map_features_geom_gix on public.map_features using gist (geom);
create index if not exists map_features_dataset_idx on public.map_features (dataset);

alter table public.map_features enable row level security;
do $$ begin
  create policy map_features_read on public.map_features for select using (true);
exception when duplicate_object then null; end $$;
grant select on public.map_features to anon, authenticated;

-- Viewport fetch. Lines/polygons are simplified to ~1px and sub-2px² polygons
-- dropped when p_zoom is given; points always pass through (they're cheap and
-- capping them by "area" would be meaningless — they're capped by lim only).
create or replace function public.features_in_bbox(
  p_dataset text, w double precision, s double precision,
  e double precision, n double precision,
  lim integer default 4000, p_zoom double precision default null)
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
    -- Lines have zero area: rank by area + length so line datasets (power
    -- lines, boundaries) keep their longest/biggest features under the cap.
    order by st_area(geom) + st_length(geom) desc
    limit lim
  ) f
  where f.g is not null and not st_isempty(f.g);
$function$;

grant execute on function public.features_in_bbox(text, double precision, double precision, double precision, double precision, integer, double precision) to anon, authenticated;
