-- 0013_lsoa_prices_catchment.sql
-- LSOA-level price data for a real, LOCAL GDV in the viability model.
-- price_per_m2 / median_price live on the LSOA centroid table (public.lsoa_imd);
-- each station gets a catchment-weighted local £/m² (population-weighted average
-- over LSOAs within the 800 m ring, with a nearest-LSOA fallback) — mirroring how
-- catchment IMD is built. Sources (OGL): HM Land Registry Price Paid × EPC floor
-- areas (London Datastore "House price per square metre", LSOA level) for £/m²;
-- ONS HPSSA median price by LSOA for median_price. Re-runnable.
--
-- Data ops after loading prices into lsoa_imd:
--   select public.rebuild_station_prices();   -- writes catchment_ppm2 / _median_price

alter table public.lsoa_imd
  add column if not exists median_price numeric,
  add column if not exists price_per_m2 numeric;

alter table public.station_assessments
  add column if not exists catchment_ppm2         numeric,
  add column if not exists catchment_median_price numeric;

create or replace function public.rebuild_station_prices(radius_m double precision default 800)
returns integer
language plpgsql
as $$
declare n integer;
begin
  with cat as (
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
    catchment_ppm2         = round(coalesce(c.ppm2, nr.price_per_m2)),
    catchment_median_price = round(coalesce(c.mprice, nr.median_price))
  from public.stations s
  left join cat     c  on c.crs  = s.crs
  left join nearest nr on nr.crs = s.crs
  where t.crs = s.crs;

  get diagnostics n = row_count;
  return n;
end
$$;
