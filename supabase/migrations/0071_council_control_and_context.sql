-- 0071_council_control_and_context.sql
--
-- Council political control, and a one-shot station-context RPC.
--
-- council_control: the party composition and control of every GB council,
-- derived from Open Council Data UK's councillor CSV (public domain /
-- CC-licensed; opencouncildata.co.uk, csv2.php?y=2026, 19,274 councillors
-- across 384 councils as of the May 2026 elections). "Control" here is the
-- SEAT arithmetic — the largest party where it holds a majority, else "No
-- overall control" — not the coalition actually running the council, which
-- the source does not carry. The deep dive says so where it shows it.
-- Refresh: re-derive after each May's elections (see docs/MANUAL_TASKS.md).
--
-- dd_station_context(lng,lat): one round trip for the deep dive's Key Facts —
-- the local authority at a point (LAD boundary point-in-polygon) joined to
-- its council control by normalised name. Name-join because Open Council
-- Data has no GSS codes: counties and combined authorities simply won't
-- match a LAD and return null control, which is correct — the district is
-- the planning authority in two-tier areas.

create table if not exists public.council_control (
  council       text primary key,
  control       text not null,
  largest       text not null,
  largest_seats integer not null,
  total_seats   integer not null,
  seats         jsonb not null,
  asof          timestamptz not null default now());

grant select on public.council_control to anon, authenticated;

create or replace function public.dd_station_context(p_lng double precision, p_lat double precision)
returns jsonb language sql stable as $$
  with pt as (select st_setsrid(st_makepoint(p_lng, p_lat), 4326) g),
  lad as (
    select f.props->>'lad_code' as code, f.name
      from public.map_features f, pt
     where f.dataset = 'lad_boundary' and st_contains(f.geom, pt.g)
     limit 1),
  cc as (
    select c.* from public.council_control c, lad
     where lower(trim(c.council)) = lower(trim(lad.name))
        or lower(trim(c.council)) = lower(regexp_replace(trim(lad.name),
             '^(City of |Royal Borough of |London Borough of )', ''))
     limit 1)
  select jsonb_build_object(
    'lad_code', (select code from lad),
    'lad_name', (select name from lad),
    'control',  (select control from cc),
    'largest',  (select largest from cc),
    'largest_seats', (select largest_seats from cc),
    'total_seats',   (select total_seats from cc),
    'asof',     (select to_char(asof, 'YYYY-MM-DD') from cc));
$$;

grant execute on function public.dd_station_context(double precision, double precision)
  to anon, authenticated;

-- Data load: the derived rows are inserted by the deploy tooling (79 kB of
-- VALUES; see pipeline notes) rather than inlined here.
