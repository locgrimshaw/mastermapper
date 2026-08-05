-- 0056: two sift↔dive alignment fixes (see 0057 for the applied final form
-- of rebuild_station_assessments — this mirror records the intermediate).
--
-- (1) station_land_values() returned SETOF rows and PostgREST caps responses
--     at 1,000 rows — there are 2,007 stations with a value, so every station
--     past the cap silently lost its MHCLG land value and fell back to proxy
--     land (Willesden Junction: 49% PoC in the sift vs -57.9% in its dive).
--     Return ONE jsonb object {crs: £/ha} instead — nothing to truncate.
--
-- (2) rebuild_station_assessments called the developable RPC with min_plot 0
--     and min_width 0, while the deep dive defaults to 15 m min width (and
--     now 1 acre min plot) — so the sift's hectares/yields systematically
--     exceeded what the dive shows. Pass the dive's defaults: 1 acre
--     (4046.856 m²) and 15 m. These numbers must move together with
--     defaultDevelopableConfig() in app.js.

drop function if exists public.station_land_values();

create function public.station_land_values()
returns jsonb
language sql stable
set search_path = public, extensions
as $$
  select coalesce(jsonb_object_agg(s.crs, lv.v), '{}'::jsonb)
  from public.stations s
  cross join lateral (
    select (mf.props->>'resi_gbp_ha')::numeric as v
    from public.map_features mf
    where mf.dataset = 'land_value'
      and st_intersects(mf.geom, st_setsrid(st_makepoint(s.lng, s.lat), 4326))
    limit 1
  ) lv;
$$;

grant execute on function public.station_land_values() to anon, authenticated, service_role;
