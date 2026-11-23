-- Football Predictor AI: versioned model configurations
create table if not exists public.model_config (
  id bigserial primary key,
  league_id text not null,
  season text not null,
  version integer not null,
  config jsonb not null,
  metrics jsonb not null default '{}'::jsonb,
  active boolean not null default false,
  created_at timestamptz not null default now(),
  unique (league_id, season, version)
);

create index if not exists model_config_active_lookup
  on public.model_config (league_id, season, active);

create table if not exists public.model_config_history (
  id bigserial primary key,
  league_id text not null,
  season text not null,
  event text not null check (event in ('candidate_saved','activated','rollback')),
  version integer,
  config jsonb not null,
  metrics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.model_config enable row level security;
alter table public.model_config_history enable row level security;

-- Accesso esclusivamente dal backend tramite SUPABASE_SERVICE_ROLE_KEY.
-- Non creare policy anon/authenticated per queste tabelle.
