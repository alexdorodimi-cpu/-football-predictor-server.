const express = require("express");
const rateLimit = require("express-rate-limit");
const { createClient } = require("@supabase/supabase-js");
const path = require("path");

const app = express();

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));

const PORT = process.env.PORT || 10000;
const PITCHAPI_URL = "https://api.pitchapi.dev/v1";
const PITCHAPI_KEY = String(process.env.PITCHAPI_KEY || "").trim();
const ACCESS_TOKEN = String(process.env.PREDICTOR_ACCESS_TOKEN || "").trim();

app.use("/api/", rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false
}));

// ==========================================
// SUPABASE
// ==========================================

let supabase = null;

if (
  process.env.SUPABASE_URL &&
  process.env.SUPABASE_SERVICE_ROLE_KEY
) {
  supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

// ==========================================
// AUTENTICAZIONE
// ==========================================

function requireAccess(req, res, next) {
  if (!ACCESS_TOKEN) {
    return res.status(503).json({
      ok: false,
      error: "PREDICTOR_ACCESS_TOKEN non configurato su Render."
    });
  }

  const auth = req.get("authorization") || "";
  const supplied = auth.startsWith("Bearer ")
    ? auth.slice(7).trim()
    : "";

  if (!supplied || supplied !== ACCESS_TOKEN) {
    return res.status(401).json({
      ok: false,
      error: "Accesso non autorizzato."
    });
  }

  next();
}

function requireSportApi(req, res, next) {
  if (!PITCHAPI_KEY) {
    return res.status(503).json({
      ok: false,
      error: "PITCHAPI_KEY non configurata su Render."
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

// Protezione di tutte le API tranne status
app.use("/api", (req, res, next) => {
  if (req.path === "/status") {
    return next();
  }

  return requireAccess(req, res, next);
});

// ==========================================
// PITCHAPI
// ==========================================

async function sportGet(endpoint) {
  if (!PITCHAPI_KEY) {
    throw new Error("PITCHAPI_KEY non configurata.");
  }

  const response = await fetch(
    `${PITCHAPI_URL}${endpoint}`,
    {
      method: "GET",
      headers: {
        "X-API-KEY": PITCHAPI_KEY,
        "Accept": "application/json"
      },
      signal: AbortSignal.timeout(20000)
    }
  );

  const raw = await response.text();

  let body;

  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(
      "PitchAPI ha restituito una risposta non JSON."
    );
  }

  if (!response.ok) {
    const error = new Error(
      body?.error?.message ||
      body?.error ||
      body?.message ||
      `PitchAPI HTTP ${response.status}`
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

// ==========================================
// FUNZIONI GENERALI
// ==========================================

function getNumber(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const n = Number.parseFloat(
    String(value).replace(",", ".")
  );

  return Number.isFinite(n) ? n : null;
}

function validDate(value) {
  const date = String(value || "");

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return false;
  }

  const parsed = new Date(`${date}T00:00:00Z`);

  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === date
  );
}

function validNumericId(value) {
  return /^[A-Za-z]_[A-Za-z0-9]+$/.test(
    String(value || "")
  );
}

function getMatches(body) {
  if (Array.isArray(body?.data?.matches)) {
    return body.data.matches;
  }

  if (Array.isArray(body?.response)) {
    return body.response;
  }

  if (Array.isArray(body?.data)) {
    return body.data;
  }

  if (Array.isArray(body?.matches)) {
    return body.matches;
  }

  if (Array.isArray(body?.fixtures)) {
    return body.fixtures;
  }

  return [];
}

function getHomeName(match) {
  return typeof match.home_team === "string"
    ? match.home_team
    : match.home_team?.name ||
      match.home_name ||
      match.home?.name ||
      null;
}

function getAwayName(match) {
  return typeof match.away_team === "string"
    ? match.away_team
    : match.away_team?.name ||
      match.away_name ||
      match.away?.name ||
      null;
}

function getHomeId(match) {
  return (
    match.home_id ??
    match.home_team_id ??
    match.home_team?.id ??
    match.home?.id ??
    null
  );
}

function getAwayId(match) {
  return (
    match.away_id ??
    match.away_team_id ??
    match.away_team?.id ??
    match.away?.id ??
    null
  );
}

function getHomeScore(match) {
  return getNumber(
    match.home_score ??
    match.score_home ??
    match.home_goals ??
    match.score?.home
  );
}

function getAwayScore(match) {
  return getNumber(
    match.away_score ??
    match.score_away ??
    match.away_goals ??
    match.score?.away
  );
}

function isFinished(match) {
  const status = String(
    match.status || ""
  ).toUpperCase();

  return [
    "FT",
    "AET",
    "PENS",
    "FINISHED",
    "COMPLETED"
  ].includes(status);
}

// ==========================================
// NORMALIZZAZIONE PARTITE
// ==========================================

function normalizeFixture(match, seasonOverride) {
  const leagueId =
    match.league_id ??
    match.league?.id ??
    match.competition?.id;

  // PitchAPI utilizza time_utc
  const date =
    match.time_utc ||
    match.kickoff_utc ||
    match.datetime ||
    match.date ||
    match.match_date ||
    null;

    const matchYear = date
    ? Number(String(date).slice(0, 4))
    : null;

  const matchMonth = date
    ? Number(String(date).slice(5, 7))
    : null;

  const inferredSeason = matchYear && matchMonth
    ? matchMonth >= 7
      ? `${matchYear}/${matchYear + 1}`
      : `${matchYear - 1}/${matchYear}`
    : null;

  const season =
    seasonOverride ||
    match.season ||
    inferredSeason;

  return {
    id: String(match.id),

    league_id: String(leagueId ?? "unknown"),

    league_name:
      match.league_name ||
      match.league?.name ||
      match.competition?.name ||
      null,

    season: String(season || ""),

    home_team: getHomeName(match) || "Squadra casa",
    away_team: getAwayName(match) || "Squadra ospite",

    home_team_id: getHomeId(match),
    away_team_id: getAwayId(match),

    match_date: date,

    home_goals: getHomeScore(match),
    away_goals: getAwayScore(match),

    status: match.status || null
  };
}

// ==========================================
// SALVATAGGIO SUPABASE
// ==========================================

async function saveMatchesToDatabase(
  matches,
  seasonOverride
) {
  if (!supabase) {
    throw new Error("Supabase non configurato.");
  }

  if (!Array.isArray(matches) || matches.length === 0) {
    return 0;
  }

  const rows = matches
    .filter(match =>
      match &&
      match.id !== undefined &&
      getHomeName(match) &&
      getAwayName(match)
    )
    .map(match =>
      normalizeFixture(match, seasonOverride)
    )
    .filter(match =>
      match.id &&
      match.league_id &&
      match.home_team &&
      match.away_team
    );

  if (!rows.length) {
    return 0;
  }

  const { error } = await supabase
    .from("matches")
    .upsert(rows, { onConflict: "id" });

  if (error) {
    throw error;
  }

  return rows.length;
}

async function getLeagueMatchesFromDatabase(
  leagueId,
  season
) {
  if (!supabase) {
    throw new Error("Supabase non configurato.");
  }

  let query = supabase
    .from("matches")
    .select("*")
    .eq("league_id", String(leagueId))
    .order("match_date", { ascending: true });

  if (season) {
    query = query.eq("season", String(season));
  }

  const { data, error } = await query.limit(5000);

  if (error) {
    throw error;
  }

  return data || [];
}

// ==========================================
// MODELLO POISSON
// ==========================================

function weightedAverage(sample, key) {
  if (!sample.length) {
    return 0;
  }

  let weightedSum = 0;
  let totalWeight = 0;

  sample.forEach((item, index) => {
    const weight = Math.pow(0.75, index);
    const value = getNumber(item[key]);

    if (value === null) {
      return;
    }

    weightedSum += value * weight;
    totalWeight += weight;
  });

  return totalWeight
    ? weightedSum / totalWeight
    : 0;
}

function poissonProbability(lambda, goals) {
  if (lambda <= 0) {
    return goals === 0 ? 1 : 0;
  }

  let factorial = 1;

  for (let i = 2; i <= goals; i++) {
    factorial *= i;
  }

  return (
    Math.exp(-lambda) *
    Math.pow(lambda, goals) /
    factorial
  );
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

      matrix.push({
        home,
        away,
        probability
      });

      total += probability;
    }
  }

  if (total > 0) {
    for (const item of matrix) {
      item.probability /= total;
    }
  }

  return matrix;
}

function percent(value) {
  return Number((value * 100).toFixed(1));
}

function getReliability(probability, sampleSize) {
  let score = probability;

  if (sampleSize < 10) {
    score -= (10 - sampleSize) * 2;
  }

  score = Math.max(0, Math.min(100, score));

  return {
    score: Number(score.toFixed(1)),
    level:
      score >= 75 ? "ALTA" :
      score >= 60 ? "MEDIA" :
      "BASSA"
  };
}

// ==========================================
// CAMPIONI STORICI
// ==========================================

function sampleForTeam(
  matches,
  teamId,
  beforeDate
) {
  return matches
    .filter(match => {
      const date = match.match_date || match.date;

      return (
        date &&
        new Date(date) < new Date(beforeDate) &&
        (
          String(
            match.home_team_id ||
            match.home_id ||
            ""
          ) === String(teamId) ||
          String(
            match.away_team_id ||
            match.away_id ||
            ""
          ) === String(teamId)
        ) &&
        match.home_goals !== null &&
        match.home_goals !== undefined &&
        match.away_goals !== null &&
        match.away_goals !== undefined
      );
    })
    .sort((a, b) =>
      new Date(b.match_date || b.date) -
      new Date(a.match_date || a.date)
    )
    .slice(0, 10)
    .map(match => {
      const home =
        String(
          match.home_team_id ||
          match.home_id ||
          ""
        ) === String(teamId);

      return {
        scored: Number(
          home ? match.home_goals : match.away_goals
        ),
        conceded: Number(
          home ? match.away_goals : match.home_goals
        )
      };
    });
}

function sampleForTeamByName(
  matches,
  teamName,
  beforeDate
) {
  const target = String(teamName || "")
    .trim()
    .toLowerCase();

  return matches
    .filter(match => {
      const date = match.match_date || match.date;

      const home = String(match.home_team || "")
        .trim()
        .toLowerCase();

      const away = String(match.away_team || "")
        .trim()
        .toLowerCase();

      const homeGoals = getNumber(match.home_goals);
      const awayGoals = getNumber(match.away_goals);

      return (
        date &&
        new Date(date) < new Date(beforeDate) &&
        (home === target || away === target) &&
        homeGoals !== null &&
        awayGoals !== null
      );
    })
    .sort((a, b) =>
      new Date(b.match_date || b.date) -
      new Date(a.match_date || a.date)
    )
    .slice(0, 10)
    .map(match => {
      const home =
        String(match.home_team || "")
          .trim()
          .toLowerCase() === target;

      return {
        scored: Number(
          home ? match.home_goals : match.away_goals
        ),
        conceded: Number(
          home ? match.away_goals : match.home_goals
        )
      };
    });
}

// ==========================================
// CALCOLO PRONOSTICO
// ==========================================

function sampleForTeamByVenue(matches, teamName, beforeDate, venue) {
  const target = String(teamName || "").trim().toLowerCase();

  return matches
    .filter(match => {
      const date = match.match_date || match.date;
      const home = String(match.home_team || "").trim().toLowerCase();
      const away = String(match.away_team || "").trim().toLowerCase();
      const homeGoals = getNumber(match.home_goals);
      const awayGoals = getNumber(match.away_goals);

      if (
        !date ||
        new Date(date) >= new Date(beforeDate) ||
        homeGoals === null ||
        awayGoals === null
      ) return false;

      if (venue === "home") return home === target;
      if (venue === "away") return away === target;

      return false;
    })
    .sort((a, b) =>
      new Date(b.match_date || b.date) -
      new Date(a.match_date || a.date)
    )
    .slice(0, 5)
    .map(match => {
      const isHome =
        String(match.home_team || "").trim().toLowerCase() === target;

      return {
        scored: Number(isHome ? match.home_goals : match.away_goals),
        conceded: Number(isHome ? match.away_goals : match.home_goals)
      };
    });
}

function calculatePrediction(fixture, history) {
  const homeName = fixture.home_team || getHomeName(fixture);
  const awayName = fixture.away_team || getAwayName(fixture);
  const fixtureDate = fixture.match_date || fixture.date || fixture.datetime;

  if (!fixtureDate || !homeName || !awayName) {
    return {
      ok: false,
      error: "Dati della partita incompleti."
    };
  }

  // Ultime 10 partite precedenti alla partita da prevedere.
  const homeSample = sampleForTeamByName(history, homeName, fixtureDate);
  const awaySample = sampleForTeamByName(history, awayName, fixtureDate);

  // Ultime 5 partite giocate in casa e in trasferta.
  const homeVenueSample = sampleForTeamByVenue(
    history, homeName, fixtureDate, "home"
  );

  const awayVenueSample = sampleForTeamByVenue(
    history, awayName, fixtureDate, "away"
  );

  if (homeSample.length < 5 || awaySample.length < 5) {
    return {
      ok: false,
      error: "Dati insufficienti: servono almeno 5 risultati precedenti per entrambe le squadre.",
      samples: {
        home: homeSample.length,
        away: awaySample.length
      }
    };
  }

  // Media delle ultime partite del campionato, senza risultati futuri.
  const priorMatches = history
    .filter(match => {
      const date = match.match_date || match.date;

      return (
        date &&
        new Date(date) < new Date(fixtureDate) &&
        getNumber(match.home_goals) !== null &&
        getNumber(match.away_goals) !== null
      );
    })
    .sort((a, b) =>
      new Date(a.match_date || a.date) -
      new Date(b.match_date || b.date)
    );

  const leagueSample = priorMatches.slice(-300);

  const leagueHomeAverage = leagueSample.length
    ? leagueSample.reduce(
        (sum, match) => sum + Number(match.home_goals), 0
      ) / leagueSample.length
    : 1.35;

  const leagueAwayAverage = leagueSample.length
    ? leagueSample.reduce(
        (sum, match) => sum + Number(match.away_goals), 0
      ) / leagueSample.length
    : 1.10;

  // Medie ponderate della forma generale.
  const homeFor = weightedAverage(homeSample, "scored");
  const homeAgainst = weightedAverage(homeSample, "conceded");
  const awayFor = weightedAverage(awaySample, "scored");
  const awayAgainst = weightedAverage(awaySample, "conceded");

  const overallHomeLambda = (homeFor + awayAgainst) / 2;
  const overallAwayLambda = (awayFor + homeAgainst) / 2;

  // Medie specifiche casa e trasferta.
  const homeVenueReady = homeVenueSample.length >= 3;
  const awayVenueReady = awayVenueSample.length >= 3;

  const homeVenueFor = homeVenueReady
    ? weightedAverage(homeVenueSample, "scored")
    : homeFor;

  const homeVenueAgainst = homeVenueReady
    ? weightedAverage(homeVenueSample, "conceded")
    : homeAgainst;

  const awayVenueFor = awayVenueReady
    ? weightedAverage(awayVenueSample, "scored")
    : awayFor;

  const awayVenueAgainst = awayVenueReady
    ? weightedAverage(awayVenueSample, "conceded")
    : awayAgainst;

  const safeHomeLeague = Math.max(0.4, leagueHomeAverage);
  const safeAwayLeague = Math.max(0.4, leagueAwayAverage);

  const venueHomeLambda =
    safeHomeLeague *
    (homeVenueFor / safeHomeLeague) *
    (awayVenueAgainst / safeHomeLeague);

  const venueAwayLambda =
    safeAwayLeague *
    (awayVenueFor / safeAwayLeague) *
    (homeVenueAgainst / safeHomeLeague);

  // 40% forma generale e 60% rendimento casa/trasferta.
  const homeLambda = Math.max(
    0.10,
    Math.min(5,
      0.4 * overallHomeLambda + 0.6 * venueHomeLambda
    )
  );

  const awayLambda = Math.max(
    0.10,
    Math.min(5,
      0.4 * overallAwayLambda + 0.6 * venueAwayLambda
    )
  );

  // Matrice delle probabilità Poisson.
  const matrix = buildGoalModel(homeLambda, awayLambda);

  const sum = fn =>
    matrix
      .filter(fn)
      .reduce((total, item) => total + item.probability, 0);

  const homeWin = sum(x => x.home > x.away);
  const draw = sum(x => x.home === x.away);
  const awayWin = sum(x => x.home < x.away);

  const over = line =>
    sum(x => x.home + x.away > line);

  const under = line =>
    1 - over(line);

  const bttsYes = sum(
    x => x.home > 0 && x.away > 0
  );

  const sampleSize = Math.min(
    homeSample.length,
    awaySample.length
  );

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

  // Affidabilità indicativa dei mercati.
  const reliability = {};

  for (const [market, probability] of Object.entries(probabilities)) {
    reliability[market] = getReliability(
      probability,
      sampleSize
    );
  }

  // I cinque risultati esatti con probabilità più alta.
  const exactScores = [...matrix]
    .sort((a, b) => b.probability - a.probability)
    .slice(0, 5)
    .map(item => ({
      score: `${item.home}-${item.away}`,
      probability: percent(item.probability)
    }));

  return {
    ok: true,

    model: "Poisson avanzato: forma recente, rendimento casa/trasferta e media campionato",

    expected_goals: {
      home: Number(homeLambda.toFixed(2)),
      away: Number(awayLambda.toFixed(2)),
      total: Number((homeLambda + awayLambda).toFixed(2))
    },

    probabilities,
    reliability,

    samples: {
      home: homeSample.length,
      away: awaySample.length,
      home_at_home: homeVenueSample.length,
      away_away: awayVenueSample.length,
      league_matches: leagueSample.length
    },

    model_inputs: {
      league_home_goals_average: Number(leagueHomeAverage.toFixed(2)),
      league_away_goals_average: Number(leagueAwayAverage.toFixed(2)),
      venue_split_used: homeVenueReady && awayVenueReady
    },

    exact_scores: exactScores
  };
}

// ==========================================
// STATUS SERVER E CAMPIONATI
// ==========================================

app.get("/api/status", async (req, res) => {
  let leagues = [];
  let providerConnected = false;

  if (PITCHAPI_KEY) {
    try {
      const body = await sportGet("/leagues");

      leagues = Array.isArray(body?.data?.leagues)
        ? body.data.leagues
        : getMatches(body);

      if (
        !leagues.length &&
        Array.isArray(body?.data)
      ) {
        leagues = body.data;
      }

      if (
        !leagues.length &&
        Array.isArray(body?.leagues)
      ) {
        leagues = body.leagues;
      }

      providerConnected = true;
    } catch (error) {
      console.error(
        "PitchAPI status:",
        error.message
      );
    }
  }

  res.json({
    ok: true,
    server: "Football Predictor AI",
    provider: "PitchAPI",
    pitchapiKeyConfigured: Boolean(PITCHAPI_KEY),
    providerConnected,
    leagues,
    leagueCount: leagues.length,
    databaseConfigured: Boolean(supabase),
    accessTokenConfigured: Boolean(ACCESS_TOKEN)
  });
});

 // ==========================================
// STATUS E TEST
// ==========================================

app.get(
  "/api/test-pitchapi",
  requireSportApi,
  async (req, res) => {
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
  }
);

app.get(
  "/api/test-database",
  requireDatabase,
  async (req, res) => {
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
  }
);

// ==========================================
// CAMPIONATI
// ==========================================

app.get(
  "/api/leagues",
  requireSportApi,
  async (req, res) => {
    try {
      const body = await sportGet("/leagues");

      res.json({
        ok: true,
        response: body
      });
    } catch (error) {
      handleError(res, error);
    }
  }
);

// ==========================================
// PARTITE DI UNA DATA
// ==========================================

app.get(
  "/api/fixtures",
  requireSportApi,
  async (req, res) => {
    const date = String(req.query.date || "");

    if (!validDate(date)) {
      return res.status(400).json({
        ok: false,
        error: "Inserisci date=YYYY-MM-DD."
      });
    }

    try {
      const status = ["played", "upcoming", "all"].includes(
  String(req.query.status || "all")
)
  ? String(req.query.status || "all")
  : "all";

const body = await sportGet(
  `/date/${encodeURIComponent(date)}?status=${encodeURIComponent(status)}`
);

      const matches = getMatches(body);

      let savedMatches = 0;
      let saveError = null;

      // Salvataggio automatico, senza bloccare il caricamento
      if (supabase && matches.length) {
        try {
          savedMatches = await saveMatchesToDatabase(
  matches,
  req.query.season || null
);
        } catch (error) {
          saveError = error.message;
          console.error(
            "Salvataggio automatico Supabase:",
            error.message
          );
        }
      }

      res.json({
        ok: true,
        date,
        results: matches.length,
        saved_matches: savedMatches,
        save_error: saveError,
        response: matches
      });
    } catch (error) {
      handleError(res, error);
    }
  }
);

// ==========================================
// SINCRONIZZA UNA DATA
// ==========================================

app.post(
  "/api/sync/date/:date",
  requireSportApi,
  requireDatabase,
  async (req, res) => {
    const date = req.params.date;

    if (!validDate(date)) {
      return res.status(400).json({
        ok: false,
        error: "Data non valida: usa YYYY-MM-DD."
      });
    }

    try {
      const body = await sportGet(
        `/date/${encodeURIComponent(date)}`
      );

      const matches = getMatches(body);

      const season = String(
        req.query.season || date.slice(0, 4)
      );

      const saved = await saveMatchesToDatabase(
        matches,
        season
      );

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
  }
);

// ==========================================
// SINCRONIZZA INTERVALLO MASSIMO 14 GIORNI
// ==========================================

app.post(
  "/api/sync/range",
  requireSportApi,
  requireDatabase,
  async (req, res) => {
    const from = String(req.query.from || "");
    const to = String(req.query.to || "");

    if (
      !validDate(from) ||
      !validDate(to) ||
      new Date(`${to}T00:00:00Z`) <
        new Date(`${from}T00:00:00Z`)
    ) {
      return res.status(400).json({
        ok: false,
        error: "Usa from=YYYY-MM-DD e to=YYYY-MM-DD."
      });
    }

    const start = new Date(`${from}T12:00:00Z`);
    const end = new Date(`${to}T12:00:00Z`);

    const days = Math.round(
      (end - start) / 86400000
    ) + 1;

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

      dateObject.setUTCDate(
        dateObject.getUTCDate() + i
      );

      const date = dateObject
        .toISOString()
        .slice(0, 10);

      try {
        const body = await sportGet(
          `/date/${encodeURIComponent(date)}`
        );

        const matches = getMatches(body);

        received += matches.length;

        saved += await saveMatchesToDatabase(
          matches,
          String(req.query.season || date.slice(0, 4))
        );
      } catch (error) {
        errors.push({
          date,
          error: error.message
        });
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
  }
);

// ==========================================
// DETTAGLIO PARTITA
// ==========================================

app.get(
  "/api/fixture/:id",
  requireSportApi,
  async (req, res) => {
    if (!validNumericId(req.params.id)) {
      return res.status(400).json({
        ok: false,
        error: "ID partita non valido."
      });
    }

    try {
      const body = await sportGet(
        `/matches/${encodeURIComponent(req.params.id)}`
      );

      res.json({
        ok: true,
        response: body
      });
    } catch (error) {
      handleError(res, error);
    }
  }
);

// ==========================================
// STATISTICHE ED EVENTI
// ==========================================

const fixtureSubroutes = [
  "statistics",
  "stats",
  "events",
  "lineups",
  "players",
  "shots",
  "momentum",
  "advanced",
  "h2h",
  "live",
  "heatmaps"
];

for (const route of fixtureSubroutes) {
  app.get(
    `/api/fixture/:id/${route}`,
    requireSportApi,
    async (req, res) => {
      if (!validNumericId(req.params.id)) {
        return res.status(400).json({
          ok: false,
          error: "ID partita non valido."
        });
      }

      try {
        const endpoint =
          route === "statistics" ? "stats" : route;

        const body = await sportGet(
          `/matches/${encodeURIComponent(req.params.id)}/${endpoint}`
        );

        res.json({
          ok: true,
          response: body
        });
      } catch (error) {
        handleError(res, error);
      }
    }
  );
}

// ==========================================
// SQUADRE
// ==========================================

app.get(
  "/api/team/:id",
  requireSportApi,
  async (req, res) => {
    if (!validNumericId(req.params.id)) {
      return res.status(400).json({
        ok: false,
        error: "ID squadra non valido."
      });
    }

    try {
      const body = await sportGet(
        `/teams/${encodeURIComponent(req.params.id)}`
      );

      res.json({
        ok: true,
        response: body
      });
    } catch (error) {
      handleError(res, error);
    }
  }
);

app.get(
  "/api/team/:id/players",
  requireSportApi,
  async (req, res) => {
    if (!validNumericId(req.params.id)) {
      return res.status(400).json({
        ok: false,
        error: "ID squadra non valido."
      });
    }

    try {
      const body = await sportGet(
        `/teams/${encodeURIComponent(req.params.id)}/players`
      );

      res.json({
        ok: true,
        response: body
      });
    } catch (error) {
      handleError(res, error);
    }
  }
);

// ==========================================
// CLASSIFICHE
// ==========================================

app.get(
  "/api/standings/:leagueId",
  requireSportApi,
  async (req, res) => {
    if (!validNumericId(req.params.leagueId)) {
      return res.status(400).json({
        ok: false,
        error: "ID campionato non valido."
      });
    }

    try {
      const body = await sportGet(
        `/standings/${encodeURIComponent(req.params.leagueId)}`
      );

      res.json({
        ok: true,
        response: body
      });
    } catch (error) {
      handleError(res, error);
    }
  }
);

 // ==========================================
// PARTITE DEL CAMPIONATO IN SUPABASE
// ==========================================

app.get(
  "/api/league/:id/matches",
  requireDatabase,
  async (req, res) => {
    const leagueId = req.params.id;

    const season = req.query.season
      ? String(req.query.season)
      : null;

    if (!validNumericId(leagueId)) {
      return res.status(400).json({
        ok: false,
        error: "ID campionato non valido."
      });
    }

    try {
      const matches = await getLeagueMatchesFromDatabase(
        leagueId,
        season
      );

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
  }
);

// ==========================================
// PRONOSTICO PARTITA
// ==========================================

app.get(
  "/api/fixture/:id/predictions",
  requireDatabase,
  async (req, res) => {
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

      const prediction = calculatePrediction(
        fixture,
        history
      );

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

        disclaimer:
          "Pronostico statistico, non garanzia del risultato."
      });
    } catch (error) {
      handleError(res, error);
    }
  }
);

// ==========================================
// BACKTEST MODELLO
// ==========================================

app.get(
  "/api/backtest/:leagueId",
  requireDatabase,
  async (req, res) => {
    try {
      const leagueId = String(req.params.leagueId);

      if (!validNumericId(leagueId)) {
        return res.status(400).json({
          ok: false,
          error: "ID campionato non valido."
        });
      }

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
        ) {
          continue;
        }

        const prediction = calculatePrediction(
          match,
          history
        );

        if (!prediction?.probabilities) {
          continue;
        }

        const p = prediction.probabilities;

        const actual = {
          home: Number(match.home_goals),
          away: Number(match.away_goals)
        };

        const actualResult =
          actual.home > actual.away
            ? "1"
            : actual.home < actual.away
              ? "2"
              : "X";

        const predictedResult = ["1", "X", "2"].sort(
          (a, b) => p[b] - p[a]
        )[0];

        results.push({
          match_id: match.id,
          home_team: match.home_team,
          away_team: match.away_team,
          actual_result: actualResult,
          predicted_result: predictedResult,
          correct_1x2: predictedResult === actualResult,
          actual_goals: actual.home + actual.away,
          probabilities: p
        });
      }

      const evaluated = results.length;

      const correct = results.filter(
        result => result.correct_1x2
      ).length;

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
              ? Number(
                  (correct / evaluated * 100).toFixed(2)
                )
              : 0
          }
        },

        results
      });
    } catch (error) {
      handleError(res, error);
    }
  }
);

// ==========================================
// MEDIE E STATISTICHE SQUADRA
// ==========================================


app.get(
  "/api/team/:id/averages",
  requireSportApi,
  requireDatabase,
  async (req, res) => {
    try {
      const teamId = String(req.params.id);

      if (!validNumericId(teamId)) {
        return res.status(400).json({
          ok: false,
          error: "ID squadra non valido."
        });
      }

      const limit = Math.min(
        Math.max(
          Number(req.query.last || req.query.limit) || 10,
          1
        ),
        30
      );

      const response = await sportGet(
        `/teams/${encodeURIComponent(teamId)}`
      );

      const teamData =
        response?.response?.[0] ||
        response?.data?.team ||
        response?.data ||
        response;

      const teamName =
        teamData?.team?.name ||
        teamData?.name ||
        teamData?.team_name;

      if (!teamName) {
        return res.status(404).json({
          ok: false,
          error: "Squadra non trovata."
        });
      }

      const { data, error } = await supabase
        .from("matches")
        .select("*")
        .not("home_goals", "is", null)
        .not("away_goals", "is", null)
        .order("match_date", { ascending: false })
        .limit(5000);

      if (error) throw error;

      const normalizedTeamName = String(teamName)
        .trim()
        .toLowerCase();

      const matches = (data || [])
        .filter(match => {
          const home = String(match.home_team || "")
            .trim()
            .toLowerCase();

          const away = String(match.away_team || "")
            .trim()
            .toLowerCase();

          return (
            home === normalizedTeamName ||
            away === normalizedTeamName
          );
        })
        .slice(0, limit);

      let goalsFor = 0;
      let goalsAgainst = 0;
      let wins = 0;
      let draws = 0;
      let losses = 0;
      let analyzed = 0;

      const statSamples = {
        corners: [],
        total_shots: [],
        shots_on_target: [],
        yellow_cards: [],
        red_cards: [],
        fouls: [],
        expected_goals: [],
        possession: []
      };

      let statsMatchesAnalyzed = 0;
      let statsMatchesFailed = 0;

      const statKeys = {
        corners: "corners",
        total_shots: "total_shots",
        shots_on_target: "ShotsOnTarget",
        yellow_cards: "yellow_cards",
        red_cards: "red_cards",
        fouls: "fouls",
        expected_goals: "expected_goals",
        possession: "BallPossesion"
      };

      for (const match of matches) {
        const isHome =
          String(match.home_team || "")
            .trim()
            .toLowerCase() === normalizedTeamName;

        const scored = getNumber(
          isHome ? match.home_goals : match.away_goals
        );

        const conceded = getNumber(
          isHome ? match.away_goals : match.home_goals
        );

        if (scored === null || conceded === null) {
          continue;
        }

        goalsFor += scored;
        goalsAgainst += conceded;
        analyzed++;

        if (scored > conceded) wins++;
        else if (scored === conceded) draws++;
        else losses++;

        // Recupera le statistiche della partita da PitchAPI.
        try {
          if (!match.id) continue;

          const statsResponse = await sportGet(
            `/matches/${encodeURIComponent(match.id)}/stats`
          );

          const periods =
            statsResponse?.data?.periods ||
            statsResponse?.response?.data?.periods ||
            statsResponse?.periods ||
            [];

          const allPeriod = periods.find(
            period =>
              String(period.period).toLowerCase() === "all"
          );

          if (!allPeriod) {
            statsMatchesFailed++;
            continue;
          }

          const items = allPeriod.groups
            ?.flatMap(group => group.items || []) || [];

          const values = {};

          for (const [field, apiKey] of Object.entries(statKeys)) {
            const item = items.find(
              stat => stat.key === apiKey
            );

            if (!item) {
              values[field] = null;
              continue;
            }

            const rawValue = isHome
              ? item.home
              : item.away;

            values[field] = getNumber(rawValue);
          }

          let foundStats = false;

          for (const field of Object.keys(statKeys)) {
            if (values[field] !== null) {
              statSamples[field].push(values[field]);
              foundStats = true;
            }
          }

          if (foundStats) {
            statsMatchesAnalyzed++;
          } else {
            statsMatchesFailed++;
          }
        } catch (statsError) {
          statsMatchesFailed++;
          console.error(
            `Statistiche non disponibili per ${match.id}:`,
            statsError.message
          );
        }
      }

      function calculateWeightedStat(values) {
        if (!values.length) return null;

        let weightedSum = 0;
        let totalWeight = 0;

        values.forEach((value, index) => {
          const weight = Math.pow(0.75, index);
          weightedSum += value * weight;
          totalWeight += weight;
        });

        return totalWeight
          ? Number((weightedSum / totalWeight).toFixed(2))
          : null;
      }

      const averageGoalsFor = analyzed
        ? Number((goalsFor / analyzed).toFixed(2))
        : null;

      const averageGoalsAgainst = analyzed
        ? Number((goalsAgainst / analyzed).toFixed(2))
        : null;

      const averages = {
        goals_for: averageGoalsFor,
        goals_against: averageGoalsAgainst,
        goals_scored: averageGoalsFor,
        goals_conceded: averageGoalsAgainst,

        corners: calculateWeightedStat(statSamples.corners),
        total_shots: calculateWeightedStat(statSamples.total_shots),
        shots_on_target: calculateWeightedStat(statSamples.shots_on_target),
        yellow_cards: calculateWeightedStat(statSamples.yellow_cards),
        red_cards: calculateWeightedStat(statSamples.red_cards),
        fouls: calculateWeightedStat(statSamples.fouls),
        expected_goals: calculateWeightedStat(statSamples.expected_goals),
        possession: calculateWeightedStat(statSamples.possession)
      };

      res.json({
        ok: true,
        team: {
          id: teamId,
          name: teamName
        },
        matches_analyzed: analyzed,
        stats_matches_analyzed: statsMatchesAnalyzed,
        stats_matches_failed: statsMatchesFailed,
        averages,
        results: [
          {
            team: teamName,
            averages
          }
        ],
        results_summary: {
          wins,
          draws,
          losses
        },
        message: analyzed
          ? "Medie calcolate sulle ultime partite disponibili."
          : "Nessuna partita storica disponibile per questa squadra."
      });
    } catch (error) {
      handleError(res, error);
    }
  }
);

// ==========================================
// GIOCATORI
// ==========================================

app.get(
  "/api/team/:id/player-averages",
  requireSportApi,
  async (req, res) => {
    try {
      const teamId = String(req.params.id);

      if (!validNumericId(teamId)) {
        return res.status(400).json({
          ok: false,
          error: "ID squadra non valido."
        });
      }

      const response = await sportGet(
        `/teams/${encodeURIComponent(teamId)}/players`
      );

      res.json({
        ok: true,
        team_id: teamId,
        data: response,
        note: "Le medie individuali richiedono statistiche giocatore verificate."
      });
    } catch (error) {
      handleError(res, error);
    }
  }
);

// ==========================================
// GENERATORE MULTIPLE
// ==========================================

app.get(
  "/api/multiples",
  requireDatabase,
  async (req, res) => {
    try {
      const date = String(req.query.date || "").trim();

      if (!validDate(date)) {
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
        Math.max(
          Number(req.query.min_probability) || 65,
          50
        ),
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
          const { data, error: historyError } =
            await supabase
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
          historyCache[cacheKey]
        );

        if (!prediction?.probabilities) continue;

        const candidates = Object.entries(
          prediction.probabilities
        )
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
            (total, item) =>
              total * item.probability / 100,
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
        warning:
          "Le probabilità sono stime del modello, non garanzie. Le selezioni non sono necessariamente indipendenti."
      });
    } catch (error) {
      handleError(res, error);
    }
  }
);

// ==========================================
// QUOTE
// ==========================================

app.get(
  "/api/fixture/:id/odds",
  (req, res) => {
    res.status(501).json({
      ok: false,
      available: false,
      message:
        "Il collegamento a un provider di quote non è ancora configurato."
    });
  }
);

// ==========================================
// PAGINA PRINCIPALE
// ==========================================

app.get("/", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

// ==========================================
// FILE STATICI
// ==========================================

app.use(express.static(
  path.join(__dirname, "public")
));

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
  console.log(
    `Football Predictor AI attivo sulla porta ${PORT}`
  );

  console.log(
    "PitchAPI key configurata:",
    Boolean(PITCHAPI_KEY)
  );

  console.log(
    "Access token configurato:",
    Boolean(ACCESS_TOKEN)
  );

  console.log(
    "Supabase configurato:",
    Boolean(supabase)
  );
});
