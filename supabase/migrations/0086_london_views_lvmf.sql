-- 0086 · London View Management Framework (LVMF) protected vistas.
--
-- The LVMF (London Plan Policies HC3/HC4, LVMF SPG 2012 / digitised from the
-- 2010 coordinates) protects designated views of St Paul's, the Palace of
-- Westminster and the Tower. Each protected vista has up to three parts, loaded
-- from the GLA planning data map (layers 215, 216, 220) with
-- load_gla_planning_layer() from 0084:
--
--   gla_lvmf_corridor   Landmark Viewing Corridor — development above the
--                       corridor's threshold plane is refused (strongest)
--   gla_lvmf_wider      Wider Setting Consultation Area — either side of the
--                       corridor; proposals are assessed against the view
--   gla_lvmf_ext        background / extension area behind the landmark
--
-- The GLA data records WHERE each part lies, not its threshold height, so a
-- site inside one is height-sensitive rather than undevelopable.
--
-- London sites gain one flag per part plus the view's name, tagged by
-- tag_london_sites_lvmf() with the centre-or-10%-of-area rule used for SIL/MOL.

alter table public.london_sites add column if not exists lvmf_corridor boolean;
alter table public.london_sites add column if not exists lvmf_wider    boolean;
alter table public.london_sites add column if not exists lvmf_ext      boolean;
alter table public.london_sites add column if not exists lvmf_view     text;

create or replace function public.tag_london_sites_lvmf(p_from int default 0, p_to int default 2147483647)
returns int
language plpgsql
set search_path = public, extensions
set statement_timeout = '10min'
as $$
declare n int;
begin
  update london_sites s set
    lvmf_corridor = exists (select 1 from map_features m where m.dataset = 'gla_lvmf_corridor'
                            and m.geom && s.geom and london_site_covers(m.geom, s.geom, s.pt)),
    lvmf_wider = exists (select 1 from map_features m where m.dataset = 'gla_lvmf_wider'
                         and m.geom && s.geom and london_site_covers(m.geom, s.geom, s.pt)),
    lvmf_ext = exists (select 1 from map_features m where m.dataset = 'gla_lvmf_ext'
                       and m.geom && s.geom and london_site_covers(m.geom, s.geom, s.pt)),
    -- The most restrictive part's view names the site: corridor, then wider
    -- setting, then background.
    lvmf_view = (select m.name from map_features m
                 where m.dataset in ('gla_lvmf_corridor', 'gla_lvmf_wider', 'gla_lvmf_ext')
                   and m.geom && s.geom and london_site_covers(m.geom, s.geom, s.pt)
                 order by case m.dataset when 'gla_lvmf_corridor' then 0
                                         when 'gla_lvmf_wider' then 1 else 2 end
                 limit 1)
  where s.id between p_from and p_to;
  get diagnostics n = row_count;
  return n;
end $$;

revoke execute on function public.tag_london_sites_lvmf(int, int) from public, anon, authenticated;
grant execute on function public.tag_london_sites_lvmf(int, int) to service_role;

-- The sifter's read RPC, now carrying the LVMF flags.
drop function if exists public.london_sites_all();
create or replace function public.london_sites_all()
returns table (
  id int, src text, cat text, subtype text, name text, pdl boolean, area_ha real,
  lad_code text, borough text, lng real, lat real,
  ptal text, ptal_ai real, conn_pt real, conn_all real, conn_emp real,
  stn_name text, stn_m real, z1_min real, z1_via text,
  resi_rent real, resi_rent_2b real, office_submkt text, office_prime real, office_mid real,
  office_voa_pm2 real, office_n int, price_ppm2 real,
  price_trend real, rent_chg real, rent_g5 real, approval_pct real, plan_vs_lhn real,
  land_value real, cil real,
  in_caz boolean, in_devcorp boolean, in_oa boolean, oa_name text, in_sil boolean, in_mol boolean,
  in_lsis boolean, sinc_grade text, article4 boolean, conservation boolean, listed_n int,
  flood3 boolean, flood2 boolean, tpo boolean, aqma boolean, public_land boolean,
  lvmf_corridor boolean, lvmf_wider boolean, lvmf_ext boolean, lvmf_view text,
  storeys_site real, storeys_ctx real, dwellings_max int, permission text
)
language sql stable
set search_path = public, extensions
as $$
  select id, src, cat, subtype, name, pdl, area_ha, lad_code, borough,
         st_x(pt)::real, st_y(pt)::real,
         ptal, ptal_ai, conn_pt, conn_all, conn_emp, stn_name, stn_m, z1_min, z1_via,
         resi_rent, resi_rent_2b, office_submkt, office_prime, office_mid,
         office_voa_pm2, office_n, price_ppm2,
         price_trend, rent_chg, rent_g5, approval_pct, plan_vs_lhn, land_value, cil,
         in_caz, in_devcorp, in_oa, oa_name, in_sil, in_mol, in_lsis, sinc_grade, article4, conservation, listed_n,
         flood3, flood2, tpo, aqma, public_land,
         lvmf_corridor, lvmf_wider, lvmf_ext, lvmf_view,
         storeys_site, storeys_ctx, dwellings_max, permission
  from london_sites
$$;

grant execute on function public.london_sites_all() to anon, authenticated;
