-- 0034_price_grid_epc.sql
-- £/m² graduates from estimate to measurement. build_ppd.py now address-
-- matches sales to EPC certificates (TOTAL_FLOOR_AREA), stamping matched
-- sales with m2 + ppm2r (price ÷ measured area). Each grid cell now prefers
-- the median of those REAL £/m² values when at least 3 matched sales back
-- it (epc=true, m2n = how many), falling back to the property-type-mix
-- estimate otherwise — so the heatmap improves cell by cell as EPC coverage
-- lands, with the hover always saying which kind of number it is showing.

create or replace function public.rebuild_price_grid()
returns integer language plpgsql volatile as $function$
declare
  r double precision;
  min_n integer;
  total integer := 0;
  n integer;
begin
  delete from public.map_features where dataset like 'price_grid%';
  foreach r in array array[0.32, 0.08, 0.02, 0.005] loop
    min_n := case when r < 0.01 then 3 else 5 end;
    insert into public.map_features (dataset, source_id, name, props, geom)
    select 'price_grid_' || case when r > 0.3 then 'c' when r > 0.05 then 'l'
             when r > 0.01 then 'm' else 'f' end,
           'pg-' || r || '-' || cx || '-' || cy,
           null,
           jsonb_build_object(
             'res', r, 'n', cnt,
             'med', round(med)::bigint,
             'ppm2', round(coalesce(
               case when m2n >= 3 then ppm2r end, ppm2e))::int,
             'epc', (m2n >= 3),
             'm2n', m2n),
           st_makeenvelope(cx * r, cy * r, (cx + 1) * r, (cy + 1) * r, 4326)
    from (
      select floor(st_x(geom) / r)::int as cx,
             floor(st_y(geom) / r)::int as cy,
             count(*) as cnt,
             percentile_cont(0.5) within group
               (order by (props->>'price')::numeric) as med,
             -- Real: median of price/EPC-measured-area over matched sales.
             percentile_cont(0.5) within group
               (order by (props->>'ppm2r')::numeric)
               filter (where props ? 'ppm2r') as ppm2r,
             count(*) filter (where props ? 'ppm2r') as m2n,
             -- Estimate: price / typical floor area for the property type.
             percentile_cont(0.5) within group
               (order by (props->>'price')::numeric /
                 case props->>'ptype'
                   when 'D' then 104 when 'S' then 93
                   when 'T' then 82  when 'F' then 57 else 88 end) as ppm2e
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
grant execute on function public.rebuild_price_grid() to service_role;
