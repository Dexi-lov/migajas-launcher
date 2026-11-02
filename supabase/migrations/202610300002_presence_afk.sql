alter table public.migajas_presence
    drop constraint if exists migajas_presence_mode_check;

alter table public.migajas_presence
    add constraint migajas_presence_mode_check
    check (mode in ('active', 'playing', 'afk'));
