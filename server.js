const express = require("express");
const rateLimit = require("express-rate-limit");

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.PITCHAPI_KEY;
const ACCESS_TOKEN = process.env.PREDICTOR_ACCESS_TOKEN;
const API_BASE = "https://api.pitchapi.dev";

// CONFIGURAZIONE
app.get("/debug-config", (req, res) => {
  res.json({
    pitchapi_key_present: Boolean(API_KEY),
    access_token_present: Boolean(ACCESS_TOKEN)
  });
});

app.use("/api/", rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false
}));

function requireConfig(req, res, next) {
  if (!API_KEY || !ACCESS_TOKEN) {
    return res.status(503).json({
      ok: false,
      error: "Configurazione mancante: controlla PITCHAPI_KEY e PREDICTOR_ACCESS_TOKEN su Render."
    });
  }
  next();
}

function requireAccess(req, res, next) {
  const auth = req.get("authorization") || "";
  const supplied = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  if (!supplied || supplied !== ACCESS_TOKEN) {
    return res.status(401).json({
      ok: false,
      error: "Accesso non autorizzato."
    });
  }
  next();
}

async function pitchGet(path, params = {}) {
  const url = new URL(API_BASE + path);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    method: "GET",
    headers: { "X-API-KEY": API_KEY }
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const err = new Error(
      body.error?.message || `PitchAPI HTTP ${response.status}`
    );
    err.status = response.status;
    err.details = body.error || body;
    throw err;
  }

  return body.data;
}

function handleError(res, err) {
  console.error("Errore PitchAPI:", err.message);

  res.status(err.status || 502).json({
    ok: false,
    error: err.message,
    details: err.details
  });
}

function validMatchId(id) {
  return /^m_[A-Za-z0-9]{6}$/.test(id);
}

function validTeamId(id) {
  return /^t_[A-Za-z0-9]{6}$/.test(id);
}

function validLeagueId(id) {
  return /^l_[A-Za-z0-9]{6}$/.test(id);
}

function getNumber(value) {
  const number = Number.parseFloat(
    String(value ?? "").replace(",", ".")
  );
  return Number.isFinite(number) ? number : null;
}

function getMatchScore(match, isHome) {
  const value = isHome
    ? (match.score_home ?? match.home_score ?? match.score?.home ?? match.home_team?.score)
    : (match.score_away ?? match.away_score ?? match.score?.away ?? match.away_team?.score);

  return getNumber(value);
}

// DISTRIBUZIONE DI POISSON
function poissonProbability(lambda, goals) {
  if (lambda <= 0) return goals === 0 ? 1 : 0;

  let factorial = 1;
  for (let i = 2; i <= goals; i++) factorial *= i;

  return Math.exp(-lambda) * Math.pow(lambda, goals) / factorial;
}

function buildGoalModel(homeLambda, awayLambda) {
  const maxGoals = 8;
  const matrix = [];
  let total = 0;

  for (let home = 0; home <= maxGoals; home++) {
    for (let away = 0; away <= maxGoals; away++) {
      const probability =
        poissonProbability(homeLambda, home) *
        poissonProbability(awayLambda, away);

      matrix.push({ home, away, probability });
      total += probability;
    }
  }

  // Normalizza la matrice per compensare la piccola coda oltre 8 gol.
  for (const item of matrix) item.probability /= total;

  return matrix;
}

function percent(value) {
  return Number((value * 100).toFixed(1));
}

// STATO COLLEGAMENTO
app.get("/api/status", requireConfig, requireAccess, async (req, res) => {
  try {
    const data = await pitchGet("/v1/leagues");

    res.json({
      ok: true,
      provider: "PitchAPI",
      leagues: data.leagues?.length || 0,
      data
    });
  } catch (err) {
    handleError(res, err);
  }
});

// PARTITE DI UN GIORNO
app.get("/api/fixtures", requireConfig, requireAccess, async (req, res) => {
  const date = req.query.date;
  const status = req.query.status || "all";

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({
      ok: false,
      error: "Inserisci la data nel formato YYYY-MM-DD."
    });
  }

  if (!["all", "played", "upcoming"].includes(status)) {
    return res.status(400).json({
      ok: false,
      error: "Stato non valido."
    });
  }

  try {
    const data = await pitchGet(`/v1/date/${date}`, { status });

    res.json({
      ok: true,
      date,
      results: data.matches?.length || 0,
      response: data.matches || []
    });
  } catch (err) {
    handleError(res, err);
  }
});
// ROTTE DELLE PARTITE
function addMatchRoute(route, endpoint) {
  app.get(route, requireConfig, requireAccess, async (req, res) => {
    const id = req.params.id;

    if (!validMatchId(id)) {
      return res.status(400).json({
        ok: false,
        error: "ID partita non valido."
      });
    }

    try {
      const data = await pitchGet(`/v1/matches/${id}${endpoint}`);
      res.json({ ok: true, response: data });
    } catch (err) {
      handleError(res, err);
    }
  });
}

addMatchRoute("/api/fixture/:id", "");
addMatchRoute("/api/fixture/:id/statistics", "/stats");
addMatchRoute("/api/fixture/:id/shots", "/shots");
addMatchRoute("/api/fixture/:id/events", "/events");
addMatchRoute("/api/fixture/:id/players", "/players");
addMatchRoute("/api/fixture/:id/lineups", "/lineups");
addMatchRoute("/api/fixture/:id/momentum", "/momentum");
addMatchRoute("/api/fixture/:id/advanced", "/advanced");
addMatchRoute("/api/fixture/:id/h2h", "/h2h");
addMatchRoute("/api/fixture/:id/live", "/live");
addMatchRoute("/api/fixture/:id/heatmaps", "/heatmaps");

// PRONOSTICI BASATI SULLE ULTIME 10 PARTITE E SULLA DISTRIBUZIONE DI POISSON
app.get("/api/fixture/:id/predictions", requireConfig, requireAccess, async (req, res) => {
  const matchId = req.params.id;

  if (!validMatchId(matchId)) {
    return res.status(400).json({
      ok: false,
      error: "ID partita non valido."
    });
  }

  try {
    const fixture = await pitchGet(`/v1/matches/${matchId}`);

    if (!fixture?.league?.id || !fixture?.season ||
        !fixture?.home_team?.id || !fixture?.away_team?.id) {
      return res.status(422).json({
        ok: false,
        error: "La partita non contiene campionato, stagione o squadre sufficienti per il pronostico."
      });
    }

    const leagueId = fixture.league.id;
    const season = fixture.season;
    const homeId = fixture.home_team.id;
    const awayId = fixture.away_team.id;

    const leagueData = await pitchGet(`/v1/leagues/${leagueId}/matches`, {
      season,
      status: "played"
    });
    const playedMatches = (leagueData.matches || [])
  .filter(match =>
    (match.status === "finished" ||
     match.status === "completed" ||
     (getMatchScore(match, true) !== null &&
      getMatchScore(match, false) !== null)) &&
    match.date < fixture.date
  )
  .sort((a, b) => new Date(b.date) - new Date(a.date));

    function getTeamSample(teamId) {
      return playedMatches
        .filter(match =>
          match.home_team?.id === teamId || match.away_team?.id === teamId
        )
        .slice(0, 10)
        .map(match => {
          const isHome = match.home_team?.id === teamId;
          return {
            scored: getMatchScore(match, isHome),
            conceded: getMatchScore(match, !isHome),
            date: match.date
          };
        })
        .filter(item => item.scored !== null && item.conceded !== null);
    }

    const homeSample = getTeamSample(homeId);
    const awaySample = getTeamSample(awayId);

    if (homeSample.length < 5 || awaySample.length < 5) {
      return res.status(422).json({
        ok: false,
        error: "Dati insufficienti: servono almeno 5 partite con risultato valido per ciascuna squadra.",
        samples: {
          home: homeSample.length,
          away: awaySample.length
        }
      });
    }

    function average(sample, key) {
      return sample.reduce((sum, item) => sum + item[key], 0) / sample.length;
    }

    const homeGoalsFor = average(homeSample, "scored");
    const homeGoalsAgainst = average(homeSample, "conceded");
    const awayGoalsFor = average(awaySample, "scored");
    const awayGoalsAgainst = average(awaySample, "conceded");

    // Stima semplice: media tra produzione offensiva e gol concessi dall'avversaria.
    const expectedHomeGoals = Math.max(
      0.10,
      Math.min(5, (homeGoalsFor + awayGoalsAgainst) / 2)
    );
    const expectedAwayGoals = Math.max(
      0.10,
      Math.min(5, (awayGoalsFor + homeGoalsAgainst) / 2)
    );

    const matrix = buildGoalModel(expectedHomeGoals, expectedAwayGoals);

    const homeWin = matrix
      .filter(item => item.home > item.away)
      .reduce((sum, item) => sum + item.probability, 0);

    const draw = matrix
      .filter(item => item.home === item.away)
      .reduce((sum, item) => sum + item.probability, 0);

    const awayWin = matrix
      .filter(item => item.home < item.away)
      .reduce((sum, item) => sum + item.probability, 0);

    const over = line => matrix
      .filter(item => item.home + item.away > line)
      .reduce((sum, item) => sum + item.probability, 0);

    const under = line => 1 - over(line);

    const bttsYes = matrix
      .filter(item => item.home > 0 && item.away > 0)
      .reduce((sum, item) => sum + item.probability, 0);

    const exactScores = [...matrix]
      .sort((a, b) => b.probability - a.probability)
      .slice(0, 5)
      .map(item => ({
        score: `${item.home}-${item.away}`,
        probability: percent(item.probability)
      }));

    res.json({
      ok: true,
      model: "Poisson basato sulle medie gol delle ultime 10 partite",
      match: {
        id: matchId,
        league: fixture.league.name,
        season,
        home_team: fixture.home_team.name,
        away_team: fixture.away_team.name,
        date: fixture.date,
        status: fixture.status
      },
      samples: {
        home: homeSample.length,
        away: awaySample.length
      },
      averages: {
        home_goals_for: Number(homeGoalsFor.toFixed(2)),
        home_goals_against: Number(homeGoalsAgainst.toFixed(2)),
        away_goals_for: Number(awayGoalsFor.toFixed(2)),
        away_goals_against: Number(awayGoalsAgainst.toFixed(2))
      },
      expected_goals: {
        home: Number(expectedHomeGoals.toFixed(2)),
        away: Number(expectedAwayGoals.toFixed(2)),
        total: Number((expectedHomeGoals + expectedAwayGoals).toFixed(2))
      },
      probabilities: {
        "1": percent(homeWin),
        "X": percent(draw),
        "2": percent(awayWin),
        "over_1_5": percent(over(1)),
        "under_1_5": percent(under(1)),
        "over_2_5": percent(over(2)),
        "under_2_5": percent(under(2)),
        "over_3_5": percent(over(3)),
        "under_3_5": percent(under(3)),
        "btts_yes": percent(bttsYes),
        "btts_no": percent(1 - bttsYes)
      },
      most_likely_scores: exactScores,
      disclaimer: "Sono stime statistiche basate sui risultati storici disponibili, non garanzie. Non sono incluse quote bookmaker."
    });

  } catch (err) {
    handleError(res, err);
  }
});
// QUOTE - FONTE SEPARATA NON ANCORA COLLEGATA
app.get("/api/fixture/:id/odds", requireConfig, requireAccess, (req, res) => {
  res.status(501).json({
    ok: false,
    error: "Le quote richiedono una fonte dati separata."
  });
});

// CAMPIONATI E PARTITE
app.get("/api/league/:id/matches", requireConfig, requireAccess, async (req, res) => {
  const id = req.params.id;
  const season = req.query.season;
  const status = req.query.status || "played";

  if (!validLeagueId(id)) {
    return res.status(400).json({
      ok: false,
      error: "ID campionato non valido."
    });
  }

  if (!["played", "upcoming", "all"].includes(status)) {
    return res.status(400).json({
      ok: false,
      error: "Stato non valido."
    });
  }

  try {
    const data = await pitchGet(`/v1/leagues/${id}/matches`, {
      season,
      status
    });

    res.json({
      ok: true,
      league: data.league,
      results: data.matches?.length || 0,
      response: data.matches || []
    });
  } catch (err) {
    handleError(res, err);
  }
});

// BACKTEST STORICO - verifica i pronostici

app.get("/api/backtest/:leagueId", requireConfig, requireAccess, async (req, res) => {
  const leagueId = req.params.leagueId;
  const season = req.query.season || "2026/2027";
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);

  if (!validLeagueId(leagueId)) {
    return res.status(400).json({
      ok: false,
      error: "ID campionato non valido."
    });
  }

  try {
    const data = await pitchGet(`/v1/leagues/${leagueId}/matches`, {
      season,
      status: "played"
    });

    const allMatches = (data.matches || [])
      .filter(match =>
        (match.status === "finished" ||
         match.status === "completed" ||
         (getMatchScore(match, true) !== null &&
          getMatchScore(match, false) !== null)) &&
        match.date
      )
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    const testMatches = allMatches.slice(-limit);

    const markets = {
      "1X2": { total: 0, correct: 0 },
      "Over 1.5": { total: 0, correct: 0 },
      "Over 2.5": { total: 0, correct: 0 },
      "Over 3.5": { total: 0, correct: 0 },
      "Goal": { total: 0, correct: 0 },
      "Risultato esatto": { total: 0, correct: 0 }
    };

    const confidence95 = {
      total: 0,
      correct: 0
    };

    const results = [];
    let skipped = 0;

    function average(sample, key) {
      return sample.reduce((sum, item) => sum + item[key], 0) / sample.length;
    }

    function recordMarket(name, probability, success) {
      markets[name].total++;
      if (success) markets[name].correct++;

      if (probability >= 0.95) {
        confidence95.total++;
        if (success) confidence95.correct++;
      }
    }

    for (const fixture of testMatches) {
      const previousMatches = allMatches.filter(match =>
        match.date < fixture.date &&
        (
          match.home_team?.id === fixture.home_team?.id ||
          match.away_team?.id === fixture.home_team?.id ||
          match.home_team?.id === fixture.away_team?.id ||
          match.away_team?.id === fixture.away_team?.id
        )
      );

      function getTeamSample(teamId) {
        return previousMatches
          .filter(match =>
            match.home_team?.id === teamId ||
            match.away_team?.id === teamId
          )
          .sort((a, b) => new Date(b.date) - new Date(a.date))
          .slice(0, 10)
          .map(match => {
            const isHome = match.home_team?.id === teamId;
            return {
              scored: getMatchScore(match, isHome),
              conceded: getMatchScore(match, !isHome)
            };
          })
          .filter(item =>
            item.scored !== null && item.conceded !== null
          );
      }

      const homeSample = getTeamSample(fixture.home_team.id);
      const awaySample = getTeamSample(fixture.away_team.id);

      if (homeSample.length < 5 || awaySample.length < 5) {
        skipped++;
        continue;
      }

      const homeFor = average(homeSample, "scored");
      const homeAgainst = average(homeSample, "conceded");
      const awayFor = average(awaySample, "scored");
      const awayAgainst = average(awaySample, "conceded");

      const homeLambda = Math.max(0.10, Math.min(5, (homeFor + awayAgainst) / 2));
      const awayLambda = Math.max(0.10, Math.min(5, (awayFor + homeAgainst) / 2));

      const matrix = buildGoalModel(homeLambda, awayLambda);

      const probability = condition =>
        matrix
          .filter(condition)
          .reduce((sum, item) => sum + item.probability, 0);

      const pHome = probability(item => item.home > item.away);
      const pDraw = probability(item => item.home === item.away);
      const pAway = probability(item => item.home < item.away);

      const pOver15 = probability(item => item.home + item.away > 1);
      const pOver25 = probability(item => item.home + item.away > 2);
      const pOver35 = probability(item => item.home + item.away > 3);
      const pGoal = probability(item => item.home > 0 && item.away > 0);

      const predictions = [
        { name: "1", probability: pHome, success: getMatchScore(fixture, true) > getMatchScore(fixture, false) },
        { name: "X", probability: pDraw, success: getMatchScore(fixture, true) === getMatchScore(fixture, false) },
        { name: "2", probability: pAway, success: getMatchScore(fixture, true) < getMatchScore(fixture, false) }
      ];

      predictions.sort((a, b) => b.probability - a.probability);
      const best1X2 = predictions[0];

      recordMarket("1X2", best1X2.probability, best1X2.success);

      const actualHome = getMatchScore(fixture, true);
      const actualAway = getMatchScore(fixture, false);
      const actualTotal = actualHome + actualAway;
      const actualGoal = actualHome > 0 && actualAway > 0;

      recordMarket("Over 1.5",
        Math.max(pOver15, 1 - pOver15),
        pOver15 >= 0.5 ? actualTotal > 1 : actualTotal <= 1
      );

      recordMarket("Over 2.5",
        Math.max(pOver25, 1 - pOver25),
        pOver25 >= 0.5 ? actualTotal > 2 : actualTotal <= 2
      );

      recordMarket("Over 3.5",
        Math.max(pOver35, 1 - pOver35),
        pOver35 >= 0.5 ? actualTotal > 3 : actualTotal <= 3
      );

      recordMarket("Goal",
        Math.max(pGoal, 1 - pGoal),
        pGoal >= 0.5 ? actualGoal : !actualGoal
      );

      const bestScore = [...matrix]
        .sort((a, b) => b.probability - a.probability)[0];

      recordMarket(
        "Risultato esatto",
        bestScore.probability,
        bestScore.home === actualHome && bestScore.away === actualAway
      );

      results.push({
        date: fixture.date,
        match: `${fixture.home_team.name} - ${fixture.away_team.name}`,
        actual: `${actualHome}-${actualAway}`,
        predicted_1x2: best1X2.name,
        predicted_1x2_probability: percent(best1X2.probability),
        predicted_score: `${bestScore.home}-${bestScore.away}`,
        predicted_score_probability: percent(bestScore.probability),
        samples: {
          home: homeSample.length,
          away: awaySample.length
        }
      });
    }

    const summary = {};

    for (const [name, stats] of Object.entries(markets)) {
      summary[name] = {
        evaluated: stats.total,
        correct: stats.correct,
        accuracy: stats.total
          ? percent(stats.correct / stats.total)
          : null
      };
    }

    res.json({
      ok: true,
      model: "Poisson storico senza utilizzo di risultati futuri",
      league_id: leagueId,
      season,
      requested_matches: testMatches.length,
      evaluated_matches: results.length,
      skipped_matches: skipped,
      accuracy_by_market: summary,
      high_confidence_95: {
        evaluated: confidence95.total,
        correct: confidence95.correct,
        accuracy: confidence95.total
          ? percent(confidence95.correct / confidence95.total)
          : null
      },
      results
    });

  } catch (err) {
    handleError(res, err);
  }
});


// MEDIE STATISTICHE DELLE SQUADRE
app.get("/api/team/:id/averages", requireConfig, requireAccess, async (req, res) => {
  const teamId = req.params.id;
  const leagueId = req.query.league;
  const season = req.query.season;
  const last = Number(req.query.last || 10);

  if (!validTeamId(teamId)) {
    return res.status(400).json({
      ok: false,
      error: "ID squadra non valido."
    });
  }

  if (!validLeagueId(leagueId || "")) {
    return res.status(400).json({
      ok: false,
      error: "ID campionato non valido."
    });
  }

  if (!season || !Number.isInteger(last) || last < 1 || last > 10) {
    return res.status(400).json({
      ok: false,
      error: "Stagione o numero di partite non valido."
    });
  }

  try {
    const leagueData = await pitchGet(`/v1/leagues/${leagueId}/matches`, {
      season,
      status: "played"
    });

    const matches = (leagueData.matches || [])
      .filter(match =>
        match.home_team?.id === teamId ||
        match.away_team?.id === teamId
      )
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, last);

    const stats = {
      goals_for: 0,
      goals_against: 0,
      corners: 0,
      total_shots: 0,
      shots_on_target: 0,
      yellow_cards: 0,
      red_cards: 0,
      fouls: 0,
      expected_goals: 0,
      possession: 0
    };

    const counts = {};
    for (const key of Object.keys(stats)) counts[key] = 0;

    const keys = {
      corners: ["corners"],
      total_shots: ["total_shots"],
      shots_on_target: ["ShotsOnTarget", "shots_on_target", "shots_on_goal"],
      yellow_cards: ["yellow_cards"],
      red_cards: ["red_cards"],
      fouls: ["fouls"],
      expected_goals: ["expected_goals"],
      possession: ["BallPossesion", "ball_possession"]
    };

    let statsMatches = 0;

    for (const match of matches) {
      const isHome = match.home_team?.id === teamId;
      const goalsFor = getMatchScore(match, isHome);
      const goalsAgainst = getMatchScore(match, !isHome);

      if (goalsFor !== null) {
        stats.goals_for += goalsFor;
        counts.goals_for++;
      }

      if (goalsAgainst !== null) {
        stats.goals_against += goalsAgainst;
        counts.goals_against++;
      }

      try {
        const data = await pitchGet(`/v1/matches/${match.id}/stats`);
        const periods = data?.periods || [];
        const period = periods.find(p =>
          String(p.period || p.key || p.name || "").toLowerCase() === "all"
        );

        if (!period) {
          console.log("Periodo All non trovato:", match.id);
          continue;
        }

        const values = {};

        for (const group of period.groups || []) {
          for (const item of group.items || []) {
            values[item.key] = isHome ? item.home : item.away;
          }
        }

        let found = false;

        for (const [name, possibleKeys] of Object.entries(keys)) {
          const foundKey = possibleKeys.find(key =>
            values[key] !== undefined && values[key] !== null
          );

          if (!foundKey) continue;

          const value = getNumber(values[foundKey]);
          if (value === null) continue;

          stats[name] += value;
          counts[name]++;
          found = true;
        }

        if (found) statsMatches++;

      } catch (error) {
        console.error("Errore statistiche partita", match.id, error.message);
      }
    }

    const averages = {};
    for (const [key, total] of Object.entries(stats)) {
      averages[key] = counts[key]
        ? Number((total / counts[key]).toFixed(2))
        : null;
    }

    res.json({
      ok: true,
      team: {
        id: teamId,
        name: matches[0]
          ? (matches[0].home_team?.id === teamId
              ? matches[0].home_team.name
              : matches[0].away_team.name)
          : teamId
      },
      league_id: leagueId,
      season,
      matches_requested: last,
      matches_analyzed: matches.length,
      stats_matches_analyzed: statsMatches,
      averages,
            sample_counts: counts,
      matches: matches.map(match => ({
        id: match.id,
        date: match.date,
        home_team: match.home_team?.name,
        away_team: match.away_team?.name,
        score_home: match.score_home ?? match.home_score,
        score_away: match.score_away ?? match.away_score
      }))
    });

  } catch (err) {
    handleError(res, err);
  }
});

// STATISTICHE INDIVIDUALI DEI GIOCATORI
app.get("/api/team/:id/player-averages", requireConfig, requireAccess, async (req, res) => {
  const teamId = req.params.id;
  const leagueId = req.query.league;
  const season = req.query.season;
  const last = Number(req.query.last || 10);

  if (!validTeamId(teamId)) {
    return res.status(400).json({
      ok: false,
      error: "ID squadra non valido."
    });
  }

  if (!validLeagueId(leagueId || "")) {
    return res.status(400).json({
      ok: false,
      error: "ID campionato non valido."
    });
  }

  if (!season || !Number.isInteger(last) || last < 1 || last > 10) {
    return res.status(400).json({
      ok: false,
      error: "Stagione o numero di partite non valido."
    });
  }

  try {
    const leagueData = await pitchGet(`/v1/leagues/${leagueId}/matches`, {
      season,
      status: "played"
    });

    const matches = (leagueData.matches || [])
      .filter(match =>
        match.home_team?.id === teamId ||
        match.away_team?.id === teamId
      )
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, last);

    const players = {};
    let matchesWithPlayerData = 0;

    for (const match of matches) {
      try {
        const data = await pitchGet(`/v1/matches/${match.id}/players`);
        if (!Array.isArray(data)) continue;

        let foundPlayers = false;

        for (const entry of data) {
          if (entry.team_id !== teamId || !entry.player?.id) continue;

          foundPlayers = true;
          const id = entry.player.id;

          if (!players[id]) {
            players[id] = {
              id,
              name: entry.player.name,
              appearances: 0,
              stats: {}
            };
          }

          const player = players[id];
          player.appearances++;

          for (const group of entry.stats || []) {
            for (const [label, item] of Object.entries(group.stats || {})) {
              const statKey = item.key;
              const stat = item.stat || {};
              const value = Number(stat.value);

              if (!statKey || !Number.isFinite(value)) continue;

              if (!player.stats[statKey]) {
                player.stats[statKey] = {
                  label,
                  total: 0,
                  samples: 0,
                  attempts: 0
                };
              }

              player.stats[statKey].total += value;
              player.stats[statKey].samples++;

              const attempts = Number(stat.total);
              if (Number.isFinite(attempts)) {
                player.stats[statKey].attempts += attempts;
              }
            }
          }
        }

        if (foundPlayers) matchesWithPlayerData++;

      } catch (error) {
        console.error("Errore statistiche giocatori", match.id, error.message);
      }
    }

    const result = Object.values(players).map(player => {
      const averages = {};

      for (const [key, stat] of Object.entries(player.stats)) {
        averages[key] = {
          label: stat.label,
          average: Number((stat.total / stat.samples).toFixed(2)),
          total: stat.total,
          samples: stat.samples,
          attempts: stat.attempts
        };
      }

      return {
        id: player.id,
        name: player.name,
        appearances: player.appearances,
        stats: averages
      };
    });

    result.sort((a, b) => b.appearances - a.appearances);

    res.json({
      ok: true,
      team_id: teamId,
      league_id: leagueId,
      season,
      matches_requested: last,
      matches_analyzed: matches.length,
      matches_with_player_data: matchesWithPlayerData,
      players_found: result.length,
      players: result
    });

  } catch (err) {
    handleError(res, err);
  }
});

// GESTIONE ERRORI
app.use((err, req, res, next) => {
  console.error("Errore server:", err.message);

  res.status(500).json({
    ok: false,
    error: "Errore interno del server."
  });
});

// FILE FRONTEND
app.use(express.static("public"));

// AVVIO SERVER
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Football Predictor AI attivo sulla porta ${PORT}`);
});
      
