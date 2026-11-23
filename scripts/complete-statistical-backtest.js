const baseUrl = String(process.env.BASE_URL || "").replace(/\/$/, "");
const token = String(process.env.PREDICTOR_ACCESS_TOKEN || "");
const leagueId = String(process.env.LEAGUE_ID || "l_0ALvwF");
const batchSize = Math.min(300, Math.max(1, Number(process.env.BACKTEST_BATCH_SIZE) || 100));
if (!baseUrl || !token) throw new Error("BASE_URL e PREDICTOR_ACCESS_TOKEN obbligatori.");
const headers = { Accept: "application/json", Authorization: `Bearer ${token}` };
const totals = new Map();
let offset = 0, batches = 0, matches = 0, statMatches = 0;

async function main() {
  while (true) {
    const url = new URL(`${baseUrl}/api/backtest/${encodeURIComponent(leagueId)}`);
    url.searchParams.set("limit", String(batchSize));
    url.searchParams.set("include_stats", "true");
    url.searchParams.set("stats_limit", String(batchSize));
    url.searchParams.set("offset", String(offset));
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(180000) });
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch { throw new Error(`Offset ${offset}: risposta non JSON HTTP ${response.status}: ${raw.slice(0,500)}`); }
    if (!response.ok || data.ok !== true) throw new Error(`Offset ${offset}: HTTP ${response.status}: ${data.error || raw.slice(0,500)}`);
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
    offset = Number(data.next_offset);
    if (!Number.isFinite(offset) || offset <= 0) throw new Error("Offset successivo non valido.");
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
  if (!matches) throw new Error("Nessuna partita valutata: verificare importazione e dati storici.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
