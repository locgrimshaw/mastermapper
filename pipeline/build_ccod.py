"""
build_ccod.py
-------------
Council-owned property from HM Land Registry's CCOD dataset ("UK companies
that own property in England and Wales"), for the map_features dataset
`la_property`.

REQUIRES the CCOD_API_KEY env var (a GitHub Actions secret): an API key from
a registered account at https://use-land-property-data.service.gov.uk/ with
the CCOD licence accepted. The raw file is licence-restricted — it is only
ever downloaded inside the workflow run, never committed.

Phase 1 (this script): download the latest CCOD full file via the service's
API, keep titles whose proprietor is a local authority (proprietorship
category "Local Authority"/"County Council", or a proprietor name that reads
as a council), geocode by POSTCODE using OS Code-Point Open (free, no key),
and aggregate to one point per (postcode, proprietor) with a title count.
Output: supabase/datasets_import.csv (dataset,source_id,name,props,geom_wkt)
— loaded by supabase/loaders/load_datasets.py with DATASETS=la_property.

Phase 2 (later): join title numbers to HMLR INSPIRE index polygons for true
parcel outlines.

Licence: contains HM Land Registry data © Crown copyright and database right
2026, licensed under the CCOD licence; postcode locations via OS Code-Point
Open (OGL). Positions are postcode centroids — indicative, not boundaries.
"""

import csv
import io
import json
import os
import re
import shutil
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "supabase" / "datasets_import.csv"

API_BASE = "https://use-land-property-data.service.gov.uk/api/v1"
CODEPOINT_URL = ("https://api.os.uk/downloads/v1/products/CodePointOpen/"
                 "downloads?area=GB&format=CSV&redirect")

LA_CATEGORY = re.compile(r"local authority|county council", re.I)
LA_NAME = re.compile(
    r"\b(BOROUGH|COUNTY|CITY|DISTRICT|TOWN|PARISH)?\s*COUNCIL\b|"
    r"\bCOMMON COUNCIL\b|\bGREATER LONDON AUTHORITY\b", re.I)


# The service sits behind Cloudflare bot protection which rejects Python's
# default urllib signature outright (Error 1010) before the API key is even
# looked at — a plain browser User-Agent lets legitimate keyed requests through.
_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")


def _api(path, key):
    req = urllib.request.Request(API_BASE + path,
                                 headers={"Authorization": key,
                                          "Accept": "application/json",
                                          "User-Agent": _UA})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")[:300]
        print(f"ERROR: API {path} -> HTTP {exc.code}. {body}", file=sys.stderr)
        if exc.code in (401, 403):
            print("A 401/403 means the service rejected the API key: on "
                  "use-land-property-data.service.gov.uk check that the CCOD "
                  "dataset licence is ACCEPTED on your account and that the "
                  "CCOD_API_KEY secret exactly matches the key on your account "
                  "page (regenerate it if unsure).", file=sys.stderr)
        sys.exit(1)


def _walk_strings(obj):
    if isinstance(obj, dict):
        for v in obj.values():
            yield from _walk_strings(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _walk_strings(v)
    elif isinstance(obj, str):
        yield obj


def file_link(fname, key):
    """Resolve one named CCOD file to its signed download URL via the
    per-file API route (works even when the dataset-listing route 403s)."""
    link_meta = _api(f"/datasets/ccod/{fname}", key)
    urls = [s for s in _walk_strings(link_meta) if s.startswith("http")]
    if not urls:
        print("ERROR: no download URL in file response. Keys:",
              list(link_meta)[:8], file=sys.stderr)
        sys.exit(1)
    return urls[0]


def discover_ccod(key):
    """Find the latest CCOD full-file name, then its signed download URL.
    The API's exact response shape has drifted between versions, so walk the
    JSON for the patterns we need rather than assuming a schema."""
    meta = _api("/datasets/ccod", key)
    names = [s for s in _walk_strings(meta)
             if re.match(r"CCOD_FULL_\d{4}_\d{2}\.zip$", s.strip())]
    if not names:
        names = [s for s in _walk_strings(meta) if "CCOD_FULL" in s and s.endswith(".zip")]
    if not names:
        print("ERROR: no CCOD_FULL file name in /datasets/ccod response. Keys:",
              list(meta)[:8], file=sys.stderr)
        sys.exit(1)
    fname = sorted(set(names))[-1]
    print(f"[ccod] latest full file: {fname}")
    return fname, file_link(fname, key)


def fetch_from_storage():
    """The manual route around HMLR's Cloudflare bot protection: the user
    downloads the CCOD zip in their browser and uploads it to the PRIVATE
    Supabase storage bucket 'restricted' (service-role access only, so the
    licence-restricted file is never public). Returns the local path of the
    newest CCOD_FULL*.zip found there, or None."""
    base = os.environ.get("SUPABASE_URL", "").rstrip("/")
    skey = os.environ.get("SUPABASE_SERVICE_KEY", "")
    if not (base and skey):
        return None
    hdrs = {"Authorization": f"Bearer {skey}", "apikey": skey,
            "Content-Type": "application/json", "User-Agent": _UA}
    body = json.dumps({"prefix": "", "limit": 100,
                       "sortBy": {"column": "name", "order": "desc"}}).encode()
    req = urllib.request.Request(f"{base}/storage/v1/object/list/restricted",
                                 data=body, headers=hdrs, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            items = json.loads(r.read().decode("utf-8"))
    except (urllib.error.HTTPError, urllib.error.URLError) as exc:
        print(f"[ccod] storage list unavailable ({exc}) — trying the API route")
        return None
    names = sorted(x.get("name", "") for x in (items or [])
                   if re.match(r"CCOD_FULL.*\.zip$", str(x.get("name", ""))))
    if not names:
        return None
    fname = names[-1]
    dest = RAW / "ccod_full.zip"
    print(f"[ccod] downloading {fname} from the private storage bucket ...")
    req = urllib.request.Request(
        f"{base}/storage/v1/object/restricted/{urllib.parse.quote(fname)}",
        headers={"Authorization": f"Bearer {skey}", "apikey": skey,
                 "User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=900) as r, dest.open("wb") as out:
        shutil.copyfileobj(r, out, 1 << 20)
    if not zipfile.is_zipfile(dest):
        print("  storage object isn't a zip — ignoring it")
        return None
    return dest


def download_zip(url, dest, key=None):
    """Download to dest, trying with the API key header first (harmless for
    presigned URLs, required if the direct route honours it), then without.
    Verifies the result is actually a zip — the website's own /download route
    answers a logged-out client with an HTML sign-in page, not the file."""
    attempts = ([{"Authorization": key, "User-Agent": _UA}] if key else []) \
        + [{"User-Agent": _UA}]
    for hdrs in attempts:
        req = urllib.request.Request(url, headers=hdrs)
        try:
            with urllib.request.urlopen(req, timeout=900) as r, dest.open("wb") as out:
                shutil.copyfileobj(r, out, 1 << 20)
        except (urllib.error.HTTPError, urllib.error.URLError) as exc:
            print(f"  download attempt ({'with key' if hdrs else 'anonymous'}) "
                  f"failed: {exc}")
            continue
        if zipfile.is_zipfile(dest):
            return
        print(f"  download attempt ({'with key' if hdrs else 'anonymous'}) "
              "returned something that isn't a zip (probably the sign-in "
              "page) — the direct website URL needs a browser session.")
    print("ERROR: could not download the CCOD file. Prefer setting CCOD_FILE "
          "to the file name (e.g. CCOD_FULL_2026_07.zip) so the signed link "
          "comes from the API with your key, rather than a raw website URL.",
          file=sys.stderr)
    sys.exit(1)


def load_postcodes():
    """postcode (no spaces, upper) -> (easting, northing) from Code-Point Open."""
    dest = RAW / "codepoint-open.zip"
    if not dest.exists():
        print("[codepoint] downloading OS Code-Point Open ...")
        urllib.request.urlretrieve(CODEPOINT_URL, dest)
    pcs = {}
    with zipfile.ZipFile(dest) as zf:
        members = [m for m in zf.namelist()
                   if m.lower().endswith(".csv") and "/csv/" in m.lower()]
        for m in members:
            with zf.open(m) as fh:
                for row in csv.reader(io.TextIOWrapper(fh, "utf-8", errors="ignore")):
                    if len(row) >= 4:
                        pc = row[0].replace(" ", "").upper()
                        try:
                            pcs[pc] = (float(row[2]), float(row[3]))
                        except ValueError:
                            continue
    print(f"[codepoint] {len(pcs):,} postcodes indexed")
    return pcs


def main():
    key = os.environ.get("CCOD_API_KEY", "").strip()
    RAW.mkdir(parents=True, exist_ok=True)

    # Source order:
    #   1. CCOD_URL   — a full direct download URL (workflow input / repo var).
    #   2. the private Supabase storage bucket 'restricted' — the manual
    #      route: upload the browser-downloaded CCOD_FULL_*.zip there.
    #   3. the HMLR API — CCOD_FILE skips discovery; needs CCOD_API_KEY and
    #      Cloudflare letting the runner through.
    direct = os.environ.get("CCOD_URL", "").strip()
    fname = os.environ.get("CCOD_FILE", "").strip()
    ccod_zip = RAW / "ccod_full.zip"
    if direct:
        fname = fname or direct.rstrip("/").rsplit("/", 1)[-1] or "CCOD_FULL.zip"
        print(f"[ccod] using direct CCOD_URL override ({fname})")
        download_zip(direct, ccod_zip, key or None)
    else:
        got = fetch_from_storage()
        if got is not None:
            ccod_zip = got
        elif not key:
            print("::warning::No CCOD source available — upload the CCOD zip "
                  "to the private 'restricted' storage bucket, or set the "
                  "CCOD_API_KEY secret. Skipping the CCOD build.")
            return 0
        else:
            if fname:
                print(f"[ccod] CCOD_FILE={fname} — skipping dataset discovery")
                url = file_link(fname, key)
            else:
                fname, url = discover_ccod(key)
            print(f"[ccod] downloading {fname} (~400 MB) ...")
            download_zip(url, ccod_zip, key)

    pcs = load_postcodes()
    try:
        from pyproj import Transformer
    except ImportError:
        print("ERROR: pyproj unavailable", file=sys.stderr)
        return 1
    tr = Transformer.from_crs(27700, 4326, always_xy=True)

    # Stream the CCOD CSV; keep LA-owned titles; aggregate per (postcode,
    # proprietor). The header names the columns; find the ones we need.
    agg = {}
    kept = seen = 0
    with zipfile.ZipFile(ccod_zip) as zf:
        member = next(m for m in zf.namelist() if m.lower().endswith(".csv"))
        with zf.open(member) as fh:
            rd = csv.reader(io.TextIOWrapper(fh, "utf-8-sig", errors="ignore"))
            header = next(rd)
            low = [h.strip().lower() for h in header]

            def col(pattern):
                return [i for i, h in enumerate(low) if re.search(pattern, h)]

            i_addr = (col(r"property address") or [None])[0]
            i_pc = (col(r"^postcode") or col(r"postcode") or [None])[0]
            i_names = col(r"proprietor name")
            i_cats = col(r"proprietorship category")
            if i_pc is None or not i_names:
                print("ERROR: unexpected CCOD columns:", header[:12],
                      file=sys.stderr)
                return 1
            for row in rd:
                seen += 1
                if len(row) <= i_pc:
                    continue
                is_la, prop_name, prop_cat = False, None, None
                for i_n, i_c in zip(i_names, i_cats + [None] * len(i_names)):
                    nm = row[i_n].strip() if i_n < len(row) else ""
                    ct = row[i_c].strip() if i_c is not None and i_c < len(row) else ""
                    if not nm:
                        continue
                    if LA_CATEGORY.search(ct) or LA_NAME.search(nm):
                        is_la, prop_name, prop_cat = True, nm, ct
                        break
                if not is_la:
                    continue
                pc = row[i_pc].replace(" ", "").upper()
                if pc not in pcs:
                    continue
                kept += 1
                k = (pc, prop_name.upper())
                a = agg.setdefault(k, {"n": 0, "name": prop_name,
                                       "category": prop_cat, "postcode": row[i_pc],
                                       "address": None})
                a["n"] += 1
                if a["address"] is None and i_addr is not None and i_addr < len(row):
                    a["address"] = row[i_addr][:160]
    print(f"[ccod] {seen:,} titles scanned, {kept:,} LA-owned with a mappable "
          f"postcode, {len(agg):,} aggregated points")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=["dataset", "source_id", "name",
                                           "props", "geom_wkt"])
        w.writeheader()
        for (pc, _), a in agg.items():
            e, n = pcs[pc]
            lon, lat = tr.transform(e, n)
            props = {k: v for k, v in (("titles", a["n"]),
                                       ("category", a["category"]),
                                       ("postcode", a["postcode"]),
                                       ("address", a["address"])) if v}
            w.writerow({
                "dataset": "la_property",
                "source_id": f"{pc}-{re.sub(r'[^A-Z0-9]+', '', a['name'].upper())[:40]}",
                "name": a["name"],
                "props": json.dumps(props, separators=(",", ":"), ensure_ascii=False),
                "geom_wkt": f"SRID=4326;POINT({lon:.6f} {lat:.6f})",
            })
    print(f"[ccod] wrote {OUT} ({OUT.stat().st_size/1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
