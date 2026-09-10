-- 0081_pipr_series.sql
--
-- The ONS Price Index of Private Rents MONTHLY HISTORY, and two corrections
-- to what 0075 said about the snapshot table it created.
--
-- 1. THE HISTORY. PIPR publishes every month from January 2015 for nine
--    series per area (all properties; 1/2/3/4+ bedrooms; detached, semi-
--    detached, terraced, flat or maisonette). Held long that is ~437,000
--    rows for ~350 areas. Held as ONE ROW PER (area, series) with the months
--    as arrays it is ~3,100 rows, and a single select returns everything
--    needed to draw an area's rent trend — which is how the client uses it.
--    Arrays are dense from first_period, one element per month, NULL where a
--    month is absent, so a point's date is first_period + its index.
--
-- 2. CORRECTION: 0075 called PIPR "accredited official statistics". It is
--    not. The workbook's own cover sheet says "official statistics in
--    development". The distinction matters when the number is quoted into a
--    viability appraisal, so it is fixed here and in the UI.
--
-- 3. CORRECTION: 0075 said PIPR is "refreshed MONTHLY at a stable ONS URL".
--    There is no stable URL — every release lands on its own dated path with
--    an unpredictable filename ("...statistics13.xlsx"), so the pipeline
--    discovers the newest release from the dataset landing page instead.
--    0075 also referenced pipeline/build_pipr_rents.py, which never existed;
--    the real pipeline is pipeline/build_pipr.py + pipeline/pipr.py.
--
-- Scotland appears only as 18 ONS RENTAL GROUPINGS (S33 — "Ayrshires",
-- "Greater Glasgow"), which are not council areas and have no published
-- boundaries, and its rents are mainly advertised NEW LETS (workbook note 8)
-- so they are not like-for-like with England and Wales. Northern Ireland's
-- Broad Rental Market Areas carry no area code at all. Both are therefore
-- kept for the appraisal's fallback chain but are NOT drawn on the map.
--
-- Source: ONS, Crown copyright, Open Government Licence v3.0.

create table if not exists public.pipr_series (
  code text not null,             -- ONS area code (LAD / region / country)
  series text not null,           -- all | b1..b4 | det | semi | terr | flat
  first_period text not null,     -- 'YYYY-MM' of element 0
  rents integer[] not null,       -- £/calendar month, one per month
  chg real[],                     -- ONS annual % change, one per month
  primary key (code, series)
);
grant select on public.pipr_series to anon, authenticated;
alter table public.pipr_series enable row level security;
do $$ begin
  create policy pipr_series_read on public.pipr_series for select using (true);
exception when duplicate_object then null; end $$;

comment on table public.pipr_series is
  'ONS Price Index of Private Rents monthly history, one row per area and '
  'series, months held as dense arrays from first_period. Official '
  'statistics in development (not accredited). OGL v3.';

-- The snapshot table gains the region (for the viability fallback chain) and
-- the headline annual change, both already in the workbook.
alter table public.pipr_rents add column if not exists region text;
alter table public.pipr_rents add column if not exists chg real;

comment on table public.pipr_rents is
  'ONS Price Index of Private Rents, latest published month, £/calendar '
  'month by bedroom count and property type. Official statistics in '
  'development (not accredited); not seasonally adjusted. Scotland is '
  'published as 18 ONS rental groupings of advertised new lets, not council '
  'areas. Built by pipeline/build_pipr.py. OGL v3.';
