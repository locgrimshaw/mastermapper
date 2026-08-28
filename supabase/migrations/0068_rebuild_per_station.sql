-- 0068_rebuild_per_station.sql
--
-- rebuild_station_assessments as a per-station LOOP, not a lateral join.
--
-- The old body computed everything in one INSERT..SELECT with
-- developable_land_near_station in a CROSS JOIN LATERAL. That function is
-- LANGUAGE sql, so the planner INLINES it into the outer query — and with the
-- 0066/0067 standoff CTEs in its body, the inlined 100-station mega-plan went
-- pathological: Denmark Hill costs 0.44 s called standalone, yet a
-- 104-station prefix blew a 30-minute budget. plpgsql calls are never
-- inlined; each station's call plans exactly like the standalone probe.
--
-- Semantics are unchanged from 0065: same built-fraction in-settlement rule,
-- same tier derivation, same nppf_density_floor, same 1-acre / 15 m
-- developable defaults (and, since 0066/0067, the 10 m transport standoff).
-- A per-station loop also degrades better: one hard station costs seconds,
-- not the whole batch.

create or replace function public.rebuild_station_assessments(
  crs_prefix text default ''::text, radius_m double precision default 800)
returns integer language plpgsql as $function$
declare
  n integer := 0;
  s record;
  frac double precision;
  near boolean;
  inset boolean;
  dens integer;
  r record;
begin
  if crs_prefix = '' or upper(crs_prefix) = 'A' then
    perform public.refresh_built_land_bng();
  end if;

  delete from public.station_assessments a
    using public.stations st
    where a.crs = st.crs and st.crs like crs_prefix || '%';

  for s in
    select st.crs, st.lng, st.lat, st.well_connected,
           st.sustained_tph, st.sustained_tph_per_dir
      from public.stations st
     where st.crs like crs_prefix || '%'
     order by st.crs
  loop
    -- Built-up fraction of the catchment (OS built-land tiles, BNG).
    with cat as (
      select st_buffer(st_transform(st_setsrid(st_makepoint(s.lng, s.lat), 4326), 27700),
                       radius_m) as c,
             st_transform(st_setsrid(st_makepoint(s.lng, s.lat), 4326), 27700) as p)
    select coalesce(sum(st_area(st_intersection(bl.geom, cat.c))), 0)
             / nullif(st_area(cat.c), 0),
           exists(select 1 from public.built_land_bng b2
                  where st_dwithin(b2.geom, cat.p, 100))
      into frac, near
      from cat left join public.built_land_bng bl on bl.geom && cat.c
     group by cat.c, cat.p;

    frac := coalesce(frac, 0);
    inset := frac >= 0.40 or (frac >= 0.20 and coalesce(near, false));
    dens := public.nppf_density_floor(s.well_connected, inset,
                                      s.sustained_tph, s.sustained_tph_per_dir);

    -- The dive's DEFAULT view: 1-acre minimum plot, 15 m minimum width (0056),
    -- 10 m road/rail standoff (0066/0067 default).
    select * into r from public.developable_land_near_station(
      s.lng, s.lat, radius_m,
      min_plot_m2 => 4046.856, min_width_m => 15);

    insert into public.station_assessments
      (crs, in_settlement, tier, density_floor,
       catchment_ha, developable_ha, inner_ha, outer_ha, dwelling_yield,
       constraint_friction, soft_cover, green_belt_ha, built_frac, largest_plot_ha)
    values
      (s.crs, inset,
       case when inset then 'A' when s.well_connected then 'B' else 'ineligible' end,
       dens,
       r.catchment_ha, r.developable_ha, r.inner_ha, r.outer_ha,
       round(r.developable_ha * coalesce(dens, 0))::int,
       r.friction, r.soft_cover, r.green_belt_ha, frac, r.largest_plot_ha);

    n := n + 1;
  end loop;

  return n;
end
$function$;

-- plpgsql caches parameterized plans; with `subtract` and the centre point as
-- parameters the generic plan has no selectivity for `kind = any(...)` over a
-- 2M-row table. Custom plans re-plan with the actual values each call, which
-- is what the standalone timings measure.
alter function public.rebuild_station_assessments(text, double precision)
  set plan_cache_mode = force_custom_plan;
