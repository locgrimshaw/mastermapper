"""
fetch_council_assets.py
-----------------------
Harvest local-authority land and building asset registers and pull out a
LOCATOR for each holding — a UPRN or a coordinate, whichever the register
publishes.

WHY: our public-land layer currently places a council's holdings by POSTCODE
CENTROID, and that is structurally lossy. CCOD holds 187,666 public land titles
but only 120,789 distinct postcode+owner points, so a point can never stand for
more than one parcel — 66,877 titles cannot be represented at all, and a
centroid often sits on the road rather than on the site. A UPRN is a precise
point on the actual property, so an asset register carrying UPRNs turns a guess
into a lookup.

WHERE FROM: the Local Government Transparency Code 2015 requires every English
council to publish a register of its land and building assets annually. They are
published individually, with no common schema, so this discovers them through
the data.gov.uk CKAN API rather than relying on a hardcoded URL list that would
rot silently.

BE WARNED: coverage is expected to be uneven. Councils publish CSV, XLSX, PDF or
nothing at all; column names vary; some registers omit UPRNs entirely. This
script is deliberately loud about what it found and what it could not use — the
coverage report is the point of running it, not a side effect.

COORDINATES MATTER AS MUCH AS UPRNs. The first run accepted only a UPRN column
and discarded 768 registers that had been fetched and read perfectly well.
Cambridgeshire's County Farms register is the case that exposed it: 3,280 plots
with Centre_X/Centre_Y and no UPRN anywhere (it carries USRN, a STREET
reference, which is a different thing). For LAND a coordinate is the better
locator anyway — a UPRN sits on a building, a plot centroid sits on the field —
so a register now qualifies on either, and eastings/northings are told apart
from decimal degrees by magnitude rather than by trusting a column name.

Output: data/raw/council_assets.csv
        columns: council, uprn, lng, lat, area_ha, description, address,
                 source_url
Also prints a per-source tally and an overall coverage summary.

Licence: individual council registers are published under the Open Government
Licence; check any that you rely on commercially.
"""

import csv
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(os.environ.get("COUNCIL_ASSETS_OUT")
           or (ROOT / "data" / "raw" / "council_assets.csv"))

CKAN = os.environ.get(
    "CKAN_API", "https://ckan.publishing.service.gov.uk/api/3/action/package_search")

# Several phrasings, because councils title these things inconsistently:
# "Land and building assets", "Asset register", "Property portfolio"...
QUERIES = [q.strip() for q in (os.environ.get("ASSET_QUERIES") or
    "land and building assets;asset register;land and property assets;"
    "property asset register;council owned land"
).split(";") if q.strip()]

MAX_RESOURCE_BYTES = int(os.environ.get("MAX_RESOURCE_BYTES") or 60_000_000)
HTTP_TIMEOUT = int(os.environ.get("HTTP_TIMEOUT") or 60)
# Politeness: these are small public servers, not a CDN.
SLEEP_BETWEEN = float(os.environ.get("SLEEP_BETWEEN") or 0.4)

# STOP CRAWLING BEFORE THE RUNNER KILLS US. The crawl is 1,300 requests to a few
# hundred independent servers, so its duration is set by how slow the slowest of
# them are that day — it has taken 75 min and 118+ min on identical inputs. If
# the job's own timeout fires first the step is killed mid-loop and every row
# harvested so far dies with it, because the artifact upload never runs.
# Rows are written to the CSV as they are found, so stopping the loop early
# yields a complete, valid, smaller file — always worth more than nothing.
# Keep this comfortably under the workflow's timeout-minutes.
DEADLINE_S = float(os.environ.get("HARVEST_DEADLINE_MIN") or 150) * 60.0
_STARTED = time.monotonic()


def _time_left():
    return DEADLINE_S - (time.monotonic() - _STARTED)

UA = ("Mozilla/5.0 (compatible; MasterMapper/1.0; "
      "+public-land-asset-register-harvest)")

# NOT EVERY DATASET A COUNCIL PUBLISHES IS A LAND HOLDING. The search phrases
# are deliberately broad, so they also drag in transparency-code datasets that
# happen to carry a UPRN or a coordinate. Two from the first coordinate-enabled
# run show why this matters:
#   Durham CC "Public street lighting" — 83,134 rows, one per lighting column.
#       A street light standing in a parcel does not make the council the owner
#       of that parcel.
#   Cambridgeshire "Empty homes" — 574 rows of PRIVATELY owned houses. Joining
#       those would attribute private homes to the council: the exact opposite
#       of the truth, and invisible once it is a coloured polygon on a map.
# Left unfiltered these would have been 28% of the harvest. Excluded here, at
# discovery, so the file is never even downloaded — and reported, because a
# silent denylist is how you lose a real register without noticing.
TITLE_DENY = re.compile(
    r"street\s*light|lighting\s*column|\bempty\s*(home|propert)|"
    r"bus\s*stop|grit\s*bin|salt\s*bin|\bgull(y|ies)\b|road\s*sign|"
    r"traffic\s*(signal|count|flow)|defibrillator|\bbench(es)?\b|"
    r"\bcctv\b|litter\s*bin|waste\s*container|\btree(s)?\s*(survey|preservation)|"
    r"planning\s*application|energy\s*performance|\bepc\b|business\s*rate|"
    r"licen[cs]|food\s*hygiene|electoral|senior\s*salar|organisation\s*chart|"
    r"trade\s*union|expenditure|payments?\s*to\s*suppliers|procurement|"
    r"contract(s)?\s*register|parking\s*(fine|ticket|penalty)|\bpcn\b|"
    # Biological survey records. The JNCC's "Species point records from 1987
    # OPRU HRE Newtown and Bembridge" got through the first denylist: 451 rows
    # of sightings, each with a grid reference, which would have made a parcel
    # "owned by" the JNCC because a bird was once recorded standing on it.
    r"species|biological\s*record|wildlife\s*(record|site)|habitat\s*survey|"
    r"bird\s*(survey|count)|\bflora\b|\bfauna\b",
    re.I)

# A UPRN is a 1-12 digit number. Anything outside that is a mis-detected column.
UPRN_RE = re.compile(r"^\d{1,12}$")
UPRN_COL = re.compile(r"\buprn\b|unique\s*property\s*reference", re.I)
DESC_COL = re.compile(r"desc|asset\s*name|property\s*name|site|building|title|"
                      r"holding|premises|farm|parish", re.I)
ADDR_COL = re.compile(r"address|location|street|postcode", re.I)

# MANY registers carry COORDINATES instead of a UPRN, and the first run threw
# all of them away — 768 resources were read fine and discarded purely for
# lacking a UPRN column. Cambridgeshire's County Farms register is the example
# that showed it: 3,280 plots with Centre_X/Centre_Y and no UPRN at all (it
# carries USRN, a STREET reference, which is not the same thing).
#
# For LAND a coordinate is better than a UPRN anyway: a UPRN sits on a building,
# a plot centroid sits on the field.
XCOL = re.compile(r"centre[_ ]?x|\beasting|\beast\b|\bx[_ ]?coord|grid[_ ]?x|^x$", re.I)
YCOL = re.compile(r"centre[_ ]?y|\bnorthing|\bnorth\b|\by[_ ]?coord|grid[_ ]?y|^y$", re.I)
LATCOL = re.compile(r"\blatitude\b|^lat$", re.I)
LONCOL = re.compile(r"\blongitude\b|^lon$|^lng$|^long$", re.I)
AREACOL = re.compile(r"hectare|\bha\b|area", re.I)

# Great Britain in EPSG:27700. Used to tell an easting/northing pair apart from
# a decimal degree pair — they differ by orders of magnitude, so this is safe.
BNG_X = (0.0, 800000.0)
BNG_Y = (0.0, 1400000.0)
# ...and the WGS84 window that actually contains the UK.
WGS_LON = (-9.0, 2.5)
WGS_LAT = (49.0, 61.5)


def _get(url, timeout=HTTP_TIMEOUT):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(MAX_RESOURCE_BYTES + 1)


def _get_retry(url, attempts=2):
    """_get with one retry, but only for failures that might not repeat.

    402 of 1,291 resources failed to fetch on the last run — 31%, and these are
    small council web servers, so a slice of that is load rather than a dead
    URL. A 404 or 403 will never succeed on a retry, so retrying those would
    only add an hour to the crawl for nothing."""
    last = None
    for n in range(attempts):
        try:
            return _get(url)
        except urllib.error.HTTPError as exc:
            if exc.code < 500 and exc.code != 429:
                raise                      # gone or forbidden: retrying is waste
            last = exc
        except Exception as exc:           # timeout, reset, DNS, bad TLS
            last = exc
        # Never spend the last of the budget on a second attempt at one file.
        if n + 1 < attempts and _time_left() > 120:
            time.sleep(3.0)
        else:
            break
    raise last


def discover():
    """Ask data.gov.uk for candidate asset-register datasets.

    Returns [(council, title, resource_url, fmt)]. Dedupes by resource URL so
    a dataset matching several queries is only fetched once."""
    seen, found, denied = set(), [], []
    for q in QUERIES:
        start, page = 0, 200
        while True:
            url = f"{CKAN}?" + urllib.parse.urlencode(
                {"q": q, "rows": page, "start": start})
            try:
                data = json.loads(_get(url).decode("utf-8", "replace"))
            except Exception as exc:
                print(f"  [discover] query {q!r} failed: {exc}", file=sys.stderr)
                break
            result = (data.get("result") or {})
            pkgs = result.get("results") or []
            if not pkgs:
                break
            for p in pkgs:
                org = ((p.get("organization") or {}).get("title")
                       or p.get("author") or "unknown")
                ptitle = p.get("title") or ""
                if TITLE_DENY.search(ptitle):
                    if ptitle not in {d[1] for d in denied}:
                        denied.append((org, ptitle))
                    continue
                for res in (p.get("resources") or []):
                    fmt = (res.get("format") or "").strip().lower()
                    href = (res.get("url") or "").strip()
                    if not href or fmt not in ("csv", "xls", "xlsx"):
                        continue
                    if href in seen:
                        continue
                    seen.add(href)
                    found.append((org, p.get("title") or "", href, fmt))
            start += page
            if start >= min(result.get("count", 0), 2000):
                break
    print(f"[assets] {len(found)} candidate resource(s) across "
          f"{len({f[0] for f in found})} publisher(s)")
    if denied:
        # Printed in full, not counted. If a real asset register ever matches
        # the denylist it has to be visible here, otherwise the harvest silently
        # shrinks and the coverage report still looks healthy.
        print(f"[assets] {len(denied)} dataset(s) excluded as not-a-land-holding:")
        for org, t in sorted(denied)[:40]:
            print(f"    - {org} — {t[:70]}")
        if len(denied) > 40:
            print(f"    ... and {len(denied) - 40} more")
    return found


def _rows_from_csv(blob):
    text = blob.decode("utf-8-sig", "replace")
    if text.lstrip()[:1] == "<":
        return []          # an HTML error page served with a .csv URL
    # Sniff the delimiter; council exports are comma, semicolon or tab.
    sample = text[:8192]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    # newline="" matters: several registers contain unquoted line breaks inside
    # address fields, and without it csv raises "new-line character seen in
    # unquoted field" and takes the whole crawl down with it.
    return list(csv.DictReader(io.StringIO(text, newline=""), dialect=dialect))


def _rows_from_excel(blob):
    try:
        import pandas as pd
    except ImportError:
        return []
    try:
        sheets = pd.read_excel(io.BytesIO(blob), sheet_name=None, dtype=str)
    except Exception:
        return []
    rows = []
    for df in sheets.values():
        df = df.fillna("")
        rows.extend(df.to_dict("records"))
    return rows


def _pick(cols, rx):
    for c in cols:
        if c and rx.search(str(c)):
            return c
    return None


def _num(v):
    if v is None:
        return None
    s = str(v).strip().replace(",", "")
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _to_wgs84(x, y):
    """(lng, lat) from a coordinate pair, deciding its CRS from magnitude.

    A British National Grid easting is ~100000-700000; a longitude is between
    -9 and 2.5. They cannot be confused, so the ranges classify the pair without
    the register having to say which it is — and most of them do not say."""
    if x is None or y is None:
        return None, None
    if BNG_X[0] <= x <= BNG_X[1] and BNG_Y[0] <= y <= BNG_Y[1] and (x > 1000 or y > 1000):
        try:
            from pyproj import Transformer
        except ImportError:
            return None, None
        global _BNG_TF
        try:
            tf = _BNG_TF
        except NameError:
            tf = _BNG_TF = Transformer.from_crs(27700, 4326, always_xy=True)
        lng, lat = tf.transform(x, y)
    elif WGS_LON[0] <= x <= WGS_LON[1] and WGS_LAT[0] <= y <= WGS_LAT[1]:
        lng, lat = x, y            # already degrees, x=lon y=lat
    elif WGS_LON[0] <= y <= WGS_LON[1] and WGS_LAT[0] <= x <= WGS_LAT[1]:
        lng, lat = y, x            # lat/lon the other way round
    else:
        return None, None
    if not (WGS_LON[0] <= lng <= WGS_LON[1] and WGS_LAT[0] <= lat <= WGS_LAT[1]):
        return None, None          # landed outside the UK: reject rather than plot it
    return round(lng, 7), round(lat, 7)


def harvest(found):
    OUT.parent.mkdir(parents=True, exist_ok=True)
    n_ok = n_uprn_col = n_rows = 0
    n_xy_col = n_xy_rows = 0
    councils_with_uprn = set()
    per_source = []
    with OUT.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["council", "uprn", "lng", "lat",
                                           "area_ha", "description",
                                           "address", "source_url"])
        w.writeheader()
        stopped_early = 0
        for i, (council, title, href, fmt) in enumerate(found, 1):
            if _time_left() <= 0:
                # Bank what we have. The file is already written up to here.
                stopped_early = len(found) - i + 1
                print(f"\n[assets] DEADLINE reached after {i - 1} resource(s) — "
                      f"stopping with {stopped_early} unfetched so the "
                      f"{n_rows:,} rows harvested so far are kept.", flush=True)
                break
            try:
                blob = _get_retry(href)
            except Exception as exc:
                per_source.append((council, title, "fetch failed", 0))
                continue
            if len(blob) > MAX_RESOURCE_BYTES:
                per_source.append((council, title, "too large", 0))
                continue
            n_ok += 1
            # EVERY per-resource step is inside try/except. This crawl spans 131
            # independent publishers with no shared schema, so malformed files
            # are not an edge case, they are the norm — the first run died on
            # the second council and lost the other 1,298 resources.
            try:
                rows = (_rows_from_csv(blob) if fmt == "csv"
                        else _rows_from_excel(blob))
            except Exception as exc:
                per_source.append((council, title, f"parse failed", 0))
                continue
            if not rows:
                per_source.append((council, title, "unreadable/empty", 0))
                continue
            try:
                cols = list(rows[0].keys())
            except Exception:
                per_source.append((council, title, "unreadable/empty", 0))
                continue
            ucol = _pick(cols, UPRN_COL)
            # Coordinates are an equally good locator — better for land — so a
            # register qualifies on EITHER.
            xcol, ycol = _pick(cols, XCOL), _pick(cols, YCOL)
            latcol, loncol = _pick(cols, LATCOL), _pick(cols, LONCOL)
            has_xy = bool((xcol and ycol) or (latcol and loncol))
            if not ucol and not has_xy:
                per_source.append((council, title, "no UPRN or coordinates", 0))
                continue
            if ucol:
                n_uprn_col += 1
            if has_xy:
                n_xy_col += 1
            dcol = _pick(cols, DESC_COL)
            acol = _pick(cols, ADDR_COL)
            arcol = _pick(cols, AREACOL)
            wrote = 0
            for r in rows:
                raw = ""
                if ucol:
                    raw = str(r.get(ucol) or "").strip().replace(".0", "")
                    # Strip thousands separators Excel loves to add.
                    raw = raw.replace(",", "").replace(" ", "")
                    if not UPRN_RE.match(raw):
                        raw = ""
                lng = lat = None
                if latcol and loncol:
                    lng, lat = _to_wgs84(_num(r.get(loncol)), _num(r.get(latcol)))
                if lng is None and xcol and ycol:
                    lng, lat = _to_wgs84(_num(r.get(xcol)), _num(r.get(ycol)))
                if not raw and lng is None:
                    continue          # neither locator on this row
                w.writerow({
                    "council": council,
                    "uprn": raw,
                    "lng": "" if lng is None else lng,
                    "lat": "" if lat is None else lat,
                    "area_ha": _num(r.get(arcol)) if arcol else "",
                    "description": str(r.get(dcol) or "").strip()[:200] if dcol else "",
                    "address": str(r.get(acol) or "").strip()[:200] if acol else "",
                    "source_url": href,
                })
                wrote += 1
                if lng is not None:
                    n_xy_rows += 1
            n_rows += wrote
            if wrote:
                councils_with_uprn.add(council)
            per_source.append((council, title, "ok", wrote))
            if i % 25 == 0:
                print(f"  [assets] {i}/{len(found)} resources, {n_rows:,} rows, "
                      f"{_time_left() / 60:.0f} min of budget left", flush=True)
            time.sleep(SLEEP_BETWEEN)

    if stopped_early:
        # Loud, and repeated at the end: a partial harvest that reads like a
        # complete one is how a coverage number quietly becomes a lie.
        print(f"::warning::PARTIAL HARVEST — {stopped_early} of {len(found)} "
              f"resources were never fetched (time budget). Coverage figures "
              f"below are a floor, not the ceiling.")
    print(f"\n[assets] fetched {n_ok}/{len(found)} resource(s); "
          f"{n_uprn_col} had a UPRN column, {n_xy_col} had coordinates")
    print(f"[assets] {n_rows:,} usable row(s) from "
          f"{len(councils_with_uprn)} publisher(s); "
          f"{n_xy_rows:,} located by coordinate, "
          f"{n_rows - n_xy_rows:,} by UPRN only")
    print(f"[assets] wrote {OUT}")
    # The failures are the interesting part — they say what is NOT covered.
    reasons = {}
    for _, _, why, _ in per_source:
        reasons[why] = reasons.get(why, 0) + 1
    print("[assets] outcome by resource: "
          + ", ".join(f"{k}={v}" for k, v in sorted(reasons.items())))
    top = sorted((p for p in per_source if p[3]), key=lambda p: -p[3])[:15]
    if top:
        print("[assets] largest registers:")
        for council, title, _, n in top:
            print(f"    {n:>7,}  {council} — {title[:60]}")
    return n_rows


def main() -> int:
    found = discover()
    if not found:
        print("ERROR: discovery returned nothing — the CKAN API may have "
              "changed or be unreachable.", file=sys.stderr)
        return 1
    n = harvest(found)
    if not n:
        print("ERROR: no UPRNs harvested. The registers exist but none exposed "
              "a usable UPRN column; the join cannot be built from this.",
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
