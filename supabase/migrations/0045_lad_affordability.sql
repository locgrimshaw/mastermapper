-- 0045_lad_affordability.sql
-- Affordability = what a home costs against what people here earn.
--
-- lad_income rows (ONS ASHE median gross annual pay, loaded by
-- build_datasets.build_income) gain two computed props after each PPD load:
--   med_price     median ppd_sales price of the LAST 12 MONTHS inside the LAD
--   afford_ratio  med_price / income_median, 1dp — the layer the map colours
--
-- Twelve months, not the full 36-month window, for two reasons: affordability
-- is a statement about NOW, and the point-in-polygon join over every sale is
-- the expensive part — a third of the rows keeps it comfortably inside the
-- workflow's timeout. Like the price grid, this is service-role-only and
-- invoked by the load-ppd workflow via PostgREST curl (--max-time 1500), never
-- through the 60-second MCP path.
--
-- LADs with no income (ASHE suppression) or fewer than 30 sales in the year
-- keep their income prop but get no ratio: a ratio from a handful of sales
-- would colour a whole authority off one street.

create or replace function public.rebuild_lad_affordability()
returns integer language plpgsql volatile as $function$
declare
  n integer;
begin
  with med as (
    select li.source_id,
           count(s.geom) as n_sales,
           percentile_cont(0.5) within group
             (order by (s.props->>'price')::numeric) as med_price
    from public.map_features li
    left join public.map_features s
      on s.dataset = 'ppd_sales'
     and (s.props->>'date') ~ '^\d{4}-\d{2}-\d{2}$'
     and (s.props->>'date')::date >= current_date - interval '12 months'
     and (s.props->>'price') ~ '^[0-9]+$'
     and st_contains(li.geom, s.geom)
    where li.dataset = 'lad_income'
    group by li.source_id
  )
  update public.map_features mf
  set props = mf.props
      || case when m.n_sales >= 30 then
           jsonb_build_object('med_price', round(m.med_price)::bigint,
                              'n_sales_12m', m.n_sales)
         else '{}'::jsonb end
      || case when m.n_sales >= 30
               and (mf.props->>'income_median')::numeric > 0 then
           jsonb_build_object('afford_ratio',
             round(m.med_price / (mf.props->>'income_median')::numeric * 10)
               / 10.0)
         else '{}'::jsonb end
  from med m
  where mf.dataset = 'lad_income' and mf.source_id = m.source_id;
  get diagnostics n = row_count;
  return n;
end $function$;
revoke execute on function public.rebuild_lad_affordability() from public, anon, authenticated;
grant execute on function public.rebuild_lad_affordability() to service_role;
