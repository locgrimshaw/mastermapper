-- 0051: expose the land_value dataset (MHCLG residential £/ha by LA) through
-- point_summary and polygon_summary areas, so the deep dive / assembler /
-- site report can price land from the published benchmark. Same mechanical
-- live-definition patch as 0047: append to the dataset in-list, guarded to
-- be idempotent and to fail loudly if the anchor text has drifted.
do $$
declare
  fn text;
  def text;
  anchor constant text := $a$'build_cost_index','lad_income','msoa_income'$a$;
begin
  foreach fn in array array['point_summary', 'polygon_summary'] loop
    select pg_get_functiondef(p.oid) into def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = fn;
    if def is null then
      raise exception '% not found', fn;
    end if;
    if def like '%''land_value''%' then
      raise notice '% already patched — skipping', fn;
      continue;
    end if;
    if position(anchor in def) = 0 then
      raise exception 'anchor % not found in % — definition drifted, patch by hand', anchor, fn;
    end if;
    def := replace(def, anchor, anchor || $a$,'land_value'$a$);
    execute def;
    raise notice '% patched', fn;
  end loop;
end $$;

notify pgrst, 'reload schema';
