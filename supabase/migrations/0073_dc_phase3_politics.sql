-- 0073_dc_phase3_politics.sql
--
-- Phase 3 of the data-centre sift: planning history and politics.
--
-- dc_application: every planning application PlanIt has that mentions a data
-- centre ("data centre" / "data center" / datacentre; planit.org.uk, free with
-- fair-use limits), swept 2015→now and deduplicated by PlanIt uid. Individual
-- rows serve a map overlay; the aggregate feeds the LAD choropleth.
--
-- rebuild_dc_rates(): aggregates dc_application per local authority and writes
-- the 'planit_dc_rates' dataset into map_features on LAD polygons — approval
-- percentage only where at least 5 applications were decided (below that the
-- frontend shows the count, colourless, rather than a rate that is noise).
-- Authority match is spatial where the application has coordinates, else by
-- normalised name.
--
-- rebuild_council_control_features(): writes the 'council_control' dataset —
-- LAD polygons carrying the seat arithmetic from council_control (0071) — so
-- political control renders as an ordinary features_in_bbox layer. Counties
-- and combined authorities in the source simply don't match a LAD name and
-- are skipped; the district is the planning authority in two-tier areas.

create table if not exists public.dc_application (
  uid          text primary key,
  area         text,
  state        text,
  size         text,
  app_type     text,
  start_date   date,
  decided_date date,
  lng          double precision,
  lat          double precision,
  descr        text,
  link         text,
  geom geometry(Point, 4326) generated always as (
    case when lng is not null and lat is not null
         then st_setsrid(st_makepoint(lng, lat), 4326) end) stored
);
create index if not exists dc_application_geom_gix
  on public.dc_application using gist (geom);
grant select on public.dc_application to anon, authenticated;
alter table public.dc_application enable row level security;
do $$ begin
  create policy dc_application_read on public.dc_application for select using (true);
exception when duplicate_object then null; end $$;

-- Point overlay: applications with a location, decision first.
create or replace function public.dc_app_points()
returns table(lng double precision, lat double precision, state text,
              size text, decided date, area text, uid text, descr text, link text)
language sql stable as $$
  select lng, lat, state, size, decided_date, area, uid, descr,
         coalesce(link, 'https://www.planit.org.uk/planapplic/' || uid || '/')
    from public.dc_application
   where lng is not null and lat is not null;
$$;
grant execute on function public.dc_app_points() to anon, authenticated;

-- Loads the swept application records from the JSON artifact committed to the
-- repo (data/planit_dc_applications.json) — fetched server-side via the http
-- extension, so a refresh is one function call after a new sweep is pushed.
create or replace function public.load_dc_applications(p_url text)
returns integer language plpgsql as $$
declare resp text; n integer;
begin
  select content into resp from extensions.http_get(p_url);
  insert into public.dc_application
    (uid, area, state, size, app_type, start_date, decided_date, lng, lat, descr)
  select r->>'uid', r->>'area', r->>'state', r->>'size', r->>'type',
         (r->>'start')::date, (r->>'decided')::date,
         (r->>'lng')::double precision, (r->>'lat')::double precision,
         r->>'desc'
    from jsonb_array_elements(resp::jsonb) r
  on conflict (uid) do update
    set state = excluded.state, decided_date = excluded.decided_date,
        area = excluded.area, size = excluded.size, app_type = excluded.app_type,
        start_date = excluded.start_date, lng = excluded.lng, lat = excluded.lat,
        descr = excluded.descr;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.load_dc_applications(text)
  from public, anon, authenticated;

create or replace function public.rebuild_dc_rates()
returns integer language plpgsql as $$
declare n integer;
begin
  delete from public.map_features where dataset = 'planit_dc_rates';
  insert into public.map_features (dataset, source_id, name, props, geom)
  with lad as (
    select source_id, name, props->>'lad_code' as code, geom,
           lower(regexp_replace(trim(name),
             '^(City of |Royal Borough of |London Borough of )', '')) as norm
      from public.map_features where dataset = 'lad_boundary'),
  app as (
    select a.uid, a.state,
           coalesce(
             (select l.source_id from lad l
               where a.geom is not null and l.geom && a.geom
                 and st_contains(l.geom, a.geom) limit 1),
             (select l.source_id from lad l
               where lower(regexp_replace(trim(coalesce(a.area, '')),
                       '^(City of |Royal Borough of |London Borough of )', ''))
                     = l.norm limit 1)) as lad_sid
      from public.dc_application a),
  agg as (
    -- PlanIt's 'Conditions' state is permission granted subject to
    -- conditions — an approval for rate purposes.
    select lad_sid,
           count(*)::int as dc_apps,
           count(*) filter (where state in ('Permitted','Conditions'))::int as approved,
           count(*) filter (where state = 'Rejected')::int  as refused,
           count(*) filter (where state = 'Withdrawn')::int as withdrawn,
           count(*) filter (where state is null
             or state not in ('Permitted','Conditions','Rejected','Withdrawn'))::int as other
      from app where lad_sid is not null group by 1)
  select 'planit_dc_rates', l.source_id, l.name,
         jsonb_build_object(
           'lad_code', l.code,
           'dc_apps', g.dc_apps,
           'dc_approved', g.approved,
           'dc_refused', g.refused,
           'dc_withdrawn', g.withdrawn,
           'dc_pending', g.other) ||
         case when g.approved + g.refused >= 5
              then jsonb_build_object('dc_approval_pct',
                     round(100.0 * g.approved / (g.approved + g.refused), 1))
              else '{}'::jsonb end,
         l.geom
    from agg g join lad l on l.source_id = g.lad_sid;
  get diagnostics n = row_count;

  -- Mirror the located applications as a point dataset so the ordinary
  -- features_in_bbox path serves them (dataset 'dc_application').
  delete from public.map_features where dataset = 'dc_application';
  insert into public.map_features (dataset, source_id, name, props, geom)
  select 'dc_application', a.uid, a.area,
         jsonb_build_object(
           'state', a.state, 'size', a.size, 'area', a.area,
           'decided', to_char(a.decided_date, 'YYYY-MM-DD'),
           'descr', left(a.descr, 200),
           'link', coalesce(a.link,
             'https://www.planit.org.uk/planapplic/' || a.uid || '/')),
         a.geom
    from public.dc_application a
   where a.geom is not null;

  analyze public.map_features;
  return n;
end $$;
revoke execute on function public.rebuild_dc_rates() from public, anon, authenticated;

create or replace function public.rebuild_council_control_features()
returns integer language plpgsql as $$
declare n integer;
begin
  delete from public.map_features where dataset = 'council_control';
  insert into public.map_features (dataset, source_id, name, props, geom)
  select 'council_control', f.source_id, f.name,
         jsonb_build_object(
           'lad_code', f.props->>'lad_code',
           'control', c.control,
           'largest', c.largest,
           'largest_seats', c.largest_seats,
           'total_seats', c.total_seats,
           'seats', c.seats,
           'asof', to_char(c.asof, 'YYYY-MM-DD')),
         f.geom
    from public.map_features f
    join public.council_control c
      on lower(trim(c.council)) = lower(trim(f.name))
      or lower(trim(c.council)) = lower(regexp_replace(trim(f.name),
           '^(City of |Royal Borough of |London Borough of )', ''))
   where f.dataset = 'lad_boundary';
  get diagnostics n = row_count;
  analyze public.map_features;
  return n;
end $$;
revoke execute on function public.rebuild_council_control_features()
  from public, anon, authenticated;

-- mp_constituency: Westminster constituencies (July 2024 boundaries, ONS BUC
-- ultra-generalised) fetched server-side via the http extension straight from
-- the ONS ArcGIS service — 650 polygons in 7 pages, no client paste needed.
-- The sitting MP + party (UK Parliament Members API) are then merged into
-- props by constituency name from a temp table loaded by the deploy tooling
-- (docs/MANUAL_TASKS.md carries the refresh procedure for both).
create or replace function public.rebuild_mp_boundaries()
returns integer language plpgsql as $$
declare off int; resp text; j jsonb; n integer;
begin
  delete from public.map_features where dataset = 'mp_constituency';
  for off in 0..6 loop
    select content into resp from extensions.http_get(
      'https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/Westminster_Parliamentary_Constituencies_July_2024_Boundaries_UK_BUC/FeatureServer/0/query?where=1%3D1&outFields=PCON24CD,PCON24NM&f=geojson&resultOffset='
      || (off * 100)::text || '&resultRecordCount=100');
    j := resp::jsonb;
    insert into public.map_features (dataset, source_id, name, props, geom)
    select 'mp_constituency',
           f->'properties'->>'PCON24CD',
           f->'properties'->>'PCON24NM',
           jsonb_build_object('pcon_code', f->'properties'->>'PCON24CD'),
           st_multi(st_makevalid(st_setsrid(st_geomfromgeojson(f->'geometry'), 4326)))
      from jsonb_array_elements(j->'features') f
    on conflict (dataset, source_id) do nothing;
  end loop;
  get diagnostics n = row_count;
  analyze public.map_features;
  return n;
end $$;
revoke execute on function public.rebuild_mp_boundaries()
  from public, anon, authenticated;
