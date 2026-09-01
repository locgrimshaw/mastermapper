// config.js — frontend configuration for MasterMapper.
//
// Fill in your Supabase project's URL and ANON (public) key below. These are
// safe to expose in a public site: the anon key only allows what your Row
// Level Security policies permit (here: read-only access to open amenity data).
// NEVER put the service_role key here — that one bypasses RLS and is for the
// loaders only (kept as a GitHub Action secret).
//
// Find these in the Supabase dashboard: Project Settings > API.
//   - Project URL  -> SUPABASE_URL
//   - anon public  -> SUPABASE_ANON_KEY
//
// If you leave these blank, the map still works fully for the IMD choropleth
// and rail overlay; only the deep-dive amenity layers (which need the database)
// are disabled, with a friendly note.

window.MASTERMAPPER_CONFIG = {
  SUPABASE_URL: "https://vwljbgyrsnnubrbjaxbc.supabase.co",       // e.g. "https://abcdefgh.supabase.co"
  SUPABASE_ANON_KEY: "sb_publishable_j55jzkpiaVPeAYii1RoCxA_RX1bt956",  // e.g. "eyJhbGciOi..."
  // Optional: absolute origin+path to load the data/ assets (tiles, stations,
  // green belt, breaks) from, e.g. "https://locgrimshaw.github.io/mastermapper/".
  // Leave empty for normal same-origin loading. Used by preview deployments of
  // the frontend so they don't need to ship ~130 MB of data files.
  DATA_BASE: "",

  // Site-wide viability defaults: every key here overrides the built-in
  // figure in VIAB_SCHEMA (web/src/app.js) as the value ALL users start
  // from — the sift, the deep-dive appraisal and site reports all read them.
  // Users can still tune variables locally; their own edits win on their
  // browser, but any field they never touched follows this block.
  //
  // Easiest workflow: open any station's "Viability variables…", tune the
  // numbers, press "Copy as site defaults", and paste the copied block here
  // (replacing this one). Keys are the schema keys, e.g.:
  //   VIABILITY_DEFAULTS: { profitTargetPct: 18, buildMonths: 30 },
  // Unknown keys and non-numeric values are ignored.
  VIABILITY_DEFAULTS: {},
};
