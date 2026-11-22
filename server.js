const express = require("express");
const rateLimit = require("express-rate-limit");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));

const PORT = process.env.PORT || 10000;
const SPORTAPI_URL = "https://sportapi.ai/api";
const SPORTAPI_KEY = String(process.env.SPORTAPI_KEY || "").trim();
const ACCESS_TOKEN = String(process.env.PREDICTOR_ACCESS_TOKEN || "").trim();

app.use("/api/", rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false
}));

// SUPABASE
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

// AUTENTICAZIONE
function requireAccess(req, res, next) {
  if (!ACCESS_TOKEN) {
    return res.status(503).json({
      ok: false,
      error: "PREDICTOR_ACCESS_TOKEN non configurato su Render."
    });
  }

  const auth = req.get("authorization") || "";
  const supplied = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

  if (!supplied || supplied !== ACCESS_TOKEN) {
    return res.status(401).json({
      ok: false,
      error: "Accesso non autorizzato."
    });
  }
  next();
}

function requireSportApi(req, res, next) {
  if (!SPORTAPI_KEY) {
    return res.status(503).json({
      ok: false,
      error: "SPORTAPI_KEY non configurata su Render."
    });
  }
  next();
}

function requireDatabase(req, res, next) {
  if (!supabase) {
    return res.status(503).json({
      ok: false,
      error: "SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY mancanti."
    });
  }
  next();
}

app.use("/api", (req, res, next) => {
  // Lo stato resta pubblico e non espone segreti; tutte le altre API sono protette.
  if (req.path === "/status") return next();
  return requireAccess(req, res, next);
});

// SPORTAPI: tutte le risposte sono JSON. La chiave resta sul server.
async function sportGet(path) {
  if (!SPORTAPI_KEY) throw new Error("SPORTAPI_KEY non configurata.");

  const response = await fetch(`${SPORTAPI_URL}${path}`, {
    method: "GET",
    headers: {
      "X-Api-Key": SPORTAPI_KEY,
      "Accept": "application/json"
    },
    signal: AbortSignal.timeout(20000)
  });

  const raw = await response.text();
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error("SportAPI ha restituito una risposta non JSON.");
  }

  if (!response.ok) {
    const error = new Error(
      body.error || body.message || `SportAPI HTTP ${response.status}`
    );
    error.status = response.status;
    error.details = body;
    throw error;
  }
  return body;
}

function handleError(res, error) {
  console.error("Errore server:", error.message);
  return res.status(error.status || 500).json({
    ok: false,
    error: error.message,
    ...(error.details ? { details: error.details } : {})
  });
}

function getNumber(value) {
  const n = Number.parseFloat(String(value ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function validNumericId(value) {
  return /^\d+$/.test(String(value || ""));
}

function getHomeName(match) {
  return typeof match.home_team === "string"
    ? match.home_team
    : match.home_team?.name || match.home_name || null;
}

function getAwayName(match) {
  return typeof match.away_team === "string"
    ? match.away_team
    : match.away_team?.name || match.away_name || null;
}

function getHomeId(match) {
  return match.home_id ?? match.home_team?.id ?? null;
}

function getAwayId(match) {
  return match.away_id ?? match.away_team?.id ?? null;
}

function getHomeScore(match) {
  return getNumber(match.home_score ?? match.score_home ?? match.score?.home);
}

function getAwayScore(match) {
  return getNumber(match.away_score ?? match.score_away ?? match.score?.away);
}

function isFinished(match) {
  const status = String(match.status || "").toUpperCase();
  return ["FT", "AET", "PENS", "FINISHED", "COMPLETED"].includes(status) ||
    (getHomeScore(match) !== null && getAwayScore(match) !== null);
}

function normalizeFixture(match, seasonOverride) {
  const leagueId = match.league_id ?? match.league?.id;
  const season = seasonOverride || match.season ||
    String((match.date || match.datetime || "").slice(0, 4));

  return {
    id: String(match.id),
    league_id: String(leagueId ?? "unknown"),
    league_name: match.league_name || match.league?.name || null,
    season: String(season),
    home_team: getHomeName(match) || "Squadra casa",
    away_team: getAwayName(match) || "Squadra ospite",
    match_date: match.kickoff_utc || match.datetime || match.date || null,
    home_goals: getHomeScore(match),
    away_goals: getAwayScore(match),
    status: match.status || null
  };
}

// SALVATAGGIO PARTITE. La chiave primaria è l'ID SportAPI.
async function saveMatchesToDatabase(matches, seasonOverride) {
  if (!supabase) throw new Error("Supabase non configurato.");
  if (!Array.isArray(matches) || matches.length === 0) return 0;

  const rows = matches
    .filter(m => m && m.id !== undefined && getHomeName(m) && getAwayName(m))
    .map(m => normalizeFixture(m, seasonOverride));

  if (!rows.length) return 0;

  const { error } = await supabase.from("matches").upsert(rows, {
    onConflict: "id"
  });
  if (error) throw error;
  return rows.length;
}

async function getLeagueMatchesFromDatabase(leagueId, season) {
  if (!supabase) throw new Error("Supabase non configurato.");
  let query = supabase
    .from("matches")
    .select("*")
    .eq("league_id", String(leagueId))
    .order("match_date", { ascending: true });

  if (season) query = query.eq("season", String(season));
  const { data, error } = await query.limit(5000);
  if (error) throw error;
  return data || [];
}

// MODELLO POISSON
function weightedAverage(sample, key) {
  if (!sample.length) return 0;
  let weightedSum = 0;
  let totalWeight = 0;

  sample.forEach((item, index) => {
    const weight = Math.pow(0.75, index);
    weightedSum += item[key] * weight;
    totalWeight += weight;
  });
  return totalWeight ? weightedSum / totalWeight : 0;
}

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

function getReliability(probability, sampleSize) {
  let score = probability;
  if (sampleSize < 10) score -= (10 - sampleSize) * 2;
  score = Math.max(0, Math.min(100, score));

  return {
    score: Number(score.toFixed(1)),
    level: score >= 75 ? "ALTA" : score >= 60 ? "MEDIA" : "BASSA"
  };
}

function sampleForTeam(matches, teamId, beforeDate) {
  return matches
    .filter(match =>
      match.match_date &&
      new Date(match.match_date) < new Date(beforeDate) &&
      (String(match.home_team_id || match.home_id || "") === String(teamId) ||
       String(match.away_team_id || match.away_id || "") === String(teamId)) &&
      match.home_goals !== null && match.home_goals !== undefined &&
      match.away_goals !== null && match.away_goals !== undefined
    )
    .sort((a, b) => new Date(b.match_date) - new Date(a.match_date))
    .slice(0, 10)
    .map(match => {
      const home = String(match.home_team_id || match.home_id || "") === String(teamId);
      return {
        scored: Number(home ? match.home_goals : match.away_goals),
        conceded: Number(home ? match.away_goals : match.home_goals)
      };
    });
}

// I record storici importati dalla API non hanno sempre gli ID squadra separati.
// Questa funzione ricava i campioni confrontando i nomi delle squadre.
function sampleForTeamByName(matches, teamName, beforeDate) {
  const target = String(teamName || "").trim().toLowerCase();

  return matches
    .filter(match => {
      const date = match.match_date || match.date;
      const home = String(match.home_team || "").trim().toLowerCase();
      const away = String(match.away_team || "").trim().toLowerCase();
      return date && new Date(date) < new Date(beforeDate) &&
        (home === target || away === target) &&
        match.home_goals !== null && match.home_goals !== undefined &&
        match.away_goals !== null && match.away_goals !== undefined;
    })
    .sort((a, b) =>
      new Date(b.match_date || b.date) - new Date(a.match_date || a.date)
    )
    .slice(0, 10)
    .map(match => {
      const home = String(match.home_team).trim().toLowerCase() === target;
      return {
        scored: Number(home ? match.home_goals : match.away_goals),
        conceded: Number(home ? match.away_goals : match.home_goals)
      };
    });
}

function calculatePrediction(fixture, history) {
  const homeName = fixture.home_team || getHomeName(fixture);
  const awayName = fixture.away_team || getAwayName(fixture);
  const fixtureDate = fixture.match_date || fixture.date || fixture.datetime;

  const homeSample = sampleForTeamByName(history, homeName, fixtureDate);
  const awaySample = sampleForTeamByName(history, awayName, fixtureDate);

  if (homeSample.length < 5 || awaySample.length < 5) {
    return {
      ok: false,
      error: "Dati insufficienti: servono almeno 5 risultati precedenti per entrambe le squadre.",
      samples: { home: homeSample.length, away: awaySample.length }
    };
  }

  const homeFor = weightedAverage(homeSample, "scored");
  const homeAgainst = weightedAverage(homeSample, "conceded");
  const awayFor = weightedAverage(awaySample, "scored");
  const awayAgainst = weightedAverage(awaySample, "conceded");

  const homeLambda = Math.max(0.10, Math.min(5, (homeFor + awayAgainst) / 2));
  const awayLambda = Math.max(0.10, Math.min(5, (awayFor + homeAgainst) / 2));
  const matrix = buildGoalModel(homeLambda, awayLambda);

  const sum = fn => matrix.filter(fn)
    .reduce((total, item) => total + item.probability, 0);

  const homeWin = sum(x => x.home > x.away);
  const draw = sum(x => x.home === x.away);
  const awayWin = sum(x => x.home < x.away);
  const over = line => sum(x => x.home + x.away > line);
  const under = line => 1 - over(line);
  const bttsYes = sum(x => x.home > 0 && x.away > 0);
  const sampleSize = Math.min(homeSample.length, awaySample.length);

  const probabilities = {
    "1": percent(homeWin),
    "X": percent(draw),
    "2": percent(awayWin),
    over_1_5: percent(over(1)),
    under_1_5: percent(under(1)),
    over_2_5: percent(over(2)),
    under_2_5: percent(under(2)),
    over_3_5: percent(over(3)),
    under_3_5: percent(under(3)),
    btts_yes: percent(bttsYes),
    btts_no: percent(1 - bttsYes)
  };
    const reliability = {};

  for (const [market, probability] of Object.entries(probabilities)) {
    reliability[market] = getReliability(probability, sampleSize);
  }

  const exactScores = [...matrix]
    .sort((a, b) => b.probability - a.probability)
    .slice(0, 5)
    .map(item => ({
      score: `${item.home}-${item.away}`,
      probability: percent(item.probability)
    }));

  return {
    ok: true,
    model: "Poisson con medie ponderate delle ultime 10 partite (peso 0,75)",
    expected_goals: {
      home: Number(homeLambda.toFixed(2)),
      away: Number(awayLambda.toFixed(2))
    },
    probabilities,
    reliability,
    samples: {
      home: homeSample.length,
      away: awaySample.length
    },
    exact_scores: exactScores
  };
}

// STATUS SERVER
app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    server: "Football Predictor AI",
    provider: "SportAPI",
    sportapiKeyConfigured: Boolean(SPORTAPI_KEY),
    sportapiKeyLength: SPORTAPI_KEY.length,
    databaseConfigured: Boolean(supabase),
    accessTokenConfigured: Boolean(ACCESS_TOKEN)
  });
});

// TEST COLLEGAMENTO SPORTAPI
app.get("/api/test-sportapi", requireSportApi, async (req, res) => {
  try {
    const body = await sportGet("/leagues");
    res.json({
      ok: true,
      connected: true,
      response: body
    });
  } catch (error) {
    handleError(res, error);
  }
});

// TEST DATABASE
app.get("/api/test-database", requireDatabase, async (req, res) => {
  try {
    const { error } = await supabase
      .from("matches")
      .select("id")
      .limit(1);

    if (error) throw error;

    res.json({
      ok: true,
      connected: true,
      database: "Supabase",
      message: "Collegamento al database riuscito."
    });
  } catch (error) {
    handleError(res, error);
  }
});

// CAMPIONATI
app.get("/api/leagues", requireSportApi, async (req, res) => {
  try {
    const body = await sportGet("/leagues");
    res.json({ ok: true, response: body });
  } catch (error) {
    handleError(res, error);
  }
});

// PARTITE DI UNA DATA
app.get("/api/fixtures", requireSportApi, async (req, res) => {
  const date = String(req.query.date || "");

  if (!validDate(date)) {
    return res.status(400).json({
      ok: false,
      error: "Inserisci date=YYYY-MM-DD."
    });
  }

  try {
    const body = await sportGet(`/fixtures/date/${encodeURIComponent(date)}`);
    const matches = Array.isArray(body.data) ? body.data : [];

    res.json({
      ok: true,
      date,
      results: matches.length,
      response: matches
    });
  } catch (error) {
    handleError(res, error);
  }
});

// SINCRONIZZA UNA DATA IN SUPABASE
app.post("/api/sync/date/:date", requireSportApi, requireDatabase, async (req, res) => {
  const date = req.params.date;

  if (!validDate(date)) {
    return res.status(400).json({
      ok: false,
      error: "Data non valida: usa YYYY-MM-DD."
    });
  }

  try {
    const body = await sportGet(`/fixtures/date/${encodeURIComponent(date)}`);
    const matches = Array.isArray(body.data) ? body.data : [];
    const season = String(req.query.season || date.slice(0, 4));
    const saved = await saveMatchesToDatabase(matches, season);

    res.json({
      ok: true,
      date,
      received_matches: matches.length,
      saved_matches: saved,
      season
    });
  } catch (error) {
    handleError(res, error);
  }
});

// SINCRONIZZA UN INTERVALLO MASSIMO DI 14 GIORNI
app.post("/api/sync/range", requireSportApi, requireDatabase, async (req, res) => {
  const from = String(req.query.from || "");
  const to = String(req.query.to || "");

  if (!validDate(from) || !validDate(to) || new Date(to) < new Date(from)) {
    return res.status(400).json({
      ok: false,
      error: "Usa from=YYYY-MM-DD e to=YYYY-MM-DD."
    });
  }

  const start = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  const days = Math.round((end - start) / 86400000) + 1;

  if (days > 14) {
    return res.status(400).json({
      ok: false,
      error: "Massimo 14 giorni per richiesta."
    });
  }

  let received = 0;
  let saved = 0;
  const errors = [];

  for (let i = 0; i < days; i++) {
    const dateObject = new Date(start);
    dateObject.setUTCDate(dateObject.getUTCDate() + i);
    const date = dateObject.toISOString().slice(0, 10);

    try {
      const body = await sportGet(`/fixtures/date/${date}`);
      const matches = Array.isArray(body.data) ? body.data : [];

      received += matches.length;
      saved += await saveMatchesToDatabase(
        matches,
        String(req.query.season || date.slice(0, 4))
      );
    } catch (error) {
      errors.push({ date, error: error.message });
    }
  }

  res.json({
    ok: errors.length === 0,
    from,
    to,
    days_requested: days,
    received_matches: received,
    saved_matches: saved,
    errors
  });
});

// DETTAGLIO PARTITA
app.get("/api/fixture/:id", requireSportApi, async (req, res) => {
  if (!validNumericId(req.params.id)) {
    return res.status(400).json({
      ok: false,
      error: "ID partita non valido."
    });
  }

  try {
    const body = await sportGet(`/fixtures/${req.params.id}`);
    res.json({ ok: true, response: body });
  } catch (error) {
    handleError(res, error);
  }
});

// STATISTICHE, EVENTI E FORMAZIONI
const fixtureSubroutes = [
  "statistics",
  "events",
  "lineups"
];

for (const route of fixtureSubroutes) {
  app.get(`/api/fixture/:id/${route}`, requireSportApi, async (req, res) => {
    if (!validNumericId(req.params.id)) {
      return res.status(400).json({
        ok: false,
        error: "ID partita non valido."
      });
    }

    try {
      const body = await sportGet(
        `/fixtures/${req.params.id}/${route}`
      );

      res.json({ ok: true, response: body });
    } catch (error) {
      handleError(res, error);
    }
  });
}

// SQUADRA
app.get("/api/team/:id", requireSportApi, async (req, res) => {
  if (!validNumericId(req.params.id)) {
    return res.status(400).json({
      ok: false,
      error: "ID squadra non valido."
    });
  }

  try {
    const body = await sportGet(`/teams/${req.params.id}`);
    res.json({ ok: true, response: body });
  } catch (error) {
    handleError(res, error);
  }
});

// ROSA SQUADRA
app.get("/api/team/:id/players", requireSportApi, async (req, res) => {
  if (!validNumericId(req.params.id)) {
    return res.status(400).json({
      ok: false,
      error: "ID squadra non valido."
    });
  }

  try {
    const body = await sportGet(`/teams/${req.params.id}/squad`);
    res.json({ ok: true, response: body });
  } catch (error) {
    handleError(res, error);
  }
});

// CLASSIFICHE
app.get("/api/standings/:leagueId", requireSportApi, async (req, res) => {
  if (!validNumericId(req.params.leagueId)) {
    return res.status(400).json({
      ok: false,
      error: "ID campionato non valido."
    });
  }

  try {
    const body = await sportGet(`/standings/${req.params.leagueId}`);
    res.json({ ok: true, response: body });
  } catch (error) {
    handleError(res, error);
  }
});

// PARTITE DEL CAMPIONATO SALVATE NEL DATABASE
app.get("/api/league/:id/matches", requireDatabase, async (req, res) => {
  const leagueId = req.params.id;
  const season = req.query.season ? String(req.query.season) : null;

  if (!validNumericId(leagueId)) {
    return res.status(400).json({
      ok: false,
      error: "ID campionato non valido."
    });
  }

  try {
    const matches = await getLeagueMatchesFromDatabase(leagueId, season);

    res.json({
      ok: true,
      league_id: leagueId,
      season,
      matches_count: matches.length,
      matches
    });
  } catch (error) {
    handleError(res, error);
  }
});

// PRONOSTICO PARTITA
app.get("/api/fixture/:id/predictions", requireDatabase, async (req, res) => {
  const matchId = String(req.params.id);

  try {
    const { data: fixture, error } = await supabase
      .from("matches")
      .select("*")
      .eq("id", matchId)
      .maybeSingle();

    if (error) throw error;

    if (!fixture) {
      return res.status(404).json({
        ok: false,
        error: "Partita non trovata in Supabase. Sincronizza prima la data."
      });
    }

    const history = await getLeagueMatchesFromDatabase(
      fixture.league_id,
      fixture.season
    );

    const prediction = calculatePrediction(fixture, history);

    if (!prediction.ok) {
      return res.status(422).json({
        ok: false,
        match: fixture,
        ...prediction
      });
    }

    res.json({
      ok: true,
      model: prediction.model,
      match: {
        id: fixture.id,
        league: fixture.league_name,
        season: fixture.season,
        home_team: fixture.home_team,
        away_team: fixture.away_team,
        date: fixture.match_date,
        status: fixture.status
      },
      samples: prediction.samples,
      expected_goals: prediction.expected_goals,
      probabilities: prediction.probabilities,
      reliability: prediction.reliability,
      exact_scores: prediction.exact_scores,
      disclaimer: "Pronostico statistico, non garanzia del risultato."
    });
  } catch (error) {
    handleError(res, error);
  }
});
// ==========================================
// BACKTEST DEL MODELLO
// ==========================================

app.get("/api/backtest/:leagueId", requireDatabase, async (req, res) => {
  try {
    const leagueId = String(req.params.leagueId);
    const limit = Math.min(
      Math.max(Number(req.query.limit) || 100, 1),
      300
    );

    const { data, error } = await supabase
      .from("matches")
      .select("*")
      .eq("league_id", leagueId)
      .not("home_goals", "is", null)
      .not("away_goals", "is", null)
      .order("match_date", { ascending: true })
      .limit(limit);

    if (error) throw error;

    const history = data || [];
    const results = [];

    for (const match of history) {
      if (
        match.home_goals === null ||
        match.away_goals === null ||
        !match.match_date
      ) continue;

      const prediction = calculatePrediction(
        match,
        history,
        match.match_date
      );

      if (!prediction || !prediction.probabilities) continue;

      const p = prediction.probabilities;
      const actual = {
        home: Number(match.home_goals),
        away: Number(match.away_goals)
      };

      const actualResult =
        actual.home > actual.away ? "1" :
        actual.home < actual.away ? "2" : "X";

      results.push({
        match_id: match.id,
        home_team: match.home_team,
        away_team: match.away_team,
        actual_result: actualResult,
        predicted_result: ["1", "X", "2"].sort(
          (a, b) => p[b] - p[a]
        )[0],
        correct_1x2:
          ["1", "X", "2"].sort((a, b) => p[b] - p[a])[0] === actualResult,
        actual_goals: actual.home + actual.away,
        probabilities: p
      });
    }

    const evaluated = results.length;
    const correct = results.filter(r => r.correct_1x2).length;

    res.json({
      ok: true,
      league_id: leagueId,
      requested_matches: limit,
      evaluated_matches: evaluated,
      accuracy_by_market: {
        "1X2": {
          evaluated,
          correct,
          accuracy: evaluated
            ? Number((correct / evaluated * 100).toFixed(2))
            : 0
        }
      },
      results
    });
  } catch (error) {
    handleError(res, error);
  }
});


// ==========================================
// MEDIE E STATISTICHE SQUADRA
// ==========================================

app.get("/api/team/:id/averages", requireDatabase, async (req, res) => {
  try {
    const teamId = String(req.params.id);
    const limit = Math.min(
      Math.max(Number(req.query.limit) || 10, 1),
      30
    );

    const response = await sportGet(`/teams/${teamId}`);
    const teamData = response?.response?.[0] || response?.data || response;
    const teamName =
      teamData?.team?.name ||
      teamData?.name ||
      teamData?.team_name;

    if (!teamName) {
      return res.status(404).json({
        ok: false,
        error: "Squadra non trovata nella risposta del provider."
      });
    }

    const { data, error } = await supabase
      .from("matches")
      .select("*")
      .or(`home_team.eq.${teamName},away_team.eq.${teamName}`)
      .not("home_goals", "is", null)
      .not("away_goals", "is", null)
      .order("match_date", { ascending: false })
      .limit(limit);

    if (error) throw error;

    const matches = data || [];

    if (!matches.length) {
      return res.json({
        ok: true,
        team: teamName,
        matches_analyzed: 0,
        message: "Nessuna partita storica disponibile."
      });
    }

    let goalsFor = 0;
    let goalsAgainst = 0;
    let wins = 0;
    let draws = 0;
    let losses = 0;

    for (const match of matches) {
      const isHome = match.home_team === teamName;
      const scored = Number(
        isHome ? match.home_goals : match.away_goals
      );
      const conceded = Number(
        isHome ? match.away_goals : match.home_goals
      );

      goalsFor += scored;
      goalsAgainst += conceded;

      if (scored > conceded) wins++;
      else if (scored === conceded) draws++;
      else losses++;
    }

    res.json({
      ok: true,
      team: teamName,
      matches_analyzed: matches.length,
      averages: {
        goals_scored: Number((goalsFor / matches.length).toFixed(2)),
        goals_conceded: Number((goalsAgainst / matches.length).toFixed(2))
      },
      results: { wins, draws, losses }
    });
  } catch (error) {
    handleError(res, error);
  }
});


// ==========================================
// ROSA E GIOCATORI DELLA SQUADRA
// ==========================================

app.get("/api/team/:id/player-averages", async (req, res) => {
  try {
    const teamId = String(req.params.id);
    const response = await sportGet(`/teams/${teamId}/players`);

    res.json({
      ok: true,
      team_id: teamId,
      data: response,
      note: "Dati restituiti dal provider. Le medie individuali richiedono statistiche giocatore verificate."
    });
  } catch (error) {
    handleError(res, error);
  }
});


// ==========================================
// GENERATORE MULTIPLE
// ==========================================

app.get("/api/multiples", requireDatabase, async (req, res) => {
  try {
    const date = String(req.query.date || "").trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({
        ok: false,
        error: "Inserisci una data valida: YYYY-MM-DD."
      });
    }

    const maxMatches = Math.min(
      Math.max(Number(req.query.max_matches) || 10, 1),
      30
    );

    const minProbability = Math.min(
      Math.max(Number(req.query.min_probability) || 65, 50),
      95
    );

    const { data: fixtures, error } = await supabase
      .from("matches")
      .select("*")
      .gte("match_date", `${date}T00:00:00`)
      .lt("match_date", `${date}T23:59:59.999`)
      .order("match_date", { ascending: true });

    if (error) throw error;

    const selected = [];
    const historyCache = {};

    for (const match of fixtures || []) {
      if (selected.length >= maxMatches) break;

      const leagueId = String(match.league_id);
      const season = String(match.season);
      const cacheKey = `${leagueId}_${season}`;

      if (!historyCache[cacheKey]) {
        const { data, error: historyError } = await supabase
          .from("matches")
          .select("*")
          .eq("league_id", leagueId)
          .eq("season", season)
          .not("home_goals", "is", null)
          .not("away_goals", "is", null)
          .order("match_date", { ascending: false })
          .limit(500);

        if (historyError) throw historyError;
        historyCache[cacheKey] = data || [];
      }

      const prediction = calculatePrediction(
        match,
        historyCache[cacheKey],
        match.match_date
      );

      if (!prediction?.probabilities) continue;

      const markets = prediction.probabilities;
      const candidates = Object.entries(markets)
        .filter(([market, probability]) =>
          Number.isFinite(Number(probability)) &&
          Number(probability) >= minProbability
        )
        .sort((a, b) => Number(b[1]) - Number(a[1]));

      if (!candidates.length) continue;

      const [market, probability] = candidates[0];

      selected.push({
        match_id: match.id,
        league: match.league_name,
        home_team: match.home_team,
        away_team: match.away_team,
        market,
        probability: Number(probability)
      });
    }

    const combinedProbability = selected.length
      ? selected.reduce(
          (total, item) => total * item.probability / 100,
          1
        ) * 100
      : 0;

    res.json({
      ok: true,
      date,
      max_matches: maxMatches,
      minimum_probability: minProbability,
      selected_matches: selected.length,
      estimated_combined_probability: Number(
        combinedProbability.toFixed(4)
      ),
      selections: selected,
      warning: "Le probabilità sono stime del modello, non garanzie. Le selezioni non sono necessariamente indipendenti."
    });
  } catch (error) {
    handleError(res, error);
  }
});


// ==========================================
// QUOTE
// ==========================================

app.get("/api/fixture/:id/odds", (req, res) => {
  res.status(501).json({
    ok: false,
    available: false,
    message: "Il collegamento a un provider di quote non è ancora configurato."
  });
});


// ==========================================
// PAGINA PRINCIPALE
// ==========================================

app.get("/", (req, res) => {
  res.json({
    ok: true,
    server: "Football Predictor AI",
    version: "2.0.0",
    provider: "SportAPI",
    message: "Football Predictor API attiva."
  });
});


// ==========================================
// FILE STATICI
// ==========================================

app.use(express.static("public"));


// ==========================================
// ROTTA NON TROVATA
// ==========================================

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "Endpoint non trovato.",
    path: req.originalUrl
  });
});


// ==========================================
// GESTIONE ERRORI
// ==========================================

app.use((error, req, res, next) => {
  console.error("Errore server:", error.message);

  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    ok: false,
    error: "Errore interno del server."
  });
});


// ==========================================
// AVVIO SERVER
// ==========================================

app.listen(PORT, () => {
  console.log(`Football Predictor AI attivo sulla porta ${PORT}`);
  console.log("SportAPI key configurata:", Boolean(SPORTAPI_KEY));
  console.log("Access token configurato:", Boolean(ACCESS_TOKEN));
  console.log("Supabase configurato:", Boolean(supabase));
});
