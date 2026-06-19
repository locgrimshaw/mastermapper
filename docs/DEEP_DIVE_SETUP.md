# Deep dive — setup (no command line needed)

The deep-dive feature shows amenity layers (GP surgeries first) inside an area
you pick. The IMD choropleth stays as it is; amenities live in a free Supabase
database and are loaded for you by a GitHub button — you never use a command
prompt.

There are four stages. Take them in order; each is just clicking and pasting.

---

## Stage 1 — Create the Supabase project

1. Go to **supabase.com**, sign in, and click **New project**.
2. Give it a name (e.g. `mastermapper`), choose a region near the UK (London if
   offered), and set a database password. **Write the password down** — you
   won't need it here, but it's a pain to reset later.
3. Wait a minute or two for it to finish setting up.

---

## Stage 2 — Build the database (paste one block of SQL)

1. In the Supabase dashboard, click **SQL Editor** in the left sidebar.
2. Click **New query**.
3. Open the file `supabase/migrations/0001_amenities.sql` from this repo, copy
   **all** of it, and paste it into the editor.
4. Click **Run** (bottom right).
5. You should see a success message. If you click **Table Editor** in the
   sidebar, an `amenities` table now exists.

That one script switches on the map/location features and creates everything
the website queries.

---

## Stage 3 — Connect the website to Supabase

You need two values from Supabase, then you paste them into one file.

### 3a. Find your keys

1. In Supabase, click the **gear / Project Settings** icon, then **API**.
2. Note these two (keep the tab open):
   - **Project URL** — looks like `https://abcd1234.supabase.co`
   - **anon public** key — a long string starting `eyJ...`
   - (You'll also see a **service_role** key. That one is secret — you'll use it
     in Stage 4, not here.)

### 3b. Put them in the website config (via GitHub's website)

1. In your GitHub repo, open the file **`web/config.js`** (click it in the file
   list).
2. Click the **pencil icon** (Edit this file).
3. Fill in the two values between the quotes:

   ```js
   window.MASTERMAPPER_CONFIG = {
     SUPABASE_URL: "https://abcd1234.supabase.co",
     SUPABASE_ANON_KEY: "eyJ...your anon public key...",
   };
   ```

4. Click **Commit changes**.

The anon key is *designed* to be public — your database only lets it read the
open amenity data, nothing else. (Until you do this, the map still works fully
for IMD and rail; only the deep-dive amenity layers are switched off, with a
small note in the panel.)

---

## Stage 4 — Load the GP data (two secrets, then one button)

The GP data is fetched and loaded by a GitHub Action, so you don't run anything
locally. First give GitHub the secret key, then press the button.

### 4a. Add the two secrets to GitHub

1. In your GitHub repo, go to **Settings** (top menu) > **Secrets and variables**
   > **Actions**.
2. Click **New repository secret** and add the first:
   - **Name:** `SUPABASE_URL`
   - **Secret:** your Project URL (same `https://abcd1234.supabase.co` as before)
3. Click **New repository secret** again and add the second:
   - **Name:** `SUPABASE_SERVICE_KEY`
   - **Secret:** the **service_role** key from Supabase (Project Settings > API).
     This one is secret — putting it in a GitHub Secret keeps it out of your
     code, which is exactly right.

### 4b. Run the loader

1. In your GitHub repo, go to the **Actions** tab.
2. In the left list, click **Load amenities into Supabase**.
3. Click **Run workflow** (right-hand side), leave the dataset as **gp**, and
   click the green **Run workflow** button.
4. Wait ~1–3 minutes. A green tick means it worked; click into the run to see
   how many GP practices it loaded.

If it fails complaining about missing secrets, re-check Stage 4a (the names must
be exactly `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`).

You only repeat Stage 4b to refresh the data later (the GP list changes slowly,
so every few months is plenty). Stages 1–3 are one-time.

---

## Stage 5 — Use it

1. Open your live map.
2. Click any zone, then press **"Deep dive into this area →"**.
3. The map zooms to that area and outlines it. In the panel, tick **GP
   surgeries** — the GPs inside that area appear on the map with a count.

---

## If something doesn't work

- **Panel says "Connect Supabase…"** → Stage 3 isn't done, or the values in
  `config.js` have a typo. They must be the **Project URL** and the **anon**
  key.
- **Loader button fails on "Missing secrets"** → Stage 4a; check the secret
  names exactly.
- **Loader fails downloading the NHS file** → the NHS occasionally moves the
  download location; let me know and I'll update the loader.
- **GPs don't appear but no error** → make sure the loader run finished with a
  green tick and reported a non-zero count, and that Stage 2's SQL ran without
  error.

## What's next (not built yet)

- Circular catchment for the "draw a plot" scenario.
- More amenity layers (pharmacies, schools, bus stops) — each adds one loader
  and one line in the app; you'll load them with the same button (new options
  in the dropdown).
- Crime hotspots, walking-distance (isochrone) catchments, and the richer stats
  panel.
