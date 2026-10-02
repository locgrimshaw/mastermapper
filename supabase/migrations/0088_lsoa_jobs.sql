-- 0088 · lsoa_jobs: employee jobs by 2021 LSOA (ONS BRES via Nomis, NM_189_1,
-- employment, all industries). England & Wales. Feeds the "everyday
-- population" (residents + workers) in stadium_metrics (0089).
create table if not exists public.lsoa_jobs (
  lsoa_code text primary key,
  jobs integer not null,
  year text
);
alter table public.lsoa_jobs enable row level security;
create policy lsoa_jobs_read on public.lsoa_jobs for select using (true);
grant select on public.lsoa_jobs to anon, authenticated;
