-- 0041_delete_dataset_chunk.sql
-- Delete one dataset's rows a chunk at a time, so clearing a large dataset
-- cannot hit the statement timeout.
--
-- WHY THIS EXISTS. The loader clears a dataset with a single
-- `DELETE ... WHERE dataset = ?` through PostgREST. For building_height that is
-- 1,500,761 rows and it never completes inside the statement timeout — it
-- failed four times running on 2026-08-01, and because the loader deletes every
-- dataset up front before upserting anything, that one timeout aborted the run
-- AFTER 22 other datasets had already been cleared. Universities, substations,
-- PTAL, TPO zones, boundaries and the rest were deleted and never reloaded.
--
-- A bounded delete finishes well inside the timeout, so the loader can call it
-- in a loop until it returns 0 and clear a dataset of any size.
--
-- ctid is used rather than a key because map_features has a composite primary
-- key (dataset, source_id); ctid gives a cheap physical row address for the
-- LIMIT, which is exactly what is wanted here.

create or replace function public.delete_dataset_chunk(
  p_dataset text,
  p_limit integer default 50000)
returns integer
language plpgsql
volatile
as $function$
declare
  n integer;
begin
  with doomed as (
    select ctid from public.map_features
    where dataset = p_dataset
    limit greatest(1, least(p_limit, 200000))
  )
  delete from public.map_features mf
  using doomed d
  where mf.ctid = d.ctid;
  get diagnostics n = row_count;
  return n;
end;
$function$;

-- Destructive: the loader authenticates with the service_role key, and nothing
-- reachable from the browser has any business calling this.
revoke all on function public.delete_dataset_chunk(text, integer) from public;
revoke all on function public.delete_dataset_chunk(text, integer) from anon;
revoke all on function public.delete_dataset_chunk(text, integer) from authenticated;
grant execute on function public.delete_dataset_chunk(text, integer) to service_role;
