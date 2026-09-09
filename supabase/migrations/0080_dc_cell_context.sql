-- 0080_dc_cell_context.sql
-- One call for the DC deep-dive panel's map annotations: the nearest 132 kV+
-- substation (dc_sub132, OSM-derived) and the nearest 20k+ settlement
-- (dc_settlement, ONS BUA Dec 2022), each with coordinates and distance so
-- the client can draw a bearing arrow and label from the cell centre.
create or replace function public.dc_cell_context(p_lng double precision, p_lat double precision)
returns jsonb language sql stable as $$
  with pt as (select st_setsrid(st_makepoint(p_lng, p_lat), 4326) as g)
  select jsonb_build_object(
    'sub', (
      select jsonb_build_object(
        'lng', st_x(st_centroid(s.geom)), 'lat', st_y(st_centroid(s.geom)),
        'km', round((st_distance(s.geom::geography, pt.g::geography) / 1000)::numeric, 2))
        from public.dc_sub132 s, pt
       order by s.geom <-> pt.g limit 1),
    'town', (
      select jsonb_build_object(
        'name', t.name, 'pop', t.pop, 'lng', t.lng, 'lat', t.lat,
        'km', round((st_distance(t.geom::geography, pt.g::geography) / 1000)::numeric, 2))
        from public.dc_settlement t, pt
       where t.pop >= 20000
       order by t.geom <-> pt.g limit 1));
$$;
grant execute on function public.dc_cell_context(double precision, double precision) to anon, authenticated;
