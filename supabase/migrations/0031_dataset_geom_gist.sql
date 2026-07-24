-- 0031_dataset_geom_gist.sql
-- map_features now carries two city-dense point datasets (ppd_sales 533k,
-- bus_stop 344k). The lone gist(geom) index makes every bbox RPC wade
-- through ALL datasets' rows in the viewport before the dataset filter
-- applies. A composite (dataset, geom) GiST index (btree_gist) turns each
-- features_in_bbox call into a single index descent for its own dataset.
set local statement_timeout = '15min';
create extension if not exists btree_gist;
create index if not exists map_features_dataset_geom_gix
  on public.map_features using gist (dataset, geom);
analyze public.map_features;
