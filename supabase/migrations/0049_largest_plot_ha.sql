-- 0049: largest developable plot per station — column + rebuild wiring.
-- The sift's step-3 numbers are whole-catchment sums, so a station with 20
-- scattered slivers could outrank one clean 10 ha site. Store the largest
-- single contiguous plot so the sift can filter/appraise by it.
--
-- NOTE: as first applied, this migration also recreated
-- developable_land_near_station from a STALE 7-parameter definition (its
-- source was migration 0017; the live function had since gained min_width_m
-- and the Scottish soft designations), leaving two overloads and making
-- short-arg calls ambiguous. 0050 is the corrective — the function body here
-- is intentionally omitted from this mirror; see 0050 for the real one.

alter table public.station_assessments add column if not exists largest_plot_ha numeric;

create or replace function public.rebuild_station_assessments(crs_prefix text DEFAULT ''::text, radius_m double precision DEFAULT 800)
 returns integer
 language plpgsql
as $function$
declare n integer;
begin
  -- Keep the fast built-up tiles current (cheap; a few seconds).
  perform public.refresh_built_land_bng();

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
         case when s.well_connected then 50 when inset.v then 40 else null end,
         r.catchment_ha, r.developable_ha, r.inner_ha, r.outer_ha,
         round(r.developable_ha
               * (case when s.well_connected then 50 when inset.v then 40 else 0 end))::int,
         r.friction, r.soft_cover, r.green_belt_ha, bf.frac, r.largest_plot_ha
  from public.stations s
  cross join lateral (
    select st_buffer(st_transform(st_setsrid(st_makepoint(s.lng, s.lat), 4326), 27700), radius_m) as c,
           st_transform(st_setsrid(st_makepoint(s.lng, s.lat), 4326), 27700) as p
  ) cat
  cross join lateral (
    -- built-up fraction of the catchment (planar, index-pruned tiles)
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
  cross join lateral public.developable_land_near_station(s.lng, s.lat, radius_m) r
  where s.crs like crs_prefix || '%';

  get diagnostics n = row_count;
  return n;
end
$function$;

notify pgrst, 'reload schema';
