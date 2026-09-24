-- 0083 · London sites sift.
--
-- A precomputed table of every candidate development plot inside Greater
-- London, each carrying the evidence the "London sites" sifter filters and
-- ranks on, so the browser can reorder and toggle gates without a fetch:
--
--   candidate land   brownfield register, OSM derelict/works land, underused
--                    built land (industrial, retail sheds, yards, surface car
--                    parks), green space and low-density leisure, grey belt
--   access           PTAL, DfT connectivity (OA), nearest station, and a
--                    door-to-Zone-1 journey time from a combined TfL + national
--                    rail graph (london_transit_node / _edge)
--   market           ONS private rents by borough, agent office rents by
--                    submarket, VOA office rateable values nearby, £/m² prices
--   growth           price and rent growth, planning approval rate, housing
--                    delivery pressure, land value, CIL
--   policy / form    CAZ, development corporations, Opportunity Areas, SIL,
--                    Metropolitan Open Land, LSIS, SINC (layers from 0084),
--                    Article 4, heritage,
--                    flood risk, TPO, AQMA, public ownership, surrounding
--                    building heights (intensification headroom)
--
-- Build order (service role): rebuild_london_transit(), then
-- rebuild_london_sites(stage) for each stage in turn — 'base', 'access',
-- 'market', 'growth', 'policy', 'form'. Every stage after 'base' also takes an
-- id range (p_from, p_to), so a caller behind the API gateway's ~100 s request
-- limit can run it in chunks (.github/workflows/rebuild-london-sites.yml).

-- ───────────────────────── transit graph ─────────────────────────

create table if not exists public.london_transit_node (
  id       text primary key,           -- TfL NaPTAN id, or 'NR:'||crs
  name     text,
  kind     text not null,              -- 'tfl' | 'rail'
  zone     text,
  z1       boolean not null default false,
  modes    text[],
  geom     geometry(Point, 4326) not null,
  mins_z1  real                        -- station → any Zone 1 stop, incl. waits
);
create index if not exists london_transit_node_gix on public.london_transit_node using gist (geom);

-- State graph for the shortest-path pass. Street nodes 'S:<stop>' and
-- platform nodes 'L:<line>:<stop>'; an edge u→v costs `cost` minutes to travel
-- from u to v, so time-to-Zone-1 is dist(u) = min(cost + dist(v)).
create table if not exists public.london_transit_edge (
  u text not null, v text not null, cost real not null
);
create index if not exists london_transit_edge_v_idx on public.london_transit_edge (v);

create or replace function public.rebuild_london_transit(
  p_url text default 'https://raw.githubusercontent.com/locgrimshaw/mastermapper/main/pipeline/data/london_transit.json'
) returns jsonb
language plpgsql
set search_path = public, extensions
set statement_timeout = '10min'
as $$
declare
  j jsonb;
  n int;
  it int := 0;
begin
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '60000');
  select content::jsonb into j from extensions.http_get(p_url);
  if j is null or jsonb_array_length(j->'nodes') < 100 then
    raise exception 'transit JSON missing or too small at %', p_url;
  end if;

  truncate london_transit_node, london_transit_edge;

  insert into london_transit_node (id, name, kind, zone, z1, modes, geom)
  select x->>'id', x->>'name', 'tfl', x->>'zone', coalesce((x->>'z1')::boolean, false),
         array(select jsonb_array_elements_text(x->'modes')),
         st_setsrid(st_makepoint((x->>'lon')::float8, (x->>'lat')::float8), 4326)
  from jsonb_array_elements(j->'nodes') x
  on conflict (id) do nothing;

  -- National rail across the wider South East, so commuter lines into the
  -- termini route properly even when they leave the GLA boundary.
  insert into london_transit_node (id, name, kind, modes, geom)
  select 'NR:' || crs, name, 'rail', array['national-rail'],
         st_setsrid(st_makepoint(lng, lat), 4326)
  from stations
  where lng between -1.3 and 1.0 and lat between 50.8 and 52.2
  on conflict (id) do nothing;

  -- A rail station beside a Zone 1 TfL stop is itself in Zone 1 (the termini).
  update london_transit_node r set z1 = true, zone = '1'
  where r.kind = 'rail' and exists (
    select 1 from london_transit_node t
    where t.kind = 'tfl' and t.z1
      and st_dwithin(t.geom::geography, r.geom::geography, 250));

  -- Ride hops, both directions.
  insert into london_transit_edge (u, v, cost)
  select 'L:' || (e->>'line') || ':' || (e->>'a'), 'L:' || (e->>'line') || ':' || (e->>'b'), (e->>'min')::real
  from jsonb_array_elements(j->'edges') e
  union all
  select 'L:' || (e->>'line') || ':' || (e->>'b'), 'L:' || (e->>'line') || ':' || (e->>'a'), (e->>'min')::real
  from jsonb_array_elements(j->'edges') e;

  -- Boarding costs a typical wait for the mode; alighting a 2-minute walk out.
  with served as (
    select distinct e->>'line' line, e->>'mode' mode, s.stop
    from jsonb_array_elements(j->'edges') e,
         lateral (values (e->>'a'), (e->>'b')) s(stop)
  )
  insert into london_transit_edge (u, v, cost)
  select 'S:' || stop, 'L:' || line || ':' || stop,
         case mode when 'tube' then 2.5 when 'dlr' then 3 when 'elizabeth-line' then 3.5
                   when 'tram' then 4 else 5 end
  from served
  union all
  select 'L:' || line || ':' || stop, 'S:' || stop, 2 from served;

  -- National rail: each link is a one-seat ride; boarding waits half the
  -- headway over an 18-hour day, capped at 10 minutes.
  insert into london_transit_edge (u, v, cost)
  select 'S:NR:' || l.crs_from, 'S:NR:' || l.crs_to,
         l.minutes + least(10, 540.0 / greatest(l.trains_day, 1))
  from station_links l
  where l.minutes > 0
    and exists (select 1 from london_transit_node a where a.id = 'NR:' || l.crs_from)
    and exists (select 1 from london_transit_node b where b.id = 'NR:' || l.crs_to);

  -- Walking interchanges between separate stops up to 400 m apart.
  insert into london_transit_edge (u, v, cost)
  select 'S:' || a.id, 'S:' || b.id,
         1 + st_distance(a.geom::geography, b.geom::geography) * 1.25 / 80
  from london_transit_node a
  join london_transit_node b
    on a.id <> b.id and st_dwithin(a.geom::geography, b.geom::geography, 400);

  -- Bellman-Ford from every Zone 1 stop (set-based relaxation).
  create temp table if not exists _lt_dist (id text primary key, dist real not null);
  truncate _lt_dist;
  insert into _lt_dist
  select id, 1e9 from (select u id from london_transit_edge union select v from london_transit_edge) s;
  update _lt_dist d set dist = 0
  from london_transit_node t
  where t.z1 and (d.id = 'S:' || t.id or d.id like 'L:%:' || t.id);

  loop
    it := it + 1;
    with c as (
      select e.u, min(dv.dist + e.cost) nd
      from london_transit_edge e join _lt_dist dv on dv.id = e.v
      where dv.dist < 1e8
      group by e.u
    )
    update _lt_dist d set dist = c.nd from c
    where d.id = c.u and c.nd < d.dist - 0.05;
    get diagnostics n = row_count;
    exit when n = 0 or it >= 300;
  end loop;

  update london_transit_node t set mins_z1 = round(d.dist::numeric, 1)
  from _lt_dist d where d.id = 'S:' || t.id and d.dist < 1e8;

  return jsonb_build_object(
    'nodes', (select count(*) from london_transit_node),
    'edges', (select count(*) from london_transit_edge),
    'reached', (select count(*) from london_transit_node where mins_z1 is not null),
    'iterations', it);
end $$;

-- ───────────────────────── candidate sites ─────────────────────────

create table if not exists public.london_sites (
  id              serial primary key,
  src             text not null,     -- register | osm_brownfield | osm_industrial | osm_retail
                                     -- | osm_storage | osm_parking | green_space | osm_leisure | grey_belt
  src_id          text,
  cat             text not null,     -- brownfield | underused | green | grey_belt
  subtype         text,
  name            text,
  pdl             boolean,
  area_ha         real,
  lad_code        text,
  borough         text,
  geom            geometry(Geometry, 4326),
  pt              geometry(Point, 4326),
  -- access
  ptal            text,
  ptal_ai         real,
  conn_pt         real,              -- DfT connectivity, public transport, all purposes (0-100)
  conn_all        real,              -- all modes
  conn_emp        real,              -- public transport to employment
  stn_name        text,
  stn_m           real,
  z1_min          real,              -- door-to-Zone-1 minutes (walk + wait + ride)
  z1_via          text,
  -- market
  resi_rent       real,              -- ONS PIPR mean £ pcm, borough
  resi_rent_2b    real,
  office_submkt   text,
  office_prime    real,              -- agent £/ft² pa, nearest submarket
  office_mid      real,
  office_voa_pm2  real,              -- median VOA office rateable value £/m², ~400 m
  office_n        integer,           -- VOA office hereditaments, ~400 m
  price_ppm2      real,              -- residential sales £/m², local grid
  -- growth
  price_trend     real,              -- % change in local £/m², recent vs prior window
  rent_chg        real,              -- % annual private rent change, borough
  rent_g5         real,              -- % five-year rent growth, borough
  approval_pct    real,              -- planning approvals, borough, 3 yrs
  plan_vs_lhn     real,              -- adopted plan supply as % of standard-method need
  land_value      real,              -- £/ha residential land value, borough
  cil             real,              -- borough CIL £/m² (indicative) + Mayoral
  -- policy / constraints
  in_caz          boolean,
  in_devcorp      boolean,
  in_oa           boolean,           -- London Plan Opportunity Area (0084)
  oa_name         text,
  in_sil          boolean,           -- Strategic Industrial Location (0084)
  in_mol          boolean,           -- Metropolitan Open Land (0084)
  in_lsis         boolean,           -- Locally Significant Industrial Site (0084)
  sinc_grade      text,              -- highest SINC grade touching the site (0084)
  article4        boolean,
  conservation    boolean,
  listed_n        integer,
  flood3          boolean,
  flood2          boolean,
  tpo             boolean,
  aqma            boolean,
  public_land     boolean,
  -- built form
  storeys_site    real,
  storeys_ctx     real,
  -- register detail
  dwellings_max   integer,
  permission      text
);
create index if not exists london_sites_geom_gix on public.london_sites using gist (geom);
create index if not exists london_sites_pt_gix on public.london_sites using gist (pt);

alter table public.london_sites enable row level security;
alter table public.london_transit_node enable row level security;
alter table public.london_transit_edge enable row level security;
grant select on public.london_sites, public.london_transit_node to anon, authenticated;
revoke all on public.london_transit_edge from anon, authenticated;
do $$ begin
  create policy london_sites_read on public.london_sites for select using (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy london_transit_node_read on public.london_transit_node for select using (true);
exception when duplicate_object then null; end $$;

-- Does a designation meaningfully cover a site? Centre inside it, or at
-- least 10% of the site's area under it. No SET clause and schema-qualified
-- PostGIS calls so the planner can inline it; callers pair it with
-- `m.geom && s.geom` so the spatial index still prunes candidates.
create or replace function public.london_site_covers(d extensions.geometry, site extensions.geometry, pt extensions.geometry)
returns boolean
language sql immutable parallel safe
as $$
  select extensions.st_intersects(d, pt)
      or (extensions.st_intersects(d, site)
          and extensions.st_area(extensions.st_intersection(d, site))
              >= 0.1 * greatest(extensions.st_area(site), 1e-12))
$$;

drop function if exists public.rebuild_london_sites(text);
create or replace function public.rebuild_london_sites(
  p_stage text, p_from int default 0, p_to int default 2147483647)
returns jsonb
language plpgsql
set search_path = public, extensions
set statement_timeout = '15min'
as $$
declare n int;
begin
  if p_stage = 'base' then
    truncate london_sites restart identity;

    create temp table if not exists _ldn (g geometry);
    truncate _ldn;
    insert into _ldn select st_union(geom) from map_features
      where dataset = 'lad_boundary' and source_id like 'E09%';

    -- Brownfield register (geography columns): polygon where published, else a
    -- circle of the stated area.
    insert into london_sites (src, src_id, cat, subtype, name, pdl, area_ha, geom, pt,
                              dwellings_max, permission, public_land)
    select 'register', b.id::text, 'brownfield', coalesce(b.permission_status, 'registered'),
           -- Many registers put a reference code ("NSP08", "15/06448/FULL") in
           -- the name; prefer the address unless the name reads like words.
           case when coalesce(b.name, '') ~ '\s' then b.name
                else coalesce(nullif(b.site_address, ''), nullif(b.name, '')) end, true,
           coalesce(b.hectares, st_area(b.area::geography) / 1e4),
           coalesce(b.area::geometry, st_buffer(b.geom::geography, sqrt(greatest(coalesce(b.hectares, 0.1), 0.01) * 1e4 / pi()))::geometry),
           b.geom::geometry, b.dwellings_max, b.permission_status, b.is_public
    from brownfield b, _ldn
    where st_intersects(b.geom::geometry, _ldn.g);

    -- OSM previously-developed land.
    insert into london_sites (src, src_id, cat, subtype, name, pdl, area_ha, geom, pt)
    select m.dataset, m.source_id,
           case when m.dataset = 'osm_brownfield' then 'brownfield' else 'underused' end,
           m.props->>'subtype', m.name, true, (m.props->>'ha')::real,
           st_simplifypreservetopology(m.geom, 0.00001), st_pointonsurface(m.geom)
    from map_features m, _ldn
    where m.dataset in ('osm_brownfield', 'osm_industrial', 'osm_retail', 'osm_storage', 'osm_parking')
      and st_intersects(m.geom, _ldn.g)
      and (m.props->>'ha')::real >= 0.05;

    -- Green space (OS Open Greenspace) and low-density leisure: not PDL.
    insert into london_sites (src, src_id, cat, subtype, name, pdl, area_ha, geom, pt)
    select 'green_space', p.source_id, 'green', p.props->>'function', p.name, false,
           st_area(p.geom::geography) / 1e4,
           st_simplifypreservetopology(p.geom, 0.00001), st_pointonsurface(p.geom)
    from planning_constraints p, _ldn
    where p.kind = 'green_space' and st_intersects(p.geom, _ldn.g)
      and st_area(p.geom::geography) >= 500;

    insert into london_sites (src, src_id, cat, subtype, name, pdl, area_ha, geom, pt)
    select 'osm_leisure', m.source_id, 'green', m.props->>'subtype', m.name, false,
           (m.props->>'ha')::real, st_simplifypreservetopology(m.geom, 0.00001), st_pointonsurface(m.geom)
    from map_features m, _ldn
    where m.dataset = 'osm_leisure_lowdensity' and st_intersects(m.geom, _ldn.g)
      and (m.props->>'ha')::real >= 0.05;

    -- Grey belt candidates (built-up Green Belt; the register-sourced ones are
    -- already in as register sites).
    insert into london_sites (src, src_id, cat, subtype, name, pdl, area_ha, geom, pt)
    select 'grey_belt', m.source_id, 'grey_belt', m.props->>'source', m.name, true,
           coalesce((m.props->>'area_ha')::real, st_area(m.geom::geography) / 1e4),
           st_simplifypreservetopology(m.geom, 0.00001), st_pointonsurface(m.geom)
    from map_features m, _ldn
    where m.dataset = 'grey_belt_candidate' and st_intersects(m.geom, _ldn.g)
      and coalesce(m.props->>'source', '') <> 'brownfield';

    -- De-duplicate: an OSM or grey-belt plot whose centre sits on a register
    -- site is the same land; keep the register record, which carries capacity.
    delete from london_sites s
    where s.src <> 'register' and s.cat <> 'green' and exists (
      select 1 from london_sites r
      where r.src = 'register' and st_intersects(r.geom, s.pt));
    -- Golf courses appear in both green-space sources.
    delete from london_sites s
    where s.src = 'osm_leisure' and exists (
      select 1 from london_sites g
      where g.src = 'green_space' and st_intersects(g.geom, s.pt));

    update london_sites s set lad_code = m.source_id, borough = m.name
    from map_features m
    where m.dataset = 'lad_boundary' and m.source_id like 'E09%' and st_intersects(m.geom, s.pt);

  elsif p_stage = 'access' then
    update london_sites s set ptal = m.props->>'ptal', ptal_ai = (m.props->>'ai')::real
    from map_features m
    where m.dataset = 'ptal' and st_intersects(m.geom, s.pt)
      and s.id between p_from and p_to;

    update london_sites s set conn_pt = (m.props->>'p_all')::real,
                              conn_all = (m.props->>'a_all')::real,
                              conn_emp = (m.props->>'p_emp')::real
    from map_features m
    where m.dataset = 'connectivity_oa' and st_intersects(m.geom, s.pt)
      and s.id between p_from and p_to;

    -- Nearest station and the fastest door-to-Zone-1 option among the eight
    -- nearest (walk at 80 m/min with a 1.25 street-detour factor).
    update london_sites s set stn_name = x.name, stn_m = x.m
    from (
      select s2.id, nn.name, st_distance(nn.geom::geography, s2.pt::geography) m
      from (select * from london_sites where id between p_from and p_to) s2
      cross join lateral (
        select t.name, t.geom from london_transit_node t
        order by t.geom <-> s2.pt limit 1) nn
    ) x where x.id = s.id;

    update london_sites s set z1_min = round(x.t::numeric, 1), z1_via = x.name
    from (
      select s2.id, best.t, best.name
      from (select * from london_sites where id between p_from and p_to) s2
      cross join lateral (
        select k.mins_z1 + st_distance(k.geom::geography, s2.pt::geography) * 1.25 / 80 t, k.name
        from (select t.* from london_transit_node t
              where t.mins_z1 is not null
              order by t.geom <-> s2.pt limit 8) k
        order by 1 limit 1) best
    ) x where x.id = s.id;

  elsif p_stage = 'market' then
    update london_sites s set resi_rent = (m.props->>'rent_all')::real,
                              resi_rent_2b = (m.props->>'rent_b2')::real,
                              rent_chg = (m.props->>'chg_all')::real,
                              rent_g5 = (m.props->>'g5_all')::real
    from map_features m
    where m.dataset = 'la_rents' and m.props->>'lad_code' = s.lad_code
      and s.id between p_from and p_to;

    update london_sites s set office_submkt = x.name, office_prime = x.prime, office_mid = x.mid
    from (
      select s2.id, a.name,
             (a.props->'prime'->>'avg')::real prime,
             coalesce((a.props->'mid'->>'avg')::real, (a.props->'low'->>'avg')::real) mid
      from (select * from london_sites where id between p_from and p_to) s2
      cross join lateral (
        select m.name, m.props, m.geom from map_features m
        where m.dataset = 'agent_office_rents'
        order by m.geom <-> s2.pt limit 1) a
      where st_dwithin(a.geom::geography, s2.pt::geography, 3000)
    ) x where x.id = s.id;

    update london_sites s set office_voa_pm2 = x.med, office_n = x.n
    from (
      select s2.id,
             percentile_cont(0.5) within group (order by (m.props->>'pm2')::real) med,
             count(*)::int n
      from (select * from london_sites where id between p_from and p_to) s2
      join map_features m
        on m.dataset = 'voa_offices' and st_dwithin(m.geom, s2.pt, 0.0045)
      where (m.props->>'pm2') is not null
      group by s2.id
    ) x where x.id = s.id;

    update london_sites s set price_ppm2 = (m.props->>'ppm2')::real,
                              price_trend = (m.props->>'trend_pct')::real
    from map_features m
    where m.dataset = 'price_grid_f' and st_intersects(m.geom, s.pt)
      and s.id between p_from and p_to;

    -- Borough figures where the local grid is too thin.
    update london_sites s set price_ppm2 = coalesce(s.price_ppm2, (m.props->>'ppm2')::real),
                              price_trend = coalesce(s.price_trend, (m.props->>'trend_pct')::real)
    from map_features m
    where m.dataset = 'lad_prices' and m.props->>'lad' = s.lad_code
      and (s.price_ppm2 is null or s.price_trend is null)
      and s.id between p_from and p_to;

  elsif p_stage = 'growth' then
    update london_sites s set approval_pct = (m.props->>'approval_pct')::real
    from map_features m
    where m.dataset = 'planit_rates' and st_intersects(m.geom, s.pt)
      and s.id between p_from and p_to;

    update london_sites s set plan_vs_lhn = (m.props->>'plan_vs_lhn')::real
    from map_features m
    where m.dataset = 'housing_need' and m.props->>'lad_code' = s.lad_code
      and s.id between p_from and p_to;

    update london_sites s set land_value = (m.props->>'resi_gbp_ha')::real
    from map_features m
    where m.dataset = 'land_value' and m.props->>'lad_code' = s.lad_code
      and s.id between p_from and p_to;

    update london_sites s set cil = coalesce((m.props->>'cil_pm2')::real, 0)
                                   + coalesce((m.props->>'mayoral')::real, 0)
    from map_features m
    where m.dataset = 'cil_rates' and m.props->>'lad_code' = s.lad_code
      and s.id between p_from and p_to;

  elsif p_stage = 'policy' then
    update london_sites s set
      in_caz = exists (select 1 from map_features m where m.dataset = 'central_activities_zone' and st_intersects(m.geom, s.pt)),
      in_devcorp = exists (select 1 from map_features m where m.dataset = 'development_corporation' and st_intersects(m.geom, s.pt)),
      article4 = exists (select 1 from map_features m where m.dataset = 'article4' and st_intersects(m.geom, s.pt)),
      tpo = exists (select 1 from map_features m where m.dataset = 'tpo_zone' and st_intersects(m.geom, s.geom)),
      aqma = exists (select 1 from map_features m where m.dataset = 'aqma' and st_intersects(m.geom, s.pt)),
      conservation = exists (select 1 from planning_constraints p where p.kind = 'conservation_area' and st_intersects(p.geom, s.pt)),
      flood3 = exists (select 1 from planning_constraints p where p.kind = 'flood_zone_3' and st_intersects(p.geom, s.pt)),
      flood2 = exists (select 1 from planning_constraints p where p.kind = 'flood_zone_2' and st_intersects(p.geom, s.pt)),
      listed_n = (select count(*) from planning_constraints p where p.kind = 'listed_building' and st_intersects(p.geom, s.geom)),
      public_land = coalesce(s.public_land, false) or exists (
        select 1 from map_features m where m.dataset = 'public_parcel' and st_intersects(m.geom, s.pt)),
      -- London Plan designations (0084). A designation counts when it covers
      -- the site's centre or at least 10% of its area: boundaries are digitised
      -- by 33 boroughs and railway-corridor SINCs run along estate edges, so a
      -- bare intersects test flags hundreds of sites on slivers (measured: ~half
      -- of SINC hits were under 2% of the site).
      oa_name = (select m.name from map_features m where m.dataset = 'gla_opportunity_area'
                 and st_intersects(m.geom, s.pt) limit 1),
      in_oa = exists (select 1 from map_features m where m.dataset = 'gla_opportunity_area' and st_intersects(m.geom, s.pt)),
      in_sil = exists (select 1 from map_features m where m.dataset = 'gla_sil' and m.geom && s.geom and london_site_covers(m.geom, s.geom, s.pt)),
      in_mol = exists (select 1 from map_features m where m.dataset = 'gla_mol' and m.geom && s.geom and london_site_covers(m.geom, s.geom, s.pt)),
      in_lsis = exists (select 1 from map_features m where m.dataset = 'gla_lsis' and m.geom && s.geom and london_site_covers(m.geom, s.geom, s.pt)),
      sinc_grade = (select m.props->>'grade' from map_features m
                    where m.dataset = 'gla_sinc' and m.geom && s.geom and london_site_covers(m.geom, s.geom, s.pt)
                    order by case when m.props->>'grade' ilike 'metropolitan%' then 0
                                  when m.props->>'grade' ilike '%grade I' then 1
                                  when m.props->>'grade' ilike 'borough%' then 2 else 3 end
                    limit 1)
    where s.id between p_from and p_to;

  elsif p_stage = 'form' then
    update london_sites s set storeys_site = x.v
    from (
      select s2.id, avg((m.props->>'storeys')::real) v
      from (select * from london_sites where id between p_from and p_to) s2
      join map_features m on m.dataset = 'building_height' and st_intersects(m.geom, s2.geom)
      where s2.cat <> 'green'
      group by s2.id
    ) x where x.id = s.id;

    update london_sites s set storeys_ctx = x.v
    from (
      select s2.id, percentile_cont(0.75) within group (order by (m.props->>'storeys')::real) v
      from (select * from london_sites where id between p_from and p_to) s2
      join map_features m on m.dataset = 'building_height' and st_dwithin(m.geom, s2.pt, 0.003)
      group by s2.id
    ) x where x.id = s.id;

  else
    raise exception 'unknown stage %', p_stage;
  end if;

  get diagnostics n = row_count;
  return jsonb_build_object('stage', p_stage, 'rows', n,
                            'sites', (select count(*) from london_sites));
end $$;

revoke execute on function public.rebuild_london_transit(text) from public, anon, authenticated;
revoke execute on function public.rebuild_london_sites(text, int, int) from public, anon, authenticated;
grant execute on function public.rebuild_london_transit(text) to service_role;
grant execute on function public.rebuild_london_sites(text, int, int) to service_role;

-- ───────────────────────── read RPCs ─────────────────────────

-- Every site's attributes and centre, no geometry: the sifter pages through
-- this once (~25k rows) and does all filtering and ranking client-side.
drop function if exists public.london_sites_all();
create or replace function public.london_sites_all()
returns table (
  id int, src text, cat text, subtype text, name text, pdl boolean, area_ha real,
  lad_code text, borough text, lng real, lat real,
  ptal text, ptal_ai real, conn_pt real, conn_all real, conn_emp real,
  stn_name text, stn_m real, z1_min real, z1_via text,
  resi_rent real, resi_rent_2b real, office_submkt text, office_prime real, office_mid real,
  office_voa_pm2 real, office_n int, price_ppm2 real,
  price_trend real, rent_chg real, rent_g5 real, approval_pct real, plan_vs_lhn real,
  land_value real, cil real,
  in_caz boolean, in_devcorp boolean, in_oa boolean, oa_name text, in_sil boolean, in_mol boolean,
  in_lsis boolean, sinc_grade text, article4 boolean, conservation boolean, listed_n int,
  flood3 boolean, flood2 boolean, tpo boolean, aqma boolean, public_land boolean,
  storeys_site real, storeys_ctx real, dwellings_max int, permission text
)
language sql stable
set search_path = public, extensions
as $$
  select id, src, cat, subtype, name, pdl, area_ha, lad_code, borough,
         st_x(pt)::real, st_y(pt)::real,
         ptal, ptal_ai, conn_pt, conn_all, conn_emp, stn_name, stn_m, z1_min, z1_via,
         resi_rent, resi_rent_2b, office_submkt, office_prime, office_mid,
         office_voa_pm2, office_n, price_ppm2,
         price_trend, rent_chg, rent_g5, approval_pct, plan_vs_lhn, land_value, cil,
         in_caz, in_devcorp, in_oa, oa_name, in_sil, in_mol, in_lsis, sinc_grade, article4, conservation, listed_n,
         flood3, flood2, tpo, aqma, public_land,
         storeys_site, storeys_ctx, dwellings_max, permission
  from london_sites
$$;

-- Site outlines for the current view, drawn from z13 up.
create or replace function public.london_site_shapes(w float8, s float8, e float8, n float8, lim int default 4000)
returns jsonb
language sql stable
set search_path = public, extensions
as $$
  select jsonb_build_object('type', 'FeatureCollection', 'features', coalesce(jsonb_agg(
    jsonb_build_object('type', 'Feature', 'id', id,
      'geometry', st_asgeojson(geom, 6)::jsonb,
      'properties', jsonb_build_object('id', id))), '[]'::jsonb))
  from (
    select id, geom from london_sites
    where geom && st_makeenvelope(w, s, e, n, 4326)
    order by area_ha desc nulls last
    limit lim
  ) q
$$;

grant execute on function public.london_sites_all() to anon, authenticated;
grant execute on function public.london_site_shapes(float8, float8, float8, float8, int) to anon, authenticated;
