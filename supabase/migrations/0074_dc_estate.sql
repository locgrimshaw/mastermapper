-- 0074_dc_estate.sql
--
-- The UK data-centre estate as a single status-coloured layer, composited
-- from free sources (no commercial directory data):
--
--   built              OSM objects tagged telecom=data_center or
--                      building=data_center (fetched server-side from
--                      Overpass via the http extension into _osm_dc_raw —
--                      no single official register of data centres exists).
--   built-live-app     a built site with an undecided planning application
--                      mentioning a data centre within 400 m.
--   approved-pipeline  a Large data-centre application approved since 2019
--                      that is NOT within 500 m of any built site — the
--                      consented new-build pipeline. Approvals near a built
--                      site are counted on that site instead (expansions).
--
-- Alongside it, dc_tec_demand: TEC-register connections whose plant type
-- includes Demand at >=50 MW — in recent years dominated by data centres,
-- but filed through SPVs, so served as "probable DC-scale demand", never as
-- confirmed sites.
--
-- _osm_dc_raw holds the last raw Overpass response; fetch_osm_dc_sites()
-- refreshes it and rebuild_dc_estate() re-derives both datasets. Refresh
-- order: fetch_osm_dc_sites() -> rebuild_dc_estate() (docs/MANUAL_TASKS.md).

create table if not exists public._osm_dc_raw (
  id int primary key default 1,
  content text);

create or replace function public.fetch_osm_dc_sites()
returns integer language plpgsql as $$
declare n integer;
begin
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '150000');
  insert into public._osm_dc_raw (id, content)
  select 1, content from extensions.http_post(
    'https://overpass-api.de/api/interpreter',
    'data=' || extensions.urlencode($q$[out:json][timeout:120];
area["ISO3166-1"="GB"][admin_level=2]->.uk;
(
  nwr["telecom"="data_center"](area.uk);
  nwr["telecom"="data_centre"](area.uk);
  nwr["building"="data_center"](area.uk);
  nwr["building"="data_centre"](area.uk);
);
out tags center;$q$),
    'application/x-www-form-urlencoded')
  on conflict (id) do update set content = excluded.content;
  select jsonb_array_length(content::jsonb->'elements') into n from public._osm_dc_raw;
  return n;
end $$;
revoke execute on function public.fetch_osm_dc_sites()
  from public, anon, authenticated;

create or replace function public.rebuild_dc_estate()
returns integer language plpgsql as $$
declare n integer;
begin
  -- Parse the raw Overpass response. Ways carry center.lat/lon, nodes
  -- lat/lon. The same campus is sometimes mapped as several buildings plus
  -- a node: collapse anything within 150 m of a higher-priority element
  -- (relation > way > node; ties broken by osm id) into one site.
  create temp table _dc_osm on commit drop as
  with el as (
    select e->>'type' as otype, (e->>'id')::bigint as oid,
           coalesce((e->'center'->>'lat')::float, (e->>'lat')::float) as lat,
           coalesce((e->'center'->>'lon')::float, (e->>'lon')::float) as lng,
           e->'tags'->>'name' as name,
           e->'tags'->>'operator' as operator
      from public._osm_dc_raw r,
           jsonb_array_elements(r.content::jsonb->'elements') e),
  ranked as (
    select *,
           st_setsrid(st_makepoint(lng, lat), 4326)::geography as g,
           case otype when 'relation' then 3 when 'way' then 2 else 1 end as prio
      from el where lat is not null and lng is not null)
  select otype, oid, lat, lng, name, operator, g from ranked a
   where not exists (
     select 1 from ranked b
      where (b.prio > a.prio or (b.prio = a.prio and b.oid < a.oid))
        and st_dwithin(a.g, b.g, 150));

  delete from public.map_features where dataset = 'dc_site';

  -- Built sites, flagged when a live (undecided) application sits nearby,
  -- with nearby approvals counted as expansion signals.
  insert into public.map_features (dataset, source_id, name, props, geom)
  select 'dc_site',
         o.otype || '/' || o.oid,
         coalesce(o.name, 'Data centre'),
         jsonb_build_object(
           'status', case when live.n > 0 then 'built-live-app' else 'built' end,
           'operator', o.operator,
           'apps_near', apps.n,
           'apps_approved_near', apps.ok),
         st_setsrid(st_makepoint(o.lng, o.lat), 4326)
    from _dc_osm o
    cross join lateral (
      select count(*)::int as n
        from public.dc_application a
       where a.geom is not null
         and a.state in ('Undecided','Referred','Unresolved')
         and st_dwithin(a.geom::geography, o.g, 400)) live
    cross join lateral (
      select count(*)::int as n,
             count(*) filter (where a.state in ('Permitted','Conditions'))::int as ok
        from public.dc_application a
       where a.geom is not null
         and st_dwithin(a.geom::geography, o.g, 400)) apps;
  get diagnostics n = row_count;

  -- Consented new-build pipeline: Large approvals since 2019 away from any
  -- built site.
  insert into public.map_features (dataset, source_id, name, props, geom)
  select 'dc_site',
         'app/' || a.uid,
         coalesce(a.area, 'Approved data centre'),
         jsonb_build_object(
           'status', 'approved-pipeline',
           'decided', to_char(a.decided_date, 'YYYY-MM-DD'),
           'descr', left(a.descr, 200),
           'link', coalesce(a.link,
             'https://www.planit.org.uk/planapplic/' || a.uid || '/')),
         a.geom
    from public.dc_application a
   where a.geom is not null
     and a.state in ('Permitted','Conditions')
     and a.size = 'Large'
     and a.decided_date >= date '2019-01-01'
     and not exists (
       select 1 from _dc_osm o
        where st_dwithin(a.geom::geography, o.g, 500));

  -- Probable DC-scale demand: TEC register Demand-type connections >=50 MW.
  delete from public.map_features where dataset = 'dc_tec_demand';
  insert into public.map_features (dataset, source_id, name, props, geom)
  select 'dc_tec_demand', t.source_id, t.name,
         jsonb_build_object(
           'mw', t.props->>'mw',
           'status', t.props->>'status',
           'site', t.props->>'site',
           'effective', t.props->>'effective',
           'customer', t.props->>'customer'),
         t.geom
    from public.map_features t
   where t.dataset = 'tec_register'
     and t.props->>'plant' ilike '%demand%'
     and (t.props->>'mw')::numeric >= 50;

  analyze public.map_features;
  return n;
end $$;
revoke execute on function public.rebuild_dc_estate()
  from public, anon, authenticated;
