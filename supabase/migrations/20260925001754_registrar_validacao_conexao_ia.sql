-- A saved API key is not proof that the provider/model can answer requests.
-- Keep validation metadata server-side; the connection table has no browser grants.
alter table public.personal_ai_connections
  add column if not exists validated_at timestamptz,
  add column if not exists validated_model text;
