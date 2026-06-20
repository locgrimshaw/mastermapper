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
    print("This is FAKE data for development only.")


if __name__ == "__main__":
    main()