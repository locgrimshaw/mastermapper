-- 0085 · London sites: every plot outline, served once.
--
-- The sifter used to fetch outlines per viewport from z13 (london_site_shapes),
-- so below that zoom every site was a dot. Outlines now draw from z11: the
-- page pulls them all once, lightly simplified (~3 m), and keeps them.
--
-- `outline` is the simplified GeoJSON geometry, stored so a request pages
-- through text rather than re-simplifying 22k polygons. All 22,574 come to
-- about 5 MB uncompressed. Generated, so rebuild_london_sites keeps it current
-- with no extra step.

alter table public.london_sites
  add column if not exists outline text
  generated always as (
    extensions.st_asgeojson(extensions.st_simplifypreservetopology(geom, 0.00003), 5)) stored;

-- Paged by the client (PostgREST caps a response at 1,000 rows).
create or replace function public.london_site_outlines()
returns table (id int, outline text)
language sql stable
set search_path = public
as $$
  select id, outline from london_sites where outline is not null
$$;

grant execute on function public.london_site_outlines() to anon, authenticated;
