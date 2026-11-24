const baseUrl = String(process.env.BASE_URL || "").replace(/\/$/, "");
const token = String(process.env.PREDICTOR_ACCESS_TOKEN || "");
const leagueId = String(process.env.LEAGUE_ID || "l_0ALvwF");
// Batch piccoli: il calcolo statistico interroga Supabase per ogni partita.
const batchSize = Math.min(50, Math.max(1, Number(process.env.BACKTEST_BATCH_SIZE) || 10));
const maxRetries = Math.min(8, Math.max(1, Number(process.env.BACKTEST_MAX_RETRIES) || 6));
const requestTimeoutMs = Math.min(180000, Math.max(30000, Number(process.env.BACKTEST_TIMEOUT_MS) || 120000));
if (!baseUrl || !token) throw new Error("BASE_URL e PREDICTOR_ACCESS_TOKEN obbligatori.");
const headers = { Accept: "application/json", Authorization: `Bearer ${token}` };
const totals = new Map();
let offset = Math.max(0, Number.parseInt(process.env.START_OFFSET || "0", 10) || 0);
let batches = 0, matches = 0, statMatches = 0;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchBatch(url, batchOffset) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(requestTimeoutMs) });
      const raw = await response.text();
      let data = null;
      try { data = JSON.parse(raw); } catch {}
      if (response.ok && data?.ok === true) return data;

      const retryable = [408, 425, 429, 500, 502, 503, 504].includes(response.status);
      const detail = data?.error || raw.slice(0, 350) || "risposta vuota";
      lastError = new Error(`HTTP ${response.status}: ${detail}`);
      if (!retryable) throw new Error(`Offset ${batchOffset}: ${lastError.message}`);
    } catch (error) {
      lastError = error;
      const message = String(error?.message || error);
      const retryable = /timeout|timed out|fetch failed|HTTP (408|425|429|500|502|503|504)/i.test(message);
      if (!retryable) throw new Error(`Offset ${batchOffset}: ${message}`);
    }
    if (attempt < maxRetries) {
      const delay = Math.min(30000, 3000 * (2 ** (attempt - 1)));
      console.warn(JSON.stringify({ warning: "backtest_retry", offset: batchOffset, attempt, max_retries: maxRetries, wait_ms: delay, error: String(lastError?.message || lastError) }));
      await sleep(delay);
    }
  }
  throw new Error(`Offset ${batchOffset}: esauriti ${maxRetries} tentativi. Ultimo errore: ${String(lastError?.message || lastError)}`);
}

async function main() {
  while (true) {
    const url = new URL(`${baseUrl}/api/backtest/${encodeURIComponent(leagueId)}`);
    url.searchParams.set("limit", String(batchSize));
    url.searchParams.set("include_stats", "true");
    url.searchParams.set("stats_limit", String(batchSize));
    url.searchParams.set("offset", String(offset));
    const data = await fetchBatch(url, offset);
    batches++;
    matches += Number(data.evaluated_matches || 0);
    statMatches += Number(data.statistical_backtest?.evaluated_matches || 0);
    for (const [market, metric] of Object.entries(data.statistical_accuracy_by_market || {})) {
      const row = totals.get(market) || { evaluated: 0, correct: 0, brierSum: 0 };
      row.evaluated += Number(metric.evaluated || 0);
      row.correct += Number(metric.correct || 0);
      row.brierSum += Number(metric.brier_score || 0) * Number(metric.evaluated || 0);
      totals.set(market, row);
    }
    console.log(JSON.stringify({
      batch: batches, offset, selected: data.evaluation_matches_selected,
      evaluated_matches: data.evaluated_matches,
      statistical_matches: data.statistical_backtest?.evaluated_matches,
      done: data.done, next_offset: data.next_offset
    }));
    if (data.done || !data.evaluation_matches_selected) break;
    const nextOffset = Number(data.next_offset);
    if (!Number.isFinite(nextOffset) || nextOffset <= offset) {
      throw new Error(`Offset successivo non valido: ${data.next_offset}`);
    }
    offset = nextOffset;
  }

  const markets = Object.fromEntries([...totals.entries()].map(([name, row]) => [name, {
    evaluated: row.evaluated,
    correct: row.correct,
    accuracy_percent: row.evaluated ? Number((row.correct / row.evaluated * 100).toFixed(2)) : null,
    brier_score: row.evaluated ? Number((row.brierSum / row.evaluated).toFixed(4)) : null
  }]));
  console.log(JSON.stringify({
    summary: true, league_id: leagueId, batches, evaluated_matches: matches,
    matches_with_actual_statistics: statMatches, statistical_markets: markets,
    completed_at: new Date().toISOString()
  }, null, 2));
  if (!matches || !statMatches) throw new Error("Backtest incompleto: nessuna partita statistica valutata.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
