-- 0044_price_grid_types_trend.sql
-- The price grid learns two things a viability appraisal actually needs:
-- WHAT KIND of stock a number describes, and WHICH WAY the market is moving.
--
-- 1. Houses (ptype D/S/T) and flats (F) get their own medians per cell:
--    n_h/med_h/ppm2_h and n_f/med_f/ppm2_f. Pooling them — what the grid did
--    until now — mixes two different markets: a cell of £700k houses and £250k
--    flats reads as a meaningless £450k. Each split is emitted only when its
--    OWN count clears the cell's min_n privacy floor, so a cell can carry a
--    house median but no flat median. £/m² per split prefers the real
--    EPC-matched median (>=3 matched sales of that type) and falls back to the
--    type-mix estimate over that type's sales only.
--
-- 2. trend_pct: median price over the last 12 months vs the median over months
--    13-36, as a percentage. Emitted only when BOTH windows have >= 5 sales —
--    a trend from two sales is noise wearing a percent sign. Depends on the
--    PPD window actually containing 36 months (build_ppd.py's year-range bug
--    is fixed in the same commit; until a 36-month load has run, cells simply
--    lack the older window and omit the key rather than fabricating a trend).
--
-- All existing props (res, n, med, ppm2, epc, m2n) are unchanged, so the
-- deployed frontend keeps working while this rolls out.
--
-- Same signature as 0034 — plain create-or-replace, no drop dance needed.

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
             'm2n', m2n)
           -- Houses split: only when the house count itself clears the floor.
           || case when n_h >= min_n then jsonb_build_object(
                'n_h', n_h,
                'med_h', round(med_h)::bigint,
                'ppm2_h', round(coalesce(
                  case when m2n_h >= 3 then ppm2r_h end, ppm2e_h))::int,
                'epc_h', (m2n_h >= 3))
              else '{}'::jsonb end
           -- Flats split, same rule.
           || case when n_f >= min_n then jsonb_build_object(
                'n_f', n_f,
                'med_f', round(med_f)::bigint,
                'ppm2_f', round(coalesce(
                  case when m2n_f >= 3 then ppm2r_f end, ppm2e_f))::int,
                'epc_f', (m2n_f >= 3))
              else '{}'::jsonb end
           -- Trend: last 12 months vs months 13-36, both windows >= 5 sales.
           || case when n_r12 >= 5 and n_p24 >= 5 and med_p24 > 0
                then jsonb_build_object(
                  'trend_pct', round((med_r12 / med_p24 - 1) * 1000) / 10.0,
                  'n_r12', n_r12, 'n_p24', n_p24)
              else '{}'::jsonb end,
           st_makeenvelope(cx * r, cy * r, (cx + 1) * r, (cy + 1) * r, 4326)
    from (
      select floor(st_x(geom) / r)::int as cx,
             floor(st_y(geom) / r)::int as cy,
             count(*) as cnt,
             percentile_cont(0.5) within group
               (order by (props->>'price')::numeric) as med,
             percentile_cont(0.5) within group
               (order by (props->>'ppm2r')::numeric)
               filter (where props ? 'ppm2r') as ppm2r,
             count(*) filter (where props ? 'ppm2r') as m2n,
             percentile_cont(0.5) within group
               (order by (props->>'price')::numeric /
                 case props->>'ptype'
                   when 'D' then 104 when 'S' then 93
                   when 'T' then 82  when 'F' then 57 else 88 end) as ppm2e,

             -- Houses: detached / semi / terraced. 'O' (other) is in the pooled
             -- figures only — a shop with a flat above is neither market.
             count(*) filter (where props->>'ptype' in ('D','S','T')) as n_h,
             percentile_cont(0.5) within group
               (order by (props->>'price')::numeric)
               filter (where props->>'ptype' in ('D','S','T')) as med_h,
             percentile_cont(0.5) within group
               (order by (props->>'ppm2r')::numeric)
               filter (where props ? 'ppm2r'
                       and props->>'ptype' in ('D','S','T')) as ppm2r_h,
             count(*) filter (where props ? 'ppm2r'
                       and props->>'ptype' in ('D','S','T')) as m2n_h,
             percentile_cont(0.5) within group
               (order by (props->>'price')::numeric /
                 case props->>'ptype'
                   when 'D' then 104 when 'S' then 93 else 82 end)
               filter (where props->>'ptype' in ('D','S','T')) as ppm2e_h,

             count(*) filter (where props->>'ptype' = 'F') as n_f,
             percentile_cont(0.5) within group
               (order by (props->>'price')::numeric)
               filter (where props->>'ptype' = 'F') as med_f,
             percentile_cont(0.5) within group
               (order by (props->>'ppm2r')::numeric)
               filter (where props ? 'ppm2r'
                       and props->>'ptype' = 'F') as ppm2r_f,
             count(*) filter (where props ? 'ppm2r'
                       and props->>'ptype' = 'F') as m2n_f,
             percentile_cont(0.5) within group
               (order by (props->>'price')::numeric / 57)
               filter (where props->>'ptype' = 'F') as ppm2e_f,

             count(*) filter (where (props->>'date')::date
                       >= current_date - interval '12 months') as n_r12,
             percentile_cont(0.5) within group
               (order by (props->>'price')::numeric)
               filter (where (props->>'date')::date
                       >= current_date - interval '12 months') as med_r12,
             count(*) filter (where (props->>'date')::date
                       <  current_date - interval '12 months'
                       and (props->>'date')::date
                       >= current_date - interval '36 months') as n_p24,
             percentile_cont(0.5) within group
               (order by (props->>'price')::numeric)
               filter (where (props->>'date')::date
                       <  current_date - interval '12 months'
                       and (props->>'date')::date
                       >= current_date - interval '36 months') as med_p24
      from public.map_features
      where dataset = 'ppd_sales'
        and (props->>'price') ~ '^[0-9]+$'
        and (props->>'date') ~ '^\d{4}-\d{2}-\d{2}$'
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
