begin;

-- Serialize an approval with an administrator/user revoking this optional
-- capability. The locked connection row makes the approval and revocation
-- have a clear order; if revocation commits first, the RPC cannot proceed.
do $migration$
declare
  function_definition text;
  serialized_definition text;
begin
  select pg_catalog.pg_get_functiondef(
    'public.confirm_personal_ai_transaction(uuid,uuid)'::pg_catalog.regprocedure
  ) into function_definition;

  if function_definition is null
    or pg_catalog.strpos(function_definition, 'where connection.user_id = v_user_id;') = 0 then
    raise exception 'The approved-action function definition does not match the expected migration version.';
  end if;

  serialized_definition := pg_catalog.replace(
    function_definition,
    'where connection.user_id = v_user_id;',
    'where connection.user_id = v_user_id' || E'\n  for update;'
  );
  execute serialized_definition;
end;
$migration$;

commit;
