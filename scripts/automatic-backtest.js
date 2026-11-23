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

  // Ottimizza le soglie decisionali solo sul blocco storico più vecchio;
  // il blocco cronologicamente più recente resta holdout e non viene usato per scegliere soglie.
  const binaryDefinitions = [
    { name: "Over 1.5", probability: "over_1_5", actual: "over_1_5" },
    { name: "Over 2.5", probability: "over_2_5", actual: "over_2_5" },
    { name: "Over 3.5", probability: "over_3_5", actual: "over_3_5" },
    { name: "BTTS", probability: "btts_yes", actual: "btts_yes" }
  ];
  const orderedResults = Array.isArray(data.results)
    ? [...data.results].sort((a, b) => String(a.match_date || "").localeCompare(String(b.match_date || "")))
    : [];
  const splitAt = Math.floor(orderedResults.length * 0.70);
  const training = orderedResults.slice(0, splitAt);
  const holdout = orderedResults.slice(splitAt);
  const thresholdOptimization = {};

  for (const market of binaryDefinitions) {
    const rows = list => list.filter(row =>
      Number.isFinite(Number(row.probabilities?.[market.probability])) &&
      typeof row.actual_markets?.[market.actual] === "boolean"
    );
    const trainRows = rows(training);
    const testRows = rows(holdout);
    let best = { threshold: 0.5, accuracy: -1, correct: 0, evaluated: trainRows.length };

    // Griglia predefinita, nessun uso dei risultati holdout per scegliere la soglia.
    for (let threshold = 0.30; threshold <= 0.70001; threshold += 0.01) {
      let correct = 0;
      for (const row of trainRows) {
        const predicted = Number(row.probabilities[market.probability]) / 100 >= threshold;
        if (predicted === row.actual_markets[market.actual]) correct++;
      }
      const accuracy = trainRows.length ? correct / trainRows.length : -1;
      if (accuracy > best.accuracy + 1e-12 ||
          (Math.abs(accuracy - best.accuracy) <= 1e-12 && Math.abs(threshold - 0.5) < Math.abs(best.threshold - 0.5))) {
        best = { threshold: Number(threshold.toFixed(2)), accuracy, correct, evaluated: trainRows.length };
      }
    }

    let holdoutCorrect = 0;
    let baselineCorrect = 0;
    for (const row of testRows) {
      const probability = Number(row.probabilities[market.probability]) / 100;
      if ((probability >= best.threshold) === row.actual_markets[market.actual]) holdoutCorrect++;
      if ((probability >= 0.5) === row.actual_markets[market.actual]) baselineCorrect++;
    }
    const holdoutAccuracy = testRows.length ? Number((holdoutCorrect / testRows.length * 100).toFixed(2)) : null;
    const baselineAccuracy = testRows.length ? Number((baselineCorrect / testRows.length * 100).toFixed(2)) : null;
    thresholdOptimization[market.name] = {
      selected_threshold_percent: Number((best.threshold * 100).toFixed(0)),
      training_evaluated: trainRows.length,
      training_accuracy: trainRows.length ? Number((best.accuracy * 100).toFixed(2)) : null,
      holdout_evaluated: testRows.length,
      holdout_accuracy: holdoutAccuracy,
      holdout_baseline_50_percent_accuracy: baselineAccuracy,
      holdout_meets_target: testRows.length >= Math.max(10, Math.floor(minimumEvaluated * 0.2)) && holdoutAccuracy !== null && holdoutAccuracy >= targetAccuracy,
      applied_to_model: false,
      note: "Soglia decisionale suggerita; modello Poisson invariato. Validare su nuovi dati prima dell'adozione."
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
    threshold_optimization: thresholdOptimization,
    optimization_split: { training_matches: training.length, untouched_holdout_matches: holdout.length, chronological: true },
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
