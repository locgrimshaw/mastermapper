"""
build_scot_designations.py
--------------------------
Download Scotland's heritage / landscape / nature designations, green belt and
SEPA flood extents and write one GeoJSON per constraint kind into
data/raw/<scot_kind>.geojson, which build_constraints.py then ingests (its
scot_* kinds map each onto the canonical kind — sssi, sac, national_scenic_area,
scheduled_monument, green_belt, flood_zone_3, …).

SELF-DISCOVERING so it doesn't hard-code brittle layer names/ids:
  - NatureScot GeoServer WFS (ogc.nature.scot): match target designations by
    keyword in a hinted workspace's GetCapabilities; if a target isn't found
    there, fall back to the GLOBAL capabilities (every workspace at once) so
    layers that moved workspace (e.g. National Scenic Areas / National Parks)
    are still discovered. Pages GetFeature in full.
  - Historic Environment Scotland ArcGIS MapServer (inspire.hes.scot): read the
    service JSON, match sub-layers by name, then harvest by OBJECTID batches —
    this works even when a layer doesn't support offset pagination (which was
    returning zero features silently) and surfaces server-side query errors.
  - SEPA ArcGIS (map.sepa.org.uk): discover the flood-map service + its
    river/coastal high- and medium-likelihood layers -> flood_zone_3 / flood_zone_2.
  - Scottish green belt via a GeoServer WFS (Improvement Service SpatialHub).

All sources Open Government Licence. Runs in CI (GitHub Actions can reach the
Scottish gov servers; the agent proxy can't). Best-effort: a source that can't be
found/reached is skipped with a warning so the rest still load.

  env SCOT_DESIGNATIONS_ONLY   optional comma list of scot_kinds to build (else all)
  env NATURESCOT_WFS           override NatureScot GeoServer base (default ogc.nature.scot)
  env HES_MAPSERVER            override HES ArcGIS MapServer URL
  env SEPA_ARCGIS              override SEPA ArcGIS REST root (default map.sepa.org.uk)
  env SCOT_GREENBELT_WFS       override Scottish green-belt WFS OWS base (SpatialHub)
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
PAGE = 1000        # WFS / ArcGIS offset page size
ARC_BATCH = 200    # ArcGIS objectId harvest batch size

# NatureScot GeoServer: which workspaces to scan first for each designation, +
# keyword sets that must ALL appear (space-split) in a candidate layer NAME to
# match (first set that matches a layer wins). A target not found in its hinted
# workspaces falls back to the global capabilities (see build_naturescot).
NATURESCOT = os.environ.get("NATURESCOT_WFS", "").strip() or "https://ogc.nature.scot/geoserver"
NS_TARGETS = {
    # scot_kind : (hinted workspaces, [keyword sets])
    "scot_sssi":                 (["protectedareas"], [["sssi"], ["site", "special", "scientific"]]),
    "scot_sac":                  (["protectedareas"], [["sac"], ["special", "area", "conservation"]]),
    "scot_spa":                  (["protectedareas"], [["spa"], ["special", "protection", "area"]]),
    "scot_ramsar":               (["protectedareas"], [["ramsar"]]),
    "scot_national_scenic_area": (["landscape", "protectedareas", "designations"], [["national", "scenic"], ["nsa"]]),
    "scot_national_park":        (["landscape", "administrative", "protectedareas", "designations"], [["national", "park"]]),
    "scot_ancient_woodland":     (["habitatsandspecies", "protectedareas"], [["ancient", "woodland"], ["awi"]]),
}

# Historic Environment Scotland ArcGIS MapServer (sub-layers discovered at runtime).
HES_MAPSERVER = os.environ.get("HES_MAPSERVER", "").strip() or \
    "https://inspire.hes.scot/arcgis/rest/services/HES/HES_Designations/MapServer"
HES_TARGETS = {
    "scot_scheduled_monument": [["scheduled", "monument"]],
    "scot_listed_building":    [["listed", "building"]],
    "scot_conservation_area":  [["conservation", "area"]],
    "scot_park_garden":        [["garden"], ["designed", "landscape"]],
}

# SEPA flood mapping (ArcGIS REST). River + coastal, by likelihood band ->
# canonical flood zones (high ~ flood_zone_3, medium ~ flood_zone_2).
SEPA_ARCGIS = os.environ.get("SEPA_ARCGIS", "").strip() or "https://map.sepa.org.uk/arcgis/rest/services"
SEPA_TARGETS = {
    "scot_flood_3": [["river", "high"], ["coastal", "high"], ["high", "likelihood"], ["high", "hazard"]],
    "scot_flood_2": [["river", "medium"], ["coastal", "medium"], ["medium", "likelihood"], ["medium", "hazard"]],
}

# Scottish green belt via the Improvement Service SpatialHub GeoServer (WFS/OWS).
SCOT_GREENBELT_WFS = os.environ.get("SCOT_GREENBELT_WFS", "").strip() or "https://geo.spatialhub.scot/geoserver/ows"


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


# ---- WFS capabilities / GetFeature (GeoServer) ------------------------------
def _wfs_layers_from_caps(caps_url):
    """{layer Name -> (name, title)} from a WFS GetCapabilities document."""
    try:
        xml = _get(caps_url)
    except Exception as exc:
        print(f"  (WFS caps failed: {caps_url.split('?')[0]}: {exc})")
        return {}
    layers = {}
    try:
        root = ET.fromstring(xml)
    except Exception as exc:
        print(f"  (WFS caps parse failed: {exc})")
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


def _wfs_workspace_layers(base, workspace):
    return _wfs_layers_from_caps(
        f"{base}/{workspace}/wfs?service=WFS&version=2.0.0&request=GetCapabilities")


def _wfs_global_layers(base):
    # `base` may be a GeoServer root (…/geoserver) or an OWS endpoint (…/ows).
    caps = base if base.rstrip("/").endswith(("ows", "wfs")) else f"{base}/wfs"
    return _wfs_layers_from_caps(
        f"{caps}?service=WFS&version=2.0.0&request=GetCapabilities")


def _wfs_fetch(base, type_name):
    """Page a WFS layer in full as EPSG:4326 GeoJSON. `base` is the OWS/WFS URL."""
    endpoint = base if base.rstrip("/").endswith(("ows", "wfs")) else f"{base}/wfs"
    feats, start = [], 0
    while True:
        params = {"service": "WFS", "version": "2.0.0", "request": "GetFeature",
                  "typeNames": type_name, "outputFormat": "application/json",
                  "srsName": "EPSG:4326", "count": PAGE, "startIndex": start}
        url = f"{endpoint}?" + urllib.parse.urlencode(params)
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
    global_layers = None
    for kind, (workspaces, keysets) in NS_TARGETS.items():
        if only and kind not in only:
            continue
        # 1) Hinted workspaces — match on the (short, unambiguous) layer NAME.
        found = None
        for ws in workspaces:
            for tn, (name, _title) in _wfs_workspace_layers(NATURESCOT, ws).items():
                if _matches(name, keysets):
                    found = tn
                    break
            if found:
                break
        if found:
            print(f"  [{kind}] NatureScot {found}")
            _write(kind, _wfs_fetch(NATURESCOT, found))
            continue
        # 2) Global fallback — search every workspace (handles moved layers).
        if global_layers is None:
            global_layers = _wfs_global_layers(NATURESCOT)
            print(f"  (global caps: {len(global_layers)} NatureScot layers)")
        gfound = next((tn for tn, (n, _t) in global_layers.items()
                       if _matches(n, keysets)), None)
        if gfound:
            print(f"  [{kind}] NatureScot (global) {gfound}")
            _write(kind, _wfs_fetch(NATURESCOT, gfound))
            continue
        cand = [n for _tn, (n, _t) in global_layers.items() if _matches(n, [keysets[0]])]
        print(f"  [{kind}] no matching NatureScot layer found — skipping"
              + (f"; near-matches: {cand[:10]}" if cand else "; (0 near-matches)"))


# ---- ArcGIS (HES + SEPA) ----------------------------------------------------
def _arcgis_layers(mapserver):
    try:
        data = json.loads(_get(f"{mapserver}?f=json"))
    except Exception as exc:
        print(f"  (service json failed {mapserver}: {exc})")
        return []
    return [(l.get("id"), l.get("name", "")) for l in data.get("layers", [])
            if l.get("id") is not None]


def _arcgis_query(mapserver, layer_id, extra):
    params = {"where": "1=1", "outFields": "*", "returnGeometry": "true",
              "outSR": "4326", "f": "geojson"}
    params.update(extra)
    url = f"{mapserver}/{layer_id}/query?" + urllib.parse.urlencode(params)
    return json.loads(_get(url))


def _arcgis_object_ids(mapserver, layer_id):
    url = f"{mapserver}/{layer_id}/query?" + urllib.parse.urlencode(
        {"where": "1=1", "returnIdsOnly": "true", "f": "json"})
    try:
        data = json.loads(_get(url))
    except Exception as exc:
        print(f"    (layer {layer_id} id-query failed: {exc})")
        return []
    if isinstance(data, dict) and data.get("error"):
        print(f"    (layer {layer_id} id-query error: {data['error']})")
        return []
    return data.get("objectIds") or []


def _arcgis_fetch(mapserver, layer_id):
    """Harvest a layer in full as EPSG:4326 GeoJSON features. Prefers OBJECTID
    batches (robust when a layer doesn't support offset paging — the failure mode
    that silently returned nothing); falls back to offset paging otherwise. Any
    server-side {"error": …} response is surfaced instead of swallowed."""
    ids = _arcgis_object_ids(mapserver, layer_id)
    feats = []
    if ids:
        print(f"    (layer {layer_id}: {len(ids)} object ids)")
        for i in range(0, len(ids), ARC_BATCH):
            chunk = ids[i:i + ARC_BATCH]
            try:
                data = _arcgis_query(mapserver, layer_id, {"objectIds": ",".join(map(str, chunk))})
            except Exception as exc:
                print(f"    (batch {i} failed: {exc})")
                continue
            if isinstance(data, dict) and data.get("error"):
                print(f"    (batch {i} error: {data['error']})")
                continue
            feats.extend(data.get("features", []))
        return feats
    # Fallback: offset paging.
    off = 0
    while True:
        try:
            data = _arcgis_query(mapserver, layer_id, {"resultOffset": off, "resultRecordCount": PAGE})
        except Exception as exc:
            print(f"    (offset {off} failed: {exc})")
            break
        if isinstance(data, dict) and data.get("error"):
            print(f"    (offset {off} error: {data['error']})")
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


# ---- SEPA flood (ArcGIS REST directory crawl) -------------------------------
def _arcgis_services(root):
    """(serviceName, type) for every service under an ArcGIS REST root, folders
    included. Service names already carry their folder prefix (e.g. 'FloodMaps/River')."""
    out = []
    try:
        top = json.loads(_get(f"{root}?f=json"))
    except Exception as exc:
        print(f"  (SEPA root failed {root}: {exc})")
        return out
    for s in top.get("services", []):
        out.append((s.get("name"), s.get("type")))
    for folder in top.get("folders", []):
        try:
            fj = json.loads(_get(f"{root}/{folder}?f=json"))
        except Exception:
            continue
        for s in fj.get("services", []):
            out.append((s.get("name"), s.get("type")))
    return [(n, t) for n, t in out if n and t]


def build_sepa(only):
    if only and not any(k in ("scot_flood_2", "scot_flood_3") for k in only):
        return
    services = _arcgis_services(SEPA_ARCGIS)
    flood = [(n, t) for n, t in services if "flood" in _norm(n)]
    if not flood:
        print("  [SEPA] no flood service discovered — skipping (set SEPA_ARCGIS)")
        return
    print(f"  SEPA flood services: {[n for n, _t in flood]}")
    for kind, keysets in SEPA_TARGETS.items():
        if only and kind not in only:
            continue
        wrote = 0
        for name, typ in flood:
            mapserver = f"{SEPA_ARCGIS}/{name}/{typ}"
            lid = next((i for i, n in _arcgis_layers(mapserver) if _matches(n, keysets)), None)
            if lid is None:
                continue
            print(f"  [{kind}] SEPA {name}/{typ} layer {lid}")
            wrote = _write(kind, _arcgis_fetch(mapserver, lid))
            if wrote:
                break
        if not wrote:
            print(f"  [{kind}] no matching SEPA flood layer — skipping")


# ---- Scottish green belt (SpatialHub WFS) -----------------------------------
def build_greenbelt(only):
    if only and "scot_green_belt" not in only:
        return
    layers = _wfs_global_layers(SCOT_GREENBELT_WFS)
    if not layers:
        print("  [scot_green_belt] no green-belt WFS reachable — skipping (set SCOT_GREENBELT_WFS)")
        return
    found = next((tn for tn, (n, t) in layers.items()
                  if _matches(n, [["green", "belt"]]) or _matches(t, [["green", "belt"]])), None)
    if not found:
        print("  [scot_green_belt] no green-belt layer in WFS caps — skipping")
        return
    print(f"  [scot_green_belt] SpatialHub {found}")
    _write("scot_green_belt", _wfs_fetch(SCOT_GREENBELT_WFS, found))


def main() -> int:
    only = [k.strip() for k in os.environ.get("SCOT_DESIGNATIONS_ONLY", "").replace(",", " ").split() if k.strip()]
    print("Building Scottish designations" + (f" (only: {only})" if only else " (all)"))
    print("NatureScot (WFS):")
    build_naturescot(only)
    print("Historic Environment Scotland (ArcGIS):")
    build_hes(only)
    print("SEPA flood (ArcGIS):")
    build_sepa(only)
    print("Green belt (SpatialHub WFS):")
    build_greenbelt(only)
    # Report what landed.
    built = sorted(p.stem for p in RAW.glob("scot_*.geojson"))
    print(f"\nDesignation files present: {', '.join(built) or '(none)'}")
    return 0 if built else 1


if __name__ == "__main__":
    raise SystemExit(main())
