-- 0052: per-resolution price-grid rebuild. The monolithic four-resolution
-- rebuild ran ~126 s on the 36-month dataset (2.07M sales) and died on the
-- API gateway's ~120 s ceiling (HTTP 504) — a wall the 20-minute role
-- statement budget cannot move, because the gateway hangs up and PostgREST
-- cancels the statement. One resolution per call fits comfortably; p_res
-- null keeps the old all-at-once behaviour for direct SQL use.
-- Zero-arg signature must be DROPPED first or the new default-arg version
-- would create an ambiguous overload (see 0050 for that lesson).

drop function if exists public.rebuild_price_grid();

create function public.rebuild_price_grid(p_res double precision default null)
returns integer
language plpgsql
as $function$
declare
  r double precision;
  min_n integer;
  total integer := 0;
  n integer;
begin
  foreach r in array array[0.32, 0.08, 0.02, 0.005] loop
    if p_res is not null and abs(r - p_res) > 1e-9 then
      continue;
    end if;
    min_n := case when r < 0.01 then 3 else 5 end;
    -- Per-dataset delete (was one like-delete up front): each call must
    -- replace only its own band so the other three stay live meanwhile.
    delete from public.map_features
      where dataset = 'price_grid_' || case when r > 0.3 then 'c' when r > 0.05 then 'l'
               when r > 0.01 then 'm' else 'f' end;
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
           || case when n_h >= min_n then jsonb_build_object(
                'n_h', n_h,
                'med_h', round(med_h)::bigint,
                'ppm2_h', round(coalesce(
                  case when m2n_h >= 3 then ppm2r_h end, ppm2e_h))::int,
                'epc_h', (m2n_h >= 3))
              else '{}'::jsonb end
           || case when n_f >= min_n then jsonb_build_object(
                'n_f', n_f,
                'med_f', round(med_f)::bigint,
                'ppm2_f', round(coalesce(
                  case when m2n_f >= 3 then ppm2r_f end, ppm2e_f))::int,
                'epc_f', (m2n_f >= 3))
              else '{}'::jsonb end
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

revoke all on function public.rebuild_price_grid(double precision) from public;
revoke all on function public.rebuild_price_grid(double precision) from anon, authenticated;
grant execute on function public.rebuild_price_grid(double precision) to service_role;

notify pgrst, 'reload schema';
