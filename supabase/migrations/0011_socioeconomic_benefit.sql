-- 0011_socioeconomic_benefit.sql
-- Assessment 4 (Socio-Economic Benefit) — a transparent, tunable benefit score
-- per station, precomputed onto station_assessments so the sift ranks instantly.
--
-- Components (each 0–100, kept visible so the score is auditable):
--   regen_score   = catchment IMD (population-weighted overall deprivation) —
--                   building homes in more-deprived catchments = regeneration benefit.
--   access_score  = 0.6 * local amenity completeness + 0.4 * rail connectivity pctile.
--   housing_score = cross-station percentile of dwelling yield (supply contribution).
--   benefit_score = weighted mean (equal default; weights are function params).
--
-- Catchment socio-economics use a compact LSOA-centroid layer (public.lsoa_imd,
-- loaded from web/data/lsoa_imd_points.geojson): a population-weighted average of
-- LSOA IMD over centroids within the 800 m catchment. Amenity access counts the
-- existing public.amenities points (gp/school/pharmacy/nursery/bus_stop) within
-- the catchment. Both use ST_DWithin against GiST indexes, so a full national
-- rebuild is a single indexed pass. Re-runnable.

-- 1. Enrich stations with the rail-connectivity fields the access score needs ---
alter table public.stations
  add column if not exists connectivity_pctile numeric,
  add column if not exists usage_pctile        numeric,
  add column if not exists direct_destinations integer,
  add column if not exists key_cities_count    integer;

-- 2. Compact LSOA IMD centroid layer (points only — free-tier friendly) --------
create table if not exists public.lsoa_imd (
  lsoa_code       text primary key,
  lad_name        text,
  geom            geometry(Point, 4326) not null,
  population      integer,
  overall_norm    numeric,
  income_norm     numeric,
  employment_norm numeric,
  education_norm  numeric,
  health_norm     numeric,
  crime_norm      numeric,
  housing_norm    numeric,
  environment_norm numeric
);
create index if not exists lsoa_imd_geom_gix on public.lsoa_imd using gist (geom);

alter table public.lsoa_imd enable row level security;
drop policy if exists "lsoa_imd readable" on public.lsoa_imd;
create policy "lsoa_imd readable" on public.lsoa_imd for select to anon, authenticated using (true);

-- 3. Socio-economic columns on station_assessments ---------------------------
alter table public.station_assessments
  add column if not exists catchment_pop       integer,
  add column if not exists catchment_imd       numeric,
  add column if not exists catchment_income    numeric,
  add column if not exists catchment_health    numeric,
  add column if not exists catchment_education numeric,
  add column if not exists gp_ct               integer,
  add column if not exists school_ct           integer,
  add column if not exists pharmacy_ct         integer,
  add column if not exists nursery_ct          integer,
  add column if not exists bus_ct              integer,
  add column if not exists amenity_score       numeric,
  add column if not exists regen_score         numeric,
  add column if not exists access_score        numeric,
  add column if not exists housing_score       numeric,
  add column if not exists benefit_score       numeric;

-- 4. Benefit rebuild ---------------------------------------------------------
-- Recomputes the socio-economic columns for every station in one indexed pass.
-- Weights are parameters so the composite can be re-weighted without a data
-- reload. Housing score is a cross-station percentile, so it needs the whole set
-- in one statement (done here in a CTE window).
create or replace function public.rebuild_station_socioecon(
  radius_m  double precision default 800,
  w_regen   numeric default 1,
  w_access  numeric default 1,
  w_housing numeric default 1
)
returns integer
language plpgsql
as $$
declare n integer;
begin
  with cat as (
    select s.crs,
           sum(l.population) as pop,
           case when sum(l.population) > 0
                then sum(l.population * l.overall_norm)   / sum(l.population) end as imd,
           case when sum(l.population) > 0
                then sum(l.population * l.income_norm)    / sum(l.population) end as income,
           case when sum(l.population) > 0
                then sum(l.population * l.health_norm)    / sum(l.population) end as health,
           case when sum(l.population) > 0
                then sum(l.population * l.education_norm) / sum(l.population) end as education
    from public.stations s
    join public.lsoa_imd l
      on st_dwithin(l.geom::geography, st_makepoint(s.lng, s.lat)::geography, radius_m)
    group by s.crs
  ),
  -- Fallback for isolated stations whose catchment catches no LSOA centroid
  -- (large rural LSOAs): use the single nearest LSOA so regen is never a false 0.
  nearest as (
    select s.crs, nl.population, nl.overall_norm, nl.income_norm,
           nl.health_norm, nl.education_norm
    from public.stations s
    cross join lateral (
      select l.population, l.overall_norm, l.income_norm, l.health_norm, l.education_norm
      from public.lsoa_imd l
      order by l.geom <-> st_setsrid(st_makepoint(s.lng, s.lat), 4326)
      limit 1
    ) nl
  ),
  amen as (
    select s.crs,
           count(*) filter (where a.kind = 'gp')       as gp_ct,
           count(*) filter (where a.kind = 'school')   as school_ct,
           count(*) filter (where a.kind = 'pharmacy') as pharmacy_ct,
           count(*) filter (where a.kind = 'nursery')  as nursery_ct,
           count(*) filter (where a.kind = 'bus_stop') as bus_ct
    from public.stations s
    join public.amenities a
      on st_dwithin(a.geom::geography, st_makepoint(s.lng, s.lat)::geography, radius_m)
    group by s.crs
  ),
  comp as (
    select s.crs,
           coalesce(c.pop, nr.population)           as pop,
           coalesce(c.imd, nr.overall_norm)         as imd,
           coalesce(c.income, nr.income_norm)       as income,
           coalesce(c.health, nr.health_norm)       as health,
           coalesce(c.education, nr.education_norm)  as education,
           coalesce(am.gp_ct, 0)       as gp_ct,
           coalesce(am.school_ct, 0)   as school_ct,
           coalesce(am.pharmacy_ct, 0) as pharmacy_ct,
           coalesce(am.nursery_ct, 0)  as nursery_ct,
           coalesce(am.bus_ct, 0)      as bus_ct,
           -- Local amenity completeness (0–100): each of gp/pharmacy/school/nursery
           -- present within the catchment = 20; bus density scaled to 20 at 10+.
           (least(coalesce(am.gp_ct, 0), 1) * 20
            + least(coalesce(am.pharmacy_ct, 0), 1) * 20
            + least(coalesce(am.school_ct, 0), 1) * 20
            + least(coalesce(am.nursery_ct, 0), 1) * 20
            + least(coalesce(am.bus_ct, 0), 10)::numeric / 10 * 20) as amenity_score,
           coalesce(s.connectivity_pctile, 0) as connectivity_pctile,
           coalesce(a.dwelling_yield, 0)       as dwelling_yield
    from public.stations s
    join public.station_assessments a on a.crs = s.crs
    left join cat     c  on c.crs  = s.crs
    left join nearest nr on nr.crs = s.crs
    left join amen    am on am.crs = s.crs
  ),
  scored as (
    select crs, pop, imd, income, health, education,
           gp_ct, school_ct, pharmacy_ct, nursery_ct, bus_ct, amenity_score,
           coalesce(imd, 0)                                        as regen_score,
           (0.6 * amenity_score + 0.4 * connectivity_pctile)       as access_score,
           -- percent_rank() is double precision; cast so round(_, 1) resolves.
           (100 * percent_rank() over (order by dwelling_yield))::numeric as housing_score
    from comp
  )
  update public.station_assessments t set
    catchment_pop       = sc.pop,
    catchment_imd       = round(sc.imd, 1),
    catchment_income    = round(sc.income, 1),
    catchment_health    = round(sc.health, 1),
    catchment_education = round(sc.education, 1),
    gp_ct = sc.gp_ct, school_ct = sc.school_ct, pharmacy_ct = sc.pharmacy_ct,
    nursery_ct = sc.nursery_ct, bus_ct = sc.bus_ct,
    amenity_score = round(sc.amenity_score, 1),
    regen_score   = round(sc.regen_score, 1),
    access_score  = round(sc.access_score, 1),
    housing_score = round(sc.housing_score, 1),
    benefit_score = round((w_regen * sc.regen_score
                           + w_access * sc.access_score
                           + w_housing * sc.housing_score)
                          / nullif(w_regen + w_access + w_housing, 0), 1)
  from scored sc
  where t.crs = sc.crs;

  get diagnostics n = row_count;
  return n;
end
$$;

-- ---------------------------------------------------------------------------
-- ONE-OFF DATA OPS (run after web/data/lsoa_imd_points.geojson is published):
--   1) Load the LSOA centroid layer via the http extension:
--        create extension if not exists http with schema extensions;
--        insert into public.lsoa_imd (...)
--        select ... from jsonb_array_elements(
--          (extensions.http_get('https://locgrimshaw.github.io/mastermapper/data/lsoa_imd_points.geojson')).content::jsonb -> 'features') f
--        on conflict (lsoa_code) do update set ...;
--   2) Backfill stations' connectivity fields from the published stations.geojson.
--   3) select public.rebuild_station_socioecon();   -- writes the benefit columns
-- ---------------------------------------------------------------------------
