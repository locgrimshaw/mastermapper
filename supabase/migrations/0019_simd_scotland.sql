-- 0019_simd_scotland.sql
-- Scotland's deprivation + population + prices, mirroring public.lsoa_imd but at
-- Data Zone 2011 geography (6,976 zones), from SIMD 2020 (Scottish Government,
-- OGL). Populates the SAME catchment_* columns on station_assessments for
-- country='scotland' stations, so the sift's "Regeneration need" (a national
-- deprivation percentile) works identically — sourced from SIMD instead of IMD.
-- Metrics are NOT comparable across the border, which is why Scotland sifts apart.

create table if not exists public.simd (
  data_zone      text primary key,
  council_name   text,
  geom           geometry(Point, 4326),
  population     integer,
  overall_norm   numeric,
  income_norm    numeric,
  employment_norm numeric,
  education_norm numeric,
  health_norm    numeric,
  crime_norm     numeric,
  housing_norm   numeric,
  access_norm    numeric,
  median_price   numeric,
  price_per_m2   numeric
);
create index if not exists simd_geom_gix on public.simd using gist (geom);

create or replace function public.rebuild_station_scotland(radius_m double precision default 800)
returns integer language plpgsql as $$
declare n integer;
begin
  with cat as (
    select s.crs,
      sum(l.population) as pop,
      case when sum(l.population) > 0 then sum(l.population * l.overall_norm) / sum(l.population) end as imd,
      case when sum(l.population) > 0 then sum(l.population * l.income_norm)  / sum(l.population) end as income,
      case when sum(l.population) > 0 then sum(l.population * l.health_norm)  / sum(l.population) end as health,
      case when sum(l.population) > 0 then sum(l.population * l.education_norm)/ sum(l.population) end as education,
      case when sum(l.population) filter (where l.price_per_m2 is not null) > 0
           then sum(l.population * l.price_per_m2) filter (where l.price_per_m2 is not null)
                / sum(l.population) filter (where l.price_per_m2 is not null) end as ppm2,
      case when sum(l.population) filter (where l.median_price is not null) > 0
           then sum(l.population * l.median_price) filter (where l.median_price is not null)
                / sum(l.population) filter (where l.median_price is not null) end as mprice
    from public.stations s
    join public.simd l on st_dwithin(l.geom::geography, st_makepoint(s.lng, s.lat)::geography, radius_m)
    where s.country = 'scotland'
    group by s.crs
  ),
  nearest as (
    select s.crs, nl.overall_norm, nl.population
    from public.stations s
    cross join lateral (
      select l.overall_norm, l.population from public.simd l
      order by l.geom <-> st_setsrid(st_makepoint(s.lng, s.lat), 4326) limit 1
    ) nl
    where s.country = 'scotland'
  )
  update public.station_assessments t set
    catchment_pop          = round(coalesce(c.pop, nr.population))::int,
    catchment_imd          = round(coalesce(c.imd, nr.overall_norm)::numeric, 1),
    regen_score            = round(coalesce(c.imd, nr.overall_norm)::numeric, 1),
    catchment_income       = round(c.income::numeric, 1),
    catchment_health       = round(c.health::numeric, 1),
    catchment_education    = round(c.education::numeric, 1),
    catchment_ppm2         = round(c.ppm2),
    catchment_median_price = round(c.mprice)
  from public.stations s
  left join cat c on c.crs = s.crs
  left join nearest nr on nr.crs = s.crs
  where t.crs = s.crs and s.country = 'scotland';
  get diagnostics n = row_count;
  return n;
end $$;
