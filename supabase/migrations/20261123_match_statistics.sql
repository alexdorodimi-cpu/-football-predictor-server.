-- Archivio completo delle statistiche PitchAPI per ogni partita.
-- Il backend usa esclusivamente SUPABASE_SERVICE_ROLE_KEY.
create table if not exists public.match_statistics (
  match_id text primary key,
  league_id text,
  season text,
  match_date timestamptz,
  home_team text,
  away_team text,
  provider text not null default 'PitchAPI',
  raw_payload jsonb not null default '{}'::jsonb,
  normalized_stats jsonb not null default '{}'::jsonb,
  available_keys text[] not null default '{}',
  missing_keys text[] not null default '{}',
  fetched_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists match_statistics_league_date
  on public.match_statistics (league_id, match_date desc);

create index if not exists match_statistics_fetched_at
  on public.match_statistics (fetched_at desc);

alter table public.match_statistics enable row level security;
-- Nessuna policy anon/authenticated: accesso soltanto dal backend con service role.
