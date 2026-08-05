-- 0053: refresh_built_land_bng must run as its owner. It truncates/rebuilds
-- the built_land_bng tile table, and TRUNCATE demands table ownership —
-- fine historically when the rebuild ran as postgres via direct SQL, but
-- rebuild_station_assessments now runs through PostgREST as service_role,
-- and every A-Z batch of run 31011634894 died on 42501 'must be owner of
-- table built_land_bng'. SECURITY DEFINER (owner: postgres) with a pinned
-- search_path lets the service-role call execute it safely.
alter function public.refresh_built_land_bng() security definer set search_path = public;

notify pgrst, 'reload schema';
