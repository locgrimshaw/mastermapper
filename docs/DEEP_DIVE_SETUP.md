# Deep dive — Supabase setup

The deep-dive feature shows amenity layers (GPs first) inside a catchment area.
The IMD choropleth stays on the static tile path; amenities live in Supabase
(Postgres + PostGIS) and are queried live. This is a one-time setup.

## 1. Create the Supabase project

1. Sign in at supabase.com and create a new project (the free tier is fine).
2. Keep the **database password** somewhere safe (you won't need it for this,
   but it's painful to reset later).

## 2. Enable PostGIS + create the schema

1. In the dashboard, open the **SQL Editor**.
2. Paste the entire contents of `supabase/migrations/0001_amenities.sql` and
   **Run**. This enables PostGIS, creates the `amenities` table with a spatial
   index, and defines the query functions the map calls.
   - (PostGIS can also be toggled on under *Database > Extensions*; the SQL does
     it for you either way.)
3. You should see the `amenities` table under *Table Editor*.

## 3. Get your API keys

In *Project Settings > API*, copy:
- **Project URL** (e.g. `https://abcd.supabase.co`)
- **anon public** key — safe to expose; used by the website (read-only via RLS).
- **service_role** key — SECRET; used only by the loader to write data. Never
  put this in the website or commit it.

## 4. Point the website at Supabase

Edit `web/config.js` and fill in:

```js
window.MASTERMAPPER_CONFIG = {
  SUPABASE_URL: "https://abcd.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOi...",   // the anon public key
};
```

Commit it. (The anon key is designed to be public — RLS only allows reading the
open amenity data.) Without this, the map still works for IMD + rail; only the
deep-dive amenity layers are disabled.

## 5. Load the GP data

The loader downloads the NHS ODS GP practice file, geocodes postcodes to
coordinates, and upserts into `amenities`. Run it locally (or as a scheduled
GitHub Action later):

```bash
export SUPABASE_URL="https://abcd.supabase.co"
export SUPABASE_SERVICE_KEY="eyJ...service_role..."   # the SECRET key
python supabase/loaders/load_gps.py
```

**Postcode geocoding:** the loader prefers a committed
`data/raw/postcodes.csv` (columns: `postcode,lat,long`) for speed and
reproducibility. If that file is absent it falls back to the free postcodes.io
API (slower, but no setup). A good source for the CSV is the ONS National
Statistics Postcode Lookup (OGL).

When it finishes you'll see a row count. Re-running updates in place (it upserts
on `kind` + `source_id`), so it's safe to schedule monthly.

## 6. Use it

Open the map, click a zone, press **"Deep dive into this area →"**. The map
zooms to the area, outlines the catchment, and the panel lets you toggle the
**GP surgeries** layer — it loads the GPs whose location falls inside that LSOA
and shows the count.

## What's next (not built yet)

- Circular catchment for the draw-a-plot scenario (Turf buffer, client-side).
- More amenity loaders (pharmacies, schools, bus stops) — each copies
  `load_gps.py` and adds a row to `AMENITY_KINDS` in `app.js`.
- Crime via the data.police.uk polygon API (no storage needed).
- Walking isochrone catchment via the public Valhalla instance.
- The richer stats panel (densities, provision ratios, plain-English summary).
