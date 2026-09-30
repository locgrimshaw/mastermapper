"""
build_planned_stations.py
-------------------------
New, under-construction and proposed railway stations in Great Britain, as the
`rail_station_planned` dataset (map layer "New & planned stations").

No single register exists — Network Rail, DfT, Transport Scotland, TfW and the
combined authorities each publish their own schemes as documents, not data. So
this merges the two open, structured sources that do track them:

  Wikidata (CC0, SPARQL, no key)
    - "state of use" (P5817) = proposed / under construction / being rebuilt
    - service entry (P1619) on or after 2019 -> opened recently
  OpenStreetMap lifecycle tagging (ODbL), from the workflow's osmium extract
    data/raw/osm_planned_stations.geojson when present:
    - railway=construction + construction=station|halt, or
      construction:railway=station|halt           -> under construction
    - railway=proposed + proposed=station|halt, or
      proposed:railway=station|halt               -> proposed

Records within 600 m sharing a name word are merged: OSM's position wins (it
is the mapped site), Wikidata's status wins when it says the station opened.
Coverage is only as current as these sources — the layer's note says so.

Output: supabase/datasets_import.csv (dataset,source_id,name,props,geom_wkt)
for supabase/loaders/load_datasets.py with DATASETS=rail_station_planned.

Run:  python pipeline/build_planned_stations.py
"""

import csv
import json
import math
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OSM_SRC = RAW / "osm_planned_stations.geojson"
OUT = ROOT / "supabase" / "datasets_import.csv"
WDQS = "https://query.wikidata.org/sparql"
UA = "MasterMapper/1.0 (https://github.com/locgrimshaw/mastermapper)"
GB = (-8.7, 49.8, 2.0, 60.9)

Q_STATUS = """
SELECT ?s ?sLabel ?use ?coord ?lineLabel ?opLabel WHERE {
  VALUES ?use { wd:Q811683 wd:Q12377751 wd:Q63187954 }
  ?s wdt:P5817 ?use; wdt:P17 wd:Q145; wdt:P31/wdt:P279* wd:Q55488.
  OPTIONAL { ?s wdt:P625 ?coord. } OPTIONAL { ?s wdt:P81 ?line. }
  OPTIONAL { ?s wdt:P137 ?op. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } }"""
Q_OPENED = """
SELECT ?s ?sLabel ?open ?coord ?lineLabel ?opLabel WHERE {
  ?s wdt:P1619 ?open. FILTER(YEAR(?open) >= 2019)
  ?s wdt:P17 wd:Q145; wdt:P31/wdt:P279* wd:Q55488.
  OPTIONAL { ?s wdt:P625 ?coord. } OPTIONAL { ?s wdt:P81 ?line. }
  OPTIONAL { ?s wdt:P137 ?op. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } }"""
USE_STATUS = {"Q811683": "proposed", "Q12377751": "under construction",
              "Q63187954": "under construction"}


def sparql(q, tries=4):
    """WDQS throttles hard at times (1 query/min during outages) — wait out a
    429 rather than silently dropping the Wikidata half of the layer."""
    url = WDQS + "?" + urllib.parse.urlencode({"query": q})
    req = urllib.request.Request(url, headers={"User-Agent": UA,
                                               "Accept": "application/sparql-results+json"})
    for i in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                return json.load(r)["results"]["bindings"]
        except urllib.error.HTTPError as e:
            if e.code not in (429, 503) or i == tries - 1:
                raise
            wait = int(e.headers.get("Retry-After") or 65)
            print(f"[stations] Wikidata busy ({e.code}), retrying in {wait}s", flush=True)
            time.sleep(min(wait, 180))


def _pt(wkt):
    m = re.match(r"Point\(([-\d.eE]+) ([-\d.eE]+)\)", wkt or "")
    return (float(m.group(1)), float(m.group(2))) if m else None


def in_gb(p):
    return p and GB[0] <= p[0] <= GB[2] and GB[1] <= p[1] <= GB[3]


def clean_name(n):
    return re.sub(r"\s+(railway|tube|metro|tram|light rail|DLR)?\s*(station|stop|halt)$", "",
                  n or "", flags=re.I).strip()


def wikidata():
    recs = {}
    for q, kind in ((Q_STATUS, "status"), (Q_OPENED, "opened")):
        try:
            rows = sparql(q)
        except Exception as e:           # WDQS is occasionally slow; OSM still loads
            print(f"[stations] Wikidata {kind} query failed: {e}")
            continue
        for b in rows:
            qid = b["s"]["value"].rsplit("/", 1)[-1]
            p = _pt(b.get("coord", {}).get("value"))
            if not in_gb(p):
                continue
            r = recs.setdefault(qid, {"name": clean_name(b["sLabel"]["value"]), "pt": p,
                                      "src": "Wikidata", "id": qid, "line": set(), "op": set()})
            if b.get("lineLabel"):
                r["line"].add(b["lineLabel"]["value"])
            if b.get("opLabel"):
                r["op"].add(b["opLabel"]["value"])
            if kind == "opened":
                r["status"] = "opened"
                r["opened"] = b["open"]["value"][:10]
            elif r.get("status") != "opened":
                r["status"] = USE_STATUS.get(b["use"]["value"].rsplit("/", 1)[-1], "proposed")
    # an "opened" date in the future is a planned opening, not an opening
    today = __import__("datetime").date.today().isoformat()
    for r in recs.values():
        if r.get("status") == "opened" and r.get("opened", "") > today:
            r["status"] = "under construction"
            r["expected"] = r.pop("opened")
    print(f"[stations] Wikidata: {len(recs)} stations")
    return list(recs.values())


def osm():
    if not OSM_SRC.exists():
        print(f"[stations] no {OSM_SRC.name} — Wikidata only")
        return []
    out = []
    for f in json.loads(OSM_SRC.read_text())["features"]:
        t = f.get("properties") or {}
        rw = t.get("railway")
        status = None
        if (rw == "construction" and t.get("construction") in ("station", "halt")) \
                or t.get("construction:railway") in ("station", "halt"):
            status = "under construction"
        elif (rw == "proposed" and t.get("proposed") in ("station", "halt")) \
                or t.get("proposed:railway") in ("station", "halt"):
            status = "proposed"
        if not status or not t.get("name"):
            continue
        g = f.get("geometry") or {}
        if g.get("type") == "Point":
            p = tuple(g["coordinates"][:2])
        else:
            flat = []

            def walk(c):
                if c and isinstance(c[0], (int, float)):
                    flat.append(c)
                else:
                    for x in c:
                        walk(x)
            walk(g.get("coordinates") or [])
            if not flat:
                continue
            p = (sum(c[0] for c in flat) / len(flat), sum(c[1] for c in flat) / len(flat))
        if not in_gb(p):
            continue
        out.append({"name": clean_name(t["name"]), "pt": p, "status": status,
                    "src": "OpenStreetMap", "id": f"osm:{t.get('@type', 'n')}{t.get('@id', '')}",
                    "line": {t["line"]} if t.get("line") else set(),
                    "op": {t["operator"]} if t.get("operator") else set()})
    print(f"[stations] OSM: {len(out)} stations")
    return out


def merge(wd, om):
    def near(a, b):
        kx = 111320 * math.cos(math.radians(a["pt"][1]))
        d = math.hypot((a["pt"][0] - b["pt"][0]) * kx, (a["pt"][1] - b["pt"][1]) * 111320)
        wa = {w for w in re.findall(r"[a-z]{4,}", a["name"].lower())}
        wb = {w for w in re.findall(r"[a-z]{4,}", b["name"].lower())}
        return d < 600 and (wa & wb or not wa or not wb)

    out = list(om)
    for w in wd:
        hit = next((o for o in out if o["src"] == "OpenStreetMap" and near(o, w)), None)
        if hit is None:
            out.append(w)
            continue
        hit["src"] = "OpenStreetMap + Wikidata"
        hit["line"] |= w["line"]
        hit["op"] |= w["op"]
        if w.get("status") == "opened":
            hit["status"], hit["opened"] = "opened", w.get("opened")
        if w.get("expected"):
            hit["expected"] = w["expected"]
    return out


def main():
    recs = merge(wikidata(), osm())
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["dataset", "source_id", "name", "props", "geom_wkt"])
        w.writeheader()
        for r in recs:
            props = {"status": r["status"], "source": r["src"],
                     "opened": r.get("opened"), "expected": r.get("expected"),
                     "line": ", ".join(sorted(r["line"])) or None,
                     "operator": ", ".join(sorted(r["op"])) or None}
            w.writerow({
                "dataset": "rail_station_planned", "source_id": r["id"],
                "name": r["name"] or "Station",
                "props": json.dumps({k: v for k, v in props.items() if v},
                                    separators=(",", ":"), ensure_ascii=False),
                "geom_wkt": f"SRID=4326;POINT({r['pt'][0]:.6f} {r['pt'][1]:.6f})",
            })
    by = {}
    for r in recs:
        by[r["status"]] = by.get(r["status"], 0) + 1
    print(f"[stations] wrote {len(recs)} to {OUT.name}: {by}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
