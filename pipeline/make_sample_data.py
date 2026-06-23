"""
make_sample_data.py
--------------------
Generates a small SYNTHETIC dataset so you can see the app working before
downloading the real government data. It writes the SAME output format as
the real pipeline, so the frontend code is identical either way.

This is fake data on a grid near central London. Do not draw any real
conclusions from it. Replace it by running the real pipeline once you've
downloaded the datasets in docs/DATASETS.md.

Run:  python pipeline/make_sample_data.py
"""

import json
import math
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web" / "data"

random.seed(42)

# A grid of fake "LSOAs" as small squares across a patch of London.
COLS, ROWS = 24, 18
LON0, LAT0 = -0.18, 51.46      # bottom-left
CELL = 0.012                    # ~ degrees per cell

DOMAINS = ["overall", "income", "employment", "education",
           "health", "crime", "housing", "environment"]


def smooth_field(c, r, seed):
    """A smooth-ish spatial gradient so the choropleth looks plausible."""
    random.seed(seed)
    ax, ay = random.uniform(0.1, 0.5), random.uniform(0.1, 0.5)
    px, py = random.uniform(0, 6), random.uniform(0, 6)
    v = (math.sin(c * ax + px) + math.cos(r * ay + py)) / 2  # -1..1
    return (v + 1) / 2  # 0..1


def main():
    features = []
    for r in range(ROWS):
        for c in range(COLS):
            lon = LON0 + c * CELL
            lat = LAT0 + r * CELL
            ring = [
                [lon, lat],
                [lon + CELL * 0.92, lat],
                [lon + CELL * 0.92, lat + CELL * 0.92],
                [lon, lat + CELL * 0.92],
                [lon, lat],
            ]
            props = {"lsoa_code": f"S{r:02d}{c:02d}"}
            # Fake names so the click panel can show borough/district in dev.
            boroughs = ["Camden", "Hackney", "Lambeth", "Southwark", "Islington", "Westminster"]
            props["lad_name"] = boroughs[(r + c) % len(boroughs)]
            props["lsoa_name"] = f"{props['lad_name']} {(r * 24 + c) % 40 + 1:03d}A"
            for i, d in enumerate(DOMAINS):
                norm = round(smooth_field(c, r, seed=100 + i) * 100, 1)
                props[f"{d}_norm"] = norm
                props[f"{d}_score_raw"] = round(norm / 100 * 60, 2)
                props[f"{d}_decile"] = max(1, min(10, 11 - math.ceil(norm / 10)))
            # Synthetic house prices: loosely inverse to deprivation, with noise.
            pnorm = round(smooth_field(c, r, seed=200) * 100, 1)
            props["price_norm"] = pnorm
            props["price_median"] = int(180000 + pnorm / 100 * 720000)
            props["price_count"] = int(8 + smooth_field(c, r, seed=300) * 40)
            # Synthetic resident population. Real LSOAs hold ~1,000-3,000 people
            # by design; vary it smoothly so density figures look plausible in
            # dev (the choropleth cells here are equal-area, so population alone
            # drives the per-km² and per-1,000 figures).
            props["population"] = int(1100 + smooth_field(c, r, seed=400) * 2200)
            # Synthetic existing households (≈ occupied dwellings). Real LSOAs
            # average ~2.3 people per household, so derive from population with a
            # little smooth variation in household size.
            _hh_size = 2.1 + smooth_field(c, r, seed=450) * 0.5
            props["households"] = int(props["population"] / _hh_size)
            features.append({
                "type": "Feature",
                "properties": props,
                "geometry": {"type": "Polygon", "coordinates": [ring]},
            })

    fc = {"type": "FeatureCollection", "features": features}
    OUT.mkdir(parents=True, exist_ok=True)
    out_path = OUT / "lsoa_imd.geojson"
    out_path.write_text(json.dumps(fc))
    print(f"Wrote {out_path}  ({len(features)} synthetic LSOAs)")

    make_sample_stations()
    print("This is FAKE data for development only.")


# Fake station names so the picker/profile have something readable in dev.
SAMPLE_STATION_NAMES = [
    "Camden Town", "Hackney Central", "Lambeth North", "Southwark Park",
    "Islington Fields", "Westminster Bridge", "Bow Junction", "Peckham Rise",
    "Clapton Vale", "Deptford Green",
]


def make_sample_stations():
    """Emit a small synthetic stations.geojson (and a minimal rail.geojson with
    mode='rail' stops) placed on the LSOA grid, with fake usage + a 4-year
    trend. Mirrors the real build's output so the station-led frontend works in
    dev without the ORR / rail downloads.
    """
    stations = []
    rail_stops = []
    n = len(SAMPLE_STATION_NAMES)
    for i, name in enumerate(SAMPLE_STATION_NAMES):
        # Scatter across the grid (deterministic from the seed for stability).
        c = random.randint(2, COLS - 3)
        r = random.randint(2, ROWS - 3)
        lon = round(LON0 + (c + 0.5) * CELL, 5)
        lat = round(LAT0 + (r + 0.5) * CELL, 5)
        crs = f"S{i:02d}"
        # Fake usage: a spread from quiet halts to busy hubs, with a plausible
        # 4-year recovery trend (dip then rise, like post-2020 rail).
        base = int(120000 + smooth_field(c, r, seed=500 + i) * 7_000_000)
        trend = []
        for yr, factor in zip(
            ["2021-22", "2022-23", "2023-24", "2024-25"],
            [0.62, 0.81, 0.93, 1.0],
        ):
            trend.append({"year": yr, "value": int(base * factor)})
        usage = trend[-1]["value"]
        operator = ["Govia Thameslink", "c2c", "Greater Anglia",
                    "Southeastern"][i % 4]
        regions = ["London", "South East", "East of England", "London"]
        stations.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": {
                "name": name, "crs": crs, "usage": usage,
                "operator": operator, "trend": trend,
                # Interchanges scale loosely with usage; season share varies.
                "interchanges": int(usage * (0.05 + 0.25 * smooth_field(c, r, seed=600 + i))),
                "season_share": round(0.12 + 0.4 * smooth_field(c, r, seed=700 + i), 3),
                "region": regions[i % 4],
                "quality": None,
                "adjusted": (i % 5 == 0),
            },
        })
        rail_stops.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [lon, lat]},
            "properties": {"kind": "stop", "mode": "rail", "name": name, "crs": crs},
        })

    # National usage percentile across the sample set (mirrors the real build).
    ordered = sorted(stations, key=lambda f: f["properties"]["usage"])
    for rank, f in enumerate(ordered):
        f["properties"]["usage_pctile"] = round(rank / max(1, len(ordered) - 1) * 100, 1)

    stations_fc = {
        "type": "FeatureCollection",
        "metadata": {"latest_year": "2024-25", "count": n,
                     "matched_crs": n, "matched_name": 0, "unmatched": 0,
                     "attribution": "SAMPLE synthetic data - not real usage."},
        "features": stations,
    }
    (OUT / "stations.geojson").write_text(json.dumps(stations_fc))
    print(f"Wrote {OUT / 'stations.geojson'}  ({n} synthetic stations)")

    # A minimal rail.geojson so the transit overlay + station layer have stops
    # in dev. Only mode='rail' stops; no lines (the overlay degrades fine).
    rail_fc = {
        "type": "FeatureCollection",
        "metadata": {
            "line_counts": {}, "stop_counts": {"rail": n},
            "attribution": "SAMPLE synthetic data - not real rail locations.",
        },
        "features": rail_stops,
    }
    (OUT / "rail.geojson").write_text(json.dumps(rail_fc))
    print(f"Wrote {OUT / 'rail.geojson'}  ({n} synthetic rail stops)")


if __name__ == "__main__":
    main()
