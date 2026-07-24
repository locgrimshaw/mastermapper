-- 0036_dataset_meta.sql
-- Data freshness ledger: the loader stamps every dataset it (re)loads with
-- a timestamp + row count, so the app (and the operator) can always answer
-- "how old is this layer?". Publicly readable; written via service key.

create table if not exists public.dataset_meta (
  dataset   text primary key,
  loaded_at timestamptz not null default now(),
  n_rows    integer
);
grant select on public.dataset_meta to anon, authenticated;
grant insert, update on public.dataset_meta to service_role;
