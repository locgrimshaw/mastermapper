"""
build_sport_leisure.py
----------------------
The "Sport & Leisure" datasets: stadia, sports facilities, hotels, event
venues and food & drink, from OpenStreetMap with Wikidata enrichment. Feeds
the Sport & Leisure layer group and the stadium catchment sidebar.

Datasets written (map_features, all points; polygons reduced to an interior
point with their area kept):

  stadium         leisure=stadium. name, sports, capacity, clubs (Wikidata
                  occupants), leagues (the clubs' current leagues), opened,
                  operator/owner, site area.
  sports_facility leisure=pitch|track|sports_centre|sports_hall|golf_course|
                  ice_rink. kind, sport, area_m2, surface, access.
  hotel           tourism=hotel|motel|hostel|guest_house|apartment. type,
                  brand, stars, rooms + how the rooms figure was obtained,
                  bedspaces (rooms x 2).
  event_venue     amenity=conference_centre|events_venue|exhibition_centre|
                  theatre|concert_hall|music_venue|arts_centre. kind, capacity.
  food_drink      amenity=pub|bar|restaurant|cafe|fast_food. kind, name.

Hotel rooms. OSM tags rooms on ~10% of hotels, so the figure comes from the
first rule that applies, and `rooms_src` says which:
  tagged     the OSM rooms tag
  brand      median of tagged hotels of the same brand (5+ tagged), e.g.
             Premier Inn, Travelodge
  footprint  mapped building footprint x storeys (building:levels, else 3)
             -> rooms by a log-log fit (rooms = a * floorspace^b) calibrated
             each run on hotels with both a tagged room count and a
             footprint; clamped 5-1,500
  typical    median tagged rooms for that accommodation type
Bedspaces = rooms x 2 (standard double-occupancy bedspace convention).

Capacity (stadia and venues): the OSM capacity tag, else Wikidata P1083.

Wikidata: entity API (wbgetentities, 50 ids a call, paced and back-off on
429) — not the SPARQL service, which throttles bulk queries hard. Responses
cache in data/raw/wikidata_cache.json between runs.

Input: data/raw/osm_sport.geojsonseq — osmium export of the tag filter in
.github/workflows/load-sport-leisure.yml (env SPORT_SRC overrides the path).
Output: supabase/datasets_import.csv (dataset,source_id,name,props,geom_wkt)
for supabase/loaders/load_datasets.py.

Licences: © OpenStreetMap contributors (ODbL); Wikidata CC0.

Run:  python pipeline/build_sport_leisure.py
"""

import csv
import json
import math
import os
import re
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from shapely.geometry import shape

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
SRC = Path(os.environ.get("SPORT_SRC") or RAW / "osm_sport.geojsonseq")
OUT = ROOT / "supabase" / "datasets_import.csv"
WD_CACHE = RAW / "wikidata_cache.json"
UA = "MasterMapper/1.0 (https://github.com/locgrimshaw/mastermapper)"

FACILITY = {"pitch", "track", "sports_centre", "sports_hall", "golf_course", "ice_rink"}
HOTEL = {"hotel", "motel", "hostel", "guest_house", "apartment"}
VENUE = {"conference_centre", "events_venue", "exhibition_centre", "theatre",
         "concert_hall", "music_venue", "arts_centre"}
FOOD = {"pub", "bar", "restaurant", "cafe", "fast_food"}

# OSM sport values -> display labels (anything else is title-cased)
SPORT = {"soccer": "Football", "american_football": "American football",
         "rugby_union": "Rugby union", "rugby_league": "Rugby league",
         "rugby": "Rugby", "cricket": "Cricket", "athletics": "Athletics",
         "running": "Athletics", "horse_racing": "Horse racing",
         "greyhound_racing": "Greyhound racing", "dog_racing": "Greyhound racing",
         "motor": "Motorsport",
         "motocross": "Motorsport", "speedway": "Speedway", "tennis": "Tennis",
         "golf": "Golf", "hockey": "Hockey", "field_hockey": "Hockey",
         "ice_hockey": "Ice hockey", "basketball": "Basketball",
         "gaelic_games": "Gaelic games", "shinty": "Shinty",
         "multi": "Multi-sport", "netball": "Netball", "bowls": "Bowls",
         "equestrian": "Equestrian", "cycling": "Cycling", "boxing": "Boxing",
         "swimming": "Swimming", "darts": "Darts", "snooker": "Snooker"}


# Club "leagues" from Wikidata P118 include cup competitions and leagues that
# no longer exist but carry no end date; neither belongs in a league filter.
DEFUNCT_LEAGUES = re.compile(r"^Scottish Football League|^Football League\b|^Football Conference$")
RL_LEAGUES = {"Championship": "RFL Championship", "League 1": "RFL League 1"}
WD_SPORT = {"association football": "Football", "dog racing": "Greyhound racing",
            "rugby union": "Rugby union", "rugby league": "Rugby league"}


def clean_league(lab, club_sports):
    if not lab or re.search(r"\bCup\b|Trophy|Shield", lab) or DEFUNCT_LEAGUES.search(lab):
        return None
    if lab in RL_LEAGUES and any("league" in s.lower() for s in club_sports):
        return RL_LEAGUES[lab]
    return lab


def sport_label(v):
    v = (v or "").strip().lower()
    return SPORT.get(v) or (v.replace("_", " ").capitalize() if v else None)


def sports_of(tags):
    out = []
    for v in re.split(r"[;,]", tags.get("sport") or ""):
        lab = sport_label(v)
        if lab and lab not in out:
            out.append(lab)
    return out


def num(v):
    if v is None:
        return None
    m = re.search(r"\d[\d,]*", str(v))
    if not m:
        return None
    try:
        return int(m.group(0).replace(",", ""))
    except ValueError:
        return None


def point_and_area(geom):
    """Interior point (lon, lat) and area in m2 (0 for points)."""
    g = shape(geom)
    if g.geom_type == "Point":
        return (g.x, g.y), 0.0
    p = g.representative_point()
    k = 111320.0 * math.cos(math.radians(p.y)) * 110540.0
    return (p.x, p.y), (g.area * k if g.geom_type in ("Polygon", "MultiPolygon") else 0.0)


# ---- Wikidata ---------------------------------------------------------------

class Wikidata:
    def __init__(self):
        self.cache = {}
        if WD_CACHE.exists():
            try:
                self.cache = json.loads(WD_CACHE.read_text())
            except ValueError:
                self.cache = {}

    def save(self):
        WD_CACHE.parent.mkdir(parents=True, exist_ok=True)
        WD_CACHE.write_text(json.dumps(self.cache))

    def get(self, ids):
        """{qid: entity} for the ids, fetching any not cached."""
        want = [q for q in dict.fromkeys(ids) if q and re.fullmatch(r"Q\d+", q)
                and q not in self.cache]
        for i in range(0, len(want), 50):
            batch = want[i:i + 50]
            url = ("https://www.wikidata.org/w/api.php?" + urllib.parse.urlencode({
                "action": "wbgetentities", "ids": "|".join(batch),
                "props": "labels|claims", "languages": "en", "format": "json"}))
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            for attempt in range(8):
                try:
                    with urllib.request.urlopen(req, timeout=60) as r:
                        ents = json.load(r).get("entities", {})
                    break
                except urllib.error.HTTPError as e:
                    if e.code not in (429, 503) or attempt == 7:
                        print(f"[sport] Wikidata HTTP {e.code} — skipping {len(batch)} ids")
                        ents = {}
                        break
                    time.sleep(min(int(e.headers.get("Retry-After") or 10), 60) + 1)
                except (urllib.error.URLError, TimeoutError) as e:
                    print(f"[sport] Wikidata unreachable ({e}) — skipping")
                    ents = {}
                    break
            for q, e in ents.items():
                claims = e.get("claims", {})
                slim = {"label": e.get("labels", {}).get("en", {}).get("value")}
                for p in ("P1083", "P466", "P641", "P1619", "P127", "P118", "P2130"):
                    vals = []
                    for c in claims.get(p, []):
                        if c.get("rank") == "deprecated":
                            continue
                        q2 = c.get("qualifiers", {})
                        ended = "P582" in q2          # end time = no longer current
                        dv = c.get("mainsnak", {}).get("datavalue", {}).get("value")
                        if dv is None:
                            continue
                        if isinstance(dv, dict) and "id" in dv:
                            vals.append({"id": dv["id"], "ended": ended,
                                         "pref": c.get("rank") == "preferred"})
                        elif isinstance(dv, dict) and "amount" in dv:
                            when = None
                            for qv in q2.get("P585", []):
                                when = (qv.get("datavalue", {}).get("value", {}) or {}).get("time")
                            vals.append({"amount": dv["amount"], "ended": ended,
                                         "pref": c.get("rank") == "preferred",
                                         "unit": str(dv.get("unit", "")).rsplit("/", 1)[-1],
                                         "when": when})
                        elif isinstance(dv, dict) and "time" in dv:
                            vals.append({"time": dv["time"]})
                    if vals:
                        slim[p] = vals
                self.cache[q] = slim
            time.sleep(1.0)
        return {q: self.cache.get(q) for q in ids if q in self.cache}

    def label(self, q):
        e = self.cache.get(q)
        return e.get("label") if e else None


def wd_capacity(ent):
    vals = [v for v in (ent or {}).get("P1083", []) if "amount" in v]
    if not vals:
        return None
    best = [v for v in vals if v.get("pref")] or [v for v in vals if not v.get("ended")] or vals
    try:
        return int(float(best[0]["amount"]))
    except (TypeError, ValueError):
        return None


# Construction cost (Wikidata P2130) in today's money via the ONS long-run RPI
# (CDKO, committed as pipeline/data/rpi_long_run.csv). Sterling only — other
# currencies are left out rather than converted at an arbitrary rate.
GBP = "Q25224"


def load_rpi():
    path = Path(__file__).resolve().parent / "data" / "rpi_long_run.csv"
    out = {}
    if path.exists():
        for r in csv.DictReader(path.open()):
            try:
                out[int(r["year"])] = float(r["rpi"])
            except (ValueError, KeyError):
                pass
    return out


def wd_cost(ent, opened, rpi):
    """(cost_gbp, cost_year, cost_2024_gbp) or Nones."""
    for v in (ent or {}).get("P2130", []):
        if "amount" not in v or v.get("unit") != GBP:
            continue
        try:
            amt = float(v["amount"])
        except (TypeError, ValueError):
            continue
        yr = None
        m = re.match(r"[+-]?(\d{4})", v.get("when") or "")
        if m:
            yr = int(m.group(1))
        yr = yr or opened
        real = None
        if yr and rpi.get(yr) and rpi.get(max(rpi)):
            real = round(amt * rpi[max(rpi)] / rpi[yr])
        return round(amt), yr, real
    return None, None, None


def current_ids(ent, prop):
    vals = [v for v in (ent or {}).get(prop, []) if "id" in v]
    cur = [v for v in vals if not v.get("ended")]
    return [v["id"] for v in (cur or vals)]


# ---- build --------------------------------------------------------------------

def read_features():
    if not SRC.exists():
        raise SystemExit(f"[sport] {SRC} not found — run the osmium step of "
                         f"load-sport-leisure.yml first")
    with SRC.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip().lstrip("\x1e")
            if line:
                yield json.loads(line)


def osm_id(f):
    p = f["properties"]
    t = p.get("@type") or (f.get("id", "")[:1] if isinstance(f.get("id"), str) else "")
    i = p.get("@id") or f.get("id")
    return f"{str(t)[:1] or 'x'}{i}"


def main():
    rows = {"stadium": [], "sports_facility": [], "hotel": [], "event_venue": [], "food_drink": []}
    for f in read_features():
        t = f["properties"]
        try:
            (lon, lat), area = point_and_area(f["geometry"])
        except Exception:
            continue
        if not (-8.7 < lon < 2.0 and 49.8 < lat < 60.95):
            continue
        base = {"id": osm_id(f), "name": (t.get("name") or "").strip()[:120],
                "lon": lon, "lat": lat, "area": area, "t": t}
        if t.get("leisure") == "stadium":
            rows["stadium"].append(base)
        elif t.get("leisure") in FACILITY:
            rows["sports_facility"].append(base)
        elif t.get("tourism") in HOTEL:
            rows["hotel"].append(base)
        elif t.get("amenity") in VENUE:
            rows["event_venue"].append(base)
        elif t.get("amenity") in FOOD:
            rows["food_drink"].append(base)
    print("[sport] OSM: " + ", ".join(f"{k} {len(v):,}" for k, v in rows.items()), flush=True)

    # Wikidata: stadia (+ their clubs and leagues) and venues
    wd = Wikidata()
    st_q = [r["t"].get("wikidata") for r in rows["stadium"]]
    ve_q = [r["t"].get("wikidata") for r in rows["event_venue"]]
    wd.get([q for q in st_q + ve_q if q])
    clubs = [c for q in st_q if q for c in current_ids(wd.cache.get(q), "P466")]
    wd.get(clubs)
    labels_needed = clubs[:]
    for c in clubs:
        labels_needed += current_ids(wd.cache.get(c), "P118") + current_ids(wd.cache.get(c), "P641")
    for q in st_q:
        if q:
            labels_needed += current_ids(wd.cache.get(q), "P641") + current_ids(wd.cache.get(q), "P127")
    wd.get(labels_needed)
    wd.save()
    print(f"[sport] Wikidata: {len(wd.cache):,} entities cached", flush=True)

    out = []

    def emit(ds, r, props):
        props = {k: v for k, v in props.items() if v not in (None, "", [], 0) or k in ("capacity",) and v}
        out.append({"dataset": ds, "source_id": r["id"], "name": r["name"] or None,
                    "props": json.dumps(props, separators=(",", ":"), ensure_ascii=False),
                    "geom_wkt": f"SRID=4326;POINT({r['lon']:.6f} {r['lat']:.6f})"})

    # stadia
    rpi = load_rpi()
    n_cap = 0
    for r in rows["stadium"]:
        t = r["t"]
        ent = wd.cache.get(t.get("wikidata") or "")
        cap = num(t.get("capacity")) or wd_capacity(ent)
        n_cap += bool(cap)
        club_ids = current_ids(ent, "P466")
        club_names = [wd.label(c) for c in club_ids if wd.label(c)]
        leagues, sports = [], sports_of(t)
        def wd_sport(q):
            lab = wd.label(q)
            return WD_SPORT.get(lab.lower(), lab.capitalize()) if lab else None
        for c in club_ids:
            club_sports = [x for x in (wd_sport(sp) for sp in current_ids(wd.cache.get(c), "P641")) if x]
            for lg in current_ids(wd.cache.get(c), "P118"):
                lab = clean_league(wd.label(lg), club_sports or sports)
                if lab and lab not in leagues:
                    leagues.append(lab)
            for lab in club_sports:
                if lab not in sports and not sports:
                    sports.append(lab)
        if not sports:
            sports = [x for x in (wd_sport(sp) for sp in current_ids(ent, "P641")) if x]
        opened = None
        for v in (ent or {}).get("P1619", []):
            m = re.match(r"[+-]?(\d{4})", v.get("time", ""))
            if m:
                opened = int(m.group(1))
                break
        owner = [wd.label(o) for o in current_ids(ent, "P127") if wd.label(o)]
        cost, cost_year, cost_real = wd_cost(ent, opened, rpi)
        name = r["name"] or (ent or {}).get("label") or "Stadium"
        r["name"] = name
        emit("stadium", r, {
            "sport": ", ".join(sports[:4]) or None, "sport1": sports[0] if sports else None,
            "capacity": cap, "clubs": ", ".join(club_names[:6]) or None,
            "league": ", ".join(leagues[:4]) or None, "opened": opened,
            "operator": (t.get("operator") or "")[:80] or None,
            "owner": ", ".join(owner[:3]) or None,
            "site_ha": round(r["area"] / 1e4, 2) if r["area"] else None,
            "wikidata": t.get("wikidata"), "website": t.get("website"),
            "cost_gbp": cost, "cost_year": cost_year, "cost_real_gbp": cost_real,
        })
    print(f"[sport] stadia: {len(rows['stadium'])}, {n_cap} with a capacity", flush=True)

    # sports facilities
    for r in rows["sports_facility"]:
        t = r["t"]
        sp = sports_of(t)
        emit("sports_facility", r, {
            "kind": t.get("leisure"), "sport": ", ".join(sp[:3]) or None,
            "sport1": sp[0] if sp else None,
            "area_m2": round(r["area"]) if r["area"] else None,
            "surface": t.get("surface"), "access": t.get("access"),
        })

    # hotels: rooms by tagged / brand / footprint / typical
    tagged = [(r, num(r["t"].get("rooms"))) for r in rows["hotel"]]
    by_brand, by_type = {}, {}
    for r, n in tagged:
        if n and 1 <= n <= 2000:
            b = (r["t"].get("brand") or "").strip().lower()
            if b:
                by_brand.setdefault(b, []).append(n)
            by_type.setdefault(r["t"].get("tourism"), []).append(n)
    brand_med = {b: statistics.median(v) for b, v in by_brand.items() if len(v) >= 5}
    type_med = {k: statistics.median(v) for k, v in by_type.items() if v}
    # Rooms from floorspace (footprint x storeys), calibrated each run on
    # hotels that have BOTH a tagged room count and a mapped footprint, as a
    # log-log fit rooms = a * floorspace^b. Large hotels carry far more
    # non-bedroom space (function rooms, restaurants, back of house), so a
    # single rooms-per-m2 ratio overstated big city-centre hotels ~2x.
    pts = []
    for r, n in tagged:
        if n and 5 <= n <= 2000 and r["area"] > 80 and r["t"].get("building") \
                and r["t"].get("tourism") == "hotel":
            lv = min(num(r["t"].get("building:levels")) or 3, 40)
            pts.append((math.log(r["area"] * lv), math.log(n)))
    if len(pts) >= 30:
        mx = sum(x for x, _ in pts) / len(pts)
        my = sum(y for _, y in pts) / len(pts)
        fb = sum((x - mx) * (y - my) for x, y in pts) / max(1e-9, sum((x - mx) ** 2 for x, _ in pts))
        fb = max(0.3, min(1.0, fb))
        fa = math.exp(my - fb * mx)
    else:
        fa, fb = 0.65 / 30, 1.0
    print(f"[sport] footprint fit: rooms = {fa:.3f} x floorspace^{fb:.2f} from {len(pts)} tagged hotels "
          f"(2,000 m2 -> {fa * 2000 ** fb:.0f} rooms, 20,000 m2 -> {fa * 20000 ** fb:.0f})", flush=True)
    src_count = {}
    for r, n in tagged:
        t = r["t"]
        kind = t.get("tourism")
        src = "tagged"
        if not n or not (1 <= n <= 2000):
            b = (t.get("brand") or "").strip().lower()
            if b in brand_med:
                n, src = round(brand_med[b]), "brand"
            elif r["area"] > 80 and t.get("building"):
                lv = num(t.get("building:levels")) or 3
                n, src = max(5, min(1500, round(fa * (r["area"] * min(lv, 40)) ** fb))), "footprint"
            else:
                n, src = round(type_med.get(kind, 10)), "typical"
        src_count[src] = src_count.get(src, 0) + 1
        stars = num(t.get("stars"))
        emit("hotel", r, {
            "type": kind, "brand": t.get("brand") or None,
            "stars": stars if stars and stars <= 5 else None,
            "rooms": n, "rooms_src": src, "beds": n * 2,
            "operator": (t.get("operator") or "")[:80] or None,
            "website": t.get("website"),
        })
    print(f"[sport] hotels: rooms from {src_count}; brand medians for {len(brand_med)} brands; "
          f"type medians {type_med}", flush=True)

    # event venues
    n_cap = 0
    for r in rows["event_venue"]:
        t = r["t"]
        ent = wd.cache.get(t.get("wikidata") or "")
        cap = num(t.get("capacity")) or wd_capacity(ent)
        n_cap += bool(cap)
        if not r["name"] and ent and ent.get("label"):
            r["name"] = ent["label"]
        emit("event_venue", r, {
            "kind": t.get("amenity"), "capacity": cap,
            "operator": (t.get("operator") or "")[:80] or None,
            "wikidata": t.get("wikidata"), "website": t.get("website"),
        })
    print(f"[sport] venues: {len(rows['event_venue'])}, {n_cap} with a capacity", flush=True)

    # food & drink
    for r in rows["food_drink"]:
        emit("food_drink", r, {"kind": r["t"].get("amenity"), "brand": r["t"].get("brand") or None})

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["dataset", "source_id", "name", "props", "geom_wkt"])
        w.writeheader()
        w.writerows(out)
    by = {}
    for o in out:
        by[o["dataset"]] = by.get(o["dataset"], 0) + 1
    print(f"[sport] wrote {OUT.name}: {by}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
