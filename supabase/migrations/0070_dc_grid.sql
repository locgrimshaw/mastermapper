-- 0070_dc_grid.sql
--
-- The data-centre sift's national grid (docs/PLAN_DATACENTRE_SIFT.md §3).
--
-- One row per 1 km OSGB cell, on the exact footprint of slope_grid (285,800
-- cells, source_id sl-{easting}-{northing}), carrying quantised per-criterion
-- attributes. The sift filters CLIENT-SIDE: checkboxes and sliders compose a
-- predicate over these columns, so toggling recolours instantly; the server
-- is only asked for (a) the cells and (b) an aggregate readout.
--
-- SERVING, phase 1: no vector tiles yet, and no geometry in responses — that
-- is what made the bbox RPCs slow (20.8 s to serialise 52k PTAL cells). The
-- two RPCs return NUMBERS ONLY: a centroid lng/lat plus the cell size, and
-- the client draws the square itself (a 1 km square drawn with local
-- metres-per-degree is accurate to well under 0.1%).
--   dc_cells_agg(res_m)    -> whole-GB blocks at res_m (4000 -> ~19k rows),
--                             fetched once and cached client-side. Aggregates
--                             are BEST-CASE (min percents, min distances, min
--                             slope) plus n: coarse green means "somewhere in
--                             this block could qualify", which is the honest
--                             strategic read; zooming refines it.
--   dc_cells_bbox(w,s,e,n) -> raw 1 km cells in a viewport, capped.
--   dc_sift_stats(p)       -> green km2 + per-LA ranking for the readout.
--
-- Percent columns are 0..100; -1 means "not computed / no data" (client
-- treats as pass + badge). Distances are in 100 m units capped at 250
-- (25 km); 255 = nothing within 25 km (fails a distance test) — except where
-- the plan says otherwise per attribute. gsp_mw is queued MW / 100.

create table if not exists public.dc_grid (
  cell_id   text primary key,             -- "dc-{easting}-{northing}"
  easting   integer not null,
  northing  integer not null,
  lng       double precision not null,    -- centroid, WGS84
  lat       double precision not null,
  geom      geometry(Polygon, 4326) not null,
  lad_code  text,
  lad_name  text,
  slope10   smallint,                     -- mean slope, degrees x10
  maxslope10 smallint,                    -- steepest 50 m cell, degrees x10
  built_pct  smallint default -1,
  transp_pct smallint default -1,
  water_pct  smallint default -1,
  prot_pct   smallint default -1,         -- sssi|sac|spa|ramsar|ancient_woodland|scheduled_monument
  herit_pct  smallint default -1,         -- conservation_area|park_garden|aonb
  fz3_pct    smallint default -1,
  fz2_pct    smallint default -1,
  gb_pct     smallint default -1,
  alc12_pct  smallint default -1,         -- ALC grades 1-2 (England only)
  d_sub132   smallint default 255,        -- nearest OSM substation kv>=132, 100 m units
  d_sub275   smallint default 255,
  d_line132  smallint default 255,        -- nearest OSM power line kv>=132
  gsp_mw     smallint default 0,          -- GSP queued_mw / 100, capped 250
  water_stat smallint default 9,          -- CAMS: 0 green 1 yellow 2 red 3 grey, 9 n/a
  aqma       smallint default 0,
  updated_at timestamptz not null default now());

create index if not exists dc_grid_gix on public.dc_grid using gist (geom);
create index if not exists dc_grid_en_idx on public.dc_grid (easting, northing);

-- Power-infrastructure lookup tables: KNN needs a gist index over exactly the
-- subset being searched — a filtered scan of the 57k-row substation layer
-- walks the index in distance order discarding the 97% below 132 kV.
create table if not exists public.dc_sub132 as
  select geom from public.map_features
   where dataset = 'power_substation' and (props->>'kv')::numeric >= 132;
create table if not exists public.dc_sub275 as
  select geom from public.map_features
   where dataset = 'power_substation' and (props->>'kv')::numeric >= 275;
create table if not exists public.dc_line132 as
  select geom from public.map_features
   where dataset = 'power_line' and (props->>'kv')::numeric >= 132;
create index if not exists dc_sub132_gix on public.dc_sub132 using gist (geom);
create index if not exists dc_sub275_gix on public.dc_sub275 using gist (geom);
create index if not exists dc_line132_gix on public.dc_line132 using gist (geom);

-- Seed the grid from slope_grid: geometry, centroid and slope in one pass.
create or replace function public.dc_grid_seed() returns integer
language sql as $$
  insert into public.dc_grid
    (cell_id, easting, northing, lng, lat, geom, slope10, maxslope10)
  select 'dc-' || split_part(source_id, '-', 2) || '-' || split_part(source_id, '-', 3),
         split_part(source_id, '-', 2)::int,
         split_part(source_id, '-', 3)::int,
         st_x(st_centroid(geom)), st_y(st_centroid(geom)),
         st_makevalid(geom)::geometry(Polygon,4326),
         round(coalesce((props->>'slope')::numeric, 0) * 10)::smallint,
         round(coalesce((props->>'max_slope')::numeric, 0) * 10)::smallint
    from public.map_features
   where dataset = 'slope_grid'
     and geom is not null
  on conflict (cell_id) do nothing;
  select count(*)::int from public.dc_grid;
$$;

-- The batched precompute. p_part/p_parts split by northing so each batch is a
-- horizontal band (spatially coherent -> warm index pages).
create or replace function public.rebuild_dc_grid(p_part integer, p_parts integer)
returns integer language plpgsql as $function$
declare n integer;
begin
  with mine as (
    select cell_id, geom, lng, lat,
           st_area(geom::geography) as cell_m2
      from public.dc_grid
     where (northing / 1000) % p_parts = p_part
  ),
  comp as (
    select m.cell_id,
           least(100, round(100 * coalesce(sum(a.ai) filter (where c.kind = 'built_land'), 0) / m.cell_m2))::smallint  as built_pct,
           least(100, round(100 * coalesce(sum(a.ai) filter (where c.kind = 'transport'), 0) / m.cell_m2))::smallint  as transp_pct,
           least(100, round(100 * coalesce(sum(a.ai) filter (where c.kind = 'water'), 0) / m.cell_m2))::smallint      as water_pct,
           least(100, round(100 * coalesce(sum(a.ai) filter (where c.kind in ('sssi','sac','spa','ramsar','ancient_woodland','scheduled_monument')), 0) / m.cell_m2))::smallint as prot_pct,
           least(100, round(100 * coalesce(sum(a.ai) filter (where c.kind in ('conservation_area','park_garden','aonb')), 0) / m.cell_m2))::smallint as herit_pct,
           least(100, round(100 * coalesce(sum(a.ai) filter (where c.kind = 'flood_zone_3'), 0) / m.cell_m2))::smallint as fz3_pct,
           least(100, round(100 * coalesce(sum(a.ai) filter (where c.kind = 'flood_zone_2'), 0) / m.cell_m2))::smallint as fz2_pct,
           least(100, round(100 * coalesce(sum(a.ai) filter (where c.kind = 'green_belt'), 0) / m.cell_m2))::smallint  as gb_pct
      from mine m
      left join public.planning_constraints c
        on c.kind in ('built_land','transport','water','sssi','sac','spa','ramsar',
                      'ancient_woodland','scheduled_monument','conservation_area',
                      'park_garden','aonb','flood_zone_3','flood_zone_2','green_belt')
       and c.geom && m.geom
      left join lateral (
        select st_area(st_intersection(st_makevalid(c.geom), m.geom)::geography) as ai
      ) a on c.kind is not null
     group by m.cell_id, m.cell_m2
  )
  update public.dc_grid g
     set built_pct = comp.built_pct, transp_pct = comp.transp_pct,
         water_pct = comp.water_pct, prot_pct = comp.prot_pct,
         herit_pct = comp.herit_pct, fz3_pct = comp.fz3_pct,
         fz2_pct = comp.fz2_pct, gb_pct = comp.gb_pct,
         updated_at = now()
    from comp where g.cell_id = comp.cell_id;
  get diagnostics n = row_count;

  -- Distances + point-in-polygon joins for the same band.
  update public.dc_grid g
     set d_sub132 = least(255, coalesce((
           select round(st_distance(s.geom::geography, pt.p::geography) / 100)
             from public.dc_sub132 s order by s.geom <-> pt.p limit 1), 255))::smallint,
         d_sub275 = least(255, coalesce((
           select round(st_distance(s.geom::geography, pt.p::geography) / 100)
             from public.dc_sub275 s order by s.geom <-> pt.p limit 1), 255))::smallint,
         d_line132 = least(255, coalesce((
           select round(st_distance(s.geom::geography, pt.p::geography) / 100)
             from public.dc_line132 s order by s.geom <-> pt.p limit 1), 255))::smallint,
         gsp_mw = least(250, coalesce((
           select round(coalesce((f.props->>'queued_mw')::numeric, 0) / 100)
             from public.map_features f
            where f.dataset = 'gsp_boundary' and st_contains(f.geom, pt.p) limit 1), 0))::smallint,
         water_stat = coalesce((
           select case lower(coalesce(f.props->>'status',''))
                    when 'green' then 0 when 'yellow' then 1
                    when 'red' then 2 when 'grey' then 3 else 9 end
             from public.map_features f
            where f.dataset = 'water_availability' and st_contains(f.geom, pt.p) limit 1), 9)::smallint,
         aqma = coalesce((
           select 1 from public.map_features f
            where f.dataset = 'aqma' and f.geom && pt.p and st_contains(f.geom, pt.p) limit 1), 0)::smallint,
         lad_code = (
           select f.props->>'lad_code' from public.map_features f
            where f.dataset = 'lad_boundary' and st_contains(f.geom, pt.p) limit 1),
         lad_name = (
           select f.name from public.map_features f
            where f.dataset = 'lad_boundary' and st_contains(f.geom, pt.p) limit 1),
         alc12_pct = coalesce((
           select least(100, round(100 * sum(
                    st_area(st_intersection(st_makevalid(f.geom), g.geom)::geography))
                    / st_area(g.geom::geography)))
             from public.map_features f
            where f.dataset = 'alc' and f.props->>'alc_grade' in ('Grade 1','Grade 2')
              and f.geom && g.geom), 0)::smallint
   from (select st_setsrid(st_makepoint(g2.lng, g2.lat), 4326) as p, g2.cell_id
           from public.dc_grid g2) pt
  where pt.cell_id = g.cell_id
    and (g.northing / 1000) % p_parts = p_part;

  return n;
end
$function$;
alter function public.rebuild_dc_grid(integer, integer)
  set plan_cache_mode = force_custom_plan;

-- Whole-GB aggregated blocks, numbers only. Best-case aggregation (see header).
create or replace function public.dc_cells_agg(res_m integer default 4000)
returns table(e integer, n integer, lng double precision, lat double precision,
              ncell integer, slope10 smallint, built_pct smallint, transp_pct smallint,
              water_pct smallint, prot_pct smallint, herit_pct smallint,
              fz3_pct smallint, fz2_pct smallint, gb_pct smallint, alc12_pct smallint,
              d_sub132 smallint, d_sub275 smallint, d_line132 smallint,
              gsp_mw smallint, water_stat smallint, aqma smallint)
language sql stable as $$
  select (easting / res_m)::int, (northing / res_m)::int,
         avg(lng), avg(lat), count(*)::int,
         min(slope10), min(built_pct), min(transp_pct), min(water_pct),
         min(prot_pct), min(herit_pct), min(fz3_pct), min(fz2_pct),
         min(gb_pct), min(alc12_pct),
         min(d_sub132), min(d_sub275), min(d_line132),
         min(gsp_mw), min(water_stat), max(aqma)
    from public.dc_grid
   group by 1, 2;
$$;

-- Raw 1 km cells for a viewport, capped.
create or replace function public.dc_cells_bbox(
  w double precision, s double precision, e double precision, n double precision,
  cap integer default 30000)
returns setof public.dc_grid
language sql stable as $$
  select * from public.dc_grid g
   where g.lng between w and e and g.lat between s and n
   limit cap;
$$;

-- Aggregate readout for the box: green totals + a per-LA ranking under the
-- client's thresholds (mirrors dcPassExpr; jsonb so the signature is stable).
create or replace function public.dc_sift_stats(p jsonb)
returns jsonb language sql stable as $$
  with pass as (
    select lad_code, lad_name
      from public.dc_grid
     where (not coalesce((p->>'exBuilt')::boolean, true)  or built_pct  <= coalesce((p->>'builtMax')::int, 10))
       and (not coalesce((p->>'exTrans')::boolean, true)  or transp_pct <= 20)
       and (not coalesce((p->>'exWater')::boolean, true)  or water_pct  <= 20)
       and (not coalesce((p->>'exProt')::boolean, true)   or prot_pct   <= coalesce((p->>'protMax')::int, 5))
       and (not coalesce((p->>'exHerit')::boolean, false) or herit_pct  <= coalesce((p->>'heritMax')::int, 10))
       and (not coalesce((p->>'exFz3')::boolean, true)    or greatest(fz3_pct, 0) <= coalesce((p->>'fz3Max')::int, 10))
       and (not coalesce((p->>'exFz2')::boolean, false)   or greatest(fz2_pct, 0) <= coalesce((p->>'fz2Max')::int, 10))
       and (not coalesce((p->>'exGB')::boolean, false)    or gb_pct     <= 25)
       and (not coalesce((p->>'exAlc')::boolean, false)   or alc12_pct  <= 25)
       and (not coalesce((p->>'exAqma')::boolean, false)  or aqma = 0)
       and slope10 <= coalesce((p->>'maxSlope10')::int, 50)
       and (case coalesce(p->>'powerAttr', 'd_sub132')
              when 'd_sub275' then d_sub275
              when 'd_line132' then d_line132
              else d_sub132 end) <= coalesce((p->>'powerMax100')::int, 50)
       and (not coalesce((p->>'avoidQueue')::boolean, false) or gsp_mw <= coalesce((p->>'maxQueue100')::int, 20))
  )
  select jsonb_build_object(
    'green_cells', (select count(*) from pass),
    'total_cells', (select count(*) from public.dc_grid),
    'top_lads', coalesce((
      select jsonb_agg(row_to_json(t)) from (
        select lad_name, count(*)::int km2 from pass
         where lad_name is not null
         group by 1 order by 2 desc limit 15) t), '[]'::jsonb));
$$;

grant select on public.dc_grid to anon, authenticated;
grant execute on function public.dc_cells_agg(integer) to anon, authenticated;
grant execute on function public.dc_cells_bbox(double precision,double precision,double precision,double precision,integer) to anon, authenticated;
grant execute on function public.dc_sift_stats(jsonb) to anon, authenticated;
