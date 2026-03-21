alter table if exists public.users
  add column if not exists persona text;

update public.users
set persona = 'manager'
where persona is null
   or lower(trim(persona)) not in ('manager', 'employee');

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'users_persona_check'
  ) then
    alter table public.users
      add constraint users_persona_check
      check (persona in ('manager', 'employee'));
  end if;
end $$;

create index if not exists idx_users_persona
  on public.users(persona);
