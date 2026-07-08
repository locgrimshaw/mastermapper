-- 0014_robust_in_settlement_rule.sql
-- CRITICAL fix to the NPPF tier test.
--
-- The old "in settlement" rule was a point-in-polygon test:
--   ST_Contains(built_land.geom, station_point).
-- OS Open Built-Up Areas leave the railway corridor as a GAP in the polygon, so
-- the station point often falls just outside the built-up area even in the middle
-- of dense London — South Bermondsey, New Southgate, Stonebridge Park and Mitcham
-- Junction were all wrongly classed as out-of-settlement (Tier B), which
-- discredited the whole sift early on.
--
-- New rule: measure the BUILT-UP FRACTION of the 800 m catchment. A station is
-- in-settlement when that fraction >= 0.40, OR >= 0.20 with a built-up area within
-- 100 m. This correctly keeps dense urban stations in Tier A while leaving genuine
-- rural stations (Bayford 0.16, Ockley 0.17) out.
--
-- This migration adds the built_frac column. The fast, reproducible implementation
-- of the rule (using a projected/subdivided built-up-area helper) lives in 0015 —
-- the raw-polygon geography version here was correct but far too slow to run over
-- all ~2,000 stations, so it is superseded.

alter table public.station_assessments
  add column if not exists built_frac double precision;

comment on column public.station_assessments.built_frac is
  'Built-up fraction of the 800 m catchment (OS Open Built-Up Areas). '
  'in_settlement = built_frac >= 0.40 OR (>= 0.20 AND a built-up area within 100 m).';
