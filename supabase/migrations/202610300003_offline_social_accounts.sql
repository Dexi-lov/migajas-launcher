alter table public.migajas_profiles
    add column if not exists is_verified boolean not null default true;
