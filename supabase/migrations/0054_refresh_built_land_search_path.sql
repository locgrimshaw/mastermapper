-- 0054: corrective for 0053. Pinning search_path = public broke PostGIS
-- resolution inside refresh_built_land_bng — Supabase installs PostGIS in
-- the extensions schema, so every st_* call failed with 42883 (run
-- 31018310050; no data harmed — batches failed before the delete). The pin
-- must include extensions.
alter function public.refresh_built_land_bng() set search_path = public, extensions;

notify pgrst, 'reload schema';
