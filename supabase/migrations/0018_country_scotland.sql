-- 0018_country_scotland.sql
-- First step of Scotland integration: tag every station (and its assessment) with
-- a country, so England and Scotland can be sifted separately (their metrics don't
-- directly align — England is NPPF/IMD, Scotland is NPF4/SIMD). Defaults to
-- 'england' so all existing rows keep their meaning; the Scottish station load
-- sets 'scotland'.

alter table public.stations
  add column if not exists country text not null default 'england';

alter table public.station_assessments
  add column if not exists country text not null default 'england';

-- Keep the assessment's country in step with its station.
update public.station_assessments a
  set country = s.country
  from public.stations s
  where a.crs = s.crs and a.country is distinct from s.country;

create index if not exists stations_country_idx on public.stations (country);
create index if not exists station_assessments_country_idx on public.station_assessments (country);

comment on column public.stations.country is
  'england | scotland — drives which framework/deprivation index the sift applies. Scotland is sifted separately (NPF4/SIMD, provisional density floors).';
