#!/usr/bin/env bash
# Upload one PMTiles file to the public Supabase Storage "tiles" bucket.
#   bash .github/scripts/upload_tiles.sh <file.pmtiles>
# Env: SUPABASE_URL, SUPABASE_SERVICE_KEY. The workflow keeps the file as an
# artifact first, so a rejected upload (usually the project's file size limit:
# Project Settings -> Storage) never costs the build.
set -euo pipefail
f="$1"
if [ -z "${SUPABASE_URL:-}" ] || [ -z "${SUPABASE_SERVICE_KEY:-}" ]; then
  echo "::error::Missing SUPABASE_URL / SUPABASE_SERVICE_KEY secrets."; exit 1
fi
code=$(curl -sS -o /tmp/upload_resp.txt -w '%{http_code}' -X POST \
  "$SUPABASE_URL/storage/v1/object/tiles/$(basename "$f")" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
  -H "apikey: $SUPABASE_SERVICE_KEY" \
  -H "Content-Type: application/octet-stream" \
  -H "x-upsert: true" \
  -T "$f")
cat /tmp/upload_resp.txt; echo
if [ "$code" != "200" ]; then
  echo "::error::Upload of $f failed (HTTP $code). A size rejection means raising Project Settings -> Storage -> Upload file size limit, then re-running against the artifact."
  exit 1
fi
echo "Uploaded: $SUPABASE_URL/storage/v1/object/public/tiles/$(basename "$f")"
