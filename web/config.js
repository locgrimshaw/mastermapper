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
};
