-- 0055: per-station MHCLG residential land value, for the sift. The deep
-- dive prices land from the land_value dataset via point_summary, but the
-- sift appraised 2,400 stations with the £/unit proxy — the same station
-- could read '£160M profit' in the sift and 'unviable, RLV 0.06× benchmark'
-- in its own deep dive (Kensal Green, 2026-08-05). One row per station:
-- the authority's published resi £/ha at the station's point, so the sift
-- can hand the engine the same land basis the deep dive uses.
create or replace function public.station_land_values()
returns table(crs text, land_value_ha numeric)
language sql stable
set search_path = public, extensions
as $$
  select s.crs, lv.v
  from public.stations s
  cross join lateral (
    select (mf.props->>'resi_gbp_ha')::numeric as v
    from public.map_features mf
    where mf.dataset = 'land_value'
      and st_intersects(mf.geom, st_setsrid(st_makepoint(s.lng, s.lat), 4326))
    limit 1
  ) lv;
$$;

-- The sift runs in the browser: anon needs execute (public open data).
grant execute on function public.station_land_values() to anon, authenticated, service_role;

notify pgrst, 'reload schema';
