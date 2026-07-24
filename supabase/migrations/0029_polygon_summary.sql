-- 0029_polygon_summary.sql
-- The portfolio tool's engine: everything we know about one SITE (polygon or
-- point+radius), as one JSON. Generalises point_summary from "what covers
-- this point" to "how much of this site is covered" — constraint coverage
-- percentages, context areas, ownership, power and market signals. Called
-- once per site by the portfolio scorer (bounded work per call: indexed &&
-- candidates only, geometries intersected against ONE site geometry).
-- Also: point_summary gains nearest recent sales (ppd_sales) and the HDT
-- band for the covering authority.

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

-- point_summary additions: nearest recent sales + HDT in areas.
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
                          'design_code_area','la_rents','ptal','uni_campus_site','hdt')
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
