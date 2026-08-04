-- 0042_grid_in_bbox.sql
-- Zoom-aware aggregation for regular value grids (ground slope today, any
-- raster-derived grid later), replacing row-capped truncation.
--
-- THE BUG THIS FIXES. features_in_bbox ends with `order by size_metric desc
-- limit $6`. size_metric is polygon area in SQUARE DEGREES, and a 1 km cell
-- spans more LONGITUDE the further north it sits — so for a uniform metric
-- grid, degree-area rises monotonically with latitude (measured on slope_grid:
-- 0.000124 at 49.8°N climbing to 0.000160 at 59°N, strictly increasing across
-- every band). That ordering is therefore, for this dataset, exactly
-- "order by latitude desc".
--
-- Zoomed out over the Midlands, 13,640 cells fell inside the viewport and the
-- 8,000 cap kept the 8,000 NORTHERNMOST: the layer spanned 52.696–53.704°N but
-- only rendered 53.038–53.700°N. The result was a razor-straight horizontal
-- edge with full coverage above it and bare basemap below, marching north as
-- you zoomed out and filling back in as you zoomed in. It reads exactly like a
-- projection fault, which is what it is — just in the ORDER BY, not the render.
--
-- Truncation is the wrong answer for a continuous grid regardless of ordering:
-- an unbiased sample would only trade a straight edge for scattered holes.
-- Instead this snaps cells onto a coarser grid sized to the zoom and averages
-- them, so coverage is always COMPLETE and the row count is bounded by
-- construction rather than by a cap that silently discards data.
--
-- Cell size targets p_cell_px screen pixels, floored at p_min_step so it never
-- goes finer than the source grid: zoomed in past that, each bucket holds one
-- cell and the original values pass through untouched.

create or replace function public.grid_in_bbox(
  p_dataset text,
  w double precision, s double precision, e double precision, n double precision,
  p_zoom double precision default null,
  lim integer default 8000,
  p_avg_key text default null,
  p_max_key text default null,
  p_cell_px double precision default 14,
  p_min_step double precision default 0.009)
returns jsonb
language plpgsql stable as $function$
declare
  step double precision;
  res jsonb;
begin
  -- Degrees per pixel at this zoom; 0 when the caller sends no zoom, in which
  -- case the floor applies and the grid comes back at source resolution.
  step := greatest(coalesce(public._px_deg(p_zoom), 0) * greatest(p_cell_px, 1),
                   greatest(p_min_step, 0.0001));
  select jsonb_build_object(
    'type', 'FeatureCollection',
    'features', coalesce(jsonb_agg(jsonb_build_object(
      'type', 'Feature',
      'properties',
        (case when p_avg_key is null then '{}'::jsonb
              else jsonb_build_object(p_avg_key, round(b.avg_val::numeric, 2)) end)
        || (case when p_max_key is null then '{}'::jsonb
                 else jsonb_build_object(p_max_key, round(b.max_val::numeric, 2)) end)
        || jsonb_build_object('cells', b.cells, 'dataset', p_dataset),
      'geometry', st_asgeojson(
        st_makeenvelope(b.gx * step, b.gy * step,
                        (b.gx + 1) * step, (b.gy + 1) * step, 4326), 6)::jsonb)),
      '[]'::jsonb))
  into res
  from (
    select floor(st_x(c) / step)::bigint  as gx,
           floor(st_y(c) / step)::bigint  as gy,
           avg(av) as avg_val,
           max(coalesce(mx, av)) as max_val,
           count(*)::int as cells
    from (
      select st_centroid(mf.geom) as c,
             case when p_avg_key is null then null
                  when jsonb_typeof(mf.props -> p_avg_key) = 'number'
                       then (mf.props ->> p_avg_key)::double precision
                  when mf.props ->> p_avg_key ~ '^-?[0-9]+(\.[0-9]+)?$'
                       then (mf.props ->> p_avg_key)::double precision end as av,
             case when p_max_key is null then null
                  when jsonb_typeof(mf.props -> p_max_key) = 'number'
                       then (mf.props ->> p_max_key)::double precision
                  when mf.props ->> p_max_key ~ '^-?[0-9]+(\.[0-9]+)?$'
                       then (mf.props ->> p_max_key)::double precision end as mx
      from public.map_features mf
      where mf.dataset = p_dataset
        and mf.geom && st_makeenvelope(w, s, e, n, 4326)
    ) q
    group by 1, 2
    -- Backstop only. Cell size scales with zoom, so the bucket count is
    -- roughly constant (~viewport_px / p_cell_px per side) and this should
    -- never bite; if it ever does, it is a plain cap, not a latitude sort.
    limit greatest(lim, 1)
  ) b;
  return res;
end $function$;

alter function public.grid_in_bbox(text, double precision, double precision,
  double precision, double precision, double precision, integer, text, text,
  double precision, double precision) set plan_cache_mode = force_custom_plan;

grant execute on function public.grid_in_bbox(text, double precision,
  double precision, double precision, double precision, double precision,
  integer, text, text, double precision, double precision)
  to anon, authenticated;
