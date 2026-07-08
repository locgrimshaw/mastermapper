"""
build_scot_designations.py
--------------------------
Download Scotland's heritage / landscape / nature designations and write one
GeoJSON per constraint kind into data/raw/<scot_kind>.geojson, which
build_constraints.py then ingests (its scot_* kinds map each onto the canonical
kind — sssi, sac, national_scenic_area, scheduled_monument, …).

SELF-DISCOVERING so it doesn't hard-code brittle layer names/ids:
  - NatureScot GeoServer WFS (ogc.nature.scot): read each workspace's
    GetCapabilities, match target designations by keyword, page GetFeature.
  - Historic Environment Scotland ArcGIS MapServer (inspire.hes.scot): read the
    service JSON, match sub-layers by name, page the query endpoint.
Both are paged so large layers (listed buildings ~47k) download in full.

All sources Open Government Licence. Runs in CI (GitHub Actions can reach the
Scottish gov servers; the agent proxy can't). Best-effort: a source that can't be
found/reached is skipped with a warning so the rest still load.

  env SCOT_DESIGNATIONS_ONLY   optional comma list of scot_kinds to build (else all)
"""

import json
import os
import re
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "Accept": "application/json,text/xml,*/*"}
PAGE = 1000

# NatureScot GeoServer: which workspaces to scan for each designation, + keywords
# that must ALL appear (space-split) in a candidate layer name to match.
NATURESCOT = "https://ogc.nature.scot/geoserver"
NS_TARGETS = {
    # scot_kind : (workspaces, [keyword sets] — first set that matches a layer wins)
    "scot_sssi":                 (["protectedareas"], [["sssi"], ["site", "special", "scientific"]]),
    "scot_sac":                  (["protectedareas"], [["sac"], ["special", "area", "conservation"]]),
    "scot_spa":                  (["protectedareas"], [["spa"], ["special", "protection", "area"]]),
    "scot_ramsar":               (["protectedareas"], [["ramsar"]]),
    "scot_national_scenic_area": (["landscape", "protectedareas"], [["national", "scenic"], ["nsa"]]),
    "scot_national_park":        (["landscape", "administrative", "protectedareas"], [["national", "park"]]),
    "scot_ancient_woodland":     (["habitatsandspecies", "protectedareas"], [["ancient", "woodland"], ["awi"]]),
}

# Historic Environment Scotland ArcGIS MapServer (sub-layers discovered at runtime).
HES_MAPSERVER = "https://inspire.hes.scot/arcgis/rest/services/HES/HES_Designations/MapServer"
HES_TARGETS = {
    "scot_scheduled_monument": [["scheduled", "monument"]],
    "scot_listed_building":    [["listed", "building"]],
    "scot_conservation_area":  [["conservation", "area"]],
    "scot_park_garden":        [["garden"], ["designed", "landscape"]],
}


def _norm(s):
    return re.sub(r"[^a-z0-9 ]", " ", str(s).lower())


def _matches(name, keysets):
    n = _norm(name)
    for ks in keysets:
        if all(k in n for k in ks):
            return True
    return False


def _get(url, timeout=180):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def _write(kind, features):
    if not features:
        print(f"  [{kind}] no features — not written")
        return 0
    out = RAW / f"{kind}.geojson"
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8") as fh:
        json.dump({"type": "FeatureCollection", "features": features}, fh, separators=(",", ":"))
    print(f"  [{kind}] wrote {len(features)} features -> {out.name}")
    return len(features)


# ---- NatureScot WFS ---------------------------------------------------------
def _wfs_layers(workspace):
    """{normalised layer title/name -> typeName} from a workspace GetCapabilities."""
    url = (f"{NATURESCOT}/{workspace}/wfs?service=WFS&version=2.0.0&request=GetCapabilities")
    try:
        xml = _get(url)
    except Exception as exc:
        print(f"  (WFS caps {workspace} failed: {exc})")
        return {}
    layers = {}
    try:
        root = ET.fromstring(xml)
    except Exception as exc:
        print(f"  (WFS caps {workspace} parse failed: {exc})")
        return {}
    for ft in root.iter():
        if ft.tag.split("}")[-1] != "FeatureType":
            continue
        name = title = None
        for ch in ft:
            t = ch.tag.split("}")[-1]
            if t == "Name":
                name = (ch.text or "").strip()
            elif t == "Title":
                title = (ch.text or "").strip()
        if name:
            layers[name] = (name, title or name)
    return layers


def _wfs_fetch(workspace, type_name):
    feats, start = [], 0
    while True:
        params = {"service": "WFS", "version": "2.0.0", "request": "GetFeature",
                  "typeNames": type_name, "outputFormat": "application/json",
                  "srsName": "EPSG:4326", "count": PAGE, "startIndex": start}
        url = f"{NATURESCOT}/{workspace}/wfs?" + urllib.parse.urlencode(params)
        try:
            data = json.loads(_get(url))
        except Exception as exc:
            print(f"    ({type_name} page {start} failed: {exc})")
            break
        page = data.get("features", [])
        feats.extend(page)
        if len(page) < PAGE:
            break
        start += PAGE
    return feats


def build_naturescot(only):
    for kind, (workspaces, keysets) in NS_TARGETS.items():
        if only and kind not in only:
            continue
        found = None
        for ws in workspaces:
            layers = _wfs_layers(ws)
            for tn, (name, title) in layers.items():
                if _matches(name, keysets) or _matches(title, keysets):
                    found = (ws, tn); break
            if found:
                break
        if not found:
            print(f"  [{kind}] no matching NatureScot layer found — skipping")
            continue
        ws, tn = found
        print(f"  [{kind}] NatureScot {ws}:{tn}")
        _write(kind, _wfs_fetch(ws, tn))


# ---- Historic Environment Scotland ArcGIS ----------------------------------
def _arcgis_layers(mapserver):
    try:
        data = json.loads(_get(f"{mapserver}?f=json"))
    except Exception as exc:
        print(f"  (HES service json failed: {exc})")
        return []
    return [(l.get("id"), l.get("name", "")) for l in data.get("layers", [])
            if l.get("id") is not None]


def _arcgis_fetch(mapserver, layer_id):
    feats, off = [], 0
    while True:
        params = {"where": "1=1", "outFields": "*", "returnGeometry": "true",
                  "outSR": "4326", "f": "geojson",
                  "resultOffset": off, "resultRecordCount": PAGE}
        url = f"{mapserver}/{layer_id}/query?" + urllib.parse.urlencode(params)
        try:
            data = json.loads(_get(url))
        except Exception as exc:
            print(f"    (layer {layer_id} offset {off} failed: {exc})")
            break
        page = data.get("features", [])
        feats.extend(page)
        if len(page) < PAGE:
            break
        off += PAGE
    return feats


def build_hes(only):
    layers = _arcgis_layers(HES_MAPSERVER)
    if layers:
        print(f"  HES layers: {[(i, n) for i, n in layers]}")
    for kind, keysets in HES_TARGETS.items():
        if only and kind not in only:
            continue
        lid = next((i for i, n in layers if _matches(n, keysets)), None)
        if lid is None:
            print(f"  [{kind}] no matching HES layer — skipping")
            continue
        print(f"  [{kind}] HES layer {lid}")
        _write(kind, _arcgis_fetch(HES_MAPSERVER, lid))


def main() -> int:
    only = [k.strip() for k in os.environ.get("SCOT_DESIGNATIONS_ONLY", "").replace(",", " ").split() if k.strip()]
    print("Building Scottish designations" + (f" (only: {only})" if only else " (all)"))
    print("NatureScot (WFS):")
    build_naturescot(only)
    print("Historic Environment Scotland (ArcGIS):")
    build_hes(only)
    # Report what landed.
    built = sorted(p.stem for p in RAW.glob("scot_*.geojson"))
    print(f"\nDesignation files present: {', '.join(built) or '(none)'}")
    return 0 if built else 1


if __name__ == "__main__":
    raise SystemExit(main())
