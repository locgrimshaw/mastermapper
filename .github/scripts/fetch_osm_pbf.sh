#!/usr/bin/env bash
# Download the UK OpenStreetMap extract to the given path.
#   bash .github/scripts/fetch_osm_pbf.sh data/raw/uk.osm.pbf [url]
#
# Geofabrik started answering bare curl with a self-redirect loop (Sept 2026:
# "Maximum (50) redirects followed", 275-byte hops) — a cookie challenge, so
# the first attempt keeps a cookie jar. If that still fails, the same extract
# comes from the openstreetmap.fr mirror. An explicit URL (OSM_PBF_SRC /
# workflow input) is tried first when given.
set -uo pipefail
out="$1"; want="${2:-}"
mkdir -p "$(dirname "$out")"
jar=$(mktemp)
try() {
  echo "Downloading OSM PBF: $1"
  rm -f "$out"
  if curl -fL --max-redirs 10 -c "$jar" -b "$jar" --retry 3 --retry-delay 15 \
       -A "MasterMapper/1.0 (github.com/locgrimshaw/mastermapper)" -o "$out" "$1"; then
    size=$(stat -c %s "$out" 2>/dev/null || echo 0)
    if [ "$size" -gt 500000000 ]; then
      echo "OK: $((size / 1000000)) MB"; return 0
    fi
    echo "::warning::$1 returned only $size bytes"
  fi
  return 1
}
for url in "$want" \
           "https://download.geofabrik.de/europe/united-kingdom-latest.osm.pbf" \
           "https://download.openstreetmap.fr/extracts/europe/united_kingdom-latest.osm.pbf"; do
  [ -n "$url" ] || continue
  try "$url" && exit 0
done
echo "::error::Could not download the UK OSM extract from any source"
exit 1
