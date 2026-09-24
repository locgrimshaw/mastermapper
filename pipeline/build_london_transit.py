"""build_london_transit.py — TfL rapid-transit network for Zone 1 travel times.

The London sites sift needs "how long from this site to Zone 1?". National
rail journey times already sit in Supabase (station_links, direct trains
between CRS stations), but most of inner London is served by the Tube, DLR,
Overground, Elizabeth line and trams, which that table does not cover. This
script pulls those networks from the TfL Unified API and writes a small graph:

  nodes: every TfL stop (NaPTAN id, name, lat/lon, fare zone, modes)
  edges: consecutive stops on each line with in-vehicle minutes

Topology comes from Line/{id}/Route/Sequence (every branch, both directions).
Run times come from Line/{id}/Timetable/{origin} station intervals; any hop the
timetables do not cover falls back to straight-line distance at the mode's
average speed, and is flagged so the result can say so.

Supabase loads the JSON straight from the repo (rebuild_london_transit() in
migration 0083 fetches it over HTTP) and merges it with station_links, so
nothing heavy passes through a workflow.

OUTPUT: pipeline/data/london_transit.json

Run:  python pipeline/build_london_transit.py
Data: Transport for London Unified API, powered by TfL Open Data (OGL v2.0).
"""

from __future__ import annotations

import json
import math
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "pipeline" / "data" / "london_transit.json"
API = "https://api.tfl.gov.uk"
MODES = "tube,dlr,elizabeth-line,overground,tram"

# Average in-vehicle speed (km/h) for hops the timetables miss.
FALLBACK_KMH = {"tube": 33, "dlr": 28, "elizabeth-line": 45,
                "overground": 35, "tram": 20}

session = requests.Session()


def get(path: str, tries: int = 6):
    # The anonymous API allows ~50 requests a minute; pace to stay under it.
    for i in range(tries):
        time.sleep(1.3)
        r = session.get(API + path, timeout=60)
        if r.status_code == 200:
            return r.json()
        if r.status_code == 404:
            return None
        time.sleep(5 * 2 ** i)
    print(f"  ! giving up on {path} ({r.status_code})")
    return None


def haversine_km(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = (math.sin((la2 - la1) / 2) ** 2
         + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2)
    return 12742 * math.asin(math.sqrt(h))


def zone_is_1(z) -> bool:
    # TfL writes zones as "1", "2+3", "1/2" etc; boundary stations count as 1.
    if not z:
        return False
    return "1" in str(z).replace("+", "/").split("/")


def main():
    nodes: dict[str, dict] = {}
    edges: dict[tuple, dict] = {}

    def add_node(s, mode):
        nid = s.get("stationId") or s.get("id")
        if not nid or s.get("lat") is None:
            return
        n = nodes.setdefault(nid, {"id": nid, "name": s.get("name", "").replace(" Underground Station", "")
                                   .replace(" DLR Station", "").replace(" Rail Station", "").strip(),
                                   "lat": round(s["lat"], 6), "lon": round(s["lon"], 6),
                                   "zone": s.get("zone"), "modes": []})
        if mode not in n["modes"]:
            n["modes"].append(mode)
        if not n["zone"] and s.get("zone"):
            n["zone"] = s["zone"]

    lines = get(f"/Line/Mode/{MODES}") or []
    for line in lines:
        lid, mode = line["id"], line["modeName"]
        print(f"{lid} ({mode})")
        # 1. Topology: every ordered route, both directions.
        seqs, origins = [], set()
        for direction in ("outbound", "inbound"):
            d = get(f"/Line/{lid}/Route/Sequence/{direction}")
            if not d:
                continue
            for sps in d.get("stopPointSequences", []):
                for s in sps.get("stopPoint", []):
                    add_node(s, mode)
            for r in d.get("orderedLineRoutes", []):
                ids = r.get("naptanIds") or []
                if len(ids) > 1:
                    seqs.append(ids)
                    origins.add(ids[0])
        # 2. Run times: timetable station intervals from each route origin.
        hop_min: dict[tuple, float] = {}
        for origin in sorted(origins):
            t = get(f"/Line/{lid}/Timetable/{origin}")
            if not t or "timetable" not in t:
                continue
            for s in (t.get("stops") or []) + (t.get("stations") or []):
                add_node(s, mode)
            for route in t["timetable"].get("routes", []):
                for si in route.get("stationIntervals", []):
                    prev, prev_t = origin, 0.0
                    for iv in si.get("intervals", []):
                        cur, ct = iv["stopId"], float(iv["timeToArrival"])
                        dt = ct - prev_t
                        if dt > 0:
                            k = tuple(sorted((prev, cur)))
                            hop_min[k] = min(hop_min.get(k, 1e9), dt)
                        prev, prev_t = cur, ct
        # 3. Edges along every sequence; timetable minutes where known.
        for ids in seqs:
            for a, b in zip(ids, ids[1:]):
                if a not in nodes or b not in nodes or a == b:
                    continue
                k = tuple(sorted((a, b)))
                key = (lid,) + k
                if key in edges:
                    continue
                if k in hop_min:
                    mins, est = hop_min[k], False
                else:
                    km = haversine_km((nodes[a]["lat"], nodes[a]["lon"]),
                                      (nodes[b]["lat"], nodes[b]["lon"]))
                    mins, est = max(1.0, round(60 * km / FALLBACK_KMH.get(mode, 30), 1)), True
                edges[key] = {"line": lid, "mode": mode, "a": k[0], "b": k[1],
                              "min": mins, "est": est}

    out = {
        "source": "Transport for London Unified API (TfL Open Data, OGL v2.0)",
        "built": time.strftime("%Y-%m-%d"),
        "nodes": [dict(n, z1=zone_is_1(n["zone"])) for n in nodes.values()],
        "edges": list(edges.values()),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    est = sum(e["est"] for e in out["edges"])
    print(f"wrote {OUT}: {len(out['nodes'])} stops, {len(out['edges'])} hops "
          f"({est} distance-estimated), {sum(n['z1'] for n in out['nodes'])} in Zone 1")


if __name__ == "__main__":
    main()
