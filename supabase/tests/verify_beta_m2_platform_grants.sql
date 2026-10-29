-- Disposable-local only: verify actual observed hosted default ACL semantics.
begin;
create table public.findback_beta_m2_grant_probe(id bigint);
create sequence public.findback_beta_m2_sequence_probe;
do $$
declare actor text;
begin
  foreach actor in array array['anon','authenticated','service_role'] loop
    if not has_table_privilege(actor,'public.findback_beta_m2_grant_probe','SELECT')
      or not has_table_privilege(actor,'public.findback_beta_m2_grant_probe','INSERT')
      or not has_table_privilege(actor,'public.findback_beta_m2_grant_probe','UPDATE')
      or not has_table_privilege(actor,'public.findback_beta_m2_grant_probe','DELETE') then
      raise exception 'Hosted default table grants not represented for %',actor;
    end if;
    if not has_sequence_privilege(actor,'public.findback_beta_m2_sequence_probe','USAGE')
      or not has_sequence_privilege(actor,'public.findback_beta_m2_sequence_probe','SELECT')
      or not has_sequence_privilege(actor,'public.findback_beta_m2_sequence_probe','UPDATE') then
      raise exception 'Hosted default sequence grants not represented for %',actor;
    end if;
  end loop;
  -- RPC-only chat tables must remain closed despite those broad platform defaults.
  if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname like 'chat_%' and c.relkind='r'
      and (has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE')
        or has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE'))) then
    raise exception 'Direct consumer chat table grant';
  end if;
end $$;
select true as platform_table_sequence_defaults_and_chat_revokes;
rollback;
