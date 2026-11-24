const fs = require("node:fs");

const baseUrl = String(process.env.BASE_URL || "").replace(/\/$/, "");
const leagueId = process.env.LEAGUE_ID || "l_0ALvwF";
const season = String(process.env.SEASON || "").trim();
const limit = Math.min(Math.max(Number(process.env.BACKTEST_LIMIT) || 300, 1), 300);
const targetAccuracy = Number(process.env.TARGET_ACCURACY || 60);
const minimumEvaluated = Number(process.env.MIN_EVALUATED || 30);

if (!baseUrl) {
  throw new Error("BASE_URL non configurato.");
}

async function main() {
  const url = new URL(`${baseUrl}/api/backtest/${encodeURIComponent(leagueId)}`);
  if (season) url.searchParams.set("season", season);
  url.searchParams.set("limit", String(limit));
  // Usa la stessa modalità paginata che ha prodotto il backtest statistico
  // verificato: la modalità standard seleziona solo le partite più recenti,
  // che in questo dataset possono non avere uno storico sufficiente per il modello.
  url.searchParams.set("include_stats", "true");
  url.searchParams.set("stats_limit", String(limit));
  url.searchParams.set("offset", "0");

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

  const selected = Number(data.evaluation_matches_selected || 0);
  const evaluated = Number(data.evaluated_matches || 0);
  if (!Array.isArray(data.results) || data.results.length === 0 || evaluated === 0) {
    throw new Error(`Backtest senza campione valutabile: storico=${data.available_history_matches ?? "n/d"}, selezionate=${selected}, valutate=${evaluated}, offset=${data.offset ?? "n/d"}.`);
  }

  const source = data.accuracy_by_market;
  const marketLabels = {
    "1X2": "1X2",
    over_0_5: "Over 0.5", under_0_5: "Under 0.5",
    over_1_5: "Over 1.5", over_2_5: "Over 2.5", over_3_5: "Over 3.5",
    under_1_5: "Under 1.5", under_2_5: "Under 2.5", under_3_5: "Under 3.5",
    over_4_5: "Over 4.5", under_4_5: "Under 4.5",
    btts_yes: "Goal", btts_no: "No Goal",
    double_chance_1x: "Doppia chance 1X",
    double_chance_x2: "Doppia chance X2",
    double_chance_12: "Doppia chance 12",
    multigoal_1_2: "Multigol 1-2", multigoal_1_3: "Multigol 1-3",
    multigoal_1_4: "Multigol 1-4", multigoal_2_3: "Multigol 2-3",
    multigoal_2_4: "Multigol 2-4", multigoal_2_5: "Multigol 2-5",
    multigoal_3_4: "Multigol 3-4",
    combo_1x_over_1_5: "1X + Over 1.5",
    combo_1x_under_2_5: "1X + Under 2.5",
    combo_x2_over_1_5: "X2 + Over 1.5",
    combo_x2_under_2_5: "X2 + Under 2.5",
    combo_12_over_1_5: "12 + Over 1.5",
    combo_12_under_2_5: "12 + Under 2.5",
    dc_combo_1x_multigoal_1_4: "1X + Multigol 1-4",
    dc_combo_x2_multigoal_1_4: "X2 + Multigol 1-4",
    dc_combo_12_multigoal_1_4: "12 + Multigol 1-4"
  };
  const markets = Object.fromEntries(
    Object.entries(marketLabels).filter(([key]) => source[key]).map(([key, label]) => [label, source[key]])
  );

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

  // Ricerca soglie sui dati storici più vecchi. Il blocco più recente resta holdout.
  // La selezione usa balanced accuracy per ridurre il vantaggio artificiale della classe maggioritaria.
  const binaryDefinitions = Object.keys(marketLabels)
    .filter(key => key !== "1X2" && source[key])
    .map(key => ({ name: marketLabels[key], probability: key, actual: key }));
  const orderedResults = Array.isArray(data.results)
    ? [...data.results].sort((a, b) => String(a.match_date || "").localeCompare(String(b.match_date || "")))
    : [];
  const splitAt = Math.floor(orderedResults.length * 0.70);
  const training = orderedResults.slice(0, splitAt);
  const holdout = orderedResults.slice(splitAt);
  const thresholdOptimization = {};
  const candidateConfig = {
    generated_at: new Date().toISOString(),
    league_id: leagueId,
    season,
    source_model: data.model || null,
    training_share_percent: 70,
    holdout_share_percent: 30,
    selection_metric: "balanced_accuracy",
    production_applied: false,
    thresholds: {}
  };

  for (const market of binaryDefinitions) {
    const validRows = list => list.filter(row =>
      Number.isFinite(Number(row.probabilities?.[market.probability])) &&
      typeof row.actual_markets?.[market.actual] === "boolean"
    );
    const trainRows = validRows(training);
    const testRows = validRows(holdout);
    let best = { threshold: 0.5, balancedAccuracy: -1, accuracy: null, correct: 0, evaluated: trainRows.length };

    for (let step = 30; step <= 70; step++) {
      const threshold = step / 100;
      let tp = 0, tn = 0, fp = 0, fn = 0;
      for (const row of trainRows) {
        const predicted = Number(row.probabilities[market.probability]) / 100 >= threshold;
        const actual = row.actual_markets[market.actual];
        if (predicted && actual) tp++;
        else if (!predicted && !actual) tn++;
        else if (predicted && !actual) fp++;
        else fn++;
      }
      const sensitivity = tp + fn ? tp / (tp + fn) : 0;
      const specificity = tn + fp ? tn / (tn + fp) : 0;
      const balancedAccuracy = (sensitivity + specificity) / 2;
      const accuracy = trainRows.length ? (tp + tn) / trainRows.length : null;
      if (balancedAccuracy > best.balancedAccuracy + 1e-12 ||
          (Math.abs(balancedAccuracy - best.balancedAccuracy) <= 1e-12 && Math.abs(threshold - 0.5) < Math.abs(best.threshold - 0.5))) {
        best = { threshold, balancedAccuracy, accuracy, correct: tp + tn, evaluated: trainRows.length };
      }
    }

    let tp = 0, tn = 0, fp = 0, fn = 0;
    let baselineCorrect = 0;
    for (const row of testRows) {
      const probability = Number(row.probabilities[market.probability]) / 100;
      const predicted = probability >= best.threshold;
      const actual = row.actual_markets[market.actual];
      if (predicted && actual) tp++;
      else if (!predicted && !actual) tn++;
      else if (predicted && !actual) fp++;
      else fn++;
      if ((probability >= 0.5) === actual) baselineCorrect++;
    }
    const holdoutAccuracy = testRows.length ? Number(((tp + tn) / testRows.length * 100).toFixed(2)) : null;
    const holdoutBalancedAccuracy = testRows.length
      ? Number((((tp + fn ? tp / (tp + fn) : 0) + (tn + fp ? tn / (tn + fp) : 0)) / 2 * 100).toFixed(2))
      : null;
    const baselineAccuracy = testRows.length ? Number((baselineCorrect / testRows.length * 100).toFixed(2)) : null;
    const enoughTraining = trainRows.length >= Math.max(20, Math.floor(minimumEvaluated * 0.5));
    const enoughHoldout = testRows.length >= Math.max(10, Math.floor(minimumEvaluated * 0.2));
    const approvedForReview = enoughTraining && enoughHoldout && holdoutBalancedAccuracy !== null &&
      holdoutBalancedAccuracy >= 50 && holdoutAccuracy >= targetAccuracy;

    thresholdOptimization[market.name] = {
      selected_threshold_percent: Number((best.threshold * 100).toFixed(0)),
      training_evaluated: trainRows.length,
      training_accuracy: best.accuracy === null ? null : Number((best.accuracy * 100).toFixed(2)),
      training_balanced_accuracy: best.balancedAccuracy < 0 ? null : Number((best.balancedAccuracy * 100).toFixed(2)),
      holdout_evaluated: testRows.length,
      holdout_accuracy: holdoutAccuracy,
      holdout_balanced_accuracy: holdoutBalancedAccuracy,
      holdout_baseline_50_percent_accuracy: baselineAccuracy,
      candidate_eligible_for_review: approvedForReview,
      applied_to_model: false,
      note: "Configurazione candidata: richiede revisione e validazione su dati futuri; il modello in produzione non viene modificato."
    };
    candidateConfig.thresholds[market.probability] = {
      threshold: best.threshold,
      training_evaluated: trainRows.length,
      holdout_evaluated: testRows.length,
      holdout_accuracy_percent: holdoutAccuracy,
      holdout_balanced_accuracy_percent: holdoutBalancedAccuracy,
      eligible_for_review: approvedForReview
    };
  }

  const allMarketsMeetTarget = Object.values(reportMarkets).every(m => m.meets_target);
  const report = {
    generated_at: new Date().toISOString(),
    league_id: leagueId,
    season: season || data.season || "Tutte le stagioni disponibili",
    model: data.model || null,
    requested_matches: data.requested_matches ?? limit,
    available_history_matches: data.available_history_matches ?? null,
    evaluation_matches_selected: data.evaluation_matches_selected ?? null,
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
    statistical_markets: data.statistical_accuracy_by_market || null,
    statistical_backtest: data.statistical_backtest || null,
    advanced_metrics: data.advanced_metrics || null
  };

  fs.mkdirSync("reports", { recursive: true });
  fs.writeFileSync("reports/automatic-backtest-latest.json", JSON.stringify(report, null, 2));
  fs.writeFileSync("reports/optimization-candidate.json", JSON.stringify(candidateConfig, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(allMarketsMeetTarget
    ? "Obiettivo raggiunto su tutti i mercati con campione minimo."
    : "Obiettivo non ancora raggiunto: il monitoraggio prosegue al prossimo ciclo.");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
