"""
pipr.py — shared reader for the ONS Price Index of Private Rents workbook.

WHAT PIPR IS. Monthly average rents for the UK private rental sector, built
from ADMINISTRATIVE data (the Valuation Office Agency's rent officer records
in England, and the devolved equivalents), covering BOTH NEW AND EXISTING
tenancies. That last point is what makes it usable as achieved-rent evidence:
a portal scrape only ever sees asking rents on new lets, which run ahead of
the passing rent on the stock a BTR investor actually buys.

STATUS, STATED HONESTLY. PIPR is "official statistics in development" — NOT
accredited official statistics. It is not seasonally adjusted, the index is
based at January 2023 = 100, and prices are rounded to the nearest £1.

GEOGRAPHY IS NOT UNIFORM ACROSS THE UK, and this matters for mapping:
  England   E06/E07/E08/E09 — 294 local authority districts, joins 1:1 to
                              the lad_boundary layer.
  Wales     W06             — 22 unitary authorities, joins 1:1.
  Scotland  S33             — 18 ONS RENTAL GROUPINGS ("Ayrshires", "Greater
                              Glasgow", "Highland and Islands"), which are
                              NOT council areas and have no published boundary
                              set. They are kept for the appraisal fallback
                              but are NOT mapped: painting a council polygon
                              with a grouping's rent would invent a geography.
  N. Ireland                — Broad Rental Market Areas carrying no area code
                              at all ("[z]"). Dropped entirely.
Plus the UK, GB, the four countries and the nine English regions, which are
kept as fallbacks for the viability model.

SCOTLAND CARRIES A FURTHER CAVEAT (workbook note 8): its underlying rents are
mainly ADVERTISED NEW LETS, so they were not subject to the in-tenancy
increase cap that applied between September 2022 and March 2025. Scottish
levels and growth are therefore not like-for-like with the rest of the UK.

THERE IS NO STABLE DOWNLOAD URL. Every monthly release lands at its own path
with an arbitrary filename suffix ("...statistics13.xlsx", "...statistics..xlsx"),
so the release has to be discovered from the dataset landing page rather than
fetched from a fixed address. `latest_release_url()` does that.

Licence: Crown copyright, Open Government Licence v3.0. Attribution required.
"""

import datetime as _dt
import re
import urllib.request

LANDING = ("https://www.ons.gov.uk/economy/inflationandpriceindices/datasets/"
           "priceindexofprivaterentsukmonthlypricestatistics")

UA = {"User-Agent": "mastermapper-pipeline/1.0 (+https://github.com/locgrimshaw/mastermapper)"}

# The nine series the workbook carries, as (key, first-column-index, label).
# Table 1 is one wide row per (month, area): four columns per series in the
# fixed order index / monthly change / annual change / rental price.
SERIES = [
    ("all",  4,  "All properties"),
    ("b1",   8,  "1 bedroom"),
    ("b2",   12, "2 bedrooms"),
    ("b3",   16, "3 bedrooms"),
    ("b4",   20, "4+ bedrooms"),
    ("det",  24, "Detached"),
    ("semi", 28, "Semi-detached"),
    ("terr", 32, "Terraced"),
    ("flat", 36, "Flat or maisonette"),
]
SERIES_KEYS = [s[0] for s in SERIES]
SERIES_LABEL = {k: lbl for k, _, lbl in SERIES}

# Area codes we map. Scotland's S33 groupings and Northern Ireland's unnamed
# BRMAs are deliberately absent — see the geography note above.
MAPPABLE_PREFIXES = ("E06", "E07", "E08", "E09", "W06")
# Codes kept for the viability model's region/country fallback chain.
FALLBACK_PREFIXES = ("E12", "E92", "W92", "S92", "N92", "K02", "K03", "S33")


def latest_release_url(html=None):
    """Newest release URL from the ONS landing page, plus its release date.

    ONS gives each monthly release its own path segment ('19august2026') and
    an unpredictable filename, so the newest release is found by parsing those
    date segments rather than by sorting the filenames — 'statistics2.xlsx'
    sorts after 'statistics13.xlsx' and neither tells you the date.
    """
    if html is None:
        req = urllib.request.Request(LANDING, headers=UA)
        with urllib.request.urlopen(req, timeout=120) as r:
            html = r.read().decode("utf-8", "replace")
    best = None
    for href in set(re.findall(r'href="([^"]*\.xlsx?[^"]*)"', html)):
        m = re.search(r"/(\d{1,2})([a-z]+)(\d{4})/", href)
        if not m:
            continue
        try:
            d = _dt.datetime.strptime(
                f"{int(m.group(1))} {m.group(2)[:3].title()} {m.group(3)}",
                "%d %b %Y").date()
        except ValueError:
            continue
        if best is None or d > best[0]:
            best = (d, href)
    if best is None:
        raise RuntimeError(
            "no dated .xlsx link found on the PIPR landing page — the page "
            "layout has changed; check " + LANDING)
    d, href = best
    if not href.startswith("http"):
        href = "https://www.ons.gov.uk" + href
    return href, d


def _num(v):
    """A cell as a float, or None. ONS writes '[x]' for not-available and
    '[z]' for not-applicable; both mean 'no number', never zero."""
    if v is None or isinstance(v, str):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if f != f else f          # drop NaN


def read_table1(path):
    """Parse Table 1 into {code: {"name", "region", "months": {period: {...}}}}.

    `period` is 'YYYY-MM'. Each month maps series key -> dict with 'rent'
    (int £/month), 'idx' (index, Jan 2023 = 100) and 'chg' (annual % change,
    None for the first twelve months where there is no year-ago comparator).
    """
    import openpyxl
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb["Table 1"]
    rows = ws.iter_rows(min_row=3, values_only=True)
    header = next(rows)
    if str(header[0]).strip().lower() != "time period":
        raise RuntimeError(f"unexpected Table 1 header: {header[:4]}")

    areas = {}
    for r in rows:
        period, code, name, region = r[0], r[1], r[2], r[3]
        if not period or not code:
            continue
        # Northern Ireland's BRMAs carry '[z]' where the area code should be.
        # Without a code there is nothing to join to, so they are dropped.
        code = str(code).strip()
        if not re.fullmatch(r"[A-Z]\d{8}", code):
            continue
        if hasattr(period, "year"):
            key = f"{period.year:04d}-{period.month:02d}"
        else:                                    # a plain 'YYYY MMM' string
            key = str(period).strip()
        a = areas.setdefault(code, {"name": str(name).strip(),
                                    "region": (str(region).strip()
                                               if region and not str(region).startswith("[")
                                               else None),
                                    "months": {}})
        m = {}
        for skey, col, _lbl in SERIES:
            rent = _num(r[col + 3])
            idx = _num(r[col])
            chg = _num(r[col + 2])
            if rent is None and idx is None:
                continue
            m[skey] = {"rent": int(round(rent)) if rent is not None else None,
                       "idx": idx, "chg": chg}
        if m:
            a["months"][key] = m
    if not areas:
        raise RuntimeError("Table 1 parsed to zero areas")
    return areas


def periods_of(areas):
    """Every month present, oldest first."""
    seen = set()
    for a in areas.values():
        seen.update(a["months"])
    return sorted(seen)


def growth_pct(months, periods, series, back):
    """Percentage change in the £ rent over `back` months, or None.

    Computed from the published rent levels rather than the index because it
    is the levels this app quotes; over five years the £1 rounding is noise.
    """
    if len(periods) <= back:
        return None
    now = (months.get(periods[-1]) or {}).get(series) or {}
    then = (months.get(periods[-1 - back]) or {}).get(series) or {}
    a, b = now.get("rent"), then.get("rent")
    if not a or not b:
        return None
    return round((a / b - 1) * 100, 1)


# Growth window for the five-year figure the map and cards quote. ONS publish
# the ANNUAL change (derived from the index) but nothing longer, so this one
# is ours, computed from the published levels and labelled as such.
GROWTH_MONTHS = 60


def fetch_workbook(dest, src=None):
    """Return a path to a PIPR workbook, downloading the latest if needed.

    `src` may be a local path (used as-is) or an http(s) URL. With neither,
    the newest release is discovered from the ONS landing page.
    """
    from pathlib import Path
    dest = Path(dest)
    if src and not str(src).startswith("http"):
        return Path(src), f"local file {Path(src).name}"
    url, released = (str(src), None) if src else latest_release_url()
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=600) as r, dest.open("wb") as fh:
        fh.write(r.read())
    return dest, (f"ONS release {released}" if released else "supplied URL")


def build_la_props(areas, periods):
    """Per-LAD props for the la_rents map layer.

    EVERY series goes on the polygon — nine rent levels, nine annual changes
    and nine five-year growth figures. That looks profligate for a choropleth
    that draws one number at a time, and it is the point: the bedroom and
    property-type selector then repaints features already in the browser
    instead of refetching the country, which is what makes switching from
    "2 bedrooms" to "detached" instant.
    """
    latest = periods[-1]
    out = {}
    for code, a in sorted(areas.items()):
        if code[:3] not in MAPPABLE_PREFIXES:
            continue
        m = a["months"].get(latest)
        if not m or (m.get("all") or {}).get("rent") is None:
            continue
        p = {"asof": latest, "pipr_name": a["name"], "pipr_code": code}
        for skey in SERIES_KEYS:
            d = m.get(skey) or {}
            if d.get("rent") is not None:
                p[f"rent_{skey}"] = d["rent"]
            if d.get("chg") is not None:
                p[f"chg_{skey}"] = round(float(d["chg"]), 1)
            g = growth_pct(a["months"], periods, skey, GROWTH_MONTHS)
            if g is not None:
                p[f"g5_{skey}"] = g
        # Legacy keys the deep dive, the sift CSV export and the site cards
        # already read. Kept so this layer stays a superset, never a break.
        p["rent_mean"] = p.get("rent_all")
        if "chg_all" in p:
            p["annual_rent_change_pct"] = p["chg_all"]
        out[code] = p
    return {"asof": latest, "first_period": periods[0],
            "months": len(periods), "areas": out}
