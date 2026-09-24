-- 0082 · Row Level Security on every public table.
--
-- Nineteen tables were created without RLS, so the anon key (shipped in
-- web/config.js) could insert, update and delete rows in them. Two groups:
--
--   Reference data the site reads — most of it through SECURITY INVOKER RPCs
--   (brownfield_in_bbox, dc_cells_bbox, dd_station_context, …) that run as
--   anon. These get RLS plus a read-only policy, matching pipr_rents (0075):
--   reads keep working, writes from the public key are refused.
--
--   Staging / raw import tables nothing in the front end touches. These get
--   RLS with NO policy and lose their anon/authenticated grants. Loaders use
--   the service role or a direct Postgres connection, both of which bypass
--   RLS, so imports are unaffected.

do $$
declare t text;
begin
  foreach t in array array[
    'brownfield', 'simd', 'dataset_meta', 'built_land_bng', 'council_control',
    'dc_grid', 'dc_sub132', 'dc_sub275', 'dc_line132', 'dc_settlement',
    'dc_heat', 'dc_dno'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke insert, update, delete, truncate on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to anon, authenticated', t);
    begin
      execute format('create policy %I on public.%I for select using (true)', t || '_read', t);
    exception when duplicate_object then null;
    end;
  end loop;

  foreach t in array array[
    'stg_gp_import', 'stg_pharmacy_import', 'stg_school_import',
    'stg_nursery_import', 'stg_bus_import', 'stg_brownfield', '_osm_dc_raw'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- The rebuild/refresh jobs were executable with the anon key too, and
-- refresh_built_land_bng is SECURITY DEFINER, so anyone could trigger a
-- national rebuild. Workflows call them with the service key; keep it that way.
do $$
declare f regprocedure;
begin
  for f in
    select p.oid::regprocedure from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('dc_grid_seed', 'rebuild_dc_grid', 'rebuild_dc_grid_dist2',
                        'rebuild_station_assessments', 'rebuild_station_prices',
                        'rebuild_station_scotland', 'rebuild_station_socioecon',
                        'refresh_built_land_bng')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
