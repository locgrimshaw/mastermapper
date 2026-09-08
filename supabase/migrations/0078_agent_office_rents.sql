-- 0078_agent_office_rents.sql
--
-- Agent-published office rent benchmarks: prime / mid / secondary headline
-- rents (£/ft²/yr) by market — London at submarket level, regional centres
-- nationally — hand-curated each quarter from the agents' own public research
-- (Savills, Knight Frank, CBRE, Cushman & Wakefield, JLL, Avison Young,
-- Colliers, LSH, Carter Jonas, Bidwells, ...). Each zone carries EVERY
-- agent figure found plus the consensus average per tier, so the map card can
-- show both the number and who said it. This is the "what agents are quoting
-- today" complement to the voa_offices statutory evidence (which is
-- comprehensive but AVD-dated). Source of truth: data/agent_office_rents.json
-- in the repo; refresh = re-curate the JSON, push, re-run the loader
-- (docs/MANUAL_TASKS.md).
--
-- JSON shape per zone:
--   { "zone": "Mayfair & St James's", "lng": -0.146, "lat": 51.509,
--     "region": "London — West End",
--     "prime": { "avg": 152.5, "vals": [{"a":"Savills","v":160,"p":"Jun 2026"}, ...] },
--     "mid":   { ... }, "low": { ... } }        -- any tier may be absent

create or replace function public.load_agent_office_rents(p_url text)
returns integer language plpgsql as $$
declare resp text; n integer;
begin
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '60000');
  select content into resp from extensions.http_get(p_url);
  delete from public.map_features where dataset = 'agent_office_rents';
  insert into public.map_features (dataset, source_id, name, props, geom)
  select 'agent_office_rents',
         lower(regexp_replace(r->>'zone', '[^A-Za-z0-9]+', '-', 'g')),
         r->>'zone',
         (r - 'zone' - 'lng' - 'lat')
           || jsonb_build_object('prime_avg', r->'prime'->'avg'),
         st_setsrid(st_makepoint((r->>'lng')::double precision,
                                 (r->>'lat')::double precision), 4326)
    from jsonb_array_elements(resp::jsonb) r
   where r->>'lng' is not null and r->>'lat' is not null
  on conflict (dataset, source_id) do update
    set name = excluded.name, props = excluded.props, geom = excluded.geom;
  get diagnostics n = row_count;
  analyze public.map_features;
  return n;
end $$;
revoke execute on function public.load_agent_office_rents(text)
  from public, anon, authenticated;
