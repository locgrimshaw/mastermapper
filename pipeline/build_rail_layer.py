"""
build_rail_layer.py
-------------------
Builds the optional RAIL overlay: passenger LINES + STOPS for England across
four modes -- heavy rail, subway/metro, light rail, and tram -- as a single
GeoJSON the tile step bakes into the map's PMTiles.

This is a toggleable overlay that sits ON TOP of the deprivation choropleth --
it never touches the LSOA scores, so it's safe to (re)build independently.

Every feature carries a `mode` property so the frontend can split them into
separately-coloured, separately-toggleable layers:
    mode = "rail" | "subway" | "light_rail" | "tram"
and a `kind` of "line" or "stop".

Sources (see docs/DATASETS.md):

  LINES   OpenStreetMap via the Overpass API, per mode:
            rail        railway=rail with usage=main|branch (passenger network;
                        railway=rail also covers freight, so usage selects it),
                        excluding sidings/yards (service=*).
            subway      railway=subway
            light_rail  railway=light_rail
            tram        railway=tram
          Disused/abandoned/construction/proposed track carries lifecycle-
          prefixed keys and is skipped automatically.

  STOPS   Heavy-rail STOPS come from a committed CSV (authoritative, includes
          CRS codes): data/raw/uk_stations.csv. Subway / light-rail / tram
          stops come from OSM (the CSV is National-Rail only):
            subway      railway=station + station=subway  (also railway=halt)
            light_rail  railway=station|halt + station=light_rail
            tram        railway=tram_stop
          If the CSV is absent we still emit OSM stops + all lines, so the
          overlay degrades gracefully (like house prices do).

Output:
  web/data/rail.geojson  ->  build_tiles.py emits per-mode tile layers.

Licensing: OSM + the Trainline-derived CSV are BOTH ODbL (share-alike +
attribution), stricter than the OGL data used elsewhere. The footer credits
"OpenStreetMap contributors & Trainline (ODbL)" when the overlay is present.

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
# Generous box; mode filters do the real work and a few border ways spilling
# into Wales/Scotland are harmless on the map.
ENGLAND_BBOX = (49.8, -6.5, 55.9, 1.9)

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",  # fallback mirror
]


def overpass_query() -> str:
    """One combined query for all four modes' lines + the non-heavy-rail stops.
    Heavy-rail stops come from the CSV, so we don't fetch railway=station for
    plain rail here (avoids dragging in every mainline station unnamed)."""
    s, w, n, e = ENGLAND_BBOX
    b = f"{s},{w},{n},{e}"
    return f"""
[out:json][timeout:240];
(
  // ---- lines, per mode ----
  way["railway"="rail"]["usage"="main"]["service"!~"."]({b});
  way["railway"="rail"]["usage"="branch"]["service"!~"."]({b});
  way["railway"="subway"]["service"!~"."]({b});
  way["railway"="light_rail"]["service"!~"."]({b});
  way["railway"="tram"]["service"!~"."]({b});
  // ---- stops (non-heavy-rail; heavy rail comes from CSV) ----
  node["railway"~"^(station|halt)$"]["station"="subway"]({b});
  node["railway"~"^(station|halt)$"]["station"="light_rail"]({b});
  node["railway"="tram_stop"]({b});
);
out geom;
""".strip()


def _mode_for_line(tags: dict) -> str:
    rw = tags.get("railway", "")
    if rw == "rail":
        return "rail"
    if rw in ("subway", "light_rail", "tram"):
        return rw
    return ""


def _mode_for_stop(tags: dict) -> str:
    if tags.get("railway") == "tram_stop":
        return "tram"
    st = tags.get("station", "")
    if st == "subway":
        return "subway"
    if st == "light_rail":
        return "light_rail"
    return ""


def fetch_osm() -> tuple:
    """Return (lines, stops) GeoJSON features from OSM, or raise on failure."""
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
            with urllib.request.urlopen(req, timeout=260) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            break
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as exc:
            last_err = exc
            print(f"  endpoint failed ({exc}); trying next...")
            time.sleep(2)
    if data is None:
        raise RuntimeError(f"All Overpass endpoints failed: {last_err}")

    lines, stops = [], []
    for el in data.get("elements", []):
        tags = el.get("tags", {})
        etype = el.get("type")
        if etype == "way":
            geom = el.get("geometry")
            if not geom or len(geom) < 2:
                continue
            mode = _mode_for_line(tags)
            if not mode:
                continue
            coords = [[round(p["lon"], 5), round(p["lat"], 5)] for p in geom]
            lines.append({
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": coords},
                "properties": {
                    "kind": "line",
                    "mode": mode,
                    "name": tags.get("name", ""),
                    "operator": tags.get("operator", ""),
                },
            })
        elif etype == "node":
            mode = _mode_for_stop(tags)
            if not mode:
                continue
            lon, lat = el.get("lon"), el.get("lat")
            if lon is None or lat is None:
                continue
            stops.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [round(lon, 5), round(lat, 5)]},
                "properties": {
                    "kind": "stop",
                    "mode": mode,
                    "name": tags.get("name", ""),
                    "operator": tags.get("operator", ""),
                    "network": tags.get("network", ""),
                },
            })
    by_mode = {}
    for f in lines:
        by_mode[f["properties"]["mode"]] = by_mode.get(f["properties"]["mode"], 0) + 1
    print(f"  OSM lines: {len(lines)} {dict(by_mode)}")
    print(f"  OSM non-rail stops: {len(stops)}")
    return lines, stops


def load_rail_stations() -> list:
    """Heavy-rail STOPS from the committed CSV, tagged mode='rail'."""
    if not STATIONS_CSV.exists():
        print(f"No {STATIONS_CSV.name} found -- heavy-rail stops skipped "
              "(other modes still build). See docs/DATASETS.md.")
        return []

    feats = []
    with STATIONS_CSV.open(newline="", encoding="utf-8-sig") as fh:
        reader = csv.DictReader(fh)

        def col(row, *names):
            for nm in names:
                if nm in row and row[nm] not in (None, ""):
                    return row[nm]
            return None

        for row in reader:
            country = col(row, "constituentCountry", "country") or ""
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
                "properties": {"kind": "stop", "mode": "rail", "name": name, "crs": crs},
            })
    print(f"  loaded {len(feats)} England heavy-rail stations from {STATIONS_CSV.name}")
    return feats


def main() -> int:
    print("Building rail overlay (lines + stops across rail/subway/light_rail/tram)...")
    try:
        osm_lines, osm_stops = fetch_osm()
    except RuntimeError as exc:
        print(f"ERROR: {exc}")
        print("OSM unavailable right now. Skipping cleanly so the rest of the "
              "build still succeeds (same policy as house prices).")
        osm_lines, osm_stops = [], []

    rail_stops = load_rail_stations()
    stops = rail_stops + osm_stops
    lines = osm_lines

    if not lines and not stops:
        print("Nothing to write (no lines AND no stops). Not creating rail.geojson.")
        return 0

    # Per-mode counts for the frontend (drives which toggles to show).
    def counts(feats, kind):
        out = {}
        for f in feats:
            if f["properties"]["kind"] != kind:
                continue
            m = f["properties"]["mode"]
            out[m] = out.get(m, 0) + 1
        return out

    all_feats = lines + stops
    fc = {
        "type": "FeatureCollection",
        "metadata": {
            "line_counts": counts(all_feats, "line"),
            "stop_counts": counts(all_feats, "stop"),
            "attribution": "OpenStreetMap contributors (ODbL); heavy-rail "
                           "station locations via Trainline (ODbL)",
        },
        "features": all_feats,
    }
    OUT.write_text(json.dumps(fc))
    size_kb = OUT.stat().st_size / 1024
    print(f"Wrote {OUT}  ({size_kb:.0f} KB)")
    print(f"  lines by mode:  {counts(all_feats, 'line')}")
    print(f"  stops by mode:  {counts(all_feats, 'stop')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
