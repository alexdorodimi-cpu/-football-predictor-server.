-- Football Predictor AI: cursore persistente per il backfill statistiche.
-- Eseguire una sola volta nell'SQL Editor di Supabase.
alter table public.matches
add column if not exists statistics_sync_attempted_at timestamptz;

create index if not exists matches_statistics_sync_pending_idx
on public.matches (match_date, id)
where statistics_sync_attempted_at is null;
