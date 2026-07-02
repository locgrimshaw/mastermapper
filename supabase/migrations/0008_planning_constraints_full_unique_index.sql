-- 0008_planning_constraints_full_unique_index.sql
-- PostgREST upsert (?on_conflict=kind,source_id, used by load_constraints.py)
-- needs a NON-partial unique index as the conflict arbiter. The original partial
-- index from 0005 (WHERE source_id is not null) is rejected by Postgres with
-- 42P10 "no unique or exclusion constraint matching the ON CONFLICT
-- specification". build_constraints.py always populates source_id (falling back
-- to a stable geometry hash), so a plain unique index on (kind, source_id) is
-- both correct and sufficient.
drop index if exists public.planning_constraints_kind_source_uidx;
create unique index if not exists planning_constraints_kind_source_uidx
  on public.planning_constraints (kind, source_id);
