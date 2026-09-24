begin;

-- Historical intermediate hardening for the shared-goal preview and opening
-- balance. The immediately following migration further restricts writes and
-- finalizes the RPC privilege model.
revoke select on table public.shared_goals from authenticated;
grant select (id, name, target_cents, target_date, created_at)
  on table public.shared_goals to authenticated;

insert into public.shared_goal_contributions (
  shared_goal_id, user_id, amount_cents, note, contributed_at
)
select goal.id, goal.owner_id, goal.initial_cents, 'Saldo ao compartilhar', goal.created_at
from public.shared_goals as goal
where goal.initial_cents > 0
  and not exists (
    select 1 from public.shared_goal_contributions as contribution
    where contribution.shared_goal_id = goal.id
      and contribution.user_id = goal.owner_id
      and contribution.note = 'Saldo ao compartilhar'
  );

commit;
