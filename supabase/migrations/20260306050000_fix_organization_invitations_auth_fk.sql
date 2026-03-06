do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'organization_invitations'
      and column_name = 'invited_by_auth_user_id'
  ) then
    execute 'alter table public.organization_invitations alter column invited_by_auth_user_id drop not null';
    execute 'alter table public.organization_invitations drop constraint if exists organization_invitations_invited_by_auth_user_id_fkey';
    execute $sql$
      alter table public.organization_invitations
      add constraint organization_invitations_invited_by_auth_user_id_fkey
      foreign key (invited_by_auth_user_id)
      references auth.users(id)
      on delete set null
    $sql$;
  end if;
end
$$;
