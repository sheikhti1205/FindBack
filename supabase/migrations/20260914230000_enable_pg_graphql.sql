-- FindBack — enable the Supabase GraphQL API (Block 10I).
--
-- Exposes pg_graphql at /graphql/v1. Auth/RLS are unchanged: PostgREST resolves
-- each request as the JWT role, so GraphQL types are filtered by column grants
-- (safe public profile columns only) and rows by the existing RLS policies.
create extension if not exists pg_graphql with schema graphql;
