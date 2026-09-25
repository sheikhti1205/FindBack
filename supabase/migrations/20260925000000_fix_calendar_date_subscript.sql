-- FindBack — fix report publishing: invalid text subscripting in the date helper.
--
-- 20260919000000_validation_alignment.sql defined
-- public.findback_is_valid_calendar_date with Python-style slicing:
--
--   v_year  := p_date[1:4]::int;
--   v_month := p_date[6:7]::int;
--   v_day   := p_date[9:10]::int;
--
-- PostgreSQL text values are not subscriptable, so the helper raised
--   42804  cannot subscript type text because it does not support subscripting
-- at runtime (the body is only parsed when executed, which is why the original
-- migration applied cleanly). The helper is called by
-- public.findback_validate_post_fields, which both findback_create_post_client
-- and findback_update_post_client call, so every publish/update carrying a date
-- failed with that database error.
--
-- Forward-only correction: replace the helper using substring() + make_date().
-- The strict YYYY-MM-DD shape check and the calendar check (make_date rejects
-- impossible dates such as 2025-02-29) are preserved. The historical migration
-- is intentionally left untouched; this file is the single authoritative
-- definition of the helper from here on.

create or replace function public.findback_is_valid_calendar_date(
  p_date text
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if p_date is null
     or p_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  then
    return false;
  end if;

  begin
    perform make_date(
      substring(p_date from 1 for 4)::int,
      substring(p_date from 6 for 2)::int,
      substring(p_date from 9 for 2)::int
    );
    -- make_date raises on an impossible day/month; reaching here means valid.
    return true;
  exception when others then
    return false;
  end;
end;
$$;

comment on function public.findback_is_valid_calendar_date(text) is
  'FindBack: strict YYYY-MM-DD shape + real calendar date check. Fixed 2026-09-25 (substring/make_date); never reintroduce text subscripting.';
