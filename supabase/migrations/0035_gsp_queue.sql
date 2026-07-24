-- 0035_gsp_queue.sql
-- The connection-queue-by-GSP heatmap: every TEC-register project is summed
-- into the Grid Supply Point boundary that contains it, stamping each GSP
-- polygon with queued_mw / queued_n. One number answers the data-centre
-- developer's first grid question — "how contested is this supply point?".
-- Re-run after every TEC refresh (the datasets workflow calls it).

create or replace function public.rebuild_gsp_queue()
returns integer language plpgsql volatile as $function$
declare n integer;
begin
  update public.map_features g
     set props = g.props || jsonb_build_object(
       'queued_mw', q.mw, 'queued_n', q.n)
    from (
      select gb.source_id,
             round(sum((t.props->>'mw')::numeric))::bigint as mw,
             count(*) as n
      from public.map_features gb
      join public.map_features t
        on t.dataset = 'tec_register'
       and (t.props->>'mw') ~ '^[0-9.]+$'
       and gb.geom && t.geom and st_intersects(gb.geom, t.geom)
      where gb.dataset = 'gsp_boundary'
      group by gb.source_id
    ) q
   where g.dataset = 'gsp_boundary' and g.source_id = q.source_id;
  get diagnostics n = row_count;
  return n;
end $function$;
revoke execute on function public.rebuild_gsp_queue() from public, anon, authenticated;
grant execute on function public.rebuild_gsp_queue() to service_role;
