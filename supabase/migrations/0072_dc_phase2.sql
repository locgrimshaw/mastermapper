-- 0072_dc_phase2.sql
--
-- Data-centre sift phase 2: settlement distance, DNO demand headroom, and
-- heat networks (docs/PLAN_DATACENTRE_SIFT.md §6 phase 2).
--
-- dc_settlement: ONS Built Up Areas (Dec 2022, GB) with population >= 5,000.
--   Population is Census-derived: the ONS LSOA21->BUA22 lookup aggregated over
--   lsoa_imd.population (England). Scotland and Wales have no LSOA population
--   in this database, so their BUAs carry an AREA-BASED ESTIMATE (median E&W
--   BUA density, 3,307/km², times the BUA's area) flagged est = true. Bands
--   at 5k / 20k / 100k tolerate that error; the UI says "estimated" for
--   Scotland/Wales. 1,669 settlements (550 >= 20k, 105 >= 100k).
--
-- dc_heat: DESNZ Heat Networks Planning Database (May–July 2026 quarterly
--   extract, OGL), all 1,495 records carrying OSGB coordinates. status is the
--   HNPD short development status; "operational"/"under construction" are the
--   existing networks, the rest the pipeline.
--
-- dc_dno: demand headroom sites from the three DNO open-data portals already
--   loaded (NGED demandconnectedheadroommw; NPG demhr; UKPN derived as firm
--   capacity minus winter max demand, where firm = sum of transformer winter
--   ratings minus the largest — the N-1 convention). SPEN, ENWL and SSEN
--   exports are permission-gated on their portals as of 2026-08 (header-only
--   responses), so the NW, Merseyside/N Wales and Scotland + central-southern
--   England licence areas have NO headroom data — the sift treats no-data as
--   pass + badge, never as red.

create table if not exists public.dc_settlement (
  code text primary key,
  name text,
  pop  integer not null,
  est  boolean not null default false,
  lng  double precision not null,
  lat  double precision not null,
  geom geometry(Point, 4326) generated always as
    (st_setsrid(st_makepoint(lng, lat), 4326)) stored);
create index if not exists dc_settlement_gix on public.dc_settlement using gist (geom);
grant select on public.dc_settlement to anon, authenticated;

create table if not exists public.dc_heat (
  id bigint generated always as identity primary key,
  status text not null,
  e integer not null,
  n integer not null,
  name text,
  tech text,
  -- st_transform is not IMMUTABLE (SRID lookup), so no generated column here:
  -- the loader backfills geom after each insert batch.
  geom geometry(Point, 4326));
create index if not exists dc_heat_gix on public.dc_heat using gist (geom);
grant select on public.dc_heat to anon, authenticated;

-- DNO headroom lookup: SQL-only, from datasets already in map_features.
drop table if exists public.dc_dno;
create table public.dc_dno as
  select 'nged' as dno, (props->>'demandconnectedheadroommw')::numeric as hr_mw, geom
    from public.map_features
   where dataset = 'nged_sites'
     and props->>'demandconnectedheadroommw' ~ '^[0-9.]+$'
  union all
  select 'npg', (props->>'demhr')::numeric, geom
    from public.map_features
   where dataset = 'npg_sites' and props->>'demhr' ~ '^-?[0-9.]+$'
  union all
  select 'ukpn',
         (select case when count(*) > 1 then sum(v) - max(v) else max(v) end
            from unnest(string_to_array(replace(props->>'transratingwinter', ' ', ''), ',')) t(s),
                 lateral (select s::numeric v) x
           where s ~ '^[0-9.]+$')
         - (props->>'maxdemandwinter')::numeric,
         geom
    from public.map_features
   where dataset = 'ukpn_sites'
     and props->>'transratingwinter' is not null
     and props->>'maxdemandwinter' ~ '^[0-9.]+$'
     -- UKPN classify their own sites: HOT = generation/demand constrained.
     -- The transformer-rating derivation overstates headroom exactly there,
     -- so HOT sites are excluded rather than credited with paper capacity.
     and coalesce(props->>'siteclassification', '') <> 'HOT';
delete from public.dc_dno where hr_mw is null;
create index dc_dno_gix on public.dc_dno using gist (geom);

-- New per-cell distances (100 m units, capped 250; 255 = none within 25 km /
-- no data in this licence area).
alter table public.dc_grid
  add column if not exists d_set5   smallint default 255,
  add column if not exists d_set20  smallint default 255,
  add column if not exists d_set100 smallint default 255,
  add column if not exists d_dno20  smallint default 255,
  add column if not exists d_dno50  smallint default 255,
  add column if not exists d_heat   smallint default 255;

-- Phase-2 distance pass: KNN only (no polygon work), whole grid in one call.
create or replace function public.rebuild_dc_grid_dist2()
returns integer language sql as $$
  with u as (
    update public.dc_grid g
       set d_set5 = least(255, coalesce((select round(st_distance(s.geom::geography, pt.p::geography)/100)
                      from public.dc_settlement s where s.pop >= 5000
                      order by s.geom <-> pt.p limit 1), 255))::smallint,
           d_set20 = least(255, coalesce((select round(st_distance(s.geom::geography, pt.p::geography)/100)
                      from public.dc_settlement s where s.pop >= 20000
                      order by s.geom <-> pt.p limit 1), 255))::smallint,
           d_set100 = least(255, coalesce((select round(st_distance(s.geom::geography, pt.p::geography)/100)
                      from public.dc_settlement s where s.pop >= 100000
                      order by s.geom <-> pt.p limit 1), 255))::smallint,
           d_dno20 = least(255, coalesce((select round(st_distance(s.geom::geography, pt.p::geography)/100)
                      from public.dc_dno s where s.hr_mw >= 20
                      order by s.geom <-> pt.p limit 1), 255))::smallint,
           d_dno50 = least(255, coalesce((select round(st_distance(s.geom::geography, pt.p::geography)/100)
                      from public.dc_dno s where s.hr_mw >= 50
                      order by s.geom <-> pt.p limit 1), 255))::smallint,
           d_heat = least(255, coalesce((select round(st_distance(s.geom::geography, pt.p::geography)/100)
                      from public.dc_heat s
                      order by s.geom <-> pt.p limit 1), 255))::smallint
      from (select cell_id, st_setsrid(st_makepoint(lng, lat), 4326) p
              from public.dc_grid) pt
     where pt.cell_id = g.cell_id
    returning 1)
  select count(*)::int from u;
$$;

-- dc_cells_agg gains the six new columns (return-type change => drop first).
drop function if exists public.dc_cells_agg(integer);
create function public.dc_cells_agg(res_m integer default 4000)
returns table(e integer, n integer, lng double precision, lat double precision,
              ncell integer, slope10 smallint, built_pct smallint, transp_pct smallint,
              water_pct smallint, prot_pct smallint, herit_pct smallint,
              fz3_pct smallint, fz2_pct smallint, gb_pct smallint, alc12_pct smallint,
              d_sub132 smallint, d_sub275 smallint, d_line132 smallint,
              gsp_mw smallint, water_stat smallint, aqma smallint,
              d_set5 smallint, d_set20 smallint, d_set100 smallint,
              d_dno20 smallint, d_dno50 smallint, d_heat smallint)
language sql stable as $$
  select (easting / res_m)::int, (northing / res_m)::int,
         avg(lng), avg(lat), count(*)::int,
         min(slope10), min(built_pct), min(transp_pct), min(water_pct),
         min(prot_pct), min(herit_pct), min(fz3_pct), min(fz2_pct),
         min(gb_pct), min(alc12_pct),
         min(d_sub132), min(d_sub275), min(d_line132),
         min(gsp_mw), min(water_stat), max(aqma),
         min(d_set5), min(d_set20), min(d_set100),
         min(d_dno20), min(d_dno50), min(d_heat)
    from public.dc_grid
   group by 1, 2;
$$;
grant execute on function public.dc_cells_agg(integer) to anon, authenticated;

-- dc_sift_stats: settlement clause, DNO power options, optional heat clause.
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
              when 'd_dno20' then case when d_dno20 = 255 then 0 else d_dno20 end
              when 'd_dno50' then case when d_dno50 = 255 then 0 else d_dno50 end
              else d_sub132 end) <= coalesce((p->>'powerMax100')::int, 50)
       and (not coalesce((p->>'avoidQueue')::boolean, false) or gsp_mw <= coalesce((p->>'maxQueue100')::int, 20))
       and (not coalesce((p->>'useSet')::boolean, false)
            or (case coalesce(p->>'setAttr', 'd_set20')
                  when 'd_set5' then d_set5
                  when 'd_set100' then d_set100
                  else d_set20 end) <= coalesce((p->>'setMax100')::int, 100))
       and (not coalesce((p->>'useHeat')::boolean, false)
            or d_heat <= coalesce((p->>'heatMax100')::int, 50))
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
grant execute on function public.dc_sift_stats(jsonb) to anon, authenticated;

-- Heat networks for the map overlay: numbers + labels, no server geometry.
create or replace function public.dc_heat_points()
returns table(lng double precision, lat double precision, status text, name text, tech text)
language sql stable as $$
  select st_x(geom), st_y(geom), status, name, tech from public.dc_heat;
$$;
grant execute on function public.dc_heat_points() to anon, authenticated;
