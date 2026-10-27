-- Deliberately fail closed: no client Storage policies or media RPCs yet.
-- A private bucket is only a prerequisite; it does not enable chat media.
begin;
insert into storage.buckets (id, name, public) values
 ('findback-chat-media', 'findback-chat-media', false),
 ('findback-chat-moderation-evidence', 'findback-chat-moderation-evidence', false);
commit;
