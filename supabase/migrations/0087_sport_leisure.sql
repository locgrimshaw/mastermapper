-- 0087 · Sport & Leisure: stadium catchment analysis.
--
-- Datasets (map_features, loaded by pipeline/build_sport_leisure.py via
-- load-sport-leisure.yml): stadium, sports_facility, hotel, event_venue,
-- food_drink. All points; polygon features carry their area in props.
--
-- point_rail_access(lng, lat)   rail gateways within walking reach of any
--                                point and the stations feeding them (direct
--                                trains, scheduled minutes) — the generalised
--                                uni_rail_access behind the public-transport
--                                catchment.
-- stadium_catchment_summary(g, lng, lat)
--                                everything the stadium sidebar totals for a
--                                catchment polygon g (GeoJSON geometry):
--                                hotels/rooms/bedspaces, event venues and
--                                capacity, sports facilities and pitch area,
--                                other stadia, food & drink, transport nodes,
--                                parking and public land. Hotels and venues
--                                are ALSO banded by straight-line distance
--                                (1/3/5 km) so "in the vicinity" does not
--                                depend on the catchment mode.

create or replace function public.point_rail_access(
  p_lng double precision, p_lat double precision, p_gateway_m integer default 1500)
returns jsonb
language sql stable
set search_path = public, extensions
as $$
with o as (select st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography g),
gws as (
  select s.crs, s.name, s.lng, s.lat, s.usage,
         st_distance(st_setsrid(st_makepoint(s.lng, s.lat), 4326)::geography, o.g)::int as walk_m
  from stations s, o
  where st_dwithin(st_setsrid(st_makepoint(s.lng, s.lat), 4326)::geography, o.g, p_gateway_m)
),
feeders as (
  select distinct on (l.crs_from)
         l.crs_from as crs, fs.name, fs.lng, fs.lat,
         l.minutes, l.trains_day, l.crs_to as via_crs, fs.usage
  from station_links l
  join gws          on gws.crs = l.crs_to
  join stations fs  on fs.crs = l.crs_from
  where l.crs_from not in (select crs from gws)
  order by l.crs_from, l.minutes asc nulls last
)
select jsonb_build_object(
  'gateways', coalesce((select jsonb_agg(to_jsonb(g) order by g.walk_m) from gws g), '[]'::jsonb),
  'feeders',  coalesce((select jsonb_agg(to_jsonb(f) order by f.minutes nulls last) from feeders f), '[]'::jsonb),
  'links_loaded', exists (select 1 from station_links limit 1));
$$;

grant execute on function public.point_rail_access(double precision, double precision, integer) to anon, authenticated;


create or replace function public.stadium_catchment_summary(
  p_geom jsonb, p_lng double precision, p_lat double precision)
returns jsonb
language plpgsql stable
set search_path = public, extensions
set statement_timeout = '45s'
as $$
declare
  g  geometry := st_makevalid(st_setsrid(st_geomfromgeojson(p_geom::text), 4326));
  o  geography := st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography;
  r  jsonb := '{}'::jsonb;
begin
  -- hotels: in the catchment, plus distance bands from the stadium
  r := r || jsonb_build_object('hotels', (
    with h as (
      select m.name, m.props, st_distance(m.geom::geography, o)::int d,
             st_intersects(m.geom, g) inside
      from map_features m
      where m.dataset = 'hotel'
        and (m.geom && g or st_dwithin(m.geom::geography, o, 5000))
    )
    select jsonb_build_object(
      'n',      count(*) filter (where inside),
      'rooms',  coalesce(sum((props->>'rooms')::int) filter (where inside), 0),
      'beds',   coalesce(sum((props->>'beds')::int) filter (where inside), 0),
      'tagged', count(*) filter (where inside and props->>'rooms_src' = 'tagged'),
      'by_type', coalesce((select jsonb_object_agg(t, n) from (
          select props->>'type' t, count(*) n from h where inside group by 1) x), '{}'::jsonb),
      'by_stars', coalesce((select jsonb_object_agg(s, n) from (
          select coalesce(props->>'stars', 'unrated') s, count(*) n from h where inside group by 1) x), '{}'::jsonb),
      'bands', jsonb_build_object(
          '1000', jsonb_build_object('n', count(*) filter (where d <= 1000),
                                     'beds', coalesce(sum((props->>'beds')::int) filter (where d <= 1000), 0)),
          '3000', jsonb_build_object('n', count(*) filter (where d <= 3000),
                                     'beds', coalesce(sum((props->>'beds')::int) filter (where d <= 3000), 0)),
          '5000', jsonb_build_object('n', count(*) filter (where d <= 5000),
                                     'beds', coalesce(sum((props->>'beds')::int) filter (where d <= 5000), 0))),
      'top', coalesce((select jsonb_agg(x) from (
          select name, props->>'brand' brand, (props->>'rooms')::int rooms, props->>'rooms_src' src,
                 props->>'stars' stars, props->>'type' type, d dist_m
          from h where d <= 5000 order by (props->>'rooms')::int desc nulls last limit 12) x), '[]'::jsonb))
    from h));

  -- event & conference venues
  r := r || jsonb_build_object('venues', (
    with v as (
      select m.name, m.props, st_distance(m.geom::geography, o)::int d,
             st_intersects(m.geom, g) inside
      from map_features m
      where m.dataset = 'event_venue'
        and (m.geom && g or st_dwithin(m.geom::geography, o, 5000))
    )
    select jsonb_build_object(
      'n', count(*) filter (where inside),
      'cap_n', count(*) filter (where inside and props ? 'capacity'),
      'capacity', coalesce(sum((props->>'capacity')::int) filter (where inside), 0),
      'by_kind', coalesce((select jsonb_object_agg(k, jsonb_build_object('n', n, 'cap', c)) from (
          select props->>'kind' k, count(*) n, coalesce(sum((props->>'capacity')::int), 0) c
          from v where inside group by 1) x), '{}'::jsonb),
      'bands', jsonb_build_object(
          '1000', count(*) filter (where d <= 1000),
          '3000', count(*) filter (where d <= 3000),
          '5000', count(*) filter (where d <= 5000)),
      'top', coalesce((select jsonb_agg(x) from (
          select name, props->>'kind' kind, (props->>'capacity')::int capacity, d dist_m
          from v where d <= 5000
          order by (props->>'capacity')::int desc nulls last, d limit 12) x), '[]'::jsonb))
    from v));

  -- sports facilities in the catchment (pitches, tracks, centres, golf...)
  r := r || jsonb_build_object('sport', (
    with s as (
      select m.props from map_features m
      where m.dataset = 'sports_facility' and m.geom && g and st_intersects(m.geom, g)
    )
    select jsonb_build_object(
      'n', count(*),
      'area_ha', round(coalesce(sum((props->>'area_m2')::numeric), 0) / 1e4, 1),
      'by_kind', coalesce((select jsonb_object_agg(k, jsonb_build_object('n', n, 'ha', ha)) from (
          select props->>'kind' k, count(*) n,
                 round(coalesce(sum((props->>'area_m2')::numeric), 0) / 1e4, 1) ha
          from s group by 1) x), '{}'::jsonb),
      'by_sport', coalesce((select jsonb_agg(x) from (
          select coalesce(props->>'sport1', 'Unspecified') sport, count(*) n,
                 round(coalesce(sum((props->>'area_m2')::numeric), 0) / 1e4, 1) ha
          from s group by 1 order by 2 desc limit 10) x), '[]'::jsonb))
    from s));

  -- other stadia in the catchment
  r := r || jsonb_build_object('stadia', coalesce((select jsonb_agg(x) from (
    select m.name, (m.props->>'capacity')::int capacity, m.props->>'sport' sport,
           m.props->>'clubs' clubs, st_distance(m.geom::geography, o)::int dist_m
    from map_features m
    where m.dataset = 'stadium' and m.geom && g and st_intersects(m.geom, g)
      and not st_dwithin(m.geom::geography, o, 150)
    order by 5 limit 15) x), '[]'::jsonb));

  -- food & drink (the matchday economy)
  r := r || jsonb_build_object('food', coalesce((select jsonb_object_agg(k, n) from (
    select m.props->>'kind' k, count(*) n
    from map_features m
    where m.dataset = 'food_drink' and m.geom && g and st_intersects(m.geom, g)
    group by 1) x), '{}'::jsonb));

  -- transport nodes: rail stations within 2 km, bus service in the catchment,
  -- surface/multi-storey parking in the catchment
  r := r || jsonb_build_object('transport', jsonb_build_object(
    'stations', coalesce((select jsonb_agg(x) from (
        select s.crs, s.name, s.usage, s.sustained_tph,
               st_distance(st_setsrid(st_makepoint(s.lng, s.lat), 4326)::geography, o)::int dist_m
        from stations s
        where st_dwithin(st_setsrid(st_makepoint(s.lng, s.lat), 4326)::geography, o, 2000)
        order by 5 limit 8) x), '[]'::jsonb),
    'bus', (select jsonb_build_object(
        'stops', count(*),
        'served', count(*) filter (where coalesce((m.props->>'trips_day')::int, 0) > 0),
        'buses_hr', round(coalesce(sum((m.props->>'buses_hr')::numeric), 0)),
        'trips_day', coalesce(sum((m.props->>'trips_day')::int), 0))
      from map_features m
      where m.dataset = 'bus_stop' and m.geom && g and st_intersects(m.geom, g)),
    'parking', (select jsonb_build_object('n', count(*),
        'ha', round(coalesce(sum((m.props->>'area_m2')::numeric), 0) / 1e4, 1))
      from map_features m
      where m.dataset = 'osm_parking' and m.geom && g and st_intersects(m.geom, g))));

  -- land: publicly owned parcels and council property records, benchmark
  -- residential land value for the authority the stadium sits in
  r := r || jsonb_build_object('land', jsonb_build_object(
    'public_parcels', (select jsonb_build_object('n', count(*),
        'ha', round(coalesce(sum((m.props->>'area_m2')::numeric), 0) / 1e4, 1),
        'by_class', coalesce((select jsonb_object_agg(c, n) from (
            select coalesce(m2.props->>'owner_class', 'other') c, count(*) n
            from map_features m2
            where m2.dataset = 'public_parcel' and m2.geom && g and st_intersects(m2.geom, g)
            group by 1) x), '{}'::jsonb))
      from map_features m
      where m.dataset = 'public_parcel' and m.geom && g and st_intersects(m.geom, g)),
    'la_property', (select count(*) from map_features m
      where m.dataset = 'la_property' and m.geom && g and st_intersects(m.geom, g)),
    'resi_land_gbp_ha', (select (m.props->>'resi_gbp_ha')::numeric from map_features m
      where m.dataset = 'land_value'
        and st_intersects(m.geom, st_setsrid(st_makepoint(p_lng, p_lat), 4326)) limit 1)));

  return r;
end $$;

grant execute on function public.stadium_catchment_summary(jsonb, double precision, double precision) to anon, authenticated;
