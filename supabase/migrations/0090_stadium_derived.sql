-- 0090 · stadium_metrics: network catchments, matchday economics and indices.
--
-- New raw columns are written by pipeline/build_stadium_catchments.py:
--   reach_pt30 / reach_pt45   people within 30 / 45 min by public transport,
--                             leaving the ground 17:00 Saturday (BODS + rail)
--   pt45_stops / pt45_stations  stops and rail stations reached in 45 min
--   pop_800 / 1500 / 3000      now from the Meta 30 m population grid, so all
--                              four nations share one source
--
-- derive_stadium_metrics() then fills the modelled columns. Every assumption
-- is in this file and repeated, editable, on the UK Stadium Analysis page:
--   tier         highest competition a ground's clubs play in (men's first)
--   matchdays    home fixtures a year for that tier (league + typical cups)
--   fill_rate    average attendance / capacity for the tier
--   annual_visits = capacity × fill_rate × matchdays
--   surge_ratio  matchday crowd ÷ everyday people within 800 m
--                (residents + workers): how much the place changes on a matchday
--   idle_days    365 − matchdays
--   beds_per_100 hotel bed spaces within 5 km per 100 seats
--   pt_share     reach_pt45 ÷ reach_drive20: how much of the car catchment
--                public transport also reaches
-- Indices (0-100, percentile rank among grounds with ≥ 1,000 seats):
--   regen_index   land within 800 m (regen_ha), deprivation, PT reach, low
--                 local prices — where a ground could anchor regeneration
--   social_index  deprivation, people within a 15-min walk, schools and
--                 sports facilities nearby — community reach
--   visitor_index hotel beds per seat, venues, food & drink, rail usage
--   anchor_index  mean of the three

alter table public.stadium_metrics
  add column if not exists reach_pt30 int,
  add column if not exists pt45_stops int,
  add column if not exists pt45_stations int,
  add column if not exists tier text,
  add column if not exists matchdays int,
  add column if not exists fill_rate numeric,
  add column if not exists annual_visits int,
  add column if not exists surge_ratio numeric,
  add column if not exists idle_days int,
  add column if not exists beds_per_100 numeric,
  add column if not exists pt_share numeric,
  add column if not exists regen_index numeric,
  add column if not exists social_index numeric,
  add column if not exists visitor_index numeric,
  add column if not exists anchor_index numeric;

-- tier → (rank, matchdays, fill rate)
create table if not exists public.stadium_tiers (
  tier text primary key, rank int, matchdays int, fill_rate numeric, note text);
alter table public.stadium_tiers enable row level security;
do $p$ begin
  create policy stadium_tiers_read on public.stadium_tiers for select using (true);
exception when duplicate_object then null; end $p$;
grant select on public.stadium_tiers to anon, authenticated;

insert into public.stadium_tiers (tier, rank, matchdays, fill_rate, note) values
  ('Premier League',        1, 25, 0.96, '19 league + cups/Europe; Premier League average ~96% full'),
  ('EFL Championship',      2, 26, 0.72, '23 league + cups'),
  ('EFL League One',        3, 26, 0.62, '23 league + cups'),
  ('EFL League Two',        4, 26, 0.55, '23 league + cups'),
  ('National League',       5, 25, 0.45, '23 league + cups; National League North/South included'),
  ('Scottish Premiership',  2, 24, 0.70, '19 league + cups/Europe'),
  ('Scottish lower leagues',6, 22, 0.35, 'SPFL Championship and below'),
  ('Cymru / NIFL Premier',  6, 20, 0.30, 'Cymru Premier, NIFL Premiership'),
  ('Women''s Super League', 4, 13, 0.35, '11 league + cups; grounds often shared'),
  ('Premiership Rugby',     2, 12, 0.78, '9 league + Europe'),
  ('United Rugby Championship', 2, 12, 0.65, '9 league + Europe'),
  ('Super League',          2, 15, 0.60, '13-14 league + Challenge Cup'),
  ('RFL Championship / League 1', 5, 14, 0.40, ''),
  ('Rugby (other)',         6, 12, 0.30, ''),
  ('Cricket',               3, 30, 0.45, 'county + international match days'),
  ('Greyhound racing',      6, 100, 0.20, 'two meetings a week'),
  ('Speedway',              6, 20, 0.30, ''),
  ('Non-league / other',    7, 21, 0.30, 'lower non-league, other sports')
on conflict (tier) do update set rank = excluded.rank, matchdays = excluded.matchdays,
  fill_rate = excluded.fill_rate, note = excluded.note;

create or replace function public.derive_stadium_metrics()
returns int language plpgsql
set search_path = public, extensions
as $$
declare n int;
begin
  update stadium_metrics s set tier = case
    when s.league ~ '(^|, )Premier League(,|$)' then 'Premier League'
    when s.league ~ 'EFL Championship' then 'EFL Championship'
    when s.league ~ 'EFL League One' then 'EFL League One'
    when s.league ~ 'EFL League Two' then 'EFL League Two'
    when s.league ~ 'Scottish Premiership(,|$)|Scottish Premier League' then 'Scottish Premiership'
    when s.league ~ 'Premiership Rugby' then 'Premiership Rugby'
    when s.league ~ 'United Rugby Championship' then 'United Rugby Championship'
    when s.league ~ '(^|, )Super League(,|$)' then 'Super League'
    when s.league ~ '(^|, )National League' then 'National League'
    when s.league ~ 'RFL ' then 'RFL Championship / League 1'
    when s.league ~ 'Scottish (Professional|Championship|League)' then 'Scottish lower leagues'
    when s.league ~ 'Cymru Premier|NIFL Premiership' then 'Cymru / NIFL Premier'
    when s.league ~ 'Women''s Super League' then 'Women''s Super League'
    when s.sport = 'Cricket' then 'Cricket'
    when s.sport in ('Greyhound racing', 'Dog racing') then 'Greyhound racing'
    when s.sport ~ 'peedway' then 'Speedway'
    when s.sport ~ '^Rugby' then 'Rugby (other)'
    else 'Non-league / other' end;

  update stadium_metrics s set
    matchdays = t.matchdays, fill_rate = t.fill_rate,
    annual_visits = round(s.capacity * t.fill_rate * t.matchdays),
    idle_days = 365 - t.matchdays,
    surge_ratio = round(s.capacity * t.fill_rate / nullif(coalesce(s.pop_800, 0) + coalesce(s.jobs_800, 0), 0), 2),
    beds_per_100 = round(100.0 * s.beds_5k / nullif(s.capacity, 0), 1),
    pt_share = round(s.reach_pt45::numeric / nullif(s.reach_drive20, 0), 3)
  from stadium_tiers t where t.tier = s.tier;

  with b as (
    select source_id,
      percent_rank() over (order by coalesce(regen_ha, 0)) r_land,
      percent_rank() over (order by coalesce(imd_1500, 50)) r_imd,
      percent_rank() over (order by coalesce(reach_pt45, 0)) r_pt,
      percent_rank() over (order by coalesce(ppm2_1500, 99999) desc) r_cheap,
      percent_rank() over (order by coalesce(reach_walk15, 0)) r_walk,
      percent_rank() over (order by coalesce(schools_1500, 0)) r_sch,
      percent_rank() over (order by coalesce(sport_fac_1500, 0)) r_fac,
      percent_rank() over (order by coalesce(beds_per_100, 0)) r_beds,
      percent_rank() over (order by coalesce(venue_cap_3k, 0)) r_ven,
      percent_rank() over (order by coalesce(food_800, 0)) r_food,
      percent_rank() over (order by coalesce(station_usage_1k, 0)) r_rail
    from stadium_metrics where capacity >= 1000
  ), i as (
    select source_id,
      round(100 * (0.4 * r_land + 0.25 * r_imd + 0.2 * r_pt + 0.15 * r_cheap)::numeric, 1) regen,
      round(100 * (0.35 * r_imd + 0.35 * r_walk + 0.15 * r_sch + 0.15 * r_fac)::numeric, 1) social,
      round(100 * (0.35 * r_beds + 0.25 * r_ven + 0.2 * r_food + 0.2 * r_rail)::numeric, 1) visitor
    from b
  )
  update stadium_metrics s set regen_index = i.regen, social_index = i.social,
    visitor_index = i.visitor, anchor_index = round((i.regen + i.social + i.visitor) / 3, 1)
  from i where i.source_id = s.source_id;

  get diagnostics n = row_count;
  return n;
end $$;

-- Typology now uses Meta-grid densities, so it works in all four nations.
create or replace function public.classify_stadia()
returns int language sql
set search_path = public, extensions
as $$
  with t as (
    update stadium_metrics set typology = case
      when other_stadia_600 > 0 and pitch_ha_1500 > 15 then 'Sports campus'
      when station_usage_1k > 5000000 or (coalesce(jobs_800, 0) > 15000 and food_800 > 80)
           or (food_800 > 150 and coalesce(dens_1500, 0) >= 3000) then 'City centre'
      when parking_ha > 6 and lowvalue_ha > 12 and coalesce(dens_1500, 0) < 3500 then 'Out-of-town / retail park'
      when coalesce(dens_1500, 0) >= 5000 then 'Inner-urban neighbourhood'
      when coalesce(dens_1500, 0) >= 2000 then 'Suburban'
      else 'Edge of town / rural' end
    returning 1)
  select count(*)::int from t;
$$;

revoke execute on function public.derive_stadium_metrics() from public, anon, authenticated;
revoke execute on function public.classify_stadia() from public, anon, authenticated;
-- The refresh workflow calls these over REST with the service key.
grant execute on function public.derive_stadium_metrics() to service_role;
grant execute on function public.classify_stadia() to service_role;
grant execute on function public.rebuild_stadium_metrics(int, int) to service_role;
grant execute on function public.set_stadium_reach() to service_role;
