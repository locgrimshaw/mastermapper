"""
build_rail_layer.py
-------------------
Builds the optional RAIL overlay: passenger railway LINES + STATIONS for
England, as a single GeoJSON the tile step bakes into the map's PMTiles.

This is a toggleable overlay that sits ON TOP of the deprivation choropleth —
it never touches the LSOA scores, so it's safe to (re)build independently.

Two inputs, two different best sources (see docs/DATASETS.md):

  LINES    OpenStreetMap, fetched live from the Overpass API. We ask only for
           PASSENGER mainline/branch track in England and skip freight-only,
           industrial, sidings/yards, and disused/abandoned/under-construction
           lines. railway=rail covers BOTH passenger and freight, so the
           usage=main|branch tag is what actually selects the passenger
           network. Trams/subways/light-rail are separate railway=* values and
           are excluded automatically.

  STATIONS A small committed CSV at data/raw/uk_stations.csv (same trick as the
           IMD CSV — drag-and-drop won't upload dotfiles, but a normal CSV is
           fine). Expected header (davwheat/uk-railway-stations, ODbL):
               stationName,lat,long,crsCode,iataAirportCode,constituentCountry
           If the CSV is absent we still emit the lines and just skip stations,
           so the overlay degrades gracefully (like prices do).

Output:
  web/data/rail.geojson   ->  consumed by build_tiles.py (layers: rail_line, rail_station)

Licensing: OSM + Trainline data are BOTH ODbL (share-alike + attribution),
which is stricter than the OGL data used elsewhere. The frontend footer must
credit "© OpenStreetMap contributors" and Trainline. See updateDataSourceNote().

Run (or let the Action run it):
  python pipeline/build_rail_layer.py
"""

import csv
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "web" / "data" / "rail.geojson"
STATIONS_CSV = RAW / "uk_stations.csv"

# England bounding box (lon/lat). Overpass takes (south,west,north,east).
# Generous box; the usage filter does the real work and a few border ways
# spilling into Wales/Scotland are harmless on the map.
ENGLAND_BBOX = (49.8, -6.5, 55.9, 1.9)

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",  # fallback mirror
]

# Overpass QL. We pull railway=rail ways whose usage is main or branch (the
# passenger network), explicitly NOT service ways (sidings/spurs/yards) and
# NOT lifecycle-prefixed (disused:/abandoned:/construction:/proposed:) — those
# carry their own keys, so a plain railway=rail + usage filter already skips
# them. out geom gives us inline geometry (no second 'recurse' round-trip).
def overpass_query() -> str:
    s, w, n, e = ENGLAND_BBOX
    bbox = f"{s},{w},{n},{e}"
    return f"""
[out:json][timeout:180];
(
  way["railway"="rail"]["usage"="main"]["service"!~"."]({bbox});
  way["railway"="rail"]["usage"="branch"]["service"!~"."]({bbox});
);
out geom;
""".strip()


def fetch_lines() -> list:
    """Return a list of GeoJSON LineString features for passenger track."""
    query = overpass_query()
    data = None
    last_err = None
    for endpoint in OVERPASS_ENDPOINTS:
        try:
            print(f"Querying Overpass: {endpoint}")
            body = urllib.parse.urlencode({"data": query}).encode("utf-8")
            req = urllib.request.Request(
                endpoint, data=body,
                headers={"User-Agent": "mastermapper-rail/1.0"},
            )
            with urllib.request.urlopen(req, timeout=200) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            break
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as exc:
            last_err = exc
            print(f"  endpoint failed ({exc}); trying next...")
            time.sleep(2)
    if data is None:
        raise RuntimeError(f"All Overpass endpoints failed: {last_err}")

    feats = []
    for el in data.get("elements", []):
        if el.get("type") != "way":
            continue
        geom = el.get("geometry")
        if not geom or len(geom) < 2:
            continue
        coords = [[round(p["lon"], 5), round(p["lat"], 5)] for p in geom]
        tags = el.get("tags", {})
        feats.append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": coords},
            "properties": {
                "kind": "line",
                "name": tags.get("name", ""),
                "usage": tags.get("usage", ""),
                "operator": tags.get("operator", ""),
                "electrified": tags.get("electrified", "no"),
            },
        })
    print(f"  got {len(feats)} passenger line segments")
    return feats


def load_stations() -> list:
    """Return GeoJSON Point features for England stations, or [] if no CSV."""
    if not STATIONS_CSV.exists():
        print(f"No {STATIONS_CSV.name} found — skipping stations "
              "(overlay will show lines only). See docs/DATASETS.md.")
        return []

    feats = []
    with STATIONS_CSV.open(newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)
        # Be tolerant of column-name variants between station-CSV sources.
        def col(row, *names):
            for nm in names:
                if nm in row and row[nm] not in (None, ""):
                    return row[nm]
            return None
        for row in reader:
            country = col(row, "constituentCountry", "country") or ""
            # Keep England only when the column exists; if absent, keep all.
            if country and country.strip().lower() != "england":
                continue
            lat = col(row, "lat", "latitude")
            lng = col(row, "long", "lng", "longitude")
            name = col(row, "stationName", "name", "station") or ""
            crs = col(row, "crsCode", "crs", "3alpha") or ""
            if lat is None or lng is None:
                continue
            try:
                lat_f, lng_f = float(lat), float(lng)
            except ValueError:
                continue
            feats.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [round(lng_f, 5), round(lat_f, 5)]},
                "properties": {"kind": "station", "name": name, "crs": crs},
            })
    print(f"  loaded {len(feats)} England stations from {STATIONS_CSV.name}")
    return feats


def main() -> int:
    print("Building rail overlay (passenger lines + stations)...")
    try:
        lines = fetch_lines()
    except RuntimeError as exc:
        print(f"ERROR: {exc}")
        print("Rail lines unavailable right now. Skipping cleanly so the rest "
              "of the build still succeeds (same policy as house prices).")
        lines = []

    stations = load_stations()

    if not lines and not stations:
        print("Nothing to write (no lines AND no stations). Not creating rail.geojson.")
        return 0

    fc = {
        "type": "FeatureCollection",
        "metadata": {
            "lines": len(lines),
            "stations": len(stations),
            "attribution": "© OpenStreetMap contributors (lines, ODbL); "
                           "station locations © Trainline / contributors (ODbL)",
        },
        "features": lines + stations,
    }
    OUT.write_text(json.dumps(fc))
    size_kb = OUT.stat().st_size / 1024
    print(f"Wrote {OUT}  ({size_kb:.0f} KB · {len(lines)} lines, {len(stations)} stations)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
