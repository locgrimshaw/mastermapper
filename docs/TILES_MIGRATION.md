# Vector tiles migration — DONE (frontend + pipeline)

The map now loads from a single PMTiles vector-tile file instead of one large
GeoJSON. The browser fetches only the tiles covering the current view, so the
map stays fast at national scale. This was the fix for the slowness.

## What changed
- Pipeline (`build_tiles.py`) produces `web/data/lsoa.pmtiles` (the tiles) and
  `web/data/breaks.json` (precomputed colour breaks, price band, bbox, and a
  sample-data flag). The build Action runs it and commits both.
- The seven domain scores ride INSIDE the tiles as attributes, so the combined
  score is computed live in a MapLibre GPU expression. Verified: the expression
  produces identical numbers to the old JS scoring (zero difference).
- Click-inspect reads straight from the clicked tile feature.
- The plot report uses `queryRenderedFeatures` over the drawn area instead of
  looping all features.

## Behaviour change to know about
Colour class breaks are now FIXED (precomputed across the whole dataset) rather
than rebalancing as you reweight. This is deliberate — a tiled map can't see
the full distribution to recompute live, and fixed breaks keep colours
comparable as you experiment, which is what most pro tools do.

## The one thing to verify on GitHub Pages
PMTiles works over HTTP range requests. Pages supports these and the file is
same-origin, so it should "just work". If the map shows the basemap but no
coloured areas, open the browser console: a range-request or CORS error on
`lsoa.pmtiles` is the thing to look for. Same-origin usually avoids it.

## To deploy
Upload the changed files (`web/index.html`, `web/src/app.js`,
`pipeline/build_tiles.py`) and re-run the Build data layer action so the tiles
and sidecar regenerate. The frontend reads tiles from then on.
