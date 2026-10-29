-- DISPOSABLE LOCAL ONLY: faithfully model observed Supabase platform defaults.
-- Explicit private-delegate revokes must remain stronger than default grants.
begin;
do $$
declare signature text;
begin
  foreach signature in array array[
    'public.findback_my_matches(text,timestamptz,text,integer)',
    'public.findback_propose_match(text,text)',
    'public.findback_confirm_match(text)',
    'public.findback_cancel_match(text)',
    'public.findback_handover_match(text)',
    'public.findback_rate_return(text,integer)'
  ] loop
    if not has_function_privilege('service_role',signature,'EXECUTE') then
      raise exception 'Local harness missing observed platform service grant: %',signature;
    end if;
    if has_function_privilege('anon',signature,'EXECUTE') then
      raise exception 'Anonymous execution granted by platform defaults: %',signature;
    end if;
  end loop;
  foreach signature in array array[
    'public.findback_propose_match_admission(text,text)',
    'public.findback_confirm_match_admission(text)',
    'public.findback_retain_match_references()',
    'public.findback_prepare_report_deletion()'
  ] loop
    if has_function_privilege('service_role',signature,'EXECUTE')
       or has_function_privilege('authenticated',signature,'EXECUTE')
       or has_function_privilege('anon',signature,'EXECUTE') then
      raise exception 'Platform default overrides explicit private revoke: %',signature;
    end if;
  end loop;
end $$;
select 'PASS observed platform defaults and explicit private-delegate revokes' as result;
rollback;
