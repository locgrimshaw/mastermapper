-- 0060: LSOA-level sold-price aggregates — dataset lsoa_prices.
--
-- Replaces the bilinear price/£-per-m² SURFACES with a choropleth on real
-- LSOA boundaries: the same visual language as the deprivation map (which
-- reads as analysis rather than decoration), and crisp administrative edges
-- instead of an interpolated blur.
--
-- Same aggregation conventions as rebuild_price_grid (0044/0052) so the
-- frontend's popup and ptype-filter logic carries straight over: med / med_h /
-- med_f, £/m² preferring the EPC-measured median (m2n >= 3) over the
-- typology-mix estimate, and the 12m-vs-prior-24m trend.
--
-- The ADDITION here is national PERCENTILE ranks (pct, pct_ppm2, and the
-- houses/flats variants). Absolute-£ ramps make most of England one flat
-- colour while London saturates; percentile ranking is exactly what gives the
-- deprivation choropleth its even, legible spread. Absolute values are kept in
-- the props for the popup and legend, so nothing is hidden by the ranking.
--
-- min_n = 3 sales per LSOA: the same privacy floor as the finest grid band.
-- An LSOA with fewer sales in 36 months is omitted (renders as no-data)
-- rather than published as a one-sale "median".
--
-- Cost: a 2M-point-in-33.7k-polygon spatial join, minutes not seconds. Run it
-- after each ppd_sales load, alongside rebuild_price_grid.

create or replace function public.rebuild_lsoa_prices()
returns integer
language plpgsql
as $$
declare n integer;
begin
  delete from public.map_features where dataset = 'lsoa_prices';

  insert into public.map_features (dataset, source_id, name, props, geom)
  with agg as (
    select l.lsoa_code,
           l.lad_name,
           l.geom,
           count(*) as cnt,
           percentile_cont(0.5) within group
             (order by (s.props->>'price')::numeric) as med,
           -- £/m²: measured (EPC floor area) preferred, typology-mix estimate
           -- as the fallback — identical rule to the grid.
           percentile_cont(0.5) within group
             (order by (s.props->>'ppm2r')::numeric)
             filter (where s.props ? 'ppm2r') as ppm2r,
           count(*) filter (where s.props ? 'ppm2r') as m2n,
           percentile_cont(0.5) within group
             (order by (s.props->>'price')::numeric /
               case s.props->>'ptype'
                 when 'D' then 104 when 'S' then 93
                 when 'T' then 82  when 'F' then 57 else 88 end) as ppm2e,
           -- Houses (detached / semi / terrace)
           count(*) filter (where s.props->>'ptype' in ('D','S','T')) as n_h,
           percentile_cont(0.5) within group
             (order by (s.props->>'price')::numeric)
             filter (where s.props->>'ptype' in ('D','S','T')) as med_h,
           percentile_cont(0.5) within group
             (order by (s.props->>'ppm2r')::numeric)
             filter (where s.props ? 'ppm2r'
                     and s.props->>'ptype' in ('D','S','T')) as ppm2r_h,
           count(*) filter (where s.props ? 'ppm2r'
                     and s.props->>'ptype' in ('D','S','T')) as m2n_h,
           percentile_cont(0.5) within group
             (order by (s.props->>'price')::numeric /
               case s.props->>'ptype'
                 when 'D' then 104 when 'S' then 93 else 82 end)
             filter (where s.props->>'ptype' in ('D','S','T')) as ppm2e_h,
           -- Flats
           count(*) filter (where s.props->>'ptype' = 'F') as n_f,
           percentile_cont(0.5) within group
             (order by (s.props->>'price')::numeric)
             filter (where s.props->>'ptype' = 'F') as med_f,
           percentile_cont(0.5) within group
             (order by (s.props->>'ppm2r')::numeric)
             filter (where s.props ? 'ppm2r'
                     and s.props->>'ptype' = 'F') as ppm2r_f,
           count(*) filter (where s.props ? 'ppm2r'
                     and s.props->>'ptype' = 'F') as m2n_f,
           percentile_cont(0.5) within group
             (order by (s.props->>'price')::numeric / 57)
             filter (where s.props->>'ptype' = 'F') as ppm2e_f,
           -- Trend: last 12 months vs the prior 24
           count(*) filter (where (s.props->>'date')::date
                     >= current_date - interval '12 months') as n_r12,
           percentile_cont(0.5) within group
             (order by (s.props->>'price')::numeric)
             filter (where (s.props->>'date')::date
                     >= current_date - interval '12 months') as med_r12,
           count(*) filter (where (s.props->>'date')::date
                     <  current_date - interval '12 months'
                     and (s.props->>'date')::date
                     >= current_date - interval '36 months') as n_p24,
           percentile_cont(0.5) within group
             (order by (s.props->>'price')::numeric)
             filter (where (s.props->>'date')::date
                     <  current_date - interval '12 months'
                     and (s.props->>'date')::date
                     >= current_date - interval '36 months') as med_p24
    from public.lsoa_imd l
    join public.map_features s
      on s.dataset = 'ppd_sales'
     and s.geom && l.geom
     and st_intersects(s.geom, l.geom)
    where (s.props->>'price') ~ '^[0-9]+$'
      and (s.props->>'date') ~ '^\d{4}-\d{2}-\d{2}$'
    group by l.lsoa_code, l.lad_name, l.geom
  ),
  kept as (
    select *,
           coalesce(case when m2n   >= 3 then ppm2r   end, ppm2e)   as ppm2_v,
           coalesce(case when m2n_h >= 3 then ppm2r_h end, ppm2e_h) as ppm2_h_v,
           coalesce(case when m2n_f >= 3 then ppm2r_f end, ppm2e_f) as ppm2_f_v
    from agg
    where cnt >= 3
  ),
  ranked as (
    -- National percentile ranks (0 = cheapest, 100 = dearest). Each metric is
    -- ranked only over the LSOAs that HAVE it, so the houses ramp is not
    -- skewed by flat-only areas and vice versa.
    select k.*,
           round((percent_rank() over (order by med))      * 1000) / 10.0 as pct,
           round((percent_rank() over (order by ppm2_v))   * 1000) / 10.0 as pct_ppm2,
           case when n_h >= 3 then
             round((percent_rank() over (
               partition by (n_h >= 3) order by med_h)) * 1000) / 10.0 end as pct_h,
           case when n_f >= 3 then
             round((percent_rank() over (
               partition by (n_f >= 3) order by med_f)) * 1000) / 10.0 end as pct_f,
           case when n_h >= 3 then
             round((percent_rank() over (
               partition by (n_h >= 3) order by ppm2_h_v)) * 1000) / 10.0 end as pct_ppm2_h,
           case when n_f >= 3 then
             round((percent_rank() over (
               partition by (n_f >= 3) order by ppm2_f_v)) * 1000) / 10.0 end as pct_ppm2_f
    from kept k
  )
  select 'lsoa_prices',
         lsoa_code,
         lad_name,
         jsonb_build_object(
           'lsoa', lsoa_code, 'n', cnt,
           'med',  round(med)::bigint,
           'ppm2', round(ppm2_v)::int,
           'epc',  (m2n >= 3),
           'm2n',  m2n,
           'pct',      pct,
           'pct_ppm2', pct_ppm2)
         || case when n_h >= 3 then jsonb_build_object(
              'n_h', n_h, 'med_h', round(med_h)::bigint,
              'ppm2_h', round(ppm2_h_v)::int, 'epc_h', (m2n_h >= 3),
              'pct_h', pct_h, 'pct_ppm2_h', pct_ppm2_h)
            else '{}'::jsonb end
         || case when n_f >= 3 then jsonb_build_object(
              'n_f', n_f, 'med_f', round(med_f)::bigint,
              'ppm2_f', round(ppm2_f_v)::int, 'epc_f', (m2n_f >= 3),
              'pct_f', pct_f, 'pct_ppm2_f', pct_ppm2_f)
            else '{}'::jsonb end
         || case when n_r12 >= 5 and n_p24 >= 5 and med_p24 > 0
              then jsonb_build_object(
                'trend_pct', round((med_r12 / med_p24 - 1) * 1000) / 10.0,
                'n_r12', n_r12, 'n_p24', n_p24)
            else '{}'::jsonb end,
         geom
  from ranked;

  get diagnostics n = row_count;
  analyze public.map_features;
  return n;
end $$;

revoke all on function public.rebuild_lsoa_prices() from public, anon, authenticated;
grant execute on function public.rebuild_lsoa_prices() to service_role;
