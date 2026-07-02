-- 0007_brownfield_area_multipolygon.sql
-- The brownfield.area column was geography(Polygon), but site footprints (the
-- planning.data.gov.uk brownfield-site dataset) are frequently MultiPolygons,
-- so loads failed with "Geometry type (MultiPolygon) does not match column type
-- (Polygon)". Widen it. area was all NULL at the time, so the cast is a no-op.
alter table public.brownfield
  alter column area type geography(MultiPolygon, 4326)
  using st_multi(area::geometry)::geography;
