-- 0058: catchment £/m² from OUR measured sales, not just the published layer.
--
-- rebuild_station_prices() previously read lsoa_imd.price_per_m2 — the London
-- Datastore "house price per square metre" LSOA dataset. Legitimate (it is
-- itself Land Registry × EPC derived) but a fixed vintage: the 2026-08 EPC
-- integration left it untouched, so the sift/dive sales value ignored the
-- 1.97M sales that now carry a measured floor area (ppm2r).
--
-- Now: catchment_ppm2 = median ppm2r of EPC-matched sales within radius_m of
-- the station, when at least 30 such sales exist (a robust local median from
-- the last 36 months); the population-weighted LSOA figure remains the
-- fallback, then nearest-LSOA as before. catchment_median_price likewise
-- prefers the local sales median. Same signature — callers unchanged.
--
-- The sales scan uses a bbox prefilter (geometry && st_expand) so the gist
-- index on map_features.geom carries the join; the exact 800 m test runs on
-- the small candidate set only.

create or replace function public.rebuild_station_prices(radius_m double precision default 800)
returns integer
language plpgsql
as $$
declare n integer;
begin
  with sale_med as (
    select s.crs,
           percentile_cont(0.5) within group
             (order by (f.props->>'ppm2r')::numeric)  as ppm2,
           percentile_cont(0.5) within group
             (order by (f.props->>'price')::numeric)  as mprice,
           count(*) filter (where f.props ? 'ppm2r')  as n_m2,
           count(*)                                   as n_all
    from public.stations s
    join public.map_features f
      on f.dataset = 'ppd_sales'
     and f.geom && st_expand(st_setsrid(st_makepoint(s.lng, s.lat), 4326),
                             radius_m / 70000.0)
     and st_dwithin(f.geom::geography,
                    st_makepoint(s.lng, s.lat)::geography, radius_m)
    group by s.crs
  ),
  cat as (
    select s.crs,
           case when sum(l.population) filter (where l.price_per_m2 is not null) > 0
                then sum(l.population * l.price_per_m2) filter (where l.price_per_m2 is not null)
                     / sum(l.population) filter (where l.price_per_m2 is not null) end as ppm2,
           case when sum(l.population) filter (where l.median_price is not null) > 0
                then sum(l.population * l.median_price) filter (where l.median_price is not null)
                     / sum(l.population) filter (where l.median_price is not null) end as mprice
    from public.stations s
    join public.lsoa_imd l
      on st_dwithin(l.geom::geography, st_makepoint(s.lng, s.lat)::geography, radius_m)
    group by s.crs
  ),
  nearest as (
    select s.crs, nl.price_per_m2, nl.median_price
    from public.stations s
    cross join lateral (
      select l.price_per_m2, l.median_price
      from public.lsoa_imd l
      where l.price_per_m2 is not null
      order by l.geom <-> st_setsrid(st_makepoint(s.lng, s.lat), 4326)
      limit 1
    ) nl
  )
  update public.station_assessments t set
    catchment_ppm2 = round(coalesce(
      case when sm.n_m2  >= 30 then sm.ppm2   end,
      c.ppm2, nr.price_per_m2)),
    catchment_median_price = round(coalesce(
      case when sm.n_all >= 30 then sm.mprice end,
      c.mprice, nr.median_price))
  from public.stations s
  left join sale_med sm on sm.crs = s.crs
  left join cat      c  on c.crs  = s.crs
  left join nearest  nr on nr.crs = s.crs
  where t.crs = s.crs;

  get diagnostics n = row_count;
  return n;
end
$$;
