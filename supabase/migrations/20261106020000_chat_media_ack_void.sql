-- Fix forward: device admission accidentally changed the canonical void ACK
-- to integer. Successful legacy ACKs then failed casting void's empty result,
-- rolling back the receipt and leaving every delivery retry unsuccessful.
begin;

-- PostgreSQL cannot change a return type with CREATE OR REPLACE. No CASCADE:
-- unexpected dependencies must stop deployment, never be silently removed.
drop function public.findback_ack_chat_media_delivery(text,text,text);
create function public.findback_ack_chat_media_delivery(
 p_account_id text,p_device_id text,p_attachment_id text)
returns void language plpgsql volatile security definer set search_path=public,pg_temp as $$
begin
 perform public.findback_device_admission(p_device_id);
 perform public.findback_ack_chat_media_delivery_authority_legacy_internal(p_account_id,p_device_id,p_attachment_id);
 return;
end $$;
revoke all on function public.findback_ack_chat_media_delivery(text,text,text)
 from public,anon,authenticated,service_role;
grant execute on function public.findback_ack_chat_media_delivery(text,text,text) to authenticated;

notify pgrst,'reload schema';
commit;
