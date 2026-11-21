
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

// MEDIA PONDERATA: le partite più recenti hanno peso maggiore.
function weightedAverage(sample, key) {
  if (!sample.length) return 0;

  let weightedSum = 0;
  let totalWeight = 0;

  sample.forEach((item, index) => {
    const weight = Math.pow(0.75, index);
    weightedSum += item[key] * weight;
    totalWeight += weight;
  });

  return weightedSum / totalWeight;
}
function getReliability(probability, sampleSize) {
  let score = probability;

  // Penalizza i campioni con pochi dati
  if (sampleSize < 10) {
    score -= (10 - sampleSize) * 2;
  }

  score = Math.max(0, Math.min(100, score));

  let level = "BASSA";

  if (score >= 75) {
    level = "ALTA";
  } else if (score >= 60) {
    level = "MEDIA";
  }

  return {
    score: Number(score.toFixed(1)),
    level
  };
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

// PRONOSTICI BASATI SULLE ULTIME 10 PARTITE
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
  season
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
          match.home_team?.id === teamId ||
          match.away_team?.id === teamId
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
        .filter(item =>
          item.scored !== null &&
          item.conceded !== null
        );
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

    const homeGoalsFor = weightedAverage(homeSample, "scored");
    const homeGoalsAgainst = weightedAverage(homeSample, "conceded");
    const awayGoalsFor = weightedAverage(awaySample, "scored");
    const awayGoalsAgainst = weightedAverage(awaySample, "conceded");

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
const reliability = {
  "1": getReliability(percent(homeWin), homeSample.length),
  "X": getReliability(percent(draw), homeSample.length),
  "2": getReliability(percent(awayWin), awaySample.length),

  "over_1_5": getReliability(percent(over(1)), Math.min(homeSample.length, awaySample.length)),
  "over_2_5": getReliability(percent(over(2)), Math.min(homeSample.length, awaySample.length)),
  "over_3_5": getReliability(percent(over(3)), Math.min(homeSample.length, awaySample.length)),
   "under_1_5": getReliability(percent(under(1)), Math.min(homeSample.length, awaySample.length)),
"under_2_5": getReliability(percent(under(2)), Math.min(homeSample.length, awaySample.length)),
"under_3_5": getReliability(percent(under(3)), Math.min(homeSample.length, awaySample.length)),
  
  "btts_yes": getReliability(percent(bttsYes), Math.min(homeSample.length, awaySample.length)),
  "btts_no": getReliability(percent(1 - bttsYes), Math.min(homeSample.length, awaySample.length))
};
    const exactScores = [...matrix]
      .sort((a, b) => b.probability - a.probability)
      .slice(0, 5)
      .map(item => ({
        score: `${item.home}-${item.away}`,
        probability: percent(item.probability)
      }));

    res.json({
      ok: true,
      model: "Poisson basato sulle medie ponderate delle ultime 10 partite (peso 0,75)",
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
      reliability,
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
  const leagueId = req.params.id;
  const season = req.query.season;
  const status = req.query.status || "all";

  if (!validLeagueId(leagueId)) {
    return res.status(400).json({
      ok: false,
      error: "ID campionato non valido."
    });
  }

  if (!season) {
    return res.status(400).json({
      ok: false,
      error: "Inserisci la stagione."
    });
  }

  try {
    const data = await pitchGet(`/v1/leagues/${leagueId}/matches`, {
      season,
      status
    });

    res.json({
      ok: true,
      league_id: leagueId,
      season,
      requested_matches: data.matches?.length || 0,
      matches: data.matches || []
    });
  } catch (err) {
    handleError(res, err);
  }
});

// BACKTEST DEL MODELLO
app.get("/api/backtest/:leagueId", requireConfig, requireAccess, async (req, res) => {
  const leagueId = req.params.leagueId;
  const season = req.query.season;
  const requestedLimit = Number.parseInt(req.query.limit || "100", 10);
  const limit = Math.max(1, Math.min(200, requestedLimit || 100));

  if (!validLeagueId(leagueId)) {
    return res.status(400).json({
      ok: false,
      error: "ID campionato non valido."
    });
  }

  if (!season) {
    return res.status(400).json({
      ok: false,
      error: "Inserisci la stagione."
    });
  }

  try {
    const leagueData = await pitchGet(`/v1/leagues/${leagueId}/matches`, {
      season,
      status: "played"
    });

    const allMatches = (leagueData.matches || [])
      .filter(match =>
        (match.status === "finished" ||
         match.status === "completed" ||
         (getMatchScore(match, true) !== null &&
          getMatchScore(match, false) !== null)) &&
        match.date
      )
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    const testMatches = allMatches.slice(-limit);

    const markets = [
      "1X2",
      "over_1_5",
      "over_2_5",
      "over_3_5",
      "btts"
    ];

    const results = {};

    for (const market of markets) {
      results[market] = {
        evaluated: 0,
        correct: 0,
        high_confidence: 0,
        high_confidence_correct: 0
      };
    }

    let evaluatedMatches = 0;
    let skippedMatches = 0;

    function recordMarket(market, prediction, actual, probability) {
      results[market].evaluated++;

      if (prediction === actual) {
        results[market].correct++;
      }

      if (probability >= 0.95) {
        results[market].high_confidence++;

        if (prediction === actual) {
          results[market].high_confidence_correct++;
        }
      }
    }

    for (const fixture of testMatches) {
      const homeId = fixture.home_team?.id;
      const awayId = fixture.away_team?.id;

      if (!homeId || !awayId) {
        skippedMatches++;
        continue;
      }

      const actualHome = getMatchScore(fixture, true);
      const actualAway = getMatchScore(fixture, false);

      if (actualHome === null || actualAway === null) {
        skippedMatches++;
        continue;
      }

      // Usiamo soltanto partite precedenti alla partita da valutare.
      const previousMatches = allMatches
        .filter(match =>
          match.date < fixture.date &&
          (
            match.home_team?.id === homeId ||
            match.away_team?.id === homeId ||
            match.home_team?.id === awayId ||
            match.away_team?.id === awayId
          )
        )
        .sort((a, b) => new Date(b.date) - new Date(a.date));

      function getTeamSample(teamId) {
        return previousMatches
          .filter(match =>
            match.home_team?.id === teamId ||
            match.away_team?.id === teamId
          )
          .slice(0, 10)
          .map(match => {
            const isHome = match.home_team?.id === teamId;

            return {
              scored: getMatchScore(match, isHome),
              conceded: getMatchScore(match, !isHome)
            };
          })
          .filter(item =>
            item.scored !== null &&
            item.conceded !== null
          );
      }

      const homeSample = getTeamSample(homeId);
      const awaySample = getTeamSample(awayId);

      if (homeSample.length < 5 || awaySample.length < 5) {
        skippedMatches++;
        continue;
      }

      const homeFor = weightedAverage(homeSample, "scored");
      const homeAgainst = weightedAverage(homeSample, "conceded");
      const awayFor = weightedAverage(awaySample, "scored");
      const awayAgainst = weightedAverage(awaySample, "conceded");

      const homeLambda = Math.max(
        0.10,
        Math.min(5, (homeFor + awayAgainst) / 2)
      );

      const awayLambda = Math.max(
        0.10,
        Math.min(5, (awayFor + homeAgainst) / 2)
      );

      const matrix = buildGoalModel(homeLambda, awayLambda);

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

      const bttsYes = matrix
        .filter(item => item.home > 0 && item.away > 0)
        .reduce((sum, item) => sum + item.probability, 0);

      const probabilities = {
        "1": homeWin,
        "X": draw,
        "2": awayWin,
        over_1_5: over(1),
        over_2_5: over(2),
        over_3_5: over(3),
        btts: bttsYes
      };

      const best1X2 = Object.entries({
        "1": homeWin,
        "X": draw,
        "2": awayWin
      }).sort((a, b) => b[1] - a[1])[0];

      const actual1X2 =
        actualHome > actualAway ? "1" :
        actualHome === actualAway ? "X" : "2";

      recordMarket(
        "1X2",
        best1X2[0],
        actual1X2,
        best1X2[1]
      );

      const actualTotal = actualHome + actualAway;

      recordMarket(
        "over_1_5",
        probabilities.over_1_5 >= 0.5,
        actualTotal > 1,
        Math.max(probabilities.over_1_5, 1 - probabilities.over_1_5)
      );

      recordMarket(
        "over_2_5",
        probabilities.over_2_5 >= 0.5,
        actualTotal > 2,
        Math.max(probabilities.over_2_5, 1 - probabilities.over_2_5)
      );

      recordMarket(
        "over_3_5",
        probabilities.over_3_5 >= 0.5,
        actualTotal > 3,
        Math.max(probabilities.over_3_5, 1 - probabilities.over_3_5)
      );

      recordMarket(
        "btts",
        probabilities.btts >= 0.5,
        actualHome > 0 && actualAway > 0,
        Math.max(probabilities.btts, 1 - probabilities.btts)
      );

      evaluatedMatches++;
    }

    const accuracy = {};

    for (const market of markets) {
      const item = results[market];

      accuracy[market] = {
        evaluated: item.evaluated,
        correct: item.correct,
        accuracy: item.evaluated
          ? percent(item.correct / item.evaluated)
          : 0,
        high_confidence: item.high_confidence,
        high_confidence_correct: item.high_confidence_correct,
        high_confidence_accuracy: item.high_confidence
          ? percent(item.high_confidence_correct / item.high_confidence)
          : null
      };
    }

    res.json({
      ok: true,
      model: "Poisson storico senza utilizzo di risultati futuri",
      league_id: leagueId,
      season,
      requested_matches: testMatches.length,
      evaluated_matches: evaluatedMatches,
      skipped_matches: skippedMatches,
      accuracy_by_market: accuracy,
      note: "Il backtest misura i risultati storici del modello e non garantisce prestazioni future."
    });

  } catch (err) {
    handleError(res, err);
  }
});

// MEDIE STATISTICHE DELLE SQUADRE
app.get("/api/team/:id/averages", requireConfig, requireAccess, async (req, res) => {
  const teamId = req.params.id;
  const leagueId = req.query.league_id;
  const season = req.query.season;
  const last = Math.max(1, Math.min(20, Number.parseInt(req.query.last || "10", 10) || 10));

  if (!validTeamId(teamId) || !validLeagueId(leagueId)) {
    return res.status(400).json({
      ok: false,
      error: "ID squadra o campionato non valido."
    });
  }

  if (!season) {
    return res.status(400).json({
      ok: false,
      error: "Inserisci la stagione."
    });
  }

  try {
    const data = await pitchGet(`/v1/leagues/${leagueId}/matches`, {
      season,
      status: "played"
    });

    const matches = (data.matches || [])
      .filter(match =>
        match.home_team?.id === teamId ||
        match.away_team?.id === teamId
      )
      .filter(match =>
        getMatchScore(match, true) !== null &&
        getMatchScore(match, false) !== null
      )
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, last);

    if (!matches.length) {
      return res.status(404).json({
        ok: false,
        error: "Nessuna partita trovata per questa squadra."
      });
    }

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

    const counts = {
      corners: 0,
      total_shots: 0,
      shots_on_target: 0,
      yellow_cards: 0,
      red_cards: 0,
      fouls: 0,
      expected_goals: 0,
      possession: 0
    };

    for (const match of matches) {
      const isHome = match.home_team?.id === teamId;

      stats.goals_for += getMatchScore(match, isHome);
      stats.goals_against += getMatchScore(match, !isHome);

      try {
        const matchStats = await pitchGet(`/v1/matches/${match.id}/stats`);
        const allStats = matchStats?.statistics || matchStats?.stats || [];

        const teamStats = allStats.find(item =>
          item.team?.id === teamId ||
          item.team_id === teamId
        );

        if (!teamStats) continue;

        const values = teamStats.statistics || teamStats.stats || teamStats;

        const aliases = {
          corners: ["corners", "corner_kicks"],
          total_shots: ["total_shots", "shots"],
          shots_on_target: ["shots_on_target", "shots_on_goal"],
          yellow_cards: ["yellow_cards"],
          red_cards: ["red_cards"],
          fouls: ["fouls"],
          expected_goals: ["expected_goals", "xg"],
          possession: ["possession", "ball_possession"]
        };

        for (const [key, possibleNames] of Object.entries(aliases)) {
          let value = null;

          for (const name of possibleNames) {
            value = getNumber(values[name]);

            if (value !== null) break;
          }

          if (value !== null) {
            stats[key] += value;
            counts[key]++;
          }
        }
      } catch (err) {
        console.error("Statistiche partita non disponibili:", match.id, err.message);
      }
    }

    const averages = {};

    for (const key of Object.keys(stats)) {
      const divisor = key === "goals_for" || key === "goals_against"
        ? matches.length
        : counts[key];

      averages[key] = divisor
        ? Number((stats[key] / divisor).toFixed(2))
        : null;
    }

    res.json({
      ok: true,
      team_id: teamId,
      league_id: leagueId,
      season,
      matches_requested: last,
      matches_analyzed: matches.length,
      stats_matches_analyzed: Math.max(...Object.values(counts)),
      averages
    });

  } catch (err) {
    handleError(res, err);
  }
});

// MEDIE STATISTICHE DEI GIOCATORI
app.get("/api/team/:id/player-averages", requireConfig, requireAccess, async (req, res) => {
  const teamId = req.params.id;
  const leagueId = req.query.league_id;
  const season = req.query.season;
  const last = Math.max(1, Math.min(20, Number.parseInt(req.query.last || "10", 10) || 10));

  if (!validTeamId(teamId) || !validLeagueId(leagueId)) {
    return res.status(400).json({
      ok: false,
      error: "ID squadra o campionato non valido."
    });
  }

  if (!season) {
    return res.status(400).json({
      ok: false,
      error: "Inserisci la stagione."
    });
  }

  try {
    const data = await pitchGet(`/v1/leagues/${leagueId}/matches`, {
      season,
      status: "played"
    });

    const matches = (data.matches || [])
      .filter(match =>
        match.home_team?.id === teamId ||
        match.away_team?.id === teamId
      )
      .filter(match =>
        getMatchScore(match, true) !== null &&
        getMatchScore(match, false) !== null
      )
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, last);

    const players = {};

    for (const match of matches) {
      try {
        const playerData = await pitchGet(`/v1/matches/${match.id}/players`);
        const list = playerData?.players || playerData?.statistics || [];

        for (const item of list) {
          const player = item.player || item;
          const playerId = player.id;

          if (!playerId) continue;

          const playerName = player.name || "Giocatore";

          if (!players[playerId]) {
            players[playerId] = {
              id: playerId,
              name: playerName,
              matches: 0,
              minutes: 0,
              goals: 0,
              assists: 0,
              shots: 0,
              shots_on_target: 0,
              yellow_cards: 0,
              red_cards: 0
            };
          }

          const entry = players[playerId];
          const values = item.statistics || item.stats || item;

          entry.matches++;

          entry.minutes += getNumber(values.minutes) || 0;
          entry.goals += getNumber(values.goals) || 0;
          entry.assists += getNumber(values.assists) || 0;
          entry.shots += getNumber(values.shots) || 0;
          entry.shots_on_target += getNumber(values.shots_on_target) || 0;
          entry.yellow_cards += getNumber(values.yellow_cards) || 0;
          entry.red_cards += getNumber(values.red_cards) || 0;
        }
      } catch (err) {
        console.error("Statistiche giocatori non disponibili:", match.id, err.message);
      }
    }

    const result = Object.values(players)
      .map(player => ({
        ...player,
        averages: {
          minutes: Number((player.minutes / player.matches).toFixed(2)),
          goals: Number((player.goals / player.matches).toFixed(2)),
          assists: Number((player.assists / player.matches).toFixed(2)),
          shots: Number((player.shots / player.matches).toFixed(2)),
          shots_on_target: Number((player.shots_on_target / player.matches).toFixed(2))
        }
      }))
      .sort((a, b) => b.goals - a.goals);

    res.json({
      ok: true,
      team_id: teamId,
      league_id: leagueId,
      season,
      matches_analyzed: matches.length,
      players: result
    });

  } catch (err) {
    handleError(res, err);
  }
});

// GESTIONE ERRORI
app.use((err, req, res, next) => {
  console.error("Errore server:", err);

  res.status(500).json({
    ok: false,
    error: "Errore interno del server."
  });
});

// FILE DEL SITO WEB
app.use(express.static("public"));

// AVVIO SERVER
app.listen(PORT, () => {
  console.log(`Football Predictor Server attivo sulla porta ${PORT}`);
});
