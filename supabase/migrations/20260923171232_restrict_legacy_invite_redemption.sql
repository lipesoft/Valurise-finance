-- Invitations are now claimed during the server-validated signup flow.
-- The old authenticated RPC must not allow an account to consume an unrelated
-- invite after it has already been created.
revoke all on function public.redeem_access_invite(uuid) from public, anon, authenticated;
