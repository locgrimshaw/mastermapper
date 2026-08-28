-- 0065_nppf_density_35_45.sql
--
-- Bring the stored density assumption onto the Framework's own numbers.
--
-- Until now station_assessments carried 50 dph for a well-connected station and
-- 40 for one merely inside a settlement — figures inherited from the pre-2026
-- Framework and never restated when the new one landed. Policy S5(2)(c) sets
-- 35 dwellings per hectare as the minimum on the station route, rising to 45
-- "where the service frequency is at least twice that of the minimum required"
-- for a well-connected station (Annex B: four trains an hour overall, or two in
-- any one direction — so double is eight overall, or four in one direction).
--
-- The 45 tier is a FREQUENCY test, not a settlement-type one. It is gated on
-- well_connected because S5(2)(c) only bites on the route to a well-connected
-- station; a busy station outside the top-80 TTWA carries no such minimum.
--
-- Depends on stations.sustained_tph / sustained_tph_per_dir being populated
-- (0063 added the columns; pipeline/load_station_tph.py fills them from the
-- timetable-derived web/data/stations.geojson).

create or replace function public.nppf_density_floor(
  p_well_connected boolean,
  p_in_settlement  boolean,
  p_tph            numeric,
  p_tph_per_dir    numeric
) returns integer
language sql immutable as $$
  select case
    when coalesce(p_well_connected, false)
     and (coalesce(p_tph, 0) >= 8 or coalesce(p_tph_per_dir, 0) >= 4) then 45
    when coalesce(p_well_connected, false) then 35
    when coalesce(p_in_settlement, false)  then 35
    else null
  end::int;
$$;

comment on function public.nppf_density_floor(boolean, boolean, numeric, numeric) is
  'NPPF 2026 policy S5(2)(c): 35 dph minimum on the route to a well-connected '
  'station, 45 where frequency is at least double the Annex B threshold '
  '(>= 8 trains/hour overall or >= 4 in one direction).';

-- Re-derive the stored floors and yields for every station already assessed.
update public.station_assessments a
   set density_floor = public.nppf_density_floor(
         s.well_connected, a.in_settlement, s.sustained_tph, s.sustained_tph_per_dir),
       dwelling_yield = round(coalesce(a.developable_ha, 0)
         * coalesce(public.nppf_density_floor(
             s.well_connected, a.in_settlement,
             s.sustained_tph, s.sustained_tph_per_dir), 0))::int
  from public.stations s
 where s.crs = a.crs;

-- And keep future rebuilds on the same rule. Body is otherwise unchanged from
-- the definition installed by 0049; only the two density expressions move.
create or replace function public.rebuild_station_assessments(
  crs_prefix text default ''::text, radius_m double precision default 800)
returns integer language plpgsql as $function$
declare n integer;
begin
  if crs_prefix = '' or upper(crs_prefix) = 'A' then
    perform public.refresh_built_land_bng();
  end if;

  delete from public.station_assessments a
    using public.stations s
    where a.crs = s.crs and s.crs like crs_prefix || '%';

  insert into public.station_assessments
    (crs, in_settlement, tier, density_floor,
     catchment_ha, developable_ha, inner_ha, outer_ha, dwelling_yield,
     constraint_friction, soft_cover, green_belt_ha, built_frac, largest_plot_ha)
  select s.crs,
         inset.v,
         case when inset.v then 'A' when s.well_connected then 'B' else 'ineligible' end,
         dens.v,
         r.catchment_ha, r.developable_ha, r.inner_ha, r.outer_ha,
         round(r.developable_ha * coalesce(dens.v, 0))::int,
         r.friction, r.soft_cover, r.green_belt_ha, bf.frac, r.largest_plot_ha
  from public.stations s
  cross join lateral (
    select st_buffer(st_transform(st_setsrid(st_makepoint(s.lng, s.lat), 4326), 27700), radius_m) as c,
           st_transform(st_setsrid(st_makepoint(s.lng, s.lat), 4326), 27700) as p
  ) cat
  cross join lateral (
    select coalesce(sum(st_area(st_intersection(bl.geom, cat.c))), 0)
             / nullif(st_area(cat.c), 0) as frac
    from public.built_land_bng bl where bl.geom && cat.c
  ) af
  cross join lateral (
    select af.frac as frac,
           exists(select 1 from public.built_land_bng bl
                  where st_dwithin(bl.geom, cat.p, 100)) as near
  ) bf
  cross join lateral (select (bf.frac >= 0.40 or (bf.frac >= 0.20 and bf.near)) as v) inset
  cross join lateral (
    select public.nppf_density_floor(s.well_connected, inset.v,
                                     s.sustained_tph, s.sustained_tph_per_dir) as v
  ) dens
  -- The dive's DEFAULT view: 1-acre minimum plot, 15 m minimum width (0056).
  cross join lateral public.developable_land_near_station(
    s.lng, s.lat, radius_m, min_plot_m2 => 4046.856, min_width_m => 15) r
  where s.crs like crs_prefix || '%';

  get diagnostics n = row_count;
  return n;
end
$function$;
