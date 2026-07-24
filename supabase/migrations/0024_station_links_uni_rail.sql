-- 0024_station_links_uni_rail.sql
-- Rail-based PBSA sift plumbing (docs/PLAN_SIFT_PBSA.md):
--   station_links    — direct scheduled station-to-station services parsed
--                      from the National Rail CIF timetable (median journey
--                      minutes + weekday direct trains). Loaded by
--                      supabase/loaders/load_station_links.py via the
--                      load-rail-links.yml workflow (needs NR credentials).
--   uni_rail_access  — for one university (map_features uni_campus by UKPRN):
--                      its GATEWAY stations (walkable to a campus) and its
--                      FEEDER stations (direct service into a gateway), as one
--                      JSON payload the PBSA sift box renders.

create table if not exists public.station_links (
  crs_from   text not null,
  crs_to     text not null,
  minutes    real,
  trains_day integer,
  primary key (crs_from, crs_to)
);
create index if not exists station_links_to_idx on public.station_links (crs_to);
alter table public.station_links enable row level security;
do $$ begin
  create policy station_links_read on public.station_links for select using (true);
exception when duplicate_object then null; end $$;
grant select on public.station_links to anon, authenticated;

create or replace function public.uni_rail_access(
  p_ukprn text, p_gateway_m integer default 1500)
returns jsonb language sql stable as $function$
with uni as (
  select name, geom, props
  from public.map_features
  where dataset = 'uni_campus' and props->>'ukprn' = p_ukprn
  limit 1
),
-- The institution's physical footprint: the HQ point plus OSM campus polygons
-- near it (distance association; name/operator matching is a later
-- refinement — in dense areas a neighbouring university's campus can slip in).
campus_geoms as (
  select geom from uni
  union all
  select mf.geom
  from public.map_features mf, uni
  where mf.dataset = 'uni_campus_site'
    and st_dwithin(mf.geom::geography, uni.geom::geography, 3000)
),
gws as (
  select s.crs, s.name, s.lng, s.lat,
         min(st_distance(st_setsrid(st_makepoint(s.lng, s.lat), 4326)::geography,
                         cg.geom::geography))::int as walk_m
  from public.stations s
  join campus_geoms cg
    on st_dwithin(st_setsrid(st_makepoint(s.lng, s.lat), 4326)::geography,
                  cg.geom::geography, p_gateway_m)
  group by s.crs, s.name, s.lng, s.lat
),
feeders as (
  select distinct on (l.crs_from)
         l.crs_from as crs, fs.name, fs.lng, fs.lat,
         l.minutes, l.trains_day, l.crs_to as via_crs, fs.usage
  from public.station_links l
  join gws            on gws.crs = l.crs_to
  join public.stations fs on fs.crs = l.crs_from
  where l.crs_from not in (select crs from gws)
  order by l.crs_from, l.minutes asc nulls last
)
select jsonb_build_object(
  'university', (select jsonb_build_object(
      'name', name, 'ukprn', p_ukprn,
      'lng', st_x(geom), 'lat', st_y(geom), 'props', props) from uni),
  'gateways', coalesce(
      (select jsonb_agg(to_jsonb(g) order by g.walk_m) from gws g), '[]'::jsonb),
  'feeders', coalesce(
      (select jsonb_agg(to_jsonb(f) order by f.minutes nulls last) from feeders f),
      '[]'::jsonb),
  'links_loaded', exists(select 1 from public.station_links limit 1));
$function$;

grant execute on function public.uni_rail_access(text, integer) to anon, authenticated;
