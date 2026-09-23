-- Remove broad anon access from the exposed schema. Browser clients use only
-- Supabase Auth while signed out; financial APIs require an authenticated
-- session and are constrained by the existing RLS policies.
begin;

revoke all privileges on all tables in schema public from anon;
revoke all privileges on all sequences in schema public from anon;
revoke execute on all functions in schema public from anon;

-- New objects must opt in to Data API access with explicit grants after RLS
-- has been designed. This preserves existing authenticated grants while
-- preventing future tables/functions from inheriting broad default access.
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated, public;

commit;
