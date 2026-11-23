const fs = require("node:fs");

const baseUrl = String(process.env.BASE_URL || "").replace(/\/$/, "");
const leagueId = process.env.LEAGUE_ID || "l_0ALvwF";
const season = process.env.SEASON || "2026/2027";
const limit = Math.min(Math.max(Number(process.env.BACKTEST_LIMIT) || 300, 1), 300);
const targetAccuracy = Number(process.env.TARGET_ACCURACY || 60);
const minimumEvaluated = Number(process.env.MIN_EVALUATED || 30);

if (!baseUrl) {
  throw new Error("BASE_URL non configurato.");
}

async function main() {
  const url = new URL(`${baseUrl}/api/backtest/${encodeURIComponent(leagueId)}`);
  url.searchParams.set("season", season);
  url.searchParams.set("limit", String(limit));

  const headers = { Accept: "application/json" };
  if (process.env.PREDICTOR_ACCESS_TOKEN) {
    headers.Authorization = `Bearer ${process.env.PREDICTOR_ACCESS_TOKEN}`;
  }

  const response = await fetch(url, { headers, signal: AbortSignal.timeout(120000) });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Backtest HTTP ${response.status}: ${body.slice(0, 1200)}`);
  }

  const data = JSON.parse(body);
  if (!data.ok || !data.accuracy_by_market) {
    throw new Error("Risposta backtest incompleta: " + body.slice(0, 1200));
  }

  const source = data.accuracy_by_market;
  const markets = {
    "1X2": source["1X2"],
    "Over 1.5": source.over_1_5,
    "Over 2.5": source.over_2_5,
    "Over 3.5": source.over_3_5,
    "BTTS": source.btts_yes
  };

  const reportMarkets = {};
  for (const [name, metric] of Object.entries(markets)) {
    const evaluated = Number(metric?.evaluated || 0);
    const accuracy = metric?.accuracy == null ? null : Number(metric.accuracy);
    reportMarkets[name] = {
      evaluated,
      correct: Number(metric?.correct || 0),
      accuracy,
      target_accuracy: targetAccuracy,
      meets_target: evaluated >= minimumEvaluated && accuracy !== null && accuracy >= targetAccuracy,
      sufficient_sample: evaluated >= minimumEvaluated
    };
  }

  const allMarketsMeetTarget = Object.values(reportMarkets).every(m => m.meets_target);
  const report = {
    generated_at: new Date().toISOString(),
    league_id: leagueId,
    season,
    model: data.model || null,
    requested_matches: data.requested_matches ?? limit,
    evaluated_matches: data.evaluated_matches ?? null,
    skipped_matches: data.evaluation_matches_selected != null && data.evaluated_matches != null
      ? data.evaluation_matches_selected - data.evaluated_matches
      : null,
    target_accuracy: targetAccuracy,
    minimum_evaluated_per_market: minimumEvaluated,
    all_markets_meet_target: allMarketsMeetTarget,
    status: allMarketsMeetTarget ? "TARGET_REACHED" : "CONTINUE_MONITORING",
    markets: reportMarkets,
    advanced_metrics: data.advanced_metrics || null
  };

  fs.mkdirSync("reports", { recursive: true });
  fs.writeFileSync("reports/automatic-backtest-latest.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(allMarketsMeetTarget
    ? "Obiettivo raggiunto su tutti i mercati con campione minimo."
    : "Obiettivo non ancora raggiunto: il monitoraggio prosegue al prossimo ciclo.");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
