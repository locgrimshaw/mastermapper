# Working in Codespaces

This project now has a devcontainer, so a Codespace comes up with Python 3.12
(+ pandas/geopandas) and Node already installed. Here are the few commands that
replace the old "everything must be a GitHub Action" workflow.

## Preview the site locally
The frontend is static files in `web/`. Serve them and open the forwarded port:

```bash
cd web && python -m http.server 8000
```

The Codespace auto-forwards port 8000 and opens a preview. Edit files in
`web/src/`, refresh the browser to see changes. No deploy needed to test.
(Tip: hard-refresh, or bump the `?v=` cache string in `index.html`, if a change
doesn't show.)

## Check the frontend parses before committing
```bash
node --check web/src/app.js
```

## Regenerate dev sample data (synthetic LSOAs + stations)
```bash
python pipeline/make_sample_data.py
```

## Run a real pipeline build (needs the raw inputs in data/raw/)
```bash
python pipeline/build_imd_layer.py     # LSOA layer (IMD + population + households)
python pipeline/build_tiles.py         # vector tiles
python pipeline/build_station_usage.py # stations + usage + connectivity
python pipeline/build_connectivity.py  # GTFS -> per-CRS connectivity CSV
```

## Large input files (e.g. GTFS) — do NOT commit them
`data/raw/*` is gitignored for good reason: big files bloat git history forever.
In a Codespace, download the big input into `data/raw/`, run the parser, and
commit only the small output (e.g. `station_connectivity.csv`). Example:

```bash
# download GTFS into data/raw/gtfs.zip (curl/wget), then:
python pipeline/build_connectivity.py
git add data/raw/station_connectivity.csv && git commit -m "Refresh connectivity"
```

## Commit & deploy
Normal git now — no web UI needed:
```bash
git add -A && git commit -m "..." && git push
```
Pushing to `main` still triggers the Pages deploy Action as before.

## If dependency install didn't finish
```bash
pip install -r pipeline/requirements.txt
```
