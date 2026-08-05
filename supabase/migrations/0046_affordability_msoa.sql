-- 0046_affordability_msoa.sql
-- Affordability at neighbourhood scale, not just district scale.
--
-- Lorcan's point, verbatim: "not much use having a big city skew the income
-- for a small village". LAD-level affordability does exactly that — one
-- figure per district. msoa_income (ONS small area household income, ~7,200
-- areas) fixes the denominator; this migration extends the ratio computation
-- to cover it, so both layers carry med_price / afford_ratio after each PPD
-- load.
--
-- Same function name rebuild_lad_affordability() — the load-ppd workflow
-- already curls it, and a rename would silently orphan that step.
--
-- Sales floors differ by geography: 30 for a district, 20 for an MSOA (a
-- district has ~20x the sales; demanding 30 of an MSOA would blank most rural
-- ones, and 20 is still enough that one odd street cannot set the median).

create or replace function public.rebuild_lad_affordability()
returns integer language plpgsql volatile as $function$
declare
  n integer := 0;
  n2 integer := 0;
begin
  with med as (
    select li.dataset, li.source_id,
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
    where li.dataset in ('lad_income', 'msoa_income')
    group by li.dataset, li.source_id
  )
  update public.map_features mf
  set props = mf.props
      || case when m.n_sales >= case m.dataset when 'msoa_income' then 20
                                               else 30 end then
           jsonb_build_object('med_price', round(m.med_price)::bigint,
                              'n_sales_12m', m.n_sales)
         else '{}'::jsonb end
      || case when m.n_sales >= case m.dataset when 'msoa_income' then 20
                                               else 30 end
               and (mf.props->>'income_median')::numeric > 0 then
           jsonb_build_object('afford_ratio',
             round(m.med_price / (mf.props->>'income_median')::numeric * 10)
               / 10.0)
         else '{}'::jsonb end
  from med m
  where mf.dataset = m.dataset and mf.source_id = m.source_id;
  get diagnostics n = row_count;
  return n;
end $function$;
revoke execute on function public.rebuild_lad_affordability() from public, anon, authenticated;
grant execute on function public.rebuild_lad_affordability() to service_role;
