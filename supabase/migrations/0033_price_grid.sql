-- 0033_price_grid.sql
-- The sold-price HEATMAP engine. Individual Price Paid dots don't answer
-- "is this side of town worth more than that side" — a multi-resolution
-- aggregation does. rebuild_price_grid() bins every ppd_sales point into
-- square cells at four resolutions (~35 km down to ~550 m) and stores, per
-- cell: sale count, median price, and an ESTIMATED £/m² (price ÷ typical
-- floor area for the property type — EHS averages: detached 104 m², semi 93,
-- terrace 82, flat 57). True per-sale £/m² arrives when the EPC floor-area
-- join lands; until then the estimate is honestly labelled in the UI.
-- The frontend picks the per-zoom dataset (price_grid_c/l/m/f), so one
-- toggle serves national, county, city and neighbourhood views.
-- Re-run after every PPD reload:  select public.rebuild_price_grid();

create or replace function public.rebuild_price_grid()
returns integer language plpgsql volatile as $function$
declare
  r double precision;
  min_n integer;
  total integer := 0;
  n integer;
begin
  -- One dataset per resolution: the (dataset, geom) index then serves each
  -- zoom band directly — a res-prop filter would scan every cell's jsonb.
  delete from public.map_features where dataset like 'price_grid%';
  foreach r in array array[0.32, 0.08, 0.02, 0.005] loop
    -- Small cells keep a 3-sale floor (noise + privacy); big cells 5.
    min_n := case when r < 0.01 then 3 else 5 end;
    insert into public.map_features (dataset, source_id, name, props, geom)
    select 'price_grid_' || case when r > 0.3 then 'c' when r > 0.05 then 'l'
             when r > 0.01 then 'm' else 'f' end,
           'pg-' || r || '-' || cx || '-' || cy,
           null,
           jsonb_build_object(
             'res', r, 'n', cnt,
             'med', round(med)::bigint,
             'ppm2', round(ppm2)::int),
           st_makeenvelope(cx * r, cy * r, (cx + 1) * r, (cy + 1) * r, 4326)
    from (
      select floor(st_x(geom) / r)::int as cx,
             floor(st_y(geom) / r)::int as cy,
             count(*) as cnt,
             percentile_cont(0.5) within group
               (order by (props->>'price')::numeric) as med,
             percentile_cont(0.5) within group
               (order by (props->>'price')::numeric /
                 case props->>'ptype'
                   when 'D' then 104 when 'S' then 93
                   when 'T' then 82  when 'F' then 57 else 88 end) as ppm2
      from public.map_features
      where dataset = 'ppd_sales'
        and (props->>'price') ~ '^[0-9]+$'
      group by 1, 2
    ) q
    where cnt >= min_n;
    get diagnostics n = row_count;
    total := total + n;
  end loop;
  analyze public.map_features;
  return total;
end $function$;
revoke execute on function public.rebuild_price_grid() from public, anon, authenticated;
-- The PPD workflow re-aggregates after each load via PostgREST.
grant execute on function public.rebuild_price_grid() to service_role;
grant execute on function public.rebuild_grey_belt_candidates() to service_role;
