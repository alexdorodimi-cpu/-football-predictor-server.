-- Checkpoint persistente per la riparazione dei nomi campionato.
create table if not exists public.data_repair_jobs (
  job_key text primary key,
  status text not null default 'idle',
  started_at timestamptz,
  finished_at timestamptz,
  error text,
  scanned bigint not null default 0,
  rows_updated bigint not null default 0,
  unchanged bigint not null default 0,
  missing_names bigint not null default 0,
  conflicting_names bigint not null default 0,
  unmapped_league_ids bigint not null default 0,
  cursor text,
  total_batches integer not null default 0,
  batch_size integer not null default 1000,
  updated_at timestamptz not null default now()
);

alter table public.data_repair_jobs enable row level security;
revoke all on table public.data_repair_jobs from anon, authenticated;
grant all on table public.data_repair_jobs to service_role;
