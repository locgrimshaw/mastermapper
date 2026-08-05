-- 0048: keyset chunk delete. The ctid version re-scanned the dataset from the
-- start on every call, wading through the dead tuples its own previous chunks
-- had just created: on ppd_sales (~910k rows in a 2.3 GB heap) each chunk got
-- slower than the last until even 500-row chunks blew the 8 s statement
-- timeout the authenticator role imposes on PostgREST sessions (observed
-- 2026-08-05, run 30996968528). Keyset on the primary key (dataset,
-- source_id) instead: the caller threads back the last id removed, so every
-- chunk descends the btree straight past already-deleted territory and the
-- per-chunk cost stays flat no matter how many rows have gone before.
-- Return type changes (integer -> jsonb carrying the cursor), so drop first.
drop function if exists public.delete_dataset_chunk(text, integer);

create function public.delete_dataset_chunk(
  p_dataset text,
  p_limit   integer default 10000,
  p_after   text    default ''
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_removed integer;
  v_last    text;
begin
  with doomed as (
    select source_id
    from public.map_features
    where dataset = p_dataset
      and source_id > p_after
    order by source_id
    limit greatest(1, least(p_limit, 200000))
  ),
  gone as (
    delete from public.map_features mf
    using doomed d
    where mf.dataset = p_dataset
      and mf.source_id = d.source_id
    returning mf.source_id
  )
  select count(*), max(source_id) into v_removed, v_last from gone;
  return jsonb_build_object('removed', coalesce(v_removed, 0), 'last', v_last);
end;
$$;

revoke all on function public.delete_dataset_chunk(text, integer, text) from public;
revoke all on function public.delete_dataset_chunk(text, integer, text) from anon, authenticated;
grant execute on function public.delete_dataset_chunk(text, integer, text) to service_role;

notify pgrst, 'reload schema';
