-- 0012_nppf_density_floor_fix.sql
-- Correct the NPPF minimum-density floor.
--
-- The draft NPPF sets the density MINIMUM by CONNECTIVITY, not by settlement:
--   "…a density of at least 40 dwellings per hectare should be achieved within
--    the net developable area of the site, OR 50 dwellings per hectare where the
--    station or stop is defined as 'well-connected'."
-- (NPPF proposed reforms consultation, MHCLG.)
--
-- So the floor is: well_connected -> 50; else (eligible in-settlement) -> 40.
-- The previous logic tested in-settlement FIRST, which wrongly gave a
-- well-connected IN-settlement station 40 dph (≈899 stations). Tier is unchanged
-- (A = in-settlement, B = well-connected out-of-settlement) — only the density
-- floor / yield are corrected, and they key off well_connected.
--
-- developable_ha is already the NET developable area (catchment minus hard
-- constraints), so yield = net developable ha × floor matches the NPPF basis.
-- Re-runnable; re-run rebuild_station_assessments() + rebuild_station_socioecon()
-- afterwards (yields change, so the housing-contribution percentile shifts).

create or replace function public.rebuild_station_assessments(
  crs_prefix text default '',
  radius_m   double precision default 800
)
returns integer
language plpgsql
as $$
declare n integer;
begin
  delete from public.station_assessments a
    using public.stations s
    where a.crs = s.crs and s.crs like crs_prefix || '%';

  insert into public.station_assessments
    (crs, in_settlement, tier, density_floor,
     catchment_ha, developable_ha, inner_ha, outer_ha, dwelling_yield,
     constraint_friction, soft_cover, green_belt_ha)
  select s.crs,
         inset.v,
         -- Tier = eligibility route (unchanged): in-settlement=A, else well-connected=B.
         case when inset.v then 'A' when s.well_connected then 'B' else 'ineligible' end,
         -- Density floor = by connectivity: well-connected 50, else eligible 40.
         case when s.well_connected then 50 when inset.v then 40 else null end,
         r.catchment_ha, r.developable_ha, r.inner_ha, r.outer_ha,
         round(r.developable_ha
               * (case when s.well_connected then 50 when inset.v then 40 else 0 end))::int,
         r.friction, r.soft_cover, r.green_belt_ha
  from public.stations s
  cross join lateral (
    select exists(
      select 1 from public.planning_constraints c
      where c.kind = 'built_land'
        and st_contains(c.geom, st_setsrid(st_makepoint(s.lng, s.lat), 4326))
    ) as v
  ) inset
  cross join lateral public.developable_land_near_station(s.lng, s.lat, radius_m) r
  where s.crs like crs_prefix || '%';

  get diagnostics n = row_count;
  return n;
end
$$;
