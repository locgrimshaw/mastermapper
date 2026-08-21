-- 0063: the published NPPF's well-connected test, and the frequency figures
-- behind it.
--
-- TWO CORRECTIONS, both scalar. Neither touches geometry, which is what makes
-- them cheap: tier, density_floor and dwelling_yield are pure functions of
-- in_settlement, well_connected and the ALREADY-STORED developable_ha (see
-- 0012). Re-deriving them is an update of three small columns on 2,382 rows,
-- not another pass over developable_land_near_station.
--
-- 1. TOP 80, NOT TOP 60. Annex B of the August 2026 Framework defines a
--    well-connected station as one "located within a top 80 Travel to Work
--    Area located partially or fully within England by Gross Value Added".
--    We were carrying the 2024 consultation draft's top 60, which held 86
--    stations a tier below where the Framework puts them — suppressing their
--    density floor and, where they sit outside a settlement, denying them the
--    Tier B Green Belt route under GB7(1)(h).
--
--    The GVA vintage is fixed by the Framework itself: 2023 data applies until
--    the day after the 2028 data publishes, then holds for five-year periods.
--    Do not "helpfully" update it early.
--
-- 2. SUSTAINED TRAINS PER HOUR. Policy S5(2)(c) sets a minimum density of 35
--    dwellings per hectare near a well-connected station, rising to 45 "where
--    the service frequency is at least twice that of the minimum required for
--    a well-connected station" — so 8 trains an hour overall, or 4 in one
--    direction. We could not identify that tier because only the boolean was
--    stored, though the timetable pipeline has always computed the numbers.
--    Adding the columns makes the higher minimum a per-station fact instead of
--    a caveat in the copy.
--
-- NOTE these are the Framework's MINIMA. The tool's own 40/50 floors sit above
-- them deliberately, since S5(3) requires the minima to be exceeded where
-- possible; this migration does not lower them to the statutory floor.

alter table public.stations
  add column if not exists sustained_tph         numeric,
  add column if not exists sustained_tph_per_dir numeric;

comment on column public.stations.sustained_tph is
  'Minimum departures per clock hour sustained through the daytime (NOT the '
  'peak). The NPPF frequency limb needs >= 4; policy S5(2)(c) double '
  'frequency needs >= 8.';
comment on column public.stations.sustained_tph_per_dir is
  'The same sustained measure taken per direction. Frequency limb >= 2; '
  'double frequency >= 4.';

-- The published definition. meets_frequency is unchanged — only the GVA limb
-- moved — so this is purely the top-60 -> top-80 widening.
update public.stations
   set well_connected = (meets_frequency and ttwa_gva_rank is not null
                         and ttwa_gva_rank <= 80)
 where coalesce(well_connected, false)
       <> (meets_frequency and ttwa_gva_rank is not null
           and ttwa_gva_rank <= 80);

-- Re-derive the three scalars that hang off well_connected, using the stored
-- developable hectares. Same arithmetic as 0012's rebuild, without the RPC.
update public.station_assessments a
   set tier = case when a.in_settlement then 'A'
                   when s.well_connected then 'B' else 'ineligible' end,
       density_floor = case when s.well_connected then 50
                            when a.in_settlement then 40 else null end,
       dwelling_yield = round(coalesce(a.developable_ha, 0)
         * (case when s.well_connected then 50
                 when a.in_settlement then 40 else 0 end))::int
  from public.stations s
 where s.crs = a.crs;
