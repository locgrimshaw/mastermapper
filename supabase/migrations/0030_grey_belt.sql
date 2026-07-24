-- 0030_grey_belt.sql
-- A computable "grey belt" MODEL: land inside the Green Belt that is already
-- previously-developed in character — the intersection of green_belt with
-- (a) OS built-up-area polygons and (b) registered brownfield footprints —
-- minus hard environmental designations (SSSI/SAC/SPA/Ramsar/ancient
-- woodland), with sub-0.25 ha slivers dropped. This is a heuristic screen
-- for NPPF para-155 "grey belt" potential, NOT a legal determination; the
-- frontend labels it as a model. Materialised into map_features as dataset
-- 'grey_belt_candidate' so the ordinary features_in_bbox path serves it.
--
-- Also: brownfield_in_bbox now carries ownership props (is_public,
-- ownership_status, hectares, permission_status) so the map can distinguish
-- publicly-owned brownfield — the portfolio tool's highest-value filter.
-- And the two summary RPCs learn about grey-belt coverage.

create or replace function public.rebuild_grey_belt_candidates()
returns integer language plpgsql volatile as $function$
declare n integer;
begin
  -- Green-belt polygons are enormous (avg ~90 km² multipolygons): subdivide
  -- so every pairwise intersection below is small-vs-small.
  create temp table _gb_sub on commit drop as
    select st_subdivide(st_makevalid(geom), 256) as geom
    from public.planning_constraints where kind = 'green_belt';
  create index on _gb_sub using gist (geom);
  analyze _gb_sub;

  create temp table _cand on commit drop as
  select row_number() over () as id, name, src, geom
  from (
    -- Built-up areas washed over by / overlapping the green belt.
    select coalesce(b.name, 'Built-up area') as name, 'built_land' as src,
           (st_dump(st_union(st_intersection(b.geom, g.geom)))).geom as geom
    from public.planning_constraints b
    join _gb_sub g on b.geom && g.geom and st_intersects(b.geom, g.geom)
    where b.kind = 'built_land'
    group by b.ctid, b.name
    union all
    -- Registered brownfield footprints inside the green belt.
    select coalesce(bf.name, bf.site_address, 'Brownfield site'), 'brownfield',
           (st_dump(st_union(st_intersection(bf.area::geometry, g.geom)))).geom
    from public.brownfield bf
    join _gb_sub g on bf.area is not null
                  and bf.area::geometry && g.geom
                  and st_intersects(bf.area::geometry, g.geom)
    group by bf.id, bf.name, bf.site_address
  ) q
  where geometrytype(geom) = 'POLYGON'
    and st_area(geom::geography) >= 2500;   -- 0.25 ha floor
  create index on _cand using gist (geom);
  analyze _cand;

  -- Punch out hard environmental designations. Clip each designation to the
  -- candidate's bbox first so a coastal mega-SAC never enters st_difference
  -- at full size.
  with hit as (
    select c.id as cid,
           st_union(st_makevalid(st_clipbybox2d(h.geom, st_envelope(c.geom)))) as hg
    from _cand c
    join public.planning_constraints h
      on h.kind in ('sssi','sac','spa','ramsar','ancient_woodland')
     and h.geom && c.geom and st_intersects(h.geom, c.geom)
    group by c.id)
  update _cand c
     set geom = st_difference(c.geom, hit.hg)
    from hit where c.id = hit.cid;

  delete from _cand
   where geom is null or st_isempty(geom)
      or st_area(geom::geography) < 2500;

  delete from public.map_features where dataset = 'grey_belt_candidate';
  insert into public.map_features (dataset, source_id, name, props, geom)
  select 'grey_belt_candidate',
         'gbc-' || row_number() over (order by st_area(geom::geography) desc),
         name,
         jsonb_build_object(
           'source', src,
           'area_ha', round((st_area(geom::geography) / 10000.0)::numeric, 2)),
         st_multi(geom)
  from _cand;
  get diagnostics n = row_count;
  analyze public.map_features;
  return n;
end $function$;
revoke execute on function public.rebuild_grey_belt_candidates() from public, anon, authenticated;

-- Brownfield bbox features now say WHO owns them.
create or replace function public.brownfield_in_bbox(
  w double precision, s double precision, e double precision, n double precision,
  lim integer default 1500, p_zoom double precision default null)
returns jsonb language sql stable as $function$
  with tol as (select public._px_deg(p_zoom) as t)
  select jsonb_build_object(
      'type', 'FeatureCollection',
      'features', coalesce(jsonb_agg(jsonb_build_object(
        'type', 'Feature',
        'properties', jsonb_build_object('kind', 'brownfield', 'name', b.name,
                                         'dwellings_max', b.dwellings_max,
                                         'is_public', b.is_public,
                                         'ownership_status', b.ownership_status,
                                         'hectares', b.hectares,
                                         'permission_status', b.permission_status),
        'geometry', st_asgeojson(b.g, 6)::jsonb)), '[]'::jsonb))
  from (
    select name, dwellings_max, is_public, ownership_status, hectares,
           permission_status,
           case when (select t from tol) > 0
                then st_simplifypreservetopology(area::geometry, (select t from tol))
                else area::geometry end as g
    from public.brownfield
    where area is not null and area::geometry && st_makeenvelope(w, s, e, n, 4326)
      and ((select t from tol) = 0
           or area_deg2 > 4 * (select t from tol) * (select t from tol))
    order by area_deg2 desc
    limit lim
  ) b
  where b.g is not null and not st_isempty(b.g);
$function$;

-- polygon_summary: add grey-belt coverage % of the site (the portfolio
-- scorer's NPPF-release signal).
create or replace function public.polygon_summary(p_geojson text)
returns jsonb language plpgsql stable as $function$
declare
  g geometry;
  garea_ha double precision;
  res jsonb;
begin
  g := st_setsrid(st_geomfromgeojson(p_geojson), 4326);
  if g is null or st_isempty(g) then
    return jsonb_build_object('error', 'empty or invalid geometry');
  end if;
  if geometrytype(g) in ('POINT', 'MULTIPOINT') then
    g := st_buffer(g::geography, 100)::geometry;   -- a point site = 100m disc
  end if;
  g := st_makevalid(g);
  garea_ha := st_area(g::geography) / 10000.0;
  if garea_ha > 5000 then
    return jsonb_build_object('error', 'site too large (>5,000 ha)');
  end if;

  execute $q$
  select jsonb_build_object(
    'area_ha', round(($2)::numeric, 2),
    -- Constraint coverage: % of the site under each kind that touches it.
    'constraints', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'kind', kind, 'pct', pct) order by pct desc), '[]'::jsonb)
      from (
        select pc.kind,
               round((100 * st_area(st_intersection(st_union(pc.geom), $1)::geography)
                      / nullif(st_area($1::geography), 0))::numeric, 1) as pct
        from public.planning_constraints pc
        where pc.kind not in ('transport', 'built_land', 'water')
          and pc.geom && $1 and st_intersects(pc.geom, $1)
        group by pc.kind
      ) c
      where pct >= 0.5),
    'grey_belt_pct', (
      select round((100 * st_area(st_intersection(st_union(geom), $1)::geography)
                    / nullif(st_area($1::geography), 0))::numeric, 1)
      from public.map_features
      where dataset = 'grey_belt_candidate'
        and geom && $1 and st_intersects(geom, $1)),
    'areas', (
      select coalesce(jsonb_object_agg(dataset,
               props || jsonb_build_object('name', name)), '{}'::jsonb)
      from (
        select distinct on (dataset) dataset, name, props
        from public.map_features
        where dataset in ('alc','water_availability','gsp_boundary','lad_boundary',
                          'lpa_boundary','local_plan_boundary','article4',
                          'la_rents','ptal','hdt')
          and geometrytype(geom_simple) not in ('POINT','MULTIPOINT')
          and geom && $1 and st_intersects(geom, st_centroid($1))
        order by dataset, size_metric asc
      ) a),
    'ownership', (
      select coalesce(jsonb_agg(jsonb_build_object('body', body, 'owner', owner_name)), '[]'::jsonb)
      from (
        select lo.body, lo.owner_name from public.land_ownership lo
        where lo.geom && $1 and st_intersects(lo.geom, $1) limit 4) o),
    'council_property', (
      select count(*) from public.map_features
      where dataset = 'la_property' and geom && $1 and st_intersects(geom, $1)),
    'brownfield_overlap', (
      select count(*) from public.brownfield
      where area is not null and area::geometry && $1
        and st_intersects(area::geometry, $1)),
    'nearest_station_m', null,   -- filled client-side from the usage layer
    'nearest_grid_substation', (
      select to_jsonb(x) from (
        select name, props->>'kv' as kv,
               round(st_distancesphere(geom, st_centroid($1)))::int as dist_m
        from public.map_features
        where dataset = 'power_substation'
          and props->>'kv' ~ '^[0-9.]+$' and (props->>'kv')::float >= 50
        order by geom <-> st_centroid($1) limit 1) x),
    'recent_sales', (
      select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) from (
        select (props->>'price')::bigint as price, props->>'date' as date,
               props->>'ptype' as ptype,
               round(st_distancesphere(geom, st_centroid($1)))::int as dist_m
        from public.map_features
        where dataset = 'ppd_sales'
          and geom && st_expand(st_centroid($1), 0.01)
        order by geom <-> st_centroid($1) limit 5) s)
  )
  $q$ into res using g, garea_ha;
  return res;
end $function$;
alter function public.polygon_summary(text) set plan_cache_mode = force_custom_plan;
grant execute on function public.polygon_summary(text) to anon, authenticated;

-- point_summary: grey_belt_candidate joins the polygon-areas list, so the
-- spot summary can flag "inside a grey-belt candidate area".
create or replace function public.point_summary(
  p_lon double precision, p_lat double precision)
returns jsonb language sql stable as $function$
  select jsonb_build_object(
    'constraints', (
      select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'name', name)
                                order by kind), '[]'::jsonb)
      from (
        select distinct on (kind) kind, name
        from public.planning_constraints
        where kind not in ('transport', 'built_land', 'water')
          and geom && st_setsrid(st_makepoint(p_lon, p_lat), 4326)
          and st_intersects(geom, st_setsrid(st_makepoint(p_lon, p_lat), 4326))
        order by kind, area_deg2 desc
      ) c),
    'areas', (
      select coalesce(jsonb_object_agg(dataset,
               props || jsonb_build_object('name', name)), '{}'::jsonb)
      from (
        select distinct on (dataset) dataset, name, props
        from public.map_features
        where dataset in ('alc','water_availability','gsp_boundary','lad_boundary',
                          'lpa_boundary','local_plan_boundary','article4','tpo_zone',
                          'design_code_area','la_rents','ptal','uni_campus_site','hdt',
                          'grey_belt_candidate')
          and geometrytype(geom) in ('POLYGON','MULTIPOLYGON')
          and geom && st_setsrid(st_makepoint(p_lon, p_lat), 4326)
          and st_intersects(geom, st_setsrid(st_makepoint(p_lon, p_lat), 4326))
        order by dataset, size_metric asc
      ) a),
    'ownership', (
      select coalesce(jsonb_agg(jsonb_build_object('body', body, 'owner', owner_name)), '[]'::jsonb)
      from (
        select body, owner_name from public.land_ownership
        where geom && st_setsrid(st_makepoint(p_lon, p_lat), 4326)
          and st_intersects(geom, st_setsrid(st_makepoint(p_lon, p_lat), 4326))
        limit 4
      ) o),
    'nearest_substation', (
      select to_jsonb(x) from (
        select name, props->>'kv' as kv, props->>'operator' as operator,
               round(st_distancesphere(geom,
                 st_setsrid(st_makepoint(p_lon, p_lat), 4326)))::int as dist_m
        from public.map_features
        where dataset = 'power_substation'
        order by geom <-> st_setsrid(st_makepoint(p_lon, p_lat), 4326)
        limit 1
      ) x),
    'nearest_grid_substation', (
      select to_jsonb(x) from (
        select name, props->>'kv' as kv, props->>'operator' as operator,
               round(st_distancesphere(geom,
                 st_setsrid(st_makepoint(p_lon, p_lat), 4326)))::int as dist_m
        from public.map_features
        where dataset = 'power_substation'
          and props->>'kv' ~ '^[0-9.]+$' and (props->>'kv')::float >= 50
        order by geom <-> st_setsrid(st_makepoint(p_lon, p_lat), 4326)
        limit 1
      ) x),
    'nearest_tec', (
      select to_jsonb(x) from (
        select name, props->>'mw' as mw, props->>'status' as status,
               props->>'plant' as plant,
               round(st_distancesphere(geom,
                 st_setsrid(st_makepoint(p_lon, p_lat), 4326)))::int as dist_m
        from public.map_features
        where dataset = 'tec_register'
        order by geom <-> st_setsrid(st_makepoint(p_lon, p_lat), 4326)
        limit 1
      ) x),
    'recent_sales', (
      select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) from (
        select (props->>'price')::bigint as price, props->>'date' as date,
               props->>'ptype' as ptype, props->>'addr' as addr,
               round(st_distancesphere(geom,
                 st_setsrid(st_makepoint(p_lon, p_lat), 4326)))::int as dist_m
        from public.map_features
        where dataset = 'ppd_sales'
          and geom && st_expand(st_setsrid(st_makepoint(p_lon, p_lat), 4326), 0.008)
        order by geom <-> st_setsrid(st_makepoint(p_lon, p_lat), 4326)
        limit 5
      ) s),
    'brownfield_nearby', (
      select count(*) from public.brownfield
      where area is not null
        and area::geometry && st_expand(st_setsrid(st_makepoint(p_lon, p_lat), 4326), 0.012)
        and st_dwithin(area, st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography, 800)
    )
  );
$function$;
