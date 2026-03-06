create table if not exists public.restaurant_locations (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  is_active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists restaurant_locations_restaurant_idx
  on public.restaurant_locations (restaurant_id);

create index if not exists restaurant_locations_restaurant_sort_idx
  on public.restaurant_locations (restaurant_id, sort_order, name);

create unique index if not exists restaurant_locations_restaurant_name_active_uq
  on public.restaurant_locations (restaurant_id, lower(name))
  where is_active = true;

create or replace function public.set_restaurant_locations_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_restaurant_locations_updated_at on public.restaurant_locations;
create trigger trg_restaurant_locations_updated_at
before update on public.restaurant_locations
for each row
execute function public.set_restaurant_locations_updated_at();

alter table if exists public.restaurant_locations enable row level security;

drop policy if exists restaurant_locations_select on public.restaurant_locations;
create policy restaurant_locations_select on public.restaurant_locations
  for select
  using (
    restaurant_locations.is_active = true
    and public.is_org_member(restaurant_locations.restaurant_id)
  );

drop policy if exists restaurant_locations_write on public.restaurant_locations;
create policy restaurant_locations_write on public.restaurant_locations
  for all
  using (public.is_org_manager(restaurant_locations.restaurant_id))
  with check (public.is_org_manager(restaurant_locations.restaurant_id));

insert into public.restaurant_locations (
  id,
  restaurant_id,
  name,
  is_active,
  sort_order,
  created_at,
  updated_at
)
select
  l.id,
  l.organization_id,
  l.name,
  true,
  coalesce(l.sort_order, 0),
  coalesce(l.created_at, now()),
  now()
from public.locations l
where l.organization_id is not null
  and l.name is not null
  and not exists (
    select 1 from public.restaurant_locations rl where rl.id = l.id
  );

create or replace function public.sync_restaurant_locations_from_locations()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    update public.restaurant_locations
    set is_active = false,
        updated_at = now()
    where id = old.id;
    return old;
  end if;

  insert into public.restaurant_locations (
    id,
    restaurant_id,
    name,
    is_active,
    sort_order,
    created_at,
    updated_at
  )
  values (
    new.id,
    new.organization_id,
    new.name,
    true,
    coalesce(new.sort_order, 0),
    coalesce(new.created_at, now()),
    now()
  )
  on conflict (id) do update
    set restaurant_id = excluded.restaurant_id,
        name = excluded.name,
        is_active = true,
        sort_order = excluded.sort_order,
        updated_at = now();

  return new;
end;
$$;

drop trigger if exists trg_sync_restaurant_locations_from_locations_insupd on public.locations;
create trigger trg_sync_restaurant_locations_from_locations_insupd
after insert or update on public.locations
for each row
execute function public.sync_restaurant_locations_from_locations();

drop trigger if exists trg_sync_restaurant_locations_from_locations_del on public.locations;
create trigger trg_sync_restaurant_locations_from_locations_del
after delete on public.locations
for each row
execute function public.sync_restaurant_locations_from_locations();
