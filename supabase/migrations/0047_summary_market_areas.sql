-- 0047_summary_market_areas.sql
-- polygon_summary and point_summary report market context alongside planning
-- context: the containing build-cost polygon and both income geographies join
-- the 'areas' object. This is how the deep-dive viability block and the land
-- assembly report get the local cost factor and affordability WITHOUT a new
-- fetch path (dataset_features_page is deliberately service-role-only).
--
-- Patched mechanically from the LIVE definitions rather than restating ~100
-- lines each and drifting. Each function has its own anchor because their
-- dataset lists differ; already-patched functions are skipped (idempotent).
do $do$
declare
  fn text;
  anchor text;
  src text;
  patched text;
begin
  for fn, anchor in values
    ('polygon_summary', $$'la_rents','ptal','hdt','planit_rates'$$),
    ('point_summary',   $$'grey_belt_candidate','planit_rates'$$)
  loop
    select pg_get_functiondef(p.oid) into src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = fn;
    if src is null then
      raise exception 'function public.% not found', fn;
    end if;
    if position('build_cost_index' in src) > 0 then
      raise notice '% already patched — skipping', fn;
      continue;
    end if;
    patched := replace(src, anchor,
      anchor || $$,'build_cost_index','lad_income','msoa_income'$$);
    if patched = src then
      raise exception 'anchor not found in % — definition drifted', fn;
    end if;
    execute patched;
  end loop;
end $do$;
