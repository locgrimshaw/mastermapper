-- 0077_voa_offices.sql
--
-- Office rent evidence around a point, from the `voa_offices` map_features
-- dataset (one point per office hereditament in the VOA rating list, with
-- floor area and rateable value — the statutory open-market rent assessment
-- at the antecedent valuation date; 2026 list = April 2024 rents). Built by
-- pipeline/build_voa_offices.py, loaded by the load-voa-offices workflow.
--
-- office_rents_near: median / quartile £/m² from the offices around a site,
-- widening the search (2 -> 5 -> 10 -> 25 km) until at least 5 comparables
-- are found, plus the nearest dozen as an evidence list. This deliberately
-- replaces a planned LA-average table: a per-authority mean hides exactly
-- the town-centre vs out-of-town spread an appraisal cares about.

create or replace function public.office_rents_near(
  p_lat double precision, p_lng double precision)
returns jsonb language plpgsql stable as $$
declare
  pt geometry := st_setsrid(st_makepoint(p_lng, p_lat), 4326);
  km double precision;
  n integer;
  stats jsonb;
  ev jsonb;
begin
  foreach km in array array[2.0, 5.0, 10.0, 25.0] loop
    select count(*) into n
      from public.map_features
     where dataset = 'voa_offices'
       and geom && st_expand(pt, km / 70.0)
       and st_dwithin(geom::geography, pt::geography, km * 1000);
    exit when n >= 5 or km = 25.0;
  end loop;

  if n = 0 then
    return jsonb_build_object('km', km, 'n', 0);
  end if;

  select jsonb_build_object(
           'km', km, 'n', count(*),
           'med_pm2', round(percentile_cont(0.5) within group
                        (order by (props->>'pm2')::numeric)),
           'p25', round(percentile_cont(0.25) within group
                        (order by (props->>'pm2')::numeric)),
           'p75', round(percentile_cont(0.75) within group
                        (order by (props->>'pm2')::numeric)),
           'med_m2', round(percentile_cont(0.5) within group
                        (order by (props->>'m2')::numeric)))
    into stats
    from public.map_features
   where dataset = 'voa_offices'
     and geom && st_expand(pt, km / 70.0)
     and st_dwithin(geom::geography, pt::geography, km * 1000);

  select jsonb_agg(row_j) into ev from (
    select jsonb_build_object(
             'addr', name, 'pc', props->>'pc',
             'm2', (props->>'m2')::numeric,
             'rv', (props->>'rv')::numeric,
             'pm2', (props->>'pm2')::numeric,
             'dist_m', round(st_distance(geom::geography, pt::geography))) row_j
      from public.map_features
     where dataset = 'voa_offices'
       and geom && st_expand(pt, km / 70.0)
       and st_dwithin(geom::geography, pt::geography, km * 1000)
     order by geom <-> pt
     limit 12) sub;

  return stats || jsonb_build_object('rows', coalesce(ev, '[]'::jsonb));
end $$;

grant execute on function public.office_rents_near(double precision, double precision)
  to anon, authenticated;
