const express = require("express");
const rateLimit = require("express-rate-limit");
const { createClient } = require("@supabase/supabase-js");
const path = require("path");
const pdfParse = require("pdf-parse");

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

// Simulazione Monte Carlo: estrae risultati dalla distribuzione Poisson
// gia' costruita dal modello. Le probabilita' analitiche restano il riferimento.
function runMonteCarlo(matrix, iterations = 10000) {
  const cumulative = [];
  let cumulativeProbability = 0;

  for (const item of matrix) {
    cumulativeProbability += item.probability;
    cumulative.push({
      home: item.home,
      away: item.away,
      cumulative: cumulativeProbability
    });
  }

  const counts = {
    home_win: 0,
    draw: 0,
    away_win: 0,
    over_1_5: 0,
    under_1_5: 0,
    over_2_5: 0,
    under_2_5: 0,
    over_3_5: 0,
    under_3_5: 0,
    btts_yes: 0,
    btts_no: 0
  };
  const scoreCounts = new Map();

  for (let i = 0; i < iterations; i++) {
    const random = Math.random();
    let result = cumulative[cumulative.length - 1];

    for (const candidate of cumulative) {
      if (random <= candidate.cumulative) {
        result = candidate;
        break;
      }
    }

    const totalGoals = result.home + result.away;
    const score = `${result.home}-${result.away}`;

    if (result.home > result.away) counts.home_win++;
    else if (result.home === result.away) counts.draw++;
    else counts.away_win++;

    if (totalGoals >= 2) counts.over_1_5++;
    else counts.under_1_5++;

    if (totalGoals >= 3) counts.over_2_5++;
    else counts.under_2_5++;

    if (totalGoals >= 4) counts.over_3_5++;
    else counts.under_3_5++;

    if (result.home > 0 && result.away > 0) counts.btts_yes++;
    else counts.btts_no++;

    scoreCounts.set(score, (scoreCounts.get(score) || 0) + 1);
  }

  const simulatedProbabilities = Object.fromEntries(
    Object.entries(counts).map(([key, count]) => [
      key,
      percent(count / iterations)
    ])
  );

  const topExactScores = [...scoreCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([score, count]) => ({
      score,
      probability: percent(count / iterations)
    }));

  return {
    iterations,
    method: "Monte Carlo su distribuzione Poisson",
    probabilities: simulatedProbabilities,
    top_exact_scores: topExactScores
  };
}

function percent(value) {
  return Number((value * 100).toFixed(1));
}

const STAT_MARKETS = {
  corners: { key: "corners", label: "Corner", lines: [7.5, 8.5, 9.5, 10.5, 11.5] },
  total_shots: { key: "total_shots", label: "Tiri totali", lines: [17.5, 19.5, 21.5, 23.5, 25.5] },
  shots_on_target: { key: "ShotsOnTarget", label: "Tiri in porta", lines: [5.5, 6.5, 7.5, 8.5, 9.5] },
  yellow_cards: { key: "yellow_cards", label: "Cartellini gialli", lines: [2.5, 3.5, 4.5, 5.5, 6.5] },
  red_cards: { key: "red_cards", label: "Cartellini rossi", lines: [0.5, 1.5] }
};

function extractAllMatchStats(body) {
  const periods =
    body?.data?.periods ||
    body?.response?.data?.periods ||
    body?.periods ||
    [];
  const allPeriod = periods.find(
    period => String(period.period).toLowerCase() === "all"
  );
  if (!allPeriod) return {};
  const items = allPeriod.groups?.flatMap(group => group.items || []) || [];
  return Object.fromEntries(
    Object.entries(STAT_MARKETS).map(([field, config]) => {
      const item = items.find(stat => stat.key === config.key);
      return [field, item ? {
        home: getNumber(item.home),
        away: getNumber(item.away)
      } : null];
    })
  );
}

async function runStatsMonteCarlo(fixture, history, iterations = 10000) {
  const fixtureDate = fixture.match_date || fixture.date || fixture.datetime;
  const homeName = String(fixture.home_team || getHomeName(fixture) || "").trim().toLowerCase();
  const awayName = String(fixture.away_team || getAwayName(fixture) || "").trim().toLowerCase();

  const eligible = (history || []).filter(match => {
    const date = match.match_date || match.date;
    return date && isFinished(match) && new Date(date) < new Date(fixtureDate) && match.id;
  }).sort((a, b) => new Date(b.match_date || b.date) - new Date(a.match_date || a.date));

  const homeMatches = eligible.filter(match =>
    String(match.home_team || "").trim().toLowerCase() === homeName ||
    String(match.away_team || "").trim().toLowerCase() === homeName
  ).slice(0, 10);
  const awayMatches = eligible.filter(match =>
    String(match.home_team || "").trim().toLowerCase() === awayName ||
    String(match.away_team || "").trim().toLowerCase() === awayName
  ).slice(0, 10);

  const uniqueMatches = [...new Map([...homeMatches, ...awayMatches].map(m => [String(m.id), m])).values()];
  const statsByMatch = new Map();

  // Limita le richieste concorrenti per non sovraccaricare PitchAPI.
  for (let i = 0; i < uniqueMatches.length; i += 4) {
    const batch = uniqueMatches.slice(i, i + 4);
    const results = await Promise.all(batch.map(async match => {
      try {
        const body = await sportGet(`/matches/${encodeURIComponent(match.id)}/stats`);
        return [String(match.id), extractAllMatchStats(body)];
      } catch (error) {
        console.error(`Statistiche Monte Carlo non disponibili per ${match.id}:`, error.message);
        return [String(match.id), null];
      }
    }));
    for (const [id, stats] of results) statsByMatch.set(id, stats);
  }

  const output = {};
  for (const [field, config] of Object.entries(STAT_MARKETS)) {
    const homeValues = [];
    const awayValues = [];
    for (const match of homeMatches) {
      const stats = statsByMatch.get(String(match.id));
      const value = stats?.[field];
      if (!value) continue;
      const isHome = String(match.home_team || "").trim().toLowerCase() === homeName;
      const n = isHome ? value.home : value.away;
      if (n !== null) homeValues.push(n);
    }
    for (const match of awayMatches) {
      const stats = statsByMatch.get(String(match.id));
      const value = stats?.[field];
      if (!value) continue;
      const isHome = String(match.home_team || "").trim().toLowerCase() === awayName;
      const n = isHome ? value.home : value.away;
      if (n !== null) awayValues.push(n);
    }

    if (homeValues.length < 5 || awayValues.length < 5) {
      output[field] = {
        label: config.label,
        available: false,
        reason: "Servono almeno 5 partite con questa statistica per entrambe le squadre.",
        samples: { home: homeValues.length, away: awayValues.length }
      };
      continue;
    }

    let homeSum = 0;
    let awaySum = 0;
    const overCounts = Object.fromEntries(config.lines.map(line => [String(line), 0]));
    for (let i = 0; i < iterations; i++) {
      const home = homeValues[Math.floor(Math.random() * homeValues.length)];
      const away = awayValues[Math.floor(Math.random() * awayValues.length)];
      const total = home + away;
      homeSum += home;
      awaySum += away;
      for (const line of config.lines) {
        if (total > line) overCounts[String(line)]++;
      }
    }
    output[field] = {
      label: config.label,
      available: true,
      iterations,
      samples: { home: homeValues.length, away: awayValues.length },
      expected: {
        home: Number((homeSum / iterations).toFixed(2)),
        away: Number((awaySum / iterations).toFixed(2)),
        total: Number(((homeSum + awaySum) / iterations).toFixed(2))
      },
      over_probabilities: Object.fromEntries(
        Object.entries(overCounts).map(([line, count]) => [line, percent(count / iterations)])
      )
    };
  }

  return {
    iterations,
    method: "Monte Carlo bootstrap su statistiche storiche PitchAPI",
    markets: output
  };
}

function getReliability(probability, sampleSize) {
  // La probabilita prevista non misura l'affidabilita del modello.
  // Il livello descrive solo l'ampiezza del campione disponibile.
  const level =
    sampleSize >= 30 ? "ALTA" :
    sampleSize >= 10 ? "MODERATA" :
    "LIMITATA";

  return {
    score: Number(Math.max(0, Math.min(100, sampleSize / 30 * 100)).toFixed(1)),
    level,
    sample_size: sampleSize,
    note: "Qualita del campione, non probabilita di successo."
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
        isFinished(match) &&
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
        isFinished(match) &&
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
        !isFinished(match) ||
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
        isFinished(match) &&
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
  (homeVenueAgainst / safeAwayLeague);

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

  // 10.000 simulazioni automatiche per ogni partita.
  const monteCarlo = runMonteCarlo(matrix, 10000);

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
    monte_carlo: monteCarlo,
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

      const statsMonteCarlo = await runStatsMonteCarlo(fixture, history);

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
        monte_carlo: prediction.monte_carlo,
        stats_monte_carlo: statsMonteCarlo,
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

      if (!/^l_[A-Za-z0-9_-]+$/.test(leagueId)) {
        return res.status(400).json({
          ok: false,
          error: "ID campionato non valido."
        });
      }

      const limit = Math.min(
        Math.max(Number(req.query.limit) || 100, 1),
        300
      );

      const targetDate = req.query.date
        ? String(req.query.date).trim()
        : null;
      const fromDate = req.query.from
        ? String(req.query.from).trim()
        : null;
      const toDate = req.query.to
        ? String(req.query.to).trim()
        : null;

      const validDate = value =>
        !value || /^\d{4}-\d{2}-\d{2}$/.test(value);

      if (!validDate(targetDate) || !validDate(fromDate) || !validDate(toDate)) {
        return res.status(400).json({
          ok: false,
          error: "Data non valida. Usa il formato YYYY-MM-DD."
        });
      }
      if (targetDate && (fromDate || toDate)) {
        return res.status(400).json({
          ok: false,
          error: "Usa date singole oppure un intervallo, non entrambi."
        });
      }
      if (fromDate && toDate && fromDate > toDate) {
        return res.status(400).json({
          ok: false,
          error: "La data iniziale deve precedere quella finale."
        });
      }

      const season = req.query.season
        ? String(req.query.season).trim()
        : null;

      if (season && !/^\d{4}\/\d{4}$/.test(season)) {
        return res.status(400).json({
          ok: false,
          error: "Stagione non valida. Usa il formato YYYY/YYYY."
        });
      }

      let backtestQuery = supabase
        .from("matches")
        .select("*")
        .eq("league_id", leagueId)
        .not("home_goals", "is", null)
        .not("away_goals", "is", null)
        .order("match_date", { ascending: false })
        .limit(5000);

      if (season) {
        backtestQuery = backtestQuery.eq("season", season);
      }

      const { data, error } = await backtestQuery;

      if (error) throw error;

      const history = (data || []).sort((a, b) =>
        new Date(a.match_date) - new Date(b.match_date)
      );
      const dateMatches = history.filter(match => {
        if (!isFinished(match)) return false;
        const day = String(match.match_date || "").slice(0, 10);
        if (targetDate) return day === targetDate;
        if (fromDate && day < fromDate) return false;
        if (toDate && day > toDate) return false;
        return true;
      });
      const evaluationMatches = dateMatches.slice(-limit);
      const results = [];

      for (const match of evaluationMatches) {
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

        const totalGoals = actual.home + actual.away;
        const actualOver15 = totalGoals >= 2;
        const actualOver25 = totalGoals >= 3;
        const actualOver35 = totalGoals >= 4;
        const actualBtts = actual.home > 0 && actual.away > 0;

        results.push({
          match_id: match.id,
          match_date: match.match_date,
          home_team: match.home_team,
          away_team: match.away_team,
          actual_result: actualResult,
          predicted_result: predictedResult,
          correct_1x2: predictedResult === actualResult,
          actual_goals: totalGoals,
          actual_score: `${actual.home}-${actual.away}`,
          actual_markets: {
            over_1_5: actualOver15,
            over_2_5: actualOver25,
            over_3_5: actualOver35,
            btts_yes: actualBtts
          },
          probabilities: p
        });
      }

      const evaluated = results.length;
      const correct = results.filter(result => result.correct_1x2).length;

      // Fasce di calibrazione: confrontano probabilita' media e frequenza reale.
      function calibrationByBands(tested) {
        const bands = Array.from({ length: 10 }, (_, index) => ({
          range: `${index * 10}-${(index + 1) * 10}%`,
          count: 0,
          probability_sum: 0,
          observed_sum: 0
        }));

        for (const item of tested) {
          const probability = Math.max(0, Math.min(1, item.probability));
          const index = Math.min(9, Math.floor(probability * 10));
          bands[index].count++;
          bands[index].probability_sum += probability;
          bands[index].observed_sum += item.actual;
        }

        return bands
          .filter(band => band.count > 0)
          .map(band => ({
            range: band.range,
            count: band.count,
            average_predicted_probability: Number((band.probability_sum / band.count * 100).toFixed(2)),
            actual_frequency: Number((band.observed_sum / band.count * 100).toFixed(2))
          }));
      }

      function marketMetrics(key, actualKey, threshold = 50) {
        const tested = results
          .filter(result =>
            Number.isFinite(Number(result.probabilities?.[key])) &&
            typeof result.actual_markets?.[actualKey] === "boolean"
          )
          .map(result => ({
            probability: Number(result.probabilities[key]) / 100,
            actual: result.actual_markets[actualKey] ? 1 : 0
          }));

        if (!tested.length) {
          return {
            evaluated: 0,
            correct: 0,
            accuracy: null,
            brier_score: null,
            calibration: []
          };
        }

        let hits = 0;
        let brier = 0;
        for (const item of tested) {
          if ((item.probability >= threshold / 100) === Boolean(item.actual)) hits++;
          brier += Math.pow(item.probability - item.actual, 2);
        }

        return {
          evaluated: tested.length,
          correct: hits,
          accuracy: Number((hits / tested.length * 100).toFixed(2)),
          brier_score: Number((brier / tested.length).toFixed(4)),
          calibration: calibrationByBands(tested)
        };
      }

      const outcomeCalibration = {};
      let multiclassBrier = 0;
      for (const outcome of ["1", "X", "2"]) {
        const tested = results
          .filter(result => Number.isFinite(Number(result.probabilities?.[outcome])))
          .map(result => ({
            probability: Number(result.probabilities[outcome]) / 100,
            actual: result.actual_result === outcome ? 1 : 0
          }));

        outcomeCalibration[outcome] = calibrationByBands(tested);
        for (const item of tested) {
          multiclassBrier += Math.pow(item.probability - item.actual, 2);
        }
      }

      // Brier multicategoria normalizzato per 3 esiti (scala 0-1).
      const brier1x2 = evaluated
        ? Number((multiclassBrier / (evaluated * 3)).toFixed(4))
        : null;

      const accuracyByMarket = {
        "1X2": {
          evaluated,
          correct,
          accuracy: evaluated ? Number((correct / evaluated * 100).toFixed(2)) : null,
          brier_score_normalized: brier1x2,
          calibration_by_outcome: outcomeCalibration
        },
        over_1_5: marketMetrics("over_1_5", "over_1_5"),
        over_2_5: marketMetrics("over_2_5", "over_2_5"),
        over_3_5: marketMetrics("over_3_5", "over_3_5"),
        btts_yes: marketMetrics("btts_yes", "btts_yes")
      };

      res.json({
        ok: true,
        league_id: leagueId,
        season,
        target_date: targetDate,
        from_date: fromDate,
        to_date: toDate,
        requested_matches: limit,
        available_history_matches: history.length,
        matches_on_target_date: dateMatches.length,
        evaluation_matches_selected: evaluationMatches.length,
        evaluation_period: {
          from: evaluationMatches[0]?.match_date || null,
          to: evaluationMatches[evaluationMatches.length - 1]?.match_date || null
        },
        evaluated_matches: evaluated,
        accuracy_by_market: accuracyByMarket,
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

      const leagueId = req.query.league
        ? String(req.query.league).trim()
        : null;

      const season = req.query.season
        ? String(req.query.season).trim()
        : null;

      if (leagueId && !validNumericId(leagueId)) {
        return res.status(400).json({
          ok: false,
          error: "ID campionato non valido."
        });
      }

      if (season && !/^\d{4}\/\d{4}$/.test(season)) {
        return res.status(400).json({
          ok: false,
          error: "Stagione non valida. Usa il formato YYYY/YYYY."
        });
      }

      let matchesQuery = supabase
        .from("matches")
        .select("*")
        .not("home_goals", "is", null)
        .not("away_goals", "is", null)
        .order("match_date", { ascending: false })
        .limit(5000);

      if (leagueId) {
        matchesQuery = matchesQuery.eq("league_id", leagueId);
      }

      if (season) {
        matchesQuery = matchesQuery.eq("season", season);
      }

      const { data, error } = await matchesQuery;

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

      const statsSampleCounts = Object.fromEntries(
        Object.entries(statSamples).map(([field, values]) => [
          field,
          values.length
        ])
      );
      statsSampleCounts.goals_for = analyzed;
      statsSampleCounts.goals_against = analyzed;

      res.json({
        ok: true,
        team: {
          id: teamId,
          name: teamName
        },
        matches_requested: matches.length,
        matches_analyzed: analyzed,
        stats_matches_analyzed: statsMatchesAnalyzed,
        stats_matches_failed: statsMatchesFailed,
        stats_sample_counts: statsSampleCounts,
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

      const profiles = {
        prudente: { minProbability: 75, maxSelections: 5, maxPerMatch: 1 },
        equilibrata: { minProbability: 65, maxSelections: 5, maxPerMatch: 1 },
        rischiosa: { minProbability: 55, maxSelections: 5, maxPerMatch: 1 }
      };
      const marketLabels = {
        "1": "Vittoria casa (1)",
        "X": "Pareggio (X)",
        "2": "Vittoria ospite (2)",
        over_1_5: "Over 1.5 gol",
        under_1_5: "Under 1.5 gol",
        over_2_5: "Over 2.5 gol",
        under_2_5: "Under 2.5 gol",
        over_3_5: "Over 3.5 gol",
        under_3_5: "Under 3.5 gol",
        btts_yes: "Entrambe le squadre segnano – Sì",
        btts_no: "Entrambe le squadre segnano – No"
      };
      const mode = String(req.query.mode || "equilibrata").toLowerCase();
      if (!profiles[mode]) {
        return res.status(400).json({
          ok: false,
          error: "Modalità non valida. Usa prudente, equilibrata o rischiosa."
        });
      }
      const profile = profiles[mode];
      const bookmaker = String(req.query.bookmaker || "sisal").toLowerCase();
      if (bookmaker !== "sisal") {
        return res.status(400).json({ ok: false, error: "Bookmaker non supportato. Al momento è configurato Sisal." });
      }
      // Whitelist iniziale Sisal: mercati standard elaborabili dal modello Poisson.
      // Mercati speciali e statistiche non verificate vengono esclususi.
      const maxMatches = Math.min(Math.max(Number(req.query.max_matches) || 10, 1), 20);
      const minProbability = Math.min(
        Math.max(Number(req.query.min_probability) || profile.minProbability, 50),
        95
      );
      const maxSelections = Math.min(
        Math.max(Number(req.query.max_selections) || profile.maxSelections, 1),
        10
      );

      const { data: fixtures, error } = await supabase
        .from("matches")
        .select("*")
        .gte("match_date", `${date}T00:00:00`)
        .lt("match_date", `${date}T23:59:59.999`)
        .order("match_date", { ascending: true });
      if (error) throw error;

      const historyCache = {};
      const candidates = [];
      const diagnostics = {
        fixtures_found: (fixtures || []).length,
        fixtures_analyzed: 0,
        skipped_insufficient_data: 0,
        stats_markets_available: 0
      };

      for (const match of (fixtures || []).slice(0, maxMatches)) {
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

        const history = historyCache[cacheKey];
        const prediction = calculatePrediction(match, history);
        if (!prediction?.probabilities) {
          diagnostics.skipped_insufficient_data++;
          continue;
        }
        diagnostics.fixtures_analyzed++;

        const addCandidate = (market, probability, source, sampleSize, label) => {
          const value = Number(probability);
          if (!Number.isFinite(value) || value < minProbability || value > 100) return;
          candidates.push({
            match_id: match.id,
            league: match.league_name,
            home_team: match.home_team,
            away_team: match.away_team,
            market,
            label,
            probability: Number(value.toFixed(2)),
            source,
            sample_size: sampleSize ?? null
          });
        };

        for (const [market, probability] of Object.entries(prediction.probabilities)) {
          addCandidate(market, probability, "poisson", prediction.samples?.home && prediction.samples?.away
            ? Math.min(prediction.samples.home, prediction.samples.away) : null, marketLabels[market] || market);
        }

        // Solo mercati standard del modello Poisson: niente cartellini, corner,
        // tiri o mercati speciali non verificati nel palinsesto Sisal.
        diagnostics.stats_markets_available = 0;
      }

      // Ordina per probabilità, poi limita mercati ripetuti della stessa partita.
      candidates.sort((a, b) => b.probability - a.probability);
      const selected = [];
      const perMatch = new Map();
      const marketKeys = new Set();
      for (const item of candidates) {
        if (selected.length >= maxSelections) break;
        const count = perMatch.get(item.match_id) || 0;
        const uniqueKey = `${item.match_id}:${item.market}`;
        if (count >= profile.maxPerMatch || marketKeys.has(uniqueKey)) continue;
        selected.push(item);
        perMatch.set(item.match_id, count + 1);
        marketKeys.add(uniqueKey);
      }

      const naiveCombinedProbability = selected.length
        ? selected.reduce((total, item) => total * item.probability / 100, 1) * 100
        : 0;

      res.json({
        ok: true,
        date,
        mode,
        bookmaker: "Sisal",
        market_policy: "Mercati standard Poisson: 1X2, Over/Under gol e Goal/No Goal. La disponibilità effettiva va verificata nell’evento Sisal.",
        minimum_probability: minProbability,
        max_matches: maxMatches,
        max_selections: maxSelections,
        selected_matches: new Set(selected.map(item => item.match_id)).size,
        selected_selections: selected.length,
        naive_combined_probability: Number(naiveCombinedProbability.toFixed(4)),
        selections: selected,
        diagnostics,
        warning:
          "Probabilità stimate dal modello Poisson, non garanzie e non quote Sisal. È selezionato al massimo un mercato per partita per ridurre le correlazioni. La disponibilità effettiva del mercato va verificata nel palinsesto Sisal."
      });
    } catch (error) {
      handleError(res, error);
    }
  }
);

// ==========================================
// IMPORTATORE FOGLIO QUOTE SISAL (PDF UFFICIALE)
// ==========================================

const SISAL_BASE_PDF_URL =
  "https://landing.sisal.it/volantini/Scommesse_Sport/Quote/calcio%20base%20per%20data.pdf";

const SISAL_ODDS_COLUMNS = [
  "1", "X", "2",
  "handicap_1", "handicap_X", "handicap_2",
  "double_chance_1X", "double_chance_X2", "double_chance_12",
  "under_1_5", "over_1_5",
  "under_2_5", "over_2_5",
  "under_3_5", "over_3_5",
  "goal", "no_goal",
  "home_scores_yes", "home_scores_no",
  "away_scores_yes", "away_scores_no"
];

function parseSisalOddsPdfText(text) {
  const lines = String(text || "").split(/\r?\n/);
  const updatedMatch = String(text || "").match(
    /Dati aggiornati al\s+(\d{2})\/(\d{2})\/(\d{4})\s*-\s*ore\s*(\d{2}:\d{2}:\d{2})/i
  );
  const updatedAt = updatedMatch
    ? `${updatedMatch[3]}-${updatedMatch[2]}-${updatedMatch[1]}T${updatedMatch[4]}+01:00`
    : null;

  const monthNames = {
    gennaio: "01", febbraio: "02", marzo: "03", aprile: "04",
    maggio: "05", giugno: "06", luglio: "07", agosto: "08",
    settembre: "09", ottobre: "10", novembre: "11", dicembre: "12"
  };
  const weekdays = "lunedi|martedi|mercoledi|giovedi|venerdi|sabato|domenica";
  let currentDateLabel = null;
  const events = [];
  let candidateLines = 0;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (!line) continue;

    const dateHeading = line.match(
      new RegExp(`^(?:${weekdays})[,]?\\s+(\\d{1,2})\\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)\\b`, "i")
    );
    if (dateHeading) {
      currentDateLabel = `${dateHeading[1].padStart(2, "0")}/${monthNames[dateHeading[2].toLowerCase()]}`;
      continue;
    }

    const prefix = line.match(/^(\d{1,2}\.\d{2})\s+([A-Z0-9]{2,8})\s+(\d{3,6})\s+(\d{2,7})\s+(.+)$/i);
    if (!prefix) continue;
    candidateLines++;

    const rest = prefix[5].split(" ");
    if (rest.length < SISAL_ODDS_COLUMNS.length + 3) continue;

    const oddsTokens = rest.slice(-SISAL_ODDS_COLUMNS.length);
    const odds = oddsTokens.map(token => {
      if (token === "-") return null;
      if (!/^\d+(?:,\d+)?$/.test(token)) return undefined;
      const value = Number(token.replace(",", "."));
      return Number.isFinite(value) && value > 1 && value <= 1000 ? value : undefined;
    });
    if (odds.some(value => value === undefined)) continue;

    const beforeOdds = rest.slice(0, -SISAL_ODDS_COLUMNS.length);
    const liveIndex = beforeOdds.lastIndexOf("L");
    if (liveIndex < 2) continue;
    const teams = beforeOdds.slice(0, liveIndex).join(" ").trim();
    if (!teams) continue;

    const markets = {};
    SISAL_ODDS_COLUMNS.forEach((key, index) => {
      markets[key] = odds[index];
    });

    events.push({
      date_label: currentDateLabel,
      time: prefix[1],
      competition_code: prefix[2],
      schedule_id: prefix[3],
      event_id: prefix[4],
      team_text: teams,
      markets
    });
  }

  return {
    updated_at: updatedAt,
    events,
    diagnostics: {
      text_lines: lines.length,
      candidate_event_lines: candidateLines,
      parsed_events: events.length
    }
  };
}

app.get("/api/sisal/odds", async (req, res) => {
  try {
    const response = await fetch(SISAL_BASE_PDF_URL, {
      headers: { "User-Agent": "FootballPredictorAI/1.0", "Accept": "application/pdf" },
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) {
      return res.status(502).json({
        ok: false, available: false,
        error: `Foglio Sisal non raggiungibile (HTTP ${response.status}).`
      });
    }

    const contentType = response.headers.get("content-type") || "";
    const buffer = Buffer.from(await response.arrayBuffer());
    const isPdf = buffer.subarray(0, 5).toString("ascii") === "%PDF-";
    if (!isPdf || buffer.length < 1000 || buffer.length > 15 * 1024 * 1024) {
      return res.status(502).json({
        ok: false, available: false,
        error: "La risposta Sisal non è un PDF valido o supera il limite di dimensione."
      });
    }

    const parsedPdf = await pdfParse(buffer);
    const parsed = parseSisalOddsPdfText(parsedPdf.text || "");
    const updatedTime = parsed.updated_at ? Date.parse(parsed.updated_at) : NaN;
    const ageMinutes = Number.isFinite(updatedTime)
      ? Math.max(0, Math.round((Date.now() - updatedTime) / 60000))
      : null;
    const stale = ageMinutes === null || ageMinutes > 180;

    res.json({
      ok: true,
      provider: "Sisal",
      source: SISAL_BASE_PDF_URL,
      source_type: "official_public_pdf",
      available: parsed.events.length > 0 && !stale,
      updated_at: parsed.updated_at,
      age_minutes: ageMinutes,
      stale,
      stale_after_minutes: 180,
      events_count: parsed.events.length,
      events: parsed.events,
      diagnostics: parsed.diagnostics,
      note: "Importazione di verifica: le quote non vengono ancora usate dal generatore multiple. Controllare gli abbinamenti squadra/data prima dell'integrazione."
    });
  } catch (error) {
    console.error("Importazione quote Sisal:", error.message);
    res.status(502).json({
      ok: false,
      available: false,
      error: "Impossibile scaricare o leggere il PDF ufficiale Sisal.",
      detail: error.message
    });
  }
});

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
