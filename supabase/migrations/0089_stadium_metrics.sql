-- 0089 · stadium_metrics: one row per stadium, everything the stadium
-- comparison table, the sidebar's peer view and the UK Stadium Analysis study
-- read. Rebuilt by rebuild_stadium_metrics(from, to) in id chunks (each
-- stadium is a dozen spatial queries).
--
-- Rings are straight-line buffers from the stadium point:
--   800 m  ≈ a 10-minute walk — the "ground-adjacent" zone
--   1.5 km ≈ a 20-minute walk — the neighbourhood
--   3 / 5 km — the visitor-economy radius (hotels, venues)
-- Network catchments (walk / drive / public transport isochrones) are stored
-- separately as map_features dataset 'stadium_iso' and their populations
-- written back here by set_stadium_reach().
--
-- Population and deprivation are area-weighted from LSOAs (England, lsoa_imd)
-- and data zones (Scotland, simd); jobs from ONS BRES by LSOA (lsoa_jobs,
-- England & Wales — Wales has no LSOA geometry here, so England only).

create table if not exists public.stadium_metrics (
  id            serial,
  source_id     text primary key,
  name          text,
  lng           double precision,
  lat           double precision,
  sport         text,
  capacity      integer,
  league        text,
  clubs         text,
  opened        integer,
  cost_real_gbp bigint,
  nation        text,
  area_name     text,
  -- people
  pop_800 int, pop_1500 int, pop_3000 int, jobs_800 int, jobs_1500 int,
  dens_1500 numeric,               -- residents per km2
  imd_1500 numeric,                -- pop-weighted deprivation, 0-100 (100 = most deprived)
  imd_income numeric, imd_health numeric, imd_employment numeric,
  -- land supply within 800 m (ha; components can overlap, regen_ha is their union)
  parking_ha numeric, brownfield_ha numeric, public_ha numeric,
  lowvalue_ha numeric, regen_ha numeric, green_ha numeric,
  flood3_share numeric, conservation_share numeric, listed_800 int,
  -- visitor economy
  hotels_3k int, rooms_1k int, beds_1k int, beds_3k int, beds_5k int,
  venues_3k int, venue_cap_3k int, food_800 int, pubs_800 int,
  -- sport & social value
  sport_fac_1500 int, pitch_ha_1500 numeric, schools_1500 int, other_stadia_600 int,
  -- transport
  stations_1k int, nearest_station_m int, station_usage_1k bigint, buses_hr_800 int,
  -- market
  ppm2_1500 numeric, ppm2_area numeric, price_premium_pct numeric,
  price_trend_pct numeric, land_value_ha numeric,
  -- network reach (set_stadium_reach)
  reach_walk15 int, reach_drive20 int, reach_pt45 int,
  typology      text,
  updated_at    timestamptz default now()
);
alter table public.stadium_metrics enable row level security;
create policy stadium_metrics_read on public.stadium_metrics for select using (true);
grant select on public.stadium_metrics to anon, authenticated;

-- Area-weighted population / jobs / deprivation inside a polygon.
create or replace function public._area_people(g geometry)
returns table (pop numeric, jobs numeric, imd numeric, income numeric, health numeric,
               employment numeric, ppm2 numeric)
language sql stable
set search_path = public, extensions
as $$
  with parts as (
    select i.population::numeric * st_area(st_intersection(i.geom, g)::geography)
             / nullif(st_area(i.geom::geography), 0) as w_pop,
           coalesce(j.jobs, 0)::numeric * st_area(st_intersection(i.geom, g)::geography)
             / nullif(st_area(i.geom::geography), 0) as w_jobs,
           i.overall_norm, i.income_norm, i.health_norm, i.employment_norm, i.price_per_m2
    from lsoa_imd i left join lsoa_jobs j using (lsoa_code)
    where i.geom && g and st_intersects(i.geom, g)
    union all
    select s.population::numeric * st_area(st_intersection(s.geom, g)::geography)
             / nullif(st_area(s.geom::geography), 0), 0,
           s.overall_norm, s.income_norm, s.health_norm, s.employment_norm, s.price_per_m2
    from simd s
    where s.geom && g and st_intersects(s.geom, g)
  )
  select sum(w_pop), sum(w_jobs),
         sum(w_pop * overall_norm) / nullif(sum(w_pop) filter (where overall_norm is not null), 0),
         sum(w_pop * income_norm) / nullif(sum(w_pop) filter (where income_norm is not null), 0),
         sum(w_pop * health_norm) / nullif(sum(w_pop) filter (where health_norm is not null), 0),
         sum(w_pop * employment_norm) / nullif(sum(w_pop) filter (where employment_norm is not null), 0),
         sum(w_pop * price_per_m2) / nullif(sum(w_pop) filter (where price_per_m2 is not null), 0)
  from parts;
$$;

-- Hectares of a dataset's polygons inside g (clipped).
create or replace function public._mf_ha(p_dataset text, g geometry)
returns numeric language sql stable
set search_path = public, extensions
as $$
  select coalesce(sum(st_area(st_intersection(m.geom, g)::geography)), 0) / 1e4
  from map_features m
  where m.dataset = p_dataset and m.geom && g and st_intersects(m.geom, g);
$$;

create or replace function public.rebuild_stadium_metrics(p_from int default 0, p_to int default 100000)
returns int
language plpgsql
set search_path = public, extensions
set statement_timeout = '15min'
as $$
declare
  s record; o geography; g8 geometry; g15 geometry; g30 geometry;
  p8 record; p15 record; p30 record; n int := 0;
  regen numeric; lad text;
begin
  -- seed / refresh the stadium list (ids stay stable across rebuilds)
  insert into stadium_metrics (source_id)
  select source_id from map_features where dataset = 'stadium'
  on conflict (source_id) do nothing;

  for s in
    select sm.id, m.source_id, m.name, m.props, m.geom
    from stadium_metrics sm join map_features m on m.dataset = 'stadium' and m.source_id = sm.source_id
    where sm.id between p_from and p_to
  loop
    o   := s.geom::geography;
    g8  := st_buffer(o, 800)::geometry;
    g15 := st_buffer(o, 1500)::geometry;
    g30 := st_buffer(o, 3000)::geometry;
    select * into p8  from _area_people(g8);
    select * into p15 from _area_people(g15);
    select * into p30 from _area_people(g30);

    select st_area(st_intersection(st_union(m.geom), g8)::geography) / 1e4 into regen
    from (select geom from map_features
          where dataset in ('osm_parking','osm_brownfield','osm_retail','osm_industrial',
                            'osm_storage','osm_leisure_lowdensity','public_parcel')
            and geom && g8 and st_intersects(geom, g8)
          union all
          select geom from brownfield where geom && g8 and st_intersects(geom, g8)) m;

    select i.lad_name into lad from lsoa_imd i where st_intersects(i.geom, s.geom) limit 1;
    if lad is null then
      select z.council_name into lad from simd z where st_intersects(z.geom, s.geom) limit 1;
    end if;

    update stadium_metrics sm set
      name = s.name, lng = st_x(s.geom), lat = st_y(s.geom),
      sport = s.props->>'sport1', capacity = (s.props->>'capacity')::int,
      league = s.props->>'league', clubs = s.props->>'clubs',
      opened = (s.props->>'opened')::int, cost_real_gbp = (s.props->>'cost_real_gbp')::bigint,
      area_name = lad,
      nation = case
        when exists (select 1 from lsoa_imd i where st_intersects(i.geom, s.geom)) then 'England'
        when exists (select 1 from simd z where st_intersects(z.geom, s.geom)) then 'Scotland'
        when st_x(s.geom) < -5.4 and st_y(s.geom) between 54 and 55.4 then 'Northern Ireland'
        else 'Wales' end,
      pop_800 = round(p8.pop), pop_1500 = round(p15.pop), pop_3000 = round(p30.pop),
      jobs_800 = round(p8.jobs), jobs_1500 = round(p15.jobs),
      dens_1500 = round(p15.pop / (pi() * 1.5 * 1.5)),
      imd_1500 = round(p15.imd * 100, 1), imd_income = round(p15.income * 100, 1),
      imd_health = round(p15.health * 100, 1), imd_employment = round(p15.employment * 100, 1),
      parking_ha = round(_mf_ha('osm_parking', g8), 2),
      brownfield_ha = round(coalesce((select sum(st_area(st_intersection(b.geom, g8)::geography)) / 1e4
                       from brownfield b where b.geom && g8 and st_intersects(b.geom, g8)), 0)
                     + _mf_ha('osm_brownfield', g8), 2),
      public_ha = round(_mf_ha('public_parcel', g8), 2),
      lowvalue_ha = round(_mf_ha('osm_retail', g8) + _mf_ha('osm_industrial', g8)
                    + _mf_ha('osm_storage', g8) + _mf_ha('osm_leisure_lowdensity', g8), 2),
      regen_ha = round(coalesce(regen, 0), 2),
      green_ha = round(coalesce((select sum(st_area(st_intersection(c.geom, g8)::geography)) / 1e4
                  from planning_constraints c where c.kind = 'green_space'
                    and c.geom && g8 and st_intersects(c.geom, g8)), 0), 2),
      flood3_share = round(coalesce((select st_area(st_intersection(st_union(c.geom), g8)::geography)
                     / st_area(g8::geography) from planning_constraints c
                     where c.kind = 'flood_zone_3' and c.geom && g8 and st_intersects(c.geom, g8)), 0), 3),
      conservation_share = round(coalesce((select st_area(st_intersection(st_union(c.geom), g8)::geography)
                     / st_area(g8::geography) from planning_constraints c
                     where c.kind = 'conservation_area' and c.geom && g8 and st_intersects(c.geom, g8)), 0), 3),
      listed_800 = (select count(*) from planning_constraints c
                    where c.kind = 'listed_building' and c.geom && g8 and st_intersects(c.geom, g8)),
      hotels_3k = (select count(*) from map_features m where m.dataset = 'hotel'
                   and st_dwithin(m.geom::geography, o, 3000)),
      rooms_1k  = (select coalesce(sum((m.props->>'rooms')::int), 0) from map_features m
                   where m.dataset = 'hotel' and st_dwithin(m.geom::geography, o, 1000)),
      beds_1k   = (select coalesce(sum((m.props->>'beds')::int), 0) from map_features m
                   where m.dataset = 'hotel' and st_dwithin(m.geom::geography, o, 1000)),
      beds_3k   = (select coalesce(sum((m.props->>'beds')::int), 0) from map_features m
                   where m.dataset = 'hotel' and st_dwithin(m.geom::geography, o, 3000)),
      beds_5k   = (select coalesce(sum((m.props->>'beds')::int), 0) from map_features m
                   where m.dataset = 'hotel' and st_dwithin(m.geom::geography, o, 5000)),
      venues_3k = (select count(*) from map_features m where m.dataset = 'event_venue'
                   and st_dwithin(m.geom::geography, o, 3000)),
      venue_cap_3k = (select coalesce(sum((m.props->>'capacity')::int), 0) from map_features m
                   where m.dataset = 'event_venue' and st_dwithin(m.geom::geography, o, 3000)),
      food_800  = (select count(*) from map_features m where m.dataset = 'food_drink'
                   and m.geom && g8 and st_intersects(m.geom, g8)),
      pubs_800  = (select count(*) from map_features m where m.dataset = 'food_drink'
                   and m.props->>'kind' in ('pub', 'bar') and m.geom && g8 and st_intersects(m.geom, g8)),
      sport_fac_1500 = (select count(*) from map_features m where m.dataset = 'sports_facility'
                   and m.geom && g15 and st_intersects(m.geom, g15)),
      pitch_ha_1500 = (select round(coalesce(sum((m.props->>'area_m2')::numeric), 0) / 1e4, 2)
                   from map_features m where m.dataset = 'sports_facility' and m.props->>'kind' = 'pitch'
                   and m.geom && g15 and st_intersects(m.geom, g15)),
      schools_1500 = (select count(*) from map_features m where m.dataset = 'school'
                   and m.geom && g15 and st_intersects(m.geom, g15)),
      other_stadia_600 = (select count(*) from map_features m where m.dataset = 'stadium'
                   and m.source_id <> s.source_id and st_dwithin(m.geom::geography, o, 600)),
      stations_1k = (select count(*) from stations t
                   where st_dwithin(st_setsrid(st_makepoint(t.lng, t.lat), 4326)::geography, o, 1000)),
      nearest_station_m = (select min(st_distance(st_setsrid(st_makepoint(t.lng, t.lat), 4326)::geography, o))::int
                   from stations t
                   where st_dwithin(st_setsrid(st_makepoint(t.lng, t.lat), 4326)::geography, o, 10000)),
      station_usage_1k = (select coalesce(sum(t.usage), 0) from stations t
                   where st_dwithin(st_setsrid(st_makepoint(t.lng, t.lat), 4326)::geography, o, 1000)),
      buses_hr_800 = (select round(coalesce(sum((m.props->>'buses_hr')::numeric), 0)) from map_features m
                   where m.dataset = 'bus_stop' and m.geom && g8 and st_intersects(m.geom, g8)),
      ppm2_1500 = round(p15.ppm2),
      ppm2_area = (select round(avg(i.price_per_m2)) from lsoa_imd i where i.lad_name = lad),
      price_trend_pct = (select round(avg((m.props->>'trend_pct')::numeric), 1) from map_features m
                   where m.dataset = 'lsoa_prices' and m.geom && g15 and st_intersects(m.geom, g15)),
      land_value_ha = (select (m.props->>'resi_gbp_ha')::numeric from map_features m
                   where m.dataset = 'land_value' and st_intersects(m.geom, s.geom) limit 1),
      updated_at = now()
    where sm.id = s.id;
    n := n + 1;
  end loop;

  update stadium_metrics set price_premium_pct =
    case when ppm2_area > 0 and ppm2_1500 > 0 then round((ppm2_1500 / ppm2_area - 1) * 100, 1) end
  where id between p_from and p_to;
  return n;
end $$;

-- Location typology, from the metrics (run after every chunk has built).
create or replace function public.classify_stadia()
returns int language sql
set search_path = public, extensions
as $$
  with t as (
    update stadium_metrics set typology = case
      when other_stadia_600 > 0 and pitch_ha_1500 > 15 then 'Sports campus'
      when station_usage_1k > 5000000 or (jobs_800 > 15000 and food_800 > 80) then 'City centre'
      when parking_ha > 6 and lowvalue_ha > 12 and coalesce(dens_1500, 0) < 3500 then 'Out-of-town / retail park'
      when coalesce(dens_1500, 0) >= 5000 then 'Inner-urban neighbourhood'
      when coalesce(dens_1500, 0) >= 2000 then 'Suburban'
      else 'Edge of town / rural' end
    returning 1)
  select count(*)::int from t;
$$;

-- Network-catchment populations, written by the isochrone builder.
create or replace function public.set_stadium_reach()
returns int language plpgsql
set search_path = public, extensions
set statement_timeout = '15min'
as $$
declare r record; n int := 0; p numeric;
begin
  for r in select source_id, name, props, geom from map_features where dataset = 'stadium_iso' loop
    select pop into p from _area_people(r.geom);
    update stadium_metrics set
      reach_walk15  = case when r.props->>'mode' = 'walk'  then round(p) else reach_walk15 end,
      reach_drive20 = case when r.props->>'mode' = 'drive' then round(p) else reach_drive20 end,
      reach_pt45    = case when r.props->>'mode' = 'pt'    then round(p) else reach_pt45 end
    where source_id = r.props->>'stadium';
    n := n + 1;
  end loop;
  return n;
end $$;

revoke execute on function public.rebuild_stadium_metrics(int, int) from public, anon, authenticated;
revoke execute on function public.classify_stadia() from public, anon, authenticated;
revoke execute on function public.set_stadium_reach() from public, anon, authenticated;
