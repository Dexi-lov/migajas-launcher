create table if not exists public.migajas_profiles (
    uuid text primary key check (uuid ~ '^[0-9a-f]{32}$'),
    username text not null,
    updated_at timestamptz not null default now()
);

create index if not exists migajas_profiles_username_idx
    on public.migajas_profiles (lower(username));

create table if not exists public.migajas_friendships (
    id bigint generated always as identity primary key,
    requester_uuid text not null references public.migajas_profiles(uuid) on delete cascade,
    addressee_uuid text not null references public.migajas_profiles(uuid) on delete cascade,
    status text not null check (status in ('pending', 'accepted')) default 'pending',
    created_at timestamptz not null default now(),
    constraint migajas_friendships_no_self check (requester_uuid <> addressee_uuid),
    constraint migajas_friendships_unique unique (requester_uuid, addressee_uuid)
);

create index if not exists migajas_friendships_addressee_idx
    on public.migajas_friendships (addressee_uuid, status);

create table if not exists public.migajas_presence (
    uuid text primary key references public.migajas_profiles(uuid) on delete cascade,
    mode text not null check (mode in ('active', 'playing')) default 'active',
    instance_id text,
    updated_at timestamptz not null default now()
);

alter table public.migajas_profiles enable row level security;
alter table public.migajas_friendships enable row level security;
alter table public.migajas_presence enable row level security;

revoke all on public.migajas_profiles from anon, authenticated;
revoke all on public.migajas_friendships from anon, authenticated;
revoke all on public.migajas_presence from anon, authenticated;

grant all on public.migajas_profiles to service_role;
grant all on public.migajas_friendships to service_role;
grant all on public.migajas_presence to service_role;
grant usage, select on sequence public.migajas_friendships_id_seq to service_role;
