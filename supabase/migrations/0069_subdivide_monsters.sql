-- 0069_subdivide_monsters.sql
--
-- Subdivide the constraint table's monster geometries.
--
-- 103 of the 2.05M rows in planning_constraints carried geometries above
-- 8,192 vertices — the worst a 347,726-vertex national tidal-water feature
-- (the dissolved OS coastline). Every catchment query that touched one paid
-- st_makevalid + st_intersection on the WHOLE thing: Dalmeny (DAM), whose
-- 800 m circle clips the Firth of Forth, took minutes per call while inland
-- stations took a fifth of a second, and a station-assessments rebuild of the
-- D prefix blew a 30-minute statement budget on a handful of coastal rows.
--
-- st_subdivide splits each monster into <=512-vertex pieces. Coverage is
-- identical (subdivision is a partition of the input), the RPCs are untouched
-- — the erase set unions the pieces back together per catchment — and each
-- piece is small enough that makevalid and intersection are effectively free.
-- Piece rows keep the parent's kind/name/props with '#n' suffixed source_ids
-- to satisfy the (kind, source_id) unique index. area_deg2 (a generated
-- column) derives per piece automatically.
--
-- Loader idempotence: build_constraints.py upserts on (kind, source_id). A
-- future full reload of a kind will re-insert the parent row (one monster
-- again) and strand the '#n' pieces. So loaders should re-run this statement
-- after any load — noted in the workflow; the statement is idempotent (a
-- second run finds no rows above the threshold).

with monsters as (
  delete from public.planning_constraints
   where st_npoints(geom) > 8192
  returning kind, source_id, name, props, geom
),
-- SRF expansion happens AFTER window processing, so numbering in the same
-- select as st_subdivide would stamp every piece of a monster with part=1 and
-- collide on the (kind, source_id) unique index. Expand first, number second.
expanded as (
  select m.kind, m.source_id, m.name, m.props,
         st_subdivide(st_makevalid(m.geom), 512) as geom
    from monsters m
),
pieces as (
  select kind, source_id, name, props, geom,
         row_number() over (partition by kind, source_id) as part
    from expanded
)
-- area_deg2 is a generated column; geom_simple may be too on some installs —
-- insert only the base columns and let the table derive the rest.
insert into public.planning_constraints
  (kind, source_id, name, props, geom)
select kind,
       source_id || '#' || part,
       name,
       props || jsonb_build_object('subdivided', true),
       geom
  from pieces;

analyze public.planning_constraints;
