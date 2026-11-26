const express = require("express");
const rateLimit = require("express-rate-limit");
const { createClient } = require("@supabase/supabase-js");
const path = require("path");
const pdfParse = require("pdf-parse");
const { predictRandomForest } = require("./random-forest");

const app = express();

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));

app.use((req, res, next) => {
  const origin = req.get("origin") || "";
  const allowedOrigins = new Set([
    "https://hoppscotch.io",
    "https://www.hoppscotch.io"
  ]);

  if (allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type,Accept");
    res.setHeader("Access-Control-Max-Age", "86400");
  }

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

const PORT = process.env.PORT || 10000;
const PITCHAPI_URL = "https://api.pitchapi.dev/v1";
const PITCHAPI_KEY = String(process.env.PITCHAPI_KEY || "").trim();
const ACCESS_TOKEN = String(process.env.PREDICTOR_ACCESS_TOKEN || "").trim();
const RANDOM_FOREST_ENABLED = String(process.env.ENABLE_RANDOM_FOREST || "").toLowerCase() === "true";
 // Parametri del modello regolabili da Render senza modificare il codice.
 // I valori di default mantengono il comportamento attuale.
 const MODEL_PRIOR_MATCHES = Math.max(0, Math.min(20, Number(process.env.MODEL_PRIOR_MATCHES || 3)));
 const MODEL_VENUE_BLEND = Math.max(0, Math.min(1, Number(process.env.MODEL_VENUE_BLEND || 0.1)));
 const MODEL_XG_BLEND = Math.max(0, Math.min(1, Number(process.env.MODEL_XG_BLEND || 0.25)));
 const MODEL_HISTORY_WINDOW = Math.max(5, Math.min(30, Number(process.env.MODEL_HISTORY_WINDOW || 25)));
 const MODEL_DECAY = Math.max(0.5, Math.min(1, Number(process.env.MODEL_DECAY || 1)));


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
  if (req.path === "/status" || req.path === "/auth-diagnostic") {
    return next();
  }

  return requireAccess(req, res, next);
});

// ==========================================
// PITCHAPI
// ==========================================

// Cache limitata per statistiche storiche: evita di richiamare PitchAPI
// per le stesse partite durante previsioni e backtest ravvicinati.
const historicalStatsCache = new Map();
const HISTORICAL_STATS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const HISTORICAL_STATS_CACHE_MAX = 500;

function historicalStatsCacheKey(endpoint) {
  const match = String(endpoint || "").match(/^\/matches\/([^/?]+)\/stats(?:\?|$)/);
  return match ? `match-stats:${decodeURIComponent(match[1])}` : null;
}

function getCachedHistoricalStats(key) {
  if (!key) return null;
  const entry = historicalStatsCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.savedAt > HISTORICAL_STATS_CACHE_TTL_MS) {
    historicalStatsCache.delete(key);
    return null;
  }
  return entry.body;
}

function cacheHistoricalStats(key, body) {
  if (!key || !body || typeof body !== "object") return;
  if (historicalStatsCache.size >= HISTORICAL_STATS_CACHE_MAX) {
    const oldestKey = historicalStatsCache.keys().next().value;
    if (oldestKey) historicalStatsCache.delete(oldestKey);
  }
  historicalStatsCache.set(key, { body, savedAt: Date.now() });
}

async function sportGet(endpoint) {
  if (!PITCHAPI_KEY) {
    throw new Error("PITCHAPI_KEY non configurata.");
  }

  const statsCacheKey = historicalStatsCacheKey(endpoint);
  const cachedStats = getCachedHistoricalStats(statsCacheKey);
  if (cachedStats) return cachedStats;

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

  if (statsCacheKey) cacheHistoricalStats(statsCacheKey, body);
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

const EUROPEAN_COUNTRY_CODES = new Set([
 "ALB","AND","ARM","AUT","AZE","BEL","BIH","BLR","BUL","CRO","CYP","CZE",
 "DEN","ENG","ESP","EST","FIN","FRA","FRO","GEO","GER","GRE","HUN","IRL",
 "ISL","ISR","ITA","KAZ","KOS","KVX","LIE","LTU","LUX","LVA","MDA","MKD",
 "MLT","MNE","NED","NIR","NOR","POL","POR","ROU","RUS","SCO","SMR","SRB",
 "SVK","SVN","SWE","SUI","TUR","UKR","WAL","GBR","GB","NL","RO","IT","DE",
 "FR","ES","PT","BE","AT","CH","GR","HR","RS","UA","SE","NO","DK","FI",
 "PL","CZ","SK","SI","HU","BG","IE","IS","CY","TR","LU","MT","EE","LV",
 "LT","BA","ME","AL","MK","MD","AD","LI","FO","AM","AZ","GE","BY","XK"
]);
const EUROPEAN_COUNTRY_NAMES = new Set([
 "albania","andorra","armenia","austria","azerbaijan","belarus","belgium",
 "bosnia and herzegovina","bulgaria","croatia","cyprus","czech republic",
 "czechia","denmark","england","estonia","faroe islands","finland","france",
 "georgia","germany","greece","hungary","iceland","ireland","israel","italy",
 "kazakhstan","kosovo","latvia","liechtenstein","lithuania","luxembourg",
 "malta","moldova","monaco","montenegro","netherlands","the netherlands",
 "north macedonia","northern ireland","norway","poland","portugal","romania",
 "russia","san marino","scotland","serbia","slovakia","slovenia","spain",
 "sweden","switzerland","turkey","ukraine","wales","united kingdom",
 "republic of ireland","republic of moldova"
]);
function isEuropeanLeague(league) {
 const countryObj = league?.country && typeof league.country === "object" ? league.country : {};
 const name = String(league?.name || league?.league_name || "").trim().toLowerCase();
 const countryCode = String(
   league?.country_code || league?.country?.code || league?.country?.iso2 ||
   league?.country?.alpha2 || league?.country_iso || countryObj.code ||
   countryObj.iso2 || countryObj.alpha2 || ""
 ).trim().toUpperCase();
 const countryName = String(
   league?.country_name || countryObj.name || countryObj.country_name ||
   (typeof league?.country === "string" ? league.country : "")
 ).trim().toLowerCase();
 const continent = String(
   league?.continent || league?.region || countryObj.continent ||
   countryObj.region || league?.country_continent || ""
 ).trim().toLowerCase();
 const isEuropeanCountry = EUROPEAN_COUNTRY_CODES.has(countryCode) ||
   EUROPEAN_COUNTRY_NAMES.has(countryName) ||
   continent === "europe" || continent === "europa";
 // Tutte le divisioni e coppe nazionali dei paesi europei restano incluse:
 // non viene applicato alcun filtro per popolarità o livello.
 const internationalCompetition =
   /champions league|uefa champions|europa league|conference league|uefa conference|world cup|fifa world cup|european championship|uefa euro/i.test(name);
 return isEuropeanCountry || internationalCompetition;
}
async function getLeagueCatalog() {
 const body = await sportGet("/leagues");
 return Array.isArray(body?.data?.leagues) ? body.data.leagues
   : Array.isArray(body?.leagues) ? body.leagues
   : Array.isArray(body?.data) ? body.data
   : getMatches(body);
}

// Cache dei nomi ufficiali: le risposte fixture possono omettere league_name.
let leagueNameMapCache = null;
let leagueNameMapCacheAt = 0;
async function getLeagueNameMap() {
 const now = Date.now();
 if (leagueNameMapCache && now - leagueNameMapCacheAt < 6 * 60 * 60 * 1000) {
   return leagueNameMapCache;
 }
 const catalog = await getLeagueCatalog();
 const nextMap = new Map(catalog
   .filter(item => item?.id && item?.name)
   .map(item => [String(item.id), String(item.name).trim()]));
 if (nextMap.size) {
   leagueNameMapCache = nextMap;
   leagueNameMapCacheAt = now;
 }
 return leagueNameMapCache || nextMap;
}
let europeanLeagueCatalogCache = null;
let europeanLeagueCatalogCacheAt = 0;
async function getEuropeanLeagueCatalog(options = {}) {
 const now = Date.now();
 if (!options.forceRefresh && europeanLeagueCatalogCache && now - europeanLeagueCatalogCacheAt < 30 * 60 * 1000) {
   return europeanLeagueCatalogCache;
 }
 const catalog = await getLeagueCatalog();
 const filtered = catalog.filter(isEuropeanLeague);
 if (filtered.length) {
   europeanLeagueCatalogCache = filtered;
   europeanLeagueCatalogCacheAt = now;
 }
 return filtered;
}
function getMatchLeagueId(match) {
 return String(match?.league_id??match?.league?.id??match?.competition?.id??"");
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
  ).trim().toUpperCase();

  if ([
    "FT",
    "AET",
    "PENS",
    "FINISHED",
    "COMPLETED",
    "PLAYED"
  ].includes(status)) {
    return true;
  }

  // Alcune risposte PitchAPI indicano le gare concluse come "played"
  // o non forniscono un codice stato standard: il risultato completo
  // e una data passata costituiscono un fallback affidabile.
  const date = match.match_date || match.time_utc || match.date || match.datetime;
  return getHomeScore(match) !== null &&
    getAwayScore(match) !== null &&
    date &&
    new Date(date).getTime() <= Date.now();
}

// ==========================================
// IMPORTAZIONE STATISTICHE STORICHE A BLOCCHI
// ==========================================
app.post(
  "/api/sync/league/:id/statistics",
  requireSportApi,
  requireDatabase,
  async (req, res) => {
    try {
      const leagueId = String(req.params.id);
      if (!/^l_[A-Za-z0-9_-]+$/.test(leagueId)) {
        return res.status(400).json({ ok: false, error: "ID campionato non valido." });
      }
      const offset = Math.max(0, Number.parseInt(req.query.offset || "0", 10) || 0);
      const batchSize = Math.min(100, Math.max(1, Number.parseInt(req.query.batch_size || "50", 10) || 50));
      const { data: matches, error: matchesError } = await supabase
        .from("matches").select("id,league_id,match_date,home_goals,away_goals,status")
        .eq("league_id", leagueId)
        // Lo storico viene importato da PitchAPI con status=played, che può
        // essere diverso dai codici FT/FINISHED. I punteggi non nulli sono
        // il criterio affidabile per identificare partite concluse.
        .not("home_goals", "is", null)
        .not("away_goals", "is", null)
        .not("match_date", "is", null)
        .lte("match_date", new Date().toISOString())
        .order("match_date", { ascending: true }).range(offset, offset + batchSize - 1);
      if (matchesError) throw matchesError;
      const rows = await mapWithConcurrency(matches || [], 5, async match => {
        try {
          const body = await sportGet("/matches/" + encodeURIComponent(match.id) + "/stats");
          return { match_id: String(match.id), league_id: leagueId, match_date: match.match_date,
            normalized_stats: getNormalizedMatchStats(body), updated_at: new Date().toISOString() };
        } catch (error) {
          return { match_id: String(match.id), error: error.message };
        }
      });
      const successful = rows.filter(row => row && row.normalized_stats);
      if (successful.length) {
        const { error } = await supabase.from("match_statistics").upsert(successful, { onConflict: "match_id" });
        if (error) throw error;
      }
      const failures = rows.filter(row => row?.error).map(row => ({ match_id: row.match_id, error: row.error }));
      res.json({ ok: true, league_id: leagueId, offset, batch_size: batchSize,
        matches_selected: (matches || []).length, statistics_saved: successful.length,
        failed: failures.length, failures, next_offset: offset + (matches || []).length,
        done: (matches || []).length < batchSize });
    } catch (error) { handleError(res, error); }
  }
);

// ==========================================
// NORMALIZZAZIONE PARTITE
// ==========================================

function normalizeFixture(match, seasonOverride, leagueIdOverride) {
  const leagueId =
    match.league_id ??
    match.league?.id ??
    match.competition?.id ??
    leagueIdOverride;

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

    // Non inviare null quando PitchAPI omette il nome: negli upsert
    // su una partita esistente null cancellerebbe il valore già corretto.
    // undefined viene omesso dal payload e conserva il dato presente.
    league_name:
      match.league_name ||
      match.league?.name ||
      match.competition?.name ||
      undefined,

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
  seasonOverride,
  leagueIdOverride
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
      normalizeFixture(match, seasonOverride, leagueIdOverride)
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

  // Il catalogo PitchAPI è l'unica fonte canonica per ID e nomi dei campionati.
  // Ogni riga deve essere risolta prima dell'upsert: un ID sconosciuto blocca
  // l'intero salvataggio, anche se la fixture contiene un nome, per evitare
  // di introdurre campionati non verificati o nomi incoerenti nel database.
  const namesById = await getLeagueNameMap();
  for (const row of rows) {
    const catalogName = namesById.get(String(row.league_id));
    if (!catalogName) {
      throw new Error("Campionato non presente nel catalogo PitchAPI per league_id " + row.league_id + ". Upsert annullato per sicurezza.");
    }
    row.league_name = catalogName;
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

  // Recupera tutto lo storico a pagine: Supabase può applicare un limite
  // massimo di 1000 righe per risposta anche quando .limit() è superiore.
  // Il modello filtra poi i campioni in base alla data della partita target,
  // evitando l'utilizzo di risultati futuri.
  const pageSize = 1000;
  const allMatches = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from("matches")
      .select("*")
      .eq("league_id", String(leagueId))
      .order("match_date", { ascending: true })
      .range(offset, offset + pageSize - 1);

    if (error) {
      throw error;
    }

    const page = data || [];
    allMatches.push(...page);

    if (page.length < pageSize) {
      break;
    }

    offset += pageSize;
  }

  return allMatches;
}

// ==========================================
// MODELLO POISSON
// ==========================================

function weightedAverage(sample, key, decay = MODEL_DECAY) {
  if (!sample.length) {
    return 0;
  }

  let weightedSum = 0;
  let totalWeight = 0;

  sample.forEach((item, index) => {
    const weight = Math.pow(decay, index);
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
function percent(value) {
  return Number((value * 100).toFixed(1));
}

function getReliability(sampleSize, homeVenueSize, awayVenueSize, leagueSampleSize) {
  // Rating trasparente della qualita' dei dati disponibili.
  // Non viene confuso con la probabilita' di vincita o con l'accuratezza storica.
  const home = Math.max(0, Number(sampleSize?.home) || 0);
  const away = Math.max(0, Number(sampleSize?.away) || 0);
  const homeVenue = Math.max(0, Number(homeVenueSize) || 0);
  const awayVenue = Math.max(0, Number(awayVenueSize) || 0);
  const league = Math.max(0, Number(leagueSampleSize) || 0);
  const minimumTeamSample = Math.min(home, away);
  const maximumTeamSample = Math.max(home, away);

  const teamCoverage = Math.min(1, minimumTeamSample / 10);
  const venueCoverage = Math.min(1, Math.min(homeVenue, awayVenue) / 5);
  const leagueCoverage = Math.min(1, league / 100);
  const sampleBalance = maximumTeamSample > 0
    ? minimumTeamSample / maximumTeamSample
    : 0;

  const components = {
    team_history: Number((teamCoverage * 40).toFixed(1)),
    home_away_history: Number((venueCoverage * 30).toFixed(1)),
    league_history: Number((leagueCoverage * 20).toFixed(1)),
    sample_balance: Number((sampleBalance * 10).toFixed(1))
  };
  const score = Number(Object.values(components).reduce((sum, value) => sum + value, 0).toFixed(1));
  const level =
    score >= 80 ? "ALTA" :
    score >= 60 ? "MEDIA" :
    "BASSA";

  return {
    score,
    level,
    sample_size: { home, away },
    venue_sample_size: { home: homeVenue, away: awayVenue },
    league_sample_size: league,
    components,
    note: "Rating della copertura e qualita' dei dati; non rappresenta l'accuratezza storica ne' una probabilita' di successo."
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
    .slice(0, MODEL_HISTORY_WINDOW)
    .map((match, index) => {
      const home =
        String(match.home_team || "")
          .trim()
          .toLowerCase() === target;

      return {
        scored: Number(home ? match.home_goals : match.away_goals),
        conceded: Number(home ? match.away_goals : match.home_goals),
        date: match.match_date || match.date || null,
        opponent: home ? match.away_team : match.home_team,
        home_team: match.home_team || null,
        away_team: match.away_team || null,
        score: `${match.home_goals}-${match.away_goals}`,
        venue: home ? "home" : "away",
        weight: Number(Math.pow(MODEL_DECAY, index).toFixed(4))
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
    .map((match, index) => {
      const isHome =
        String(match.home_team || "").trim().toLowerCase() === target;

      return {
        scored: Number(isHome ? match.home_goals : match.away_goals),
        conceded: Number(isHome ? match.away_goals : match.home_goals),
        date: match.match_date || match.date || null,
        opponent: isHome ? match.away_team : match.home_team,
        home_team: match.home_team || null,
        away_team: match.away_team || null,
        score: `${match.home_goals}-${match.away_goals}`,
        venue,
        weight: Number(Math.pow(0.75, index).toFixed(4))
      };
    });
}

function calculatePrediction(fixture, history, lineupImpact = null, statisticalForecast = null, coachImpact = null) {
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

  // Shrinkage bayesiano: regolarizza le medie della squadra verso
  // quelle del campionato per ridurre l'effetto di campioni piccoli.
  const PRIOR_MATCHES = MODEL_PRIOR_MATCHES;
  const shrink = (observed, prior, sampleCount) =>
    (observed * sampleCount + prior * PRIOR_MATCHES) /
    (sampleCount + PRIOR_MATCHES || 1);

  const safeHomeLeague = Math.max(0.4, leagueHomeAverage);
  const safeAwayLeague = Math.max(0.4, leagueAwayAverage);
  const homeVenueReady = homeVenueSample.length >= 3;
  const awayVenueReady = awayVenueSample.length >= 3;

  const homeAttack = shrink(homeFor, safeHomeLeague, homeSample.length);
  const homeDefense = shrink(homeAgainst, safeAwayLeague, homeSample.length);
  const awayAttack = shrink(awayFor, safeAwayLeague, awaySample.length);
  const awayDefense = shrink(awayAgainst, safeHomeLeague, awaySample.length);

  const homeVenueFor = shrink(
    homeVenueReady ? weightedAverage(homeVenueSample, "scored") : homeAttack,
    homeAttack, homeVenueSample.length
  );
  const homeVenueAgainst = shrink(
    homeVenueReady ? weightedAverage(homeVenueSample, "conceded") : homeDefense,
    homeDefense, homeVenueSample.length
  );
  const awayVenueFor = shrink(
    awayVenueReady ? weightedAverage(awayVenueSample, "scored") : awayAttack,
    awayAttack, awayVenueSample.length
  );
  const awayVenueAgainst = shrink(
    awayVenueReady ? weightedAverage(awayVenueSample, "conceded") : awayDefense,
    awayDefense, awayVenueSample.length
  );

  const overallHomeLambda =
    safeHomeLeague * (homeAttack / safeHomeLeague) * (awayDefense / safeAwayLeague);
  const overallAwayLambda =
    safeAwayLeague * (awayAttack / safeAwayLeague) * (homeDefense / safeHomeLeague);
  const venueHomeLambda =
    safeHomeLeague * (homeVenueFor / safeHomeLeague) * (awayVenueAgainst / safeAwayLeague);
  const venueAwayLambda =
    safeAwayLeague * (awayVenueFor / safeAwayLeague) * (homeVenueAgainst / safeHomeLeague);

  // Blend generale/venue configurabile per esperimenti; default 70% venue.
  let homeLambda = Math.max(0.10, Math.min(4.5,
    (1 - MODEL_VENUE_BLEND) * overallHomeLambda + MODEL_VENUE_BLEND * venueHomeLambda
  ));
  let awayLambda = Math.max(0.10, Math.min(4.5,
    (1 - MODEL_VENUE_BLEND) * overallAwayLambda + MODEL_VENUE_BLEND * venueAwayLambda
  ));

  // Integra gli xG storici nel modello gol solo quando entrambi i lati
  // hanno almeno 5 osservazioni reali. Gli xG correggono, non sostituiscono,
  // la stima Poisson basata sui risultati e sul rendimento casa/trasferta.
  const xgAverages = statisticalForecast?.weighted_averages?.expected_goals;
  const xgCounts = statisticalForecast?.samples?.expected_goals;
  const xgReady = getNumber(xgAverages?.home) !== null &&
    getNumber(xgAverages?.away) !== null &&
    Number(xgCounts?.home || 0) >= 5 &&
    Number(xgCounts?.away || 0) >= 5;
  const preXgLambdas = { home: homeLambda, away: awayLambda };
  const XG_BLEND_WEIGHT = MODEL_XG_BLEND;
  if (xgReady && XG_BLEND_WEIGHT > 0) {
    homeLambda = Math.max(0.10, Math.min(4.5,
      (1 - XG_BLEND_WEIGHT) * homeLambda +
      XG_BLEND_WEIGHT * Number(xgAverages.home)
    ));
    awayLambda = Math.max(0.10, Math.min(4.5,
      (1 - XG_BLEND_WEIGHT) * awayLambda +
      XG_BLEND_WEIGHT * Number(xgAverages.away)
    ));
  }
  // Correzione prudente per cambio allenatore: deriva dal differenziale reti
  // osservato con il tecnico attuale rispetto ai precedenti, mai da un nome in sé.
  const homeCoachAdjustment = coachImpact?.home?.applied
    ? Number(coachImpact.home.adjustment_percent || 0) / 100 : 0;
  const awayCoachAdjustment = coachImpact?.away?.applied
    ? Number(coachImpact.away.adjustment_percent || 0) / 100 : 0;
  const lambdasBeforeCoach = { home: homeLambda, away: awayLambda };
  homeLambda = Math.max(0.10, Math.min(4.5, homeLambda * (1 + homeCoachAdjustment) * (1 - awayCoachAdjustment * 0.5)));
  awayLambda = Math.max(0.10, Math.min(4.5, awayLambda * (1 + awayCoachAdjustment) * (1 - homeCoachAdjustment * 0.5)));

  // Random Forest sperimentale: addestramento su partite precedenti al target.
  // Non sostituisce Poisson; contribuisce solo se esiste uno storico sufficiente.
  const randomForestForecast = RANDOM_FOREST_ENABLED
    ? predictRandomForest(history, {
        home_team: homeName,
        away_team: awayName,
        match_date: fixtureDate
      })
    : { applied: false, training_matches: 0, reason: "Random Forest disattivato: impostare ENABLE_RANDOM_FOREST=true dopo il test controllato." };
  const RANDOM_FOREST_BLEND_WEIGHT = randomForestForecast.applied ? 0.20 : 0;
  const lambdasAfterCoach = { home: homeLambda, away: awayLambda };
  const lambdasBeforeRandomForest = { home: homeLambda, away: awayLambda };
  if (randomForestForecast.applied) {
    homeLambda = Math.max(0.10, Math.min(4.5,
      (1 - RANDOM_FOREST_BLEND_WEIGHT) * homeLambda +
      RANDOM_FOREST_BLEND_WEIGHT * randomForestForecast.home
    ));
    awayLambda = Math.max(0.10, Math.min(4.5,
      (1 - RANDOM_FOREST_BLEND_WEIGHT) * awayLambda +
      RANDOM_FOREST_BLEND_WEIGHT * randomForestForecast.away
    ));
  }

  const lambdasBeforeLineup = { home: homeLambda, away: awayLambda };
  if (lineupImpact?.applied) {
    homeLambda *= lineupImpact.home_attack_factor / lineupImpact.away_defence_factor;
    awayLambda *= lineupImpact.away_attack_factor / lineupImpact.home_defence_factor;
    homeLambda = Math.max(0.10, Math.min(4.5, homeLambda));
    awayLambda = Math.max(0.10, Math.min(4.5, awayLambda));
  }
  const finalLambdas = { home: homeLambda, away: awayLambda };

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

  const poissonProbabilities = {
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
    btts_no: percent(1 - bttsYes),
    under_0_5: percent(sum(x => x.home + x.away === 0)),
    over_0_5: percent(sum(x => x.home + x.away >= 1)),
    under_4_5: percent(sum(x => x.home + x.away <= 4)),
    over_4_5: percent(sum(x => x.home + x.away >= 5)),
    double_chance_1x: percent(homeWin + draw),
    double_chance_x2: percent(draw + awayWin),
    double_chance_12: percent(homeWin + awayWin),
    multigoal_1_2: percent(sum(x => x.home + x.away >= 1 && x.home + x.away <= 2)),
    multigoal_1_3: percent(sum(x => x.home + x.away >= 1 && x.home + x.away <= 3)),
    multigoal_1_4: percent(sum(x => x.home + x.away >= 1 && x.home + x.away <= 4)),
    multigoal_2_3: percent(sum(x => x.home + x.away >= 2 && x.home + x.away <= 3)),
    multigoal_2_4: percent(sum(x => x.home + x.away >= 2 && x.home + x.away <= 4)),
    multigoal_2_5: percent(sum(x => x.home + x.away >= 2 && x.home + x.away <= 5)),
    multigoal_3_4: percent(sum(x => x.home + x.away >= 3 && x.home + x.away <= 4)),
    combo_1x_over_1_5: percent(sum(x => x.home >= x.away && x.home + x.away >= 2)),
    combo_1x_under_2_5: percent(sum(x => x.home >= x.away && x.home + x.away <= 2)),
    combo_x2_over_1_5: percent(sum(x => x.home <= x.away && x.home + x.away >= 2)),
    combo_x2_under_2_5: percent(sum(x => x.home <= x.away && x.home + x.away <= 2)),
    combo_12_over_1_5: percent(sum(x => x.home !== x.away && x.home + x.away >= 2)),
    combo_12_under_2_5: percent(sum(x => x.home !== x.away && x.home + x.away <= 2)),
    dc_combo_1x_multigoal_1_4: percent(sum(x => x.home >= x.away && x.home + x.away >= 1 && x.home + x.away <= 4)),
    dc_combo_x2_multigoal_1_4: percent(sum(x => x.home <= x.away && x.home + x.away >= 1 && x.home + x.away <= 4)),
    dc_combo_12_multigoal_1_4: percent(sum(x => x.home !== x.away && x.home + x.away >= 1 && x.home + x.away <= 4))
  };

  const probabilities = poissonProbabilities;

  // Affidabilità indicativa dei mercati.
  const reliability = {};

  for (const [market, probability] of Object.entries(probabilities)) {
    reliability[market] = getReliability(
      {
        home: homeSample.length,
        away: awaySample.length
      },
      homeVenueSample.length,
      awayVenueSample.length,
      leagueSample.length
    );
  }

  // I cinque risultati esatti con probabilità più alta.
  const poissonExactScores = [...matrix]
    .sort((a, b) => b.probability - a.probability)
    .slice(0, 5)
    .map(item => ({
      score: `${item.home}-${item.away}`,
      probability: percent(item.probability)
    }));
  const exactScores = poissonExactScores;

  return {
    ok: true,

    model: [
      "Poisson ponderato",
      "shrinkage bayesiano",
      "rendimento casa/trasferta",
      ...(xgReady ? ["integrazione xG storici (25%)"] : []),
      ...(randomForestForecast.applied ? ["Random Forest regressore gol (20%, sperimentale)"] : []),
      ...(lineupImpact?.applied ? ["forma titolari (sperimentale)"] : [])
    ].join(" + "),

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
      team_weighted_averages: {
        home_scored: Number(homeFor.toFixed(3)),
        home_conceded: Number(homeAgainst.toFixed(3)),
        away_scored: Number(awayFor.toFixed(3)),
        away_conceded: Number(awayAgainst.toFixed(3))
      },
      recent_matches: {
        home: homeSample,
        away: awaySample,
        home_at_home: homeVenueSample,
        away_away: awayVenueSample
      },
      venue_weighted_averages: {
        home_scored_at_home: Number(weightedAverage(homeVenueSample, "scored").toFixed(3)),
        home_conceded_at_home: Number(weightedAverage(homeVenueSample, "conceded").toFixed(3)),
        away_scored_away: Number(weightedAverage(awayVenueSample, "scored").toFixed(3)),
        away_conceded_away: Number(weightedAverage(awayVenueSample, "conceded").toFixed(3))
      },
      lambda_components: {
        overall_home: Number(overallHomeLambda.toFixed(3)),
        venue_home: Number(venueHomeLambda.toFixed(3)),
        overall_away: Number(overallAwayLambda.toFixed(3)),
        venue_away: Number(venueAwayLambda.toFixed(3)),
        overall_weight: 0.3,
        venue_weight: 0.7
      },
      lambda_diagnostics: {
        lambda_from_poisson_before_xg_blend: {
          home: Number(preXgLambdas.home.toFixed(4)),
          away: Number(preXgLambdas.away.toFixed(4))
        },
        lambda_after_xg_blend_before_coach: {
          home: Number(lambdasBeforeCoach.home.toFixed(4)),
          away: Number(lambdasBeforeCoach.away.toFixed(4))
        },
        xg_blend: {
          applied: Boolean(xgReady),
          weight_percent: xgReady ? XG_BLEND_WEIGHT * 100 : 0,
          historical_xg: xgReady ? {
            home: Number(Number(xgAverages.home).toFixed(4)),
            away: Number(Number(xgAverages.away).toFixed(4))
          } : null
        },
        coach_adjustment_percent: {
          home: Number((homeCoachAdjustment * 100).toFixed(3)),
          away: Number((awayCoachAdjustment * 100).toFixed(3))
        },
        lambda_after_coach: {
          home: Number(lambdasAfterCoach.home.toFixed(4)),
          away: Number(lambdasAfterCoach.away.toFixed(4))
        },
        lambda_after_random_forest_before_lineup: {
          home: Number(lambdasBeforeLineup.home.toFixed(4)),
          away: Number(lambdasBeforeLineup.away.toFixed(4))
        },
        lambda_final_used_for_poisson: {
          home: Number(finalLambdas.home.toFixed(4)),
          away: Number(finalLambdas.away.toFixed(4))
        },
        lineup_applied: Boolean(lineupImpact?.applied),
        random_forest_applied: Boolean(randomForestForecast.applied)
      },
      venue_split_used: homeVenueReady && awayVenueReady,
      random_forest: {
        ...randomForestForecast,
        blend_weight: RANDOM_FOREST_BLEND_WEIGHT,
        lambdas_before: {
          home: Number(lambdasBeforeRandomForest.home.toFixed(3)),
          away: Number(lambdasBeforeRandomForest.away.toFixed(3))
        }
      },
      xg_adjustment: {
        applied: xgReady,
        blend_weight: xgReady ? XG_BLEND_WEIGHT : 0,
        historical_xg: xgReady ? {
          home: Number(Number(xgAverages.home).toFixed(3)),
          away: Number(Number(xgAverages.away).toFixed(3))
        } : null,
        sample_size: {
          home: Number(xgCounts?.home || 0),
          away: Number(xgCounts?.away || 0)
        },
        lambdas_before_xg_blend: {
          home: Number(preXgLambdas.home.toFixed(3)),
          away: Number(preXgLambdas.away.toFixed(3))
        },
        reason: xgReady ? "xG disponibili su almeno 5 partite per entrambe le squadre." : "xG mancanti o campione inferiore a 5 partite: nessuna correzione."
      },
      lineup_form_adjustment: lineupImpact || { applied: false, reason: "Non disponibile" }
    },

    exact_scores: exactScores
  };
}

// ==========================================
// STATUS SERVER E CAMPIONATI
// ==========================================

function poissonCountProbability(lambda, value) {
  if (lambda <= 0) return value === 0 ? 1 : 0;
  let factorial = 1;
  for (let i = 2; i <= value; i++) factorial *= i;
  return Math.exp(-lambda) * Math.pow(lambda, value) / factorial;
}
function countMarketProbabilities(lambda, prefix, maxLine = 30) {
  const distribution = Array.from({ length: maxLine + 1 }, (_, value) => poissonCountProbability(lambda, value));
  distribution[maxLine] += Math.max(0, 1 - distribution.reduce((a, b) => a + b, 0));
  const output = {};
  for (let half = 1; half <= maxLine; half++) {
    const line = half - 0.5;
    const over = distribution.slice(half).reduce((a, b) => a + b, 0);
    const suffix = String(line).replace(".", "_");
    output[prefix + "_over_" + suffix] = percent(over);
    output[prefix + "_under_" + suffix] = percent(1 - over);
  }
  return output;
}
async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      try { results[index] = await worker(items[index], index); }
      catch (error) { results[index] = { error: error.message }; }
    }
  });
  await Promise.all(runners);
  return results;
}
async function buildHistoricalStatForecast(fixture, history) {
  const fixtureDate = fixture.match_date || fixture.date || fixture.datetime;
  const homeName = String(fixture.home_team || getHomeName(fixture) || "").trim().toLowerCase();
  const awayName = String(fixture.away_team || getAwayName(fixture) || "").trim().toLowerCase();
  const eligible = history.filter(match => {
    const date = match.match_date || match.date;
    return date && isFinished(match) && new Date(date) < new Date(fixtureDate) &&
      getNumber(match.home_goals) !== null && getNumber(match.away_goals) !== null;
  }).sort((a, b) => new Date(b.match_date || b.date) - new Date(a.match_date || a.date));
  const selectTeam = name => eligible.filter(match =>
    String(match.home_team || "").trim().toLowerCase() === name ||
    String(match.away_team || "").trim().toLowerCase() === name
  ).slice(0, 10);
  const homeMatches = selectTeam(homeName), awayMatches = selectTeam(awayName);
  const unique = [...new Map([...homeMatches, ...awayMatches].filter(m => m.id).map(m => [String(m.id), m])).values()];
  let persistedStats = [];
  if (supabase && unique.length) {
    const { data, error } = await supabase
      .from("match_statistics")
      .select("match_id,normalized_stats")
      .in("match_id", unique.map(match => String(match.id)));
    if (error) throw error;
    persistedStats = data || [];
  }
  const statsById = new Map(persistedStats.map(row => [String(row.match_id), row.normalized_stats]));
  const missingStats = unique.filter(match => !statsById.has(String(match.id)));
  const fetched = await mapWithConcurrency(missingStats, 5, async match => {
    const body = await sportGet("/matches/" + encodeURIComponent(match.id) + "/stats");
    return { id: String(match.id), league_id: String(match.league_id || fixture.league_id), match_date: match.match_date || match.date || null, stats: getNormalizedMatchStats(body) };
  });
  const successfulFetches = fetched.filter(item => item && !item.error);
  for (const item of successfulFetches) statsById.set(item.id, item.stats);
  if (supabase && successfulFetches.length) {
    const { error } = await supabase.from("match_statistics").upsert(
      successfulFetches.map(item => ({ match_id: item.id, league_id: item.league_id, match_date: item.match_date, normalized_stats: item.stats, updated_at: new Date().toISOString() })),
      { onConflict: "match_id" }
    );
    if (error) console.error("Persistenza statistiche storiche:", error.message);
  }
  const fields = ["corners", "total_shots", "shots_on_target", "shots_off_target", "blocked_shots",
    "yellow_cards", "red_cards", "fouls", "offsides", "possession", "expected_goals",
    "saves", "passes", "accurate_passes", "tackles", "big_chances", "big_chances_missed",
    "hit_woodwork", "crosses", "long_balls", "duels_won", "aerials_won", "interceptions",
    "clearances", "xg_open_play", "xg_set_play", "npxg", "ppda", "field_tilt",
    "box_entries", "progressive_passes", "progressive_carries", "key_passes",
    "shot_assists", "xg_chain", "xg_buildup", "xa", "xt", "vaep"];
  const samples = {};
  for (const field of fields) samples[field] = { home: [], away: [] };
  const addSamples = (matches, targetSide) => {
    const targetName = targetSide === "home" ? homeName : awayName;
    for (const match of matches) {
      const stats = statsById.get(String(match.id));
      if (!stats) continue;
      const apiSide = String(match.home_team || "").trim().toLowerCase() === targetName ? "home" : "away";
      for (const field of fields) {
        const value = stats[field] && stats[field][apiSide];
        if (value !== null && value !== undefined && Number.isFinite(Number(value))) {
          samples[field][targetSide].push({ value: Number(value), date: match.match_date || match.date });
        }
      }
    }
  };
  addSamples(homeMatches, "home"); addSamples(awayMatches, "away");
  const average = rows => {
    if (!rows.length) return null;
    const ordered = [...rows].sort((a, b) => new Date(b.date) - new Date(a.date));
    let sum = 0, weights = 0;
    ordered.forEach((row, index) => {
      const weight = Math.pow(0.75, index);
      sum += row.value * weight; weights += weight;
    });
    return weights ? Number((sum / weights).toFixed(3)) : null;
  };
  const averages = {}, counts = {}, probabilities = {};
  const countMarkets = ["corners", "total_shots", "shots_on_target", "shots_off_target", "blocked_shots",
    "yellow_cards", "red_cards", "fouls", "offsides", "saves", "big_chances", "big_chances_missed",
    "hit_woodwork", "crosses", "long_balls", "duels_won", "aerials_won", "interceptions",
    "clearances", "box_entries", "progressive_passes", "progressive_carries", "key_passes", "shot_assists"];
  for (const field of fields) {
    averages[field] = { home: average(samples[field].home), away: average(samples[field].away), total: null };
    if (averages[field].home !== null && averages[field].away !== null) {
      averages[field].total = Number((averages[field].home + averages[field].away).toFixed(3));
    }
    counts[field] = { home: samples[field].home.length, away: samples[field].away.length };
    if (countMarkets.includes(field)) {
      // Evita probabilità di mercati volume basate su campioni troppo piccoli.
      // Per home/away serve il campione del lato; per total servono entrambi.
      const MIN_STAT_SAMPLES = 5;
      for (const side of ["home", "away", "total"]) {
        const enoughSamples = side === "total"
          ? counts[field].home >= MIN_STAT_SAMPLES && counts[field].away >= MIN_STAT_SAMPLES
          : counts[field][side] >= MIN_STAT_SAMPLES;
        const lambda = averages[field][side];
        if (enoughSamples && lambda !== null) {
          Object.assign(probabilities, countMarketProbabilities(lambda, field + "_" + side));
        }
      }
    }
  }
  return {
    source: "PitchAPI historical match statistics",
    matches_requested: unique.length,
    matches_with_stats: statsById.size,
    samples: counts,
    weighted_averages: averages,
    probabilities,
    minimum_samples_per_team_for_volume_markets: 5,
    note: "Statistiche assenti restano null; i mercati di volume sono generati solo con almeno 5 osservazioni valide per ciascuna squadra (per i mercati total) o per il lato richiesto."
  };
}

app.get("/api/auth-diagnostic", (req, res) => {
  const authorization = req.get("authorization") || "";
  const hasBearer = authorization.startsWith("Bearer ");
  const supplied = hasBearer ? authorization.slice(7).trim() : "";

  res.json({
    ok: true,
    diagnostic: "auth-header-check",
    serverTokenConfigured: Boolean(ACCESS_TOKEN),
    authorizationHeaderReceived: Boolean(authorization),
    bearerFormatReceived: hasBearer,
    tokenMatchesServer: Boolean(supplied && ACCESS_TOKEN && supplied === ACCESS_TOKEN)
  });
});

app.get("/api/status", async (req, res) => {
  let leagues = [];
  let providerConnected = false;

  if (PITCHAPI_KEY) {
    try {
      leagues = await getEuropeanLeagueCatalog();
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
      const leagues = await getEuropeanLeagueCatalog();
      res.json({ ok: true, response: { data: { leagues } }, league_count: leagues.length });
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

      const europeanLeagues = await getEuropeanLeagueCatalog();
      const europeanIds = new Set(europeanLeagues.map(item => String(item.id)));
      const matches = getMatches(body).filter(match => europeanIds.has(getMatchLeagueId(match)));

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

      const europeanLeagues = await getEuropeanLeagueCatalog();
      const europeanIds = new Set(europeanLeagues.map(item => String(item.id)));
      const matches = getMatches(body).filter(match => europeanIds.has(getMatchLeagueId(match)));

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

        const europeanLeagues = await getEuropeanLeagueCatalog();
        const europeanIds = new Set(europeanLeagues.map(item => String(item.id)));
        const matches = getMatches(body).filter(match => europeanIds.has(getMatchLeagueId(match)));

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
// IMPORTAZIONE STORICO COMPLETO CAMPIONATO
// ==========================================
// Importa le stagioni dichiarate da PitchAPI e salva i risultati in Supabase.
// Le chiamate sono sequenziali per rispettare il fair-use dell'API.
app.post(
  "/api/sync/league/:id/history",
  requireSportApi,
  requireDatabase,
  async (req, res) => {
    const leagueId = String(req.params.id || "");
    if (!/^l_[A-Za-z0-9_-]+$/.test(leagueId)) {
      return res.status(400).json({ ok: false, error: "ID campionato non valido." });
    }

    try {
      const leagues = await getEuropeanLeagueCatalog();
      const league = leagues.find(item => String(item.id) === leagueId);
      if (!league) return res.status(404).json({ ok: false, error: "Campionato non europeo o non presente nel catalogo consentito." });

      const availableSeasons = Array.isArray(league.seasons) ? league.seasons : [];
      const requested = String(req.query.seasons || "").trim();
      const selectedSeasons = requested
        ? requested.split(",").map(value => value.trim()).filter(Boolean)
        : availableSeasons;
      const validSeasons = selectedSeasons.filter(value => /^(?:\d{4}\/\d{4}|\d{4})$/.test(value));
      if (!validSeasons.length) {
        return res.status(422).json({
          ok: false,
          error: "Nessuna stagione valida disponibile per questo campionato.",
          available_seasons: availableSeasons
        });
      }

      let receivedMatches = 0;
      let savedMatches = 0;
      const seasonReports = [];
      for (const season of validSeasons) {
        const body = await sportGet(
          `/leagues/${encodeURIComponent(leagueId)}/matches?season=${encodeURIComponent(season)}&status=played`
        );
        const matches = getMatches(body);
        const saved = await saveMatchesToDatabase(matches, season, leagueId);
        receivedMatches += matches.length;
        savedMatches += saved;
        seasonReports.push({
          season,
          received_matches: matches.length,
          upserted_rows: saved
        });
      }

      res.json({
        ok: true,
        league: { id: leagueId, name: league.name },
        available_seasons: availableSeasons,
        seasons_imported: validSeasons.length,
        received_matches: receivedMatches,
        upserted_rows: savedMatches,
        seasons: seasonReports,
        database: "Supabase"
      });
    } catch (error) {
      handleError(res, error);
    }
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
// FORMA INDIVIDUALE DEI TITOLARI (SOLO ANALISI)
// ==========================================

function extractPlayerRows(body) {
  const rows =
    body?.data?.players ||
    body?.data ||
    body?.response?.data?.players ||
    body?.response?.data ||
    body?.response ||
    [];
  return Array.isArray(rows) ? rows : [];
}

function readPlayerStats(groups) {
  const result = {};
  for (const group of Array.isArray(groups) ? groups : []) {
    const stats = group?.stats;
    if (!stats || typeof stats !== "object") continue;
    for (const item of Object.values(stats)) {
      const key = item?.key;
      const value = getNumber(item?.stat?.value);
      if (key && value !== null) result[key] = value;
    }
  }
  return result;
}

function classifyPlayerPosition(player) {
  const raw = [
    player?.position,
    player?.position_name,
    player?.positionName,
    player?.role,
    player?.position?.name
  ].filter(value => typeof value === "string").join(" ").toLowerCase();
  if (/goalkeeper|keeper|portiere|\bgk\b/.test(raw)) return "goalkeeper";
  if (/defender|defence|defense|difensore|\b(cb|lb|rb|lwb|rwb)\b/.test(raw)) return "defender";
  if (/forward|attacker|striker|winger|attaccante|\b(st|cf|lw|rw)\b/.test(raw)) return "attacker";
  if (/midfield|centrocampista|\b(dm|cm|am)\b/.test(raw)) return "midfielder";
  return "unknown";
}

function calculateLineupFormImpact(playerForm) {
  const result = {
    applied: false,
    reason: "Servono due formazioni confermate e dati recenti sufficienti per i titolari.",
    home_attack_rating: null,
    away_attack_rating: null,
    home_goalkeeper_rating: null,
    away_goalkeeper_rating: null,
    home_defensive_rating: null,
    away_defensive_rating: null,
    home_attack_factor: 1,
    away_attack_factor: 1,
    home_defence_factor: 1,
    away_defence_factor: 1
  };
  if (!playerForm?.lineup_confirmed) return result;

  const summarize = players => {
    const usable = (players || []).filter(player =>
      player.appearances >= 3 &&
      Number.isFinite(getNumber(player.average_per_appearance?.rating))
    );
    const groups = { attack: [], defence: [], goalkeeper: [] };
    for (const player of usable) {
      const rating = getNumber(player.average_per_appearance.rating);
      const role = player.position_group || "unknown";
      if (role === "attacker" || role === "midfielder") groups.attack.push(rating);
      if (role === "defender" || role === "goalkeeper") groups.defence.push(rating);
      if (role === "goalkeeper") groups.goalkeeper.push(rating);
    }
    const avg = values => values.length >= 2
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : null;
    return {
      attack: avg(groups.attack),
      defence: avg(groups.defence),
      goalkeeper: avg(groups.goalkeeper),
      coverage: usable.length
    };
  };
  const home = summarize(playerForm.players?.home);
  const away = summarize(playerForm.players?.away);
  const allHaveRoleData = home.attack !== null && away.attack !== null &&
    home.defence !== null && away.defence !== null &&
    home.goalkeeper !== null && away.goalkeeper !== null;
  if (!allHaveRoleData) {
    result.reason = "Ruoli o valutazioni recenti insufficienti: Poisson lasciato invariato.";
    return result;
  }
  // Rating recenti verso il riferimento neutro 6.70; effetto massimo ±3%.
  const factor = rating => Math.max(0.97, Math.min(1.03,
    1 + ((rating - 6.70) * 0.015)
  ));
  result.home_attack_rating = Number(home.attack.toFixed(3));
  result.away_attack_rating = Number(away.attack.toFixed(3));
  result.home_defensive_rating = Number(home.defence.toFixed(3));
  result.away_defensive_rating = Number(away.defence.toFixed(3));
  result.home_goalkeeper_rating = Number(home.goalkeeper.toFixed(3));
  result.away_goalkeeper_rating = Number(away.goalkeeper.toFixed(3));
  result.home_attack_factor = factor(home.attack);
  result.away_attack_factor = factor(away.attack);
  result.home_defence_factor = factor((home.defence + home.goalkeeper) / 2);
  result.away_defence_factor = factor((away.defence + away.goalkeeper) / 2);
  result.applied = true;
  result.reason = "Correzione sperimentale basata sui rating recenti dei titolari, limitata a ±3%.";
  return result;
}

function extractLineupData(body) {
  return body?.data || body?.response?.data || body?.response || body;
}

async function getFixturePlayerForm(fixture, history) {
  const lineupBody = await sportGet(
    `/matches/${encodeURIComponent(fixture.id)}/lineups`
  );
  const lineup = extractLineupData(lineupBody);
  const sides = [
    { key: "home", teamName: fixture.home_team, lineup: lineup?.home },
    { key: "away", teamName: fixture.away_team, lineup: lineup?.away }
  ];
  const beforeDate = new Date(fixture.match_date || fixture.date || fixture.datetime);
  const output = {
    lineup_confirmed: Boolean(sides.every(side => side.lineup?.confirmed === true)),
    lineup: {},
    players: { home: [], away: [] },
    methodology: "Ultime presenze individuali ricostruite dalle statistiche partita PitchAPI; la correzione Poisson e\u0300 applicata solo con formazioni confermate e copertura sufficiente."
  };

  for (const side of sides) {
    const starters = Array.isArray(side.lineup?.starters) ? side.lineup.starters : [];
    output.lineup[side.key] = {
      formation: side.lineup?.formation || null,
      confirmed: side.lineup?.confirmed === true,
      lineup_type: side.lineup?.lineup_type || null,
      starters_count: starters.length
    };
    if (!starters.length) continue;

    // Preferisci gli ID squadra (piu' affidabili dei nomi); usa il nome
    // normalizzato solo quando l'ID non e' presente nello storico.
    const currentTeamId = side.key === "home"
      ? (fixture.home_team_id || getHomeId(fixture))
      : (fixture.away_team_id || getAwayId(fixture));
    const normalizedTeamName = String(side.teamName || "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .trim().toLowerCase().replace(/\s+/g, " ");

    const teamMatches = (history || [])
      .filter(match => {
        const date = match.match_date || match.date;
        const homeId = match.home_team_id || getHomeId(match);
        const awayId = match.away_team_id || getAwayId(match);
        const hasComparableIds = currentTeamId && (homeId || awayId);
        const sameTeam = hasComparableIds
          ? String(homeId || "") === String(currentTeamId) ||
            String(awayId || "") === String(currentTeamId)
          : [match.home_team, match.away_team].some(name =>
              String(name || "").normalize("NFD")
                .replace(/[\u0300-\u036f]/g, "")
                .trim().toLowerCase().replace(/\s+/g, " ") === normalizedTeamName
            );
        return date && new Date(date) < beforeDate && isFinished(match) && sameTeam && match.id;
      })
      .sort((a, b) => new Date(b.match_date || b.date) - new Date(a.match_date || a.date))
      .slice(0, 10);

    const playerIds = new Set(starters.map(player => String(player.player_id || player.id || "")).filter(Boolean));
    const appearanceMap = new Map([...playerIds].map(id => [id, []]));

    for (let i = 0; i < teamMatches.length; i += 4) {
      const batch = teamMatches.slice(i, i + 4);
      const results = await Promise.all(batch.map(async match => {
        try {
          const body = await sportGet(`/matches/${encodeURIComponent(match.id)}/players`);
          return { match, rows: extractPlayerRows(body) };
        } catch (error) {
          console.error(`Player stats non disponibili per ${match.id}:`, error.message);
          return { match, rows: [] };
        }
      }));

      for (const result of results) {
        for (const row of result.rows) {
          const playerId = String(row?.player?.id || row?.player_id || "");
          if (!playerIds.has(playerId)) continue;
          const stats = readPlayerStats(row.stats);
          const minutes = stats.minutes_played ?? stats.minutes ?? 0;
          if (minutes <= 0) continue;
          appearanceMap.get(playerId).push({
            match_id: String(result.match.id),
            date: result.match.match_date || result.match.date || null,
            minutes,
            stats
          });
        }
      }
    }

    for (const player of starters) {
      const id = String(player.player_id || player.id || "");
      const appearances = (appearanceMap.get(id) || [])
        .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
        .slice(0, 10);
      const totals = {};
      for (const appearance of appearances) {
        for (const [key, value] of Object.entries(appearance.stats)) {
          totals[key] = (totals[key] || 0) + value;
        }
      }
      const averages = Object.fromEntries(
        Object.entries(totals).map(([key, value]) => [
          key,
          Number((value / Math.max(1, appearances.length)).toFixed(3))
        ])
      );
      output.players[side.key].push({
        team: side.teamName,
        player_id: id || null,
        name: player.name || null,
        position: player.position?.name || player.position_name || player.position || null,
        position_group: classifyPlayerPosition(player),
        shirt_number: player.shirt_number || null,
        appearances: appearances.length,
        minutes_total: appearances.reduce((sum, item) => sum + item.minutes, 0),
        average_per_appearance: averages,
        recent_appearances: appearances
      });
    }
  }
  return output;
}

// ==========================================
// IMPATTO ALLENATORE: STORICO RECENTE PER TECNICO
// ==========================================
const coachLineupCache = new Map();
const COACH_LINEUP_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function getCachedCoachLineup(matchId) {
  const key = String(matchId);
  const cached = coachLineupCache.get(key);
  if (cached && Date.now() - cached.savedAt < COACH_LINEUP_CACHE_TTL_MS) {
    return cached.data;
  }
  const body = await sportGet(`/matches/${encodeURIComponent(key)}/lineups`);
  const data = extractLineupData(body);
  if (coachLineupCache.size >= 500) {
    const oldestKey = coachLineupCache.keys().next().value;
    if (oldestKey) coachLineupCache.delete(oldestKey);
  }
  coachLineupCache.set(key, { data, savedAt: Date.now() });
  return data;
}

function normalizeCoachTeamName(value) {
  return String(value || "").normalize("NFD")
    .replace(/[\\u0300-\\u036f]/g, "").trim().toLowerCase().replace(/\\s+/g, " ");
}

async function getCoachChangeImpact(fixture, history) {
  const result = {
    applied: false,
    reason: "Storico allenatori insufficiente o allenatore non disponibile.",
    home: null,
    away: null,
    max_adjustment_percent: 3
  };
  const fixtureDate = new Date(fixture.match_date || fixture.date || fixture.datetime);
  if (!Number.isFinite(fixtureDate.getTime())) return result;

  const sides = [
    { key: "home", name: fixture.home_team, id: fixture.home_team_id || getHomeId(fixture) },
    { key: "away", name: fixture.away_team, id: fixture.away_team_id || getAwayId(fixture) }
  ];
  const tasks = [];
  for (const side of sides) {
    const teamName = normalizeCoachTeamName(side.name);
    const teamMatches = (history || []).filter(match => {
      const date = match.match_date || match.date;
      if (!date || new Date(date) >= fixtureDate || !isFinished(match)) return false;
      const homeId = match.home_team_id || getHomeId(match);
      const awayId = match.away_team_id || getAwayId(match);
      if (side.id && (homeId || awayId)) {
        return String(homeId || "") === String(side.id) || String(awayId || "") === String(side.id);
      }
      return normalizeCoachTeamName(match.home_team) === teamName ||
        normalizeCoachTeamName(match.away_team) === teamName;
    }).sort((a,b) => new Date(b.match_date || b.date) - new Date(a.match_date || a.date)).slice(0, 30);
    tasks.push({ side, teamMatches });
  }

  const teamResults = await Promise.all(tasks.map(async ({side, teamMatches}) => {
    // Scansione progressiva delle ultime 30 gare: si interrompe appena
    // abbiamo almeno 3 osservazioni col tecnico più recente e 2 precedenti.
    // Le richieste sono in piccoli blocchi per limitare carico e latenza.
    const valid = [];
    let currentCoach = null;
    let scanned = 0;
    for (let offset = 0; offset < teamMatches.length; offset += 4) {
      const batch = teamMatches.slice(offset, offset + 4);
      scanned += batch.length;
      const observations = await mapWithConcurrency(batch, 4, async match => {
        try {
          const lineup = await getCachedCoachLineup(match.id);
          const homeId = match.home_team_id || getHomeId(match);
          const isHome = side.id && homeId
            ? String(homeId) === String(side.id)
            : normalizeCoachTeamName(match.home_team) === normalizeCoachTeamName(side.name);
          const teamLineup = isHome ? lineup?.home : lineup?.away;
          const coach = teamLineup?.coach?.name || teamLineup?.coach || null;
          if (!coach || getNumber(match.home_goals) === null || getNumber(match.away_goals) === null) return null;
          const scored = Number(isHome ? match.home_goals : match.away_goals);
          const conceded = Number(isHome ? match.away_goals : match.home_goals);
          return { coach: String(coach).trim(), scored, conceded, date: match.match_date || match.date };
        } catch (error) {
          return null;
        }
      });
      valid.push(...observations.filter(Boolean));
      valid.sort((a,b) => new Date(b.date)-new Date(a.date));
      if (!currentCoach && valid.length) currentCoach = valid[0].coach;
      if (currentCoach) {
        const currentCount = valid.filter(item => item.coach.toLowerCase() === currentCoach.toLowerCase()).length;
        const previousCount = valid.length - currentCount;
        if (currentCount >= 3 && previousCount >= 2) break;
      }
    }
    if (!valid.length) return { team: side.name, applied:false, history_matches_scanned: scanned, coach_observations: 0,
      reason:"Nessun allenatore rilevato nelle formazioni storiche." };
    currentCoach = valid[0].coach;
    const current = valid.filter(item => item.coach.toLowerCase() === currentCoach.toLowerCase());
    const previous = valid.filter(item => item.coach.toLowerCase() !== currentCoach.toLowerCase());
    const avgDiff = rows => rows.length ? rows.reduce((sum,item)=>sum+item.scored-item.conceded,0)/rows.length : null;
    const currentDiff = avgDiff(current);
    const previousDiff = avgDiff(previous);
    if (current.length < 3 || previous.length < 2 || previousDiff === null) {
      return { team: side.name, coach: currentCoach, matches_under_current_coach: current.length,
        matches_under_previous_coaches: previous.length, history_matches_scanned: scanned,
        coach_observations: valid.length, applied:false,
        reason:"Campione insufficiente anche dopo la scansione estesa: servono almeno 3 partite con l'allenatore attuale e 2 con i precedenti." };
    }
    const delta = currentDiff - previousDiff;
    const adjustment = Math.max(-0.03, Math.min(0.03, delta * 0.015));
    return {
      team: side.name, coach: currentCoach, matches_under_current_coach: current.length,
      matches_under_previous_coaches: previous.length,
      history_matches_scanned: scanned,
      coach_observations: valid.length,
      goal_difference_per_match_current: Number(currentDiff.toFixed(3)),
      goal_difference_per_match_previous: Number(previousDiff.toFixed(3)),
      observed_change: Number(delta.toFixed(3)),
      adjustment_percent: Number((adjustment * 100).toFixed(2)),
      applied: true,
      reason: "Confronto descrittivo dei risultati con il tecnico attuale e i precedenti; effetto limitato a ±3%."
    };
  }));
  result.home = teamResults[0];
  result.away = teamResults[1];
  result.applied = Boolean(result.home?.applied || result.away?.applied);
  result.reason = result.applied
    ? "Impatto allenatore applicato solo dove lo storico dei tecnici è sufficiente."
    : "Impatto non applicato: campione insufficiente; Poisson invariato.";
  return result;
}

app.get(
  "/api/fixture/:id/player-form",
  requireDatabase,
  requireSportApi,
  async (req, res) => {
    const matchId = String(req.params.id);
    try {
      const { data: fixture, error } = await supabase
        .from("matches").select("*").eq("id", matchId).maybeSingle();
      if (error) throw error;
      if (!fixture) {
        return res.status(404).json({ ok: false, error: "Partita non trovata in Supabase. Sincronizza prima la data." });
      }
      const history = await getLeagueMatchesFromDatabase(fixture.league_id, fixture.season);
      const playerForm = await getFixturePlayerForm(fixture, history);
      res.json({
        ok: true,
        match: { id: fixture.id, home_team: fixture.home_team, away_team: fixture.away_team, date: fixture.match_date },
        ...playerForm,
        note: "Forma e statistiche individuali dei titolari; correzione Poisson applicata solo se le formazioni sono confermate e i dati sono sufficienti."
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

      const playerForm = await getFixturePlayerForm(fixture, history).catch(error => {
        console.error("Player form non disponibile:", error.message);
        return null;
      });
      const lineupImpact = calculateLineupFormImpact(playerForm);

      // Recupera prima le statistiche storiche: gli xG validi partecipano
      // anche al calcolo degli expected goals, non solo ai mercati di volume.
      let statisticalForecast = null;
      try {
        statisticalForecast = await buildHistoricalStatForecast(fixture, history);
      } catch (statsError) {
        console.error("Modello statistiche avanzate non disponibile:", statsError.message);
      }

      let coachImpact = null;
      try {
        coachImpact = await getCoachChangeImpact(fixture, history);
      } catch (coachError) {
        console.error("Impatto allenatore non disponibile:", coachError.message);
      }

      const prediction = calculatePrediction(
        fixture, history, lineupImpact, statisticalForecast, coachImpact
      );
      if (!prediction.ok) {
        return res.status(422).json({
          ok: false,
          match: fixture,
          ...prediction
        });
      }
      if (statisticalForecast?.probabilities) {
        prediction.probabilities = {
          ...prediction.probabilities,
          ...statisticalForecast.probabilities
        };
      }

      res.json({
        ok: true,
        model: prediction.model,
        statistical_forecast: statisticalForecast,
        data_coverage: statisticalForecast ? {
          historical_matches_requested: statisticalForecast.matches_requested,
          historical_matches_with_statistics: statisticalForecast.matches_with_stats,
          available_stat_fields: Object.entries(statisticalForecast.samples || {})
            .filter(([, counts]) => counts.home > 0 || counts.away > 0)
            .map(([field]) => field),
          missing_stat_fields: Object.entries(statisticalForecast.samples || {})
            .filter(([, counts]) => counts.home === 0 && counts.away === 0)
            .map(([field]) => field)
        } : { available: false, reason: "Statistiche storiche non recuperabili in questa richiesta." },
        lineup_form_impact: lineupImpact,
        coach_impact: coachImpact,
        player_form: playerForm ? { lineup_confirmed: playerForm.lineup_confirmed, lineup: playerForm.lineup, players: playerForm.players } : null,

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
        model_inputs: prediction.model_inputs,
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
// BACKTEST COMPLETO A BLOCCHI (JOB ASINCRONO)
// ==========================================
const bulkBacktestJobs = new Map();

function aggregateBulkMarket(target, source) {
  for (const [market, metric] of Object.entries(source || {})) {
    const row = target[market] || {
      evaluated: 0, correct: 0, tp: 0, tn: 0, fp: 0, fn: 0,
      positive_actual: 0, negative_actual: 0, brier_sum: 0, brier_n: 0
    };
    const evaluated = Number(metric.evaluated || 0);
    row.evaluated += evaluated;
    row.correct += Number(metric.correct || 0);
    row.tp += Number(metric.true_positive || 0);
    row.tn += Number(metric.true_negative || 0);
    row.fp += Number(metric.false_positive || 0);
    row.fn += Number(metric.false_negative || 0);
    row.positive_actual += Number(metric.positive_actual || 0);
    row.negative_actual += Number(metric.negative_actual || 0);
    if (metric.brier_score !== undefined && metric.brier_score !== null && evaluated > 0) {
      row.brier_sum += Number(metric.brier_score) * evaluated;
      row.brier_n += evaluated;
    }
    target[market] = row;
  }
}

function finalizeBulkMarkets(source) {
  return Object.fromEntries(Object.entries(source).map(([market, row]) => {
    const sensitivity = row.tp + row.fn ? row.tp / (row.tp + row.fn) : null;
    const specificity = row.tn + row.fp ? row.tn / (row.tn + row.fp) : null;
    const baseline = row.evaluated
      ? Math.max(row.positive_actual, row.negative_actual) / row.evaluated * 100
      : null;
    return [market, {
      evaluated: row.evaluated,
      correct: row.correct,
      accuracy: row.evaluated ? Number((row.correct / row.evaluated * 100).toFixed(2)) : null,
      positive_actual: row.positive_actual,
      negative_actual: row.negative_actual,
      true_positive: row.tp,
      true_negative: row.tn,
      false_positive: row.fp,
      false_negative: row.fn,
      sensitivity_percent: sensitivity === null ? null : Number((sensitivity * 100).toFixed(2)),
      specificity_percent: specificity === null ? null : Number((specificity * 100).toFixed(2)),
      balanced_accuracy_percent: sensitivity === null || specificity === null
        ? null : Number(((sensitivity + specificity) / 2 * 100).toFixed(2)),
      majority_baseline_accuracy_percent: baseline === null ? null : Number(baseline.toFixed(2)),
      beats_majority_baseline: baseline !== null && row.evaluated > 0 &&
        row.correct / row.evaluated * 100 > baseline,
      brier_score: row.brier_n ? Number((row.brier_sum / row.brier_n).toFixed(4)) : null
    }];
  }));
}

async function runBulkBacktestJob(job) {
  const aggregateStats = {};
  const aggregateGoals = {};
  const baseUrl = `http://127.0.0.1:${PORT}`;
  try {
    for (let offset = 0; offset < job.maxMatches; offset += job.batchSize) {
      const url = new URL(`/api/backtest/${encodeURIComponent(job.leagueId)}`, baseUrl);
      url.searchParams.set("limit", String(job.batchSize));
      url.searchParams.set("offset", String(offset));
      if (job.allSeasons) url.searchParams.set("all_seasons", "true");
      else url.searchParams.set("season", job.season);
      url.searchParams.set("include_stats", "true");
      url.searchParams.set("stats_limit", String(job.batchSize));
      url.searchParams.set("summary", "true");

      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, Accept: "application/json" },
        signal: AbortSignal.timeout(180000)
      });
      const raw = await response.text();
      let data;
      try { data = JSON.parse(raw); } catch { throw new Error(`Risposta non JSON al blocco offset ${offset}.`); }
      if (!response.ok || data?.ok !== true) {
        throw new Error(`Blocco offset ${offset}: HTTP ${response.status} - ${data?.error || "errore backtest"}`);
      }

      aggregateBulkMarket(aggregateStats, data.statistical_accuracy_by_market);
      aggregateBulkMarket(aggregateGoals, data.accuracy_by_market);
      const statRows = Object.entries(data.statistical_accuracy_by_market || {})
        .filter(([, m]) => m.beats_majority_baseline === true &&
          Number(m.positive_actual || 0) >= 4 && Number(m.negative_actual || 0) >= 4 &&
          Number.isFinite(Number(m.balanced_accuracy_percent)))
        .sort((a, b) => Number(b[1].balanced_accuracy_percent) - Number(a[1].balanced_accuracy_percent))
        .slice(0, 15)
        .map(([market, metric]) => ({ market, ...metric }));

      job.blocks.push({
        block: job.blocks.length + 1,
        offset,
        matches_selected: Number(data.evaluation_matches_selected || 0),
        matches_evaluated: Number(data.evaluated_matches || 0),
        period: data.evaluation_period || null,
        accuracy_by_market: data.accuracy_by_market || {},
        advanced_metrics: data.advanced_metrics || {},
        statistical_matches: Number(data.statistical_backtest?.evaluated_matches || 0),
        statistical_markets_count: Object.keys(data.statistical_accuracy_by_market || {}).length,
        top_statistical_markets: statRows
      });
      job.completedMatches += Number(data.evaluated_matches || 0);
      job.completedBlocks = job.blocks.length;
      job.nextOffset = Number(data.next_offset ?? offset + job.batchSize);
      job.updatedAt = new Date().toISOString();

      if (data.done || !data.evaluation_matches_selected) break;
    }

    job.result = {
      ok: true,
      league_id: job.leagueId,
      season: job.allSeasons ? "ALL" : job.season,
      all_seasons: job.allSeasons,
      requested_matches_max: job.maxMatches,
      batch_size: job.batchSize,
      blocks_completed: job.blocks.length,
      evaluated_matches: job.completedMatches,
      statistical_markets_aggregated: finalizeBulkMarkets(aggregateStats),
      goal_markets_aggregated: finalizeBulkMarkets(aggregateGoals),
      blocks: job.blocks,
      completed_at: new Date().toISOString(),
      notes: [
        "Le accuratezze aggregate sono calcolate sommando conteggi e matrici di confusione dei blocchi.",
        "Le voci 1/X/2 vanno interpretate con cautela: il report standard può ripetere la stessa metrica aggregata per tutte e tre.",
        "Balanced accuracy e baseline maggioritaria sono più informative della sola accuracy per mercati sbilanciati."
      ]
    };
    job.status = "completed";
  } catch (error) {
    job.status = "failed";
    job.error = error.message;
  } finally {
    job.updatedAt = new Date().toISOString();
  }
}

app.post("/api/backtest/bulk/start/:leagueId", requireDatabase, (req, res) => {
  const leagueId = String(req.params.leagueId || "");
  if (!/^l_[A-Za-z0-9_-]+$/.test(leagueId)) {
    return res.status(400).json({ ok: false, error: "ID campionato non valido." });
  }
  const allSeasons = String(req.query.all_seasons || "").toLowerCase() === "true";
  const season = allSeasons ? "ALL" : String(req.query.season || "2026/2027");
  if (!allSeasons && !/^\d{4}\/\d{4}$/.test(season)) {
    return res.status(400).json({ ok: false, error: "Stagione non valida. Usa YYYY/YYYY." });
  }
  const maxMatches = Math.min(1000, Math.max(1, Number.parseInt(req.query.matches || "1000", 10) || 1000));
  const batchSize = Math.min(20, Math.max(5, Number.parseInt(req.query.batch_size || "20", 10) || 20));
  const active = [...bulkBacktestJobs.values()].find(job =>
    job.status === "running" && job.leagueId === leagueId && job.season === season && job.allSeasons === allSeasons
  );
  if (active) {
    return res.status(202).json({
      ok: true, already_running: true, job_id: active.id,
      status_url: `/api/backtest/bulk/${active.id}`,
      result_url: `/api/backtest/bulk/${active.id}/result`
    });
  }
  const id = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  const job = {
    id, leagueId, season, allSeasons, maxMatches, batchSize, status: "running",
    blocks: [], completedBlocks: 0, completedMatches: 0, nextOffset: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    result: null, error: null
  };
  bulkBacktestJobs.set(id, job);
  setTimeout(() => runBulkBacktestJob(job), 0);
  res.status(202).json({
    ok: true, message: "Backtest completo avviato in background.",
    job_id: id, status_url: `/api/backtest/bulk/${id}`,
    result_url: `/api/backtest/bulk/${id}/result`,
    expected_blocks: Math.ceil(maxMatches / batchSize),
    batch_size: batchSize, requested_matches: maxMatches, all_seasons: allSeasons
  });
});

app.get("/api/backtest/bulk/:jobId", (req, res) => {
  const job = bulkBacktestJobs.get(String(req.params.jobId));
  if (!job) return res.status(404).json({ ok: false, error: "Job non trovato o scaduto." });
  res.json({
    ok: true, job_id: job.id, status: job.status,
    completed_blocks: job.completedBlocks,
    expected_blocks: Math.ceil(job.maxMatches / job.batchSize),
    completed_matches: job.completedMatches,
    next_offset: job.nextOffset,
    updated_at: job.updatedAt,
    error: job.error,
    result_url: job.status === "completed" ? `/api/backtest/bulk/${job.id}/result` : null
  });
});

app.get("/api/backtest/bulk/:jobId/result", (req, res) => {
  const job = bulkBacktestJobs.get(String(req.params.jobId));
  if (!job) return res.status(404).json({ ok: false, error: "Job non trovato o scaduto." });
  if (job.status !== "completed") {
    return res.status(409).json({
      ok: false, status: job.status, completed_blocks: job.completedBlocks,
      expected_blocks: Math.ceil(job.maxMatches / job.batchSize),
      error: job.error || "Il backtest è ancora in esecuzione."
    });
  }
  res.setHeader("Content-Disposition", `attachment; filename="football-predictor-backtest-${job.leagueId}-${job.season.replace("/", "-")}.json"`);
  res.json(job.result);
});

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

      const allowedLeagues = await getEuropeanLeagueCatalog();
      if (!allowedLeagues.some(item => String(item.id) === leagueId)) {
        return res.status(404).json({ ok: false, error: "Backtest consentito solo per campionati europei e competizioni UEFA/World Cup incluse." });
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

      const allSeasons = String(req.query.all_seasons || "").toLowerCase() === "true";
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

      // Carica lo storico completo del campionato, incluse le stagioni
      // precedenti: serve per avere campioni sufficienti a inizio stagione.
      // La selezione delle partite da valutare resta limitata alla stagione richiesta.
      const { data, error } = await backtestQuery;

      if (error) throw error;

      const history = (data || []).sort((a, b) =>
        new Date(a.match_date) - new Date(b.match_date)
      );
      const dateMatches = history.filter(match => {
        if (!isFinished(match)) return false;
        // La stagione limita il campione di valutazione, non lo storico
        // disponibile al modello per i soli incontri precedenti.
        if (!allSeasons && season && String(match.season || "") !== season) return false;
        const day = String(match.match_date || "").slice(0, 10);
        if (targetDate) return day === targetDate;
        if (fromDate && day < fromDate) return false;
        if (toDate && day > toDate) return false;
        return true;
      });
      const summaryOnly = String(req.query.summary || "").toLowerCase() === "true";
      const includeStats = String(req.query.include_stats || "").toLowerCase() === "true";
      const statsEvaluationLimit = Math.min(Math.max(Number(req.query.stats_limit) || 20, 1), 300);
      const offset = Math.max(0, Number.parseInt(req.query.offset || "0", 10) || 0);
      // Multi-season: valuta prima le partite concluse più recenti.
      // calculatePrediction usa soltanto incontri precedenti alla data prevista.
      const evaluationPool = allSeasons ? [...dateMatches].reverse() : dateMatches;
      const evaluationMatches = includeStats
        ? evaluationPool.slice(offset, offset + Math.min(limit, statsEvaluationLimit))
        : evaluationPool.slice(-limit);
      const results = [];
      const statisticalMarketRows = {};

      for (const match of evaluationMatches) {
        if (
          match.home_goals === null ||
          match.away_goals === null ||
          !match.match_date
        ) {
          continue;
        }

        const prediction = calculatePrediction(match, history);
        if (!prediction?.probabilities) continue;

        let historicalStatsForecast = null;
        let actualMatchStats = null;
        if (includeStats) {
          try {
            historicalStatsForecast = await buildHistoricalStatForecast(match, history);
            const { data: storedStats, error: storedStatsError } = await supabase
              .from("match_statistics")
              .select("normalized_stats")
              .eq("match_id", String(match.id))
              .maybeSingle();
            if (storedStatsError) throw storedStatsError;
            actualMatchStats = storedStats?.normalized_stats || null;

            // Se le statistiche della partita target non sono ancora in Supabase,
            // recuperale direttamente da PitchAPI: non scartare una valutazione valida
            // solo perché il backfill del database non è ancora arrivato.
            if (!actualMatchStats) {
              try {
                const actualBody = await sportGet(
                  "/matches/" + encodeURIComponent(match.id) + "/stats"
                );
                actualMatchStats = getNormalizedMatchStats(actualBody);
                if (actualMatchStats) {
                  const { error: saveActualStatsError } = await supabase
                    .from("match_statistics")
                    .upsert({
                      match_id: String(match.id),
                      league_id: String(match.league_id || leagueId),
                      match_date: match.match_date,
                      normalized_stats: actualMatchStats,
                      updated_at: new Date().toISOString()
                    }, { onConflict: "match_id" });
                  if (saveActualStatsError) {
                    console.error("Persistenza statistiche target " + match.id + ":", saveActualStatsError.message);
                  }
                }
              } catch (fetchActualStatsError) {
                console.error("Recupero statistiche target " + match.id + ":", fetchActualStatsError.message);
              }
            }
          } catch (statsError) {
            console.error("Backtest statistiche " + match.id + ":", statsError.message);
          }
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
            over_0_5: totalGoals >= 1,
            under_0_5: totalGoals === 0,
            over_1_5: actualOver15,
            under_1_5: totalGoals <= 1,
            over_2_5: actualOver25,
            under_2_5: totalGoals <= 2,
            over_3_5: actualOver35,
            under_3_5: totalGoals <= 3,
            btts_yes: actualBtts,
            btts_no: !actualBtts,
            double_chance_1x: actual.home >= actual.away,
            double_chance_x2: actual.home <= actual.away,
            double_chance_12: actual.home !== actual.away,
            multigoal_1_2: totalGoals >= 1 && totalGoals <= 2,
            multigoal_1_3: totalGoals >= 1 && totalGoals <= 3,
            multigoal_1_4: totalGoals >= 1 && totalGoals <= 4,
            multigoal_2_3: totalGoals >= 2 && totalGoals <= 3,
            multigoal_2_4: totalGoals >= 2 && totalGoals <= 4,
            multigoal_2_5: totalGoals >= 2 && totalGoals <= 5,
            multigoal_3_4: totalGoals >= 3 && totalGoals <= 4,
            combo_1x_over_1_5: actual.home >= actual.away && totalGoals >= 2,
            combo_1x_under_2_5: actual.home >= actual.away && totalGoals <= 2,
            combo_x2_over_1_5: actual.home <= actual.away && totalGoals >= 2,
            combo_x2_under_2_5: actual.home <= actual.away && totalGoals <= 2,
            combo_12_over_1_5: actual.home !== actual.away && totalGoals >= 2,
            combo_12_under_2_5: actual.home !== actual.away && totalGoals <= 2,
            dc_combo_1x_multigoal_1_4: actual.home >= actual.away && totalGoals >= 1 && totalGoals <= 4,
            dc_combo_x2_multigoal_1_4: actual.home <= actual.away && totalGoals >= 1 && totalGoals <= 4,
            dc_combo_12_multigoal_1_4: actual.home !== actual.away && totalGoals >= 1 && totalGoals <= 4
          },
          probabilities: p,
          expected_goals: prediction.expected_goals || null,
          exact_scores: prediction.exact_scores || [],
          ...(includeStats ? {
            statistical_forecast: historicalStatsForecast,
            actual_statistics: actualMatchStats
          } : {})
        });

        if (includeStats) {
          // Valuta anche i mercati derivati dai gol: doppia chance, multigol e combo.
          // Usa la probabilità del modello e il risultato effettivo della partita.
          const goalMarketKeys = [
            "double_chance_1x", "double_chance_x2", "double_chance_12",
            "multigoal_1_2", "multigoal_1_3", "multigoal_1_4",
            "multigoal_2_3", "multigoal_2_4", "multigoal_2_5", "multigoal_3_4",
            "combo_1x_over_1_5", "combo_1x_under_2_5",
            "combo_x2_over_1_5", "combo_x2_under_2_5",
            "combo_12_over_1_5", "combo_12_under_2_5",
            "dc_combo_1x_multigoal_1_4", "dc_combo_x2_multigoal_1_4",
            "dc_combo_12_multigoal_1_4"
          ];
          for (const key of goalMarketKeys) {
            const probability = getNumber(p[key]);
            const actualMarket = results[results.length - 1].actual_markets[key];
            if (probability === null || typeof actualMarket !== "boolean") continue;
            if (!statisticalMarketRows[key]) statisticalMarketRows[key] = [];
            statisticalMarketRows[key].push({ probability, actual: actualMarket });
          }
        }

        if (includeStats && historicalStatsForecast?.probabilities && actualMatchStats) {
          const statFields = ["corners", "total_shots", "shots_on_target", "shots_off_target",
            "blocked_shots", "yellow_cards", "red_cards", "fouls", "offsides", "saves",
            "big_chances", "big_chances_missed", "hit_woodwork", "crosses", "long_balls",
            "duels_won", "aerials_won", "interceptions", "clearances", "box_entries",
            "progressive_passes", "progressive_carries", "key_passes", "shot_assists"];
          for (const field of statFields) {
            const actualHome = getNumber(actualMatchStats[field]?.home);
            const actualAway = getNumber(actualMatchStats[field]?.away);
            const actualValues = {
              home: actualHome,
              away: actualAway,
              total: actualHome !== null && actualAway !== null
                ? actualHome + actualAway
                : null
            };
            for (const side of ["home", "away", "total"]) {
              const actualValue = actualValues[side];
              // Una statistica mancante per una squadra non deve annullare
              // la valutazione valida dell'altra squadra.
              if (actualValue === null) continue;
              for (let half = 1; half <= 20; half++) {
                const line = half - 0.5;
                const suffix = String(line).replace(".", "_");
                const key = field + "_" + side + "_over_" + suffix;
                const probability = getNumber(historicalStatsForecast.probabilities[key]);
                if (probability === null) continue;
                if (!statisticalMarketRows[key]) statisticalMarketRows[key] = [];
                statisticalMarketRows[key].push({
                  probability,
                  actual: actualValue >= half
                });
                const underKey = field + "_" + side + "_under_" + suffix;
                if (!statisticalMarketRows[underKey]) statisticalMarketRows[underKey] = [];
                statisticalMarketRows[underKey].push({
                  probability: 100 - probability,
                  actual: actualValue < half
                });
              }
            }
          }
        }
      }

      const evaluated = results.length;
      const correct = results.filter(result => result.correct_1x2).length;

      // Metriche avanzate di valutazione del modello.
      const EPSILON = 1e-6;
      let totalLogLoss = 0;
      let homeGoalAbsoluteError = 0;
      let awayGoalAbsoluteError = 0;
      let homeGoalSquaredError = 0;
      let awayGoalSquaredError = 0;
      let exactScoreTop1Hits = 0;
      let exactScoreEvaluated = 0;
      let expectedGoalsEvaluated = 0;

      for (const result of results) {
        const actualOutcome = result.actual_result;
        const rawProbability = Number(result.probabilities?.[actualOutcome]) / 100;
        const outcomeProbability = Math.max(EPSILON, Math.min(1, rawProbability));
        totalLogLoss += -Math.log(outcomeProbability);

        const expectedHome = getNumber(result.expected_goals?.home);
        const expectedAway = getNumber(result.expected_goals?.away);
        const [actualHome, actualAway] = result.actual_score.split("-").map(Number);
        if (expectedHome !== null && expectedAway !== null &&
            Number.isFinite(actualHome) && Number.isFinite(actualAway)) {
          expectedGoalsEvaluated++;
          const homeError = expectedHome - actualHome;
          const awayError = expectedAway - actualAway;
          homeGoalAbsoluteError += Math.abs(homeError);
          awayGoalAbsoluteError += Math.abs(awayError);
          homeGoalSquaredError += homeError * homeError;
          awayGoalSquaredError += awayError * awayError;
        }

        if (Array.isArray(result.exact_scores) && result.exact_scores.length) {
          exactScoreEvaluated++;
          if (result.exact_scores[0]?.score === result.actual_score) exactScoreTop1Hits++;
        }
      }

      const xgPairs = results.flatMap(result => {
        const predictedHome = getNumber(result.expected_goals?.home);
        const predictedAway = getNumber(result.expected_goals?.away);
        const actualHomeXg = getNumber(result.actual_statistics?.expected_goals?.home);
        const actualAwayXg = getNumber(result.actual_statistics?.expected_goals?.away);
        return predictedHome !== null && predictedAway !== null &&
          actualHomeXg !== null && actualAwayXg !== null
          ? [{ predictedHome, predictedAway, actualHomeXg, actualAwayXg }]
          : [];
      });
      const xgAbsoluteError = xgPairs.reduce((sum, row) =>
        sum + Math.abs(row.predictedHome - row.actualHomeXg) +
          Math.abs(row.predictedAway - row.actualAwayXg), 0);
      const xgSquaredError = xgPairs.reduce((sum, row) =>
        sum + Math.pow(row.predictedHome - row.actualHomeXg, 2) +
          Math.pow(row.predictedAway - row.actualAwayXg, 2), 0);

      // Validazione temporale prequential: i pronostici sono prodotti per data
      // usando solo risultati precedenti; i fold sono blocchi cronologici contigui.
      const chronologicalResults = [...results].sort((a, b) =>
        new Date(a.match_date) - new Date(b.match_date));
      const foldCount = Math.min(5, chronologicalResults.length);
      const walkForwardFolds = [];
      for (let fold = 0; fold < foldCount; fold++) {
        const start = Math.floor(fold * chronologicalResults.length / foldCount);
        const end = Math.floor((fold + 1) * chronologicalResults.length / foldCount);
        const rows = chronologicalResults.slice(start, end);
        const foldCorrect = rows.filter(row => row.correct_1x2).length;
        const foldLogLoss = rows.reduce((sum, row) => {
          const p = Math.max(EPSILON, Math.min(1,
            Number(row.probabilities?.[row.actual_result]) / 100));
          return sum - Math.log(p);
        }, 0);
        walkForwardFolds.push({
          fold: fold + 1,
          from: rows[0]?.match_date || null,
          to: rows[rows.length - 1]?.match_date || null,
          evaluated: rows.length,
          accuracy_1x2: rows.length ? Number((foldCorrect / rows.length * 100).toFixed(2)) : null,
          log_loss_1x2: rows.length ? Number((foldLogLoss / rows.length).toFixed(4)) : null
        });
      }

      // Inizializza prima l'oggetto usato da advancedMetrics; viene popolato più sotto.
      const outcomeMetrics = {};

      const advancedMetrics = {
        "1X2": {
          log_loss: evaluated ? Number((totalLogLoss / evaluated).toFixed(4)) : null,
          lower_is_better: true,
          per_class: outcomeMetrics
        },
        expected_goals_error: {
          evaluated: expectedGoalsEvaluated,
          home_mae: expectedGoalsEvaluated ? Number((homeGoalAbsoluteError / expectedGoalsEvaluated).toFixed(3)) : null,
          away_mae: expectedGoalsEvaluated ? Number((awayGoalAbsoluteError / expectedGoalsEvaluated).toFixed(3)) : null,
          home_rmse: expectedGoalsEvaluated ? Number(Math.sqrt(homeGoalSquaredError / expectedGoalsEvaluated).toFixed(3)) : null,
          away_rmse: expectedGoalsEvaluated ? Number(Math.sqrt(awayGoalSquaredError / expectedGoalsEvaluated).toFixed(3)) : null
        },
        expected_goals_xg_comparison: {
          evaluated_matches: xgPairs.length,
          home_away_mae_combined: xgPairs.length ? Number((xgAbsoluteError / (xgPairs.length * 2)).toFixed(3)) : null,
          home_away_rmse_combined: xgPairs.length ? Number(Math.sqrt(xgSquaredError / (xgPairs.length * 2)).toFixed(3)) : null,
          note: "Confronto disponibile solo quando PitchAPI fornisce xG effettivi per entrambe le squadre."
        },
        temporal_walk_forward: {
          method: "5-fold chronological prequential evaluation",
          folds: walkForwardFolds,
          note: "Ogni previsione usa lo storico precedente alla data della partita; i fold sono blocchi temporali, non una suddivisione casuale."
        },
        exact_score_top_1: {
          evaluated: exactScoreEvaluated,
          top_1_correct: exactScoreTop1Hits,
          top_1_accuracy: exactScoreEvaluated ? Number((exactScoreTop1Hits / exactScoreEvaluated * 100).toFixed(2)) : null
        }
      };

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

      function buildModelMetrics(probabilityField) {
        const probabilityFor = result => result[probabilityField] || {};
        const testedResults = results.filter(result => {
          const probabilities = probabilityFor(result);
          return ["1", "X", "2"].every(key =>
            Number.isFinite(Number(probabilities[key]))
          );
        });

        let multiclassBrier = 0;
        let correct1x2 = 0;
        const outcomeCalibrationByModel = {};

        for (const outcome of ["1", "X", "2"]) {
          const tested = testedResults.map(result => ({
            probability: Number(probabilityFor(result)[outcome]) / 100,
            actual: result.actual_result === outcome ? 1 : 0
          }));
          outcomeCalibrationByModel[outcome] = calibrationByBands(tested);
          for (const item of tested) {
            multiclassBrier += Math.pow(item.probability - item.actual, 2);
          }
        }

        for (const result of testedResults) {
          const probabilities = probabilityFor(result);
          const predicted = ["1", "X", "2"].sort(
            (a, b) => Number(probabilities[b]) - Number(probabilities[a])
          )[0];
          if (predicted === result.actual_result) correct1x2++;
        }

        const count = testedResults.length;
        const marketMetricsForModel = (key, actualKey) => {
          const tested = results
            .filter(result =>
              Number.isFinite(Number(probabilityFor(result)[key])) &&
              typeof result.actual_markets?.[actualKey] === "boolean"
            )
            .map(result => ({
              probability: Number(probabilityFor(result)[key]) / 100,
              actual: result.actual_markets[actualKey] ? 1 : 0
            }));

          if (!tested.length) {
            return { evaluated: 0, correct: 0, accuracy: null, brier_score: null, calibration: [] };
          }

          let hits = 0;
          let brier = 0;
          for (const item of tested) {
            if ((item.probability >= 0.5) === Boolean(item.actual)) hits++;
            brier += Math.pow(item.probability - item.actual, 2);
          }
          return {
            evaluated: tested.length,
            correct: hits,
            accuracy: Number((hits / tested.length * 100).toFixed(2)),
            brier_score: Number((brier / tested.length).toFixed(4)),
            calibration: calibrationByBands(tested)
          };
        };

        return {
          "1X2": {
            evaluated: count,
            correct: correct1x2,
            accuracy: count ? Number((correct1x2 / count * 100).toFixed(2)) : null,
            brier_score_normalized: count
              ? Number((multiclassBrier / (count * 3)).toFixed(4))
              : null,
            calibration_by_outcome: outcomeCalibrationByModel
          },
          over_0_5: marketMetricsForModel("over_0_5", "over_0_5"),
          under_0_5: marketMetricsForModel("under_0_5", "under_0_5"),
          over_1_5: marketMetricsForModel("over_1_5", "over_1_5"),
          under_1_5: marketMetricsForModel("under_1_5", "under_1_5"),
          over_2_5: marketMetricsForModel("over_2_5", "over_2_5"),
          under_2_5: marketMetricsForModel("under_2_5", "under_2_5"),
          over_3_5: marketMetricsForModel("over_3_5", "over_3_5"),
          under_3_5: marketMetricsForModel("under_3_5", "under_3_5"),
          btts_yes: marketMetricsForModel("btts_yes", "btts_yes"),
          btts_no: marketMetricsForModel("btts_no", "btts_no"),
          under_4_5: marketMetricsForModel("under_4_5", "under_4_5"),
          over_4_5: marketMetricsForModel("over_4_5", "over_4_5"),
          double_chance_1x: marketMetricsForModel("double_chance_1x", "double_chance_1x"),
          double_chance_x2: marketMetricsForModel("double_chance_x2", "double_chance_x2"),
          double_chance_12: marketMetricsForModel("double_chance_12", "double_chance_12"),
          multigoal_1_2: marketMetricsForModel("multigoal_1_2", "multigoal_1_2"),
          multigoal_1_3: marketMetricsForModel("multigoal_1_3", "multigoal_1_3"),
          multigoal_1_4: marketMetricsForModel("multigoal_1_4", "multigoal_1_4"),
          multigoal_2_3: marketMetricsForModel("multigoal_2_3", "multigoal_2_3"),
          multigoal_2_4: marketMetricsForModel("multigoal_2_4", "multigoal_2_4"),
          multigoal_2_5: marketMetricsForModel("multigoal_2_5", "multigoal_2_5"),
          multigoal_3_4: marketMetricsForModel("multigoal_3_4", "multigoal_3_4"),
          combo_1x_over_1_5: marketMetricsForModel("combo_1x_over_1_5", "combo_1x_over_1_5"),
          combo_1x_under_2_5: marketMetricsForModel("combo_1x_under_2_5", "combo_1x_under_2_5"),
          combo_x2_over_1_5: marketMetricsForModel("combo_x2_over_1_5", "combo_x2_over_1_5"),
          combo_x2_under_2_5: marketMetricsForModel("combo_x2_under_2_5", "combo_x2_under_2_5"),
          combo_12_over_1_5: marketMetricsForModel("combo_12_over_1_5", "combo_12_over_1_5"),
          combo_12_under_2_5: marketMetricsForModel("combo_12_under_2_5", "combo_12_under_2_5"),
          dc_combo_1x_multigoal_1_4: marketMetricsForModel("dc_combo_1x_multigoal_1_4", "dc_combo_1x_multigoal_1_4"),
          dc_combo_x2_multigoal_1_4: marketMetricsForModel("dc_combo_x2_multigoal_1_4", "dc_combo_x2_multigoal_1_4"),
          dc_combo_12_multigoal_1_4: marketMetricsForModel("dc_combo_12_multigoal_1_4", "dc_combo_12_multigoal_1_4")
        };
      }

      const poissonMetrics = buildModelMetrics("probabilities");
      // Backtest principale: soltanto mercati gol, 1X2 e risultati esatti.
      // Gli altri mercati restano disponibili nelle singole previsioni, ma non
      // vengono elaborati né restituiti nelle metriche del test principale.
      const selectedMarketKeys = [
        "1", "X", "2",
        "over_0_5", "under_0_5",
        "over_1_5", "under_1_5",
        "over_2_5", "under_2_5",
        "over_3_5", "under_3_5",
        "btts_yes", "btts_no"
      ];
      // Metriche 1/X/2 separate: accuracy = recall della singola classe.
      for (const outcome of ["1", "X", "2"]) {
        const tp = results.filter(result => result.actual_result === outcome && result.predicted_result === outcome).length;
        const fp = results.filter(result => result.actual_result !== outcome && result.predicted_result === outcome).length;
        const fn = results.filter(result => result.actual_result === outcome && result.predicted_result !== outcome).length;
        const tn = evaluated - tp - fp - fn;
        const support = tp + fn;
        const predictedCount = tp + fp;
        const precision = predictedCount ? tp / predictedCount : null;
        const recall = support ? tp / support : null;
        const specificity = tn + fp ? tn / (tn + fp) : null;
        outcomeMetrics[outcome] = {
          evaluated,
          correct: tp,
          support,
          predicted: predictedCount,
          accuracy: recall === null ? null : Number((recall * 100).toFixed(2)),
          precision_percent: precision === null ? null : Number((precision * 100).toFixed(2)),
          recall_percent: recall === null ? null : Number((recall * 100).toFixed(2)),
          specificity_percent: specificity === null ? null : Number((specificity * 100).toFixed(2)),
          true_positive: tp, true_negative: tn, false_positive: fp, false_negative: fn
        };
      }
      const accuracyByMarket = Object.fromEntries(
        selectedMarketKeys.map(key => [key,
          ["1", "X", "2"].includes(key) ? outcomeMetrics[key] : poissonMetrics[key]
        ])
      );
      const statisticalAccuracyByMarket = {};
      for (const [market, tested] of Object.entries(statisticalMarketRows)) {
        if (!tested.length) continue;
        let tp = 0, tn = 0, fp = 0, fn = 0, brier = 0, logLoss = 0;
        const calibrationBins = Array.from({ length: 10 }, (_, index) => ({
          range: `${index * 10}-${(index + 1) * 10}%`,
          count: 0,
          probability_sum: 0,
          observed_sum: 0
        }));
        const metricEpsilon = 1e-6;
        for (const item of tested) {
          const probability = Math.max(0, Math.min(1, item.probability / 100));
          const predicted = probability >= 0.5;
          if (predicted && item.actual) tp++;
          else if (!predicted && !item.actual) tn++;
          else if (predicted && !item.actual) fp++;
          else fn++;
          const actualBinary = item.actual ? 1 : 0;
          brier += Math.pow(probability - actualBinary, 2);
          logLoss += -(actualBinary
            ? Math.log(Math.max(metricEpsilon, probability))
            : Math.log(Math.max(metricEpsilon, 1 - probability)));
          const binIndex = Math.min(9, Math.floor(probability * 10));
          calibrationBins[binIndex].count++;
          calibrationBins[binIndex].probability_sum += probability;
          calibrationBins[binIndex].observed_sum += actualBinary;
        }
        const evaluated = tested.length;
        const calibration = calibrationBins
          .filter(bin => bin.count > 0)
          .map(bin => ({
            range: bin.range,
            count: bin.count,
            average_predicted_probability: Number((bin.probability_sum / bin.count * 100).toFixed(2)),
            actual_frequency: Number((bin.observed_sum / bin.count * 100).toFixed(2))
          }));
        const correctCount = tp + tn;
        const sensitivity = tp + fn ? tp / (tp + fn) : null;
        const specificity = tn + fp ? tn / (tn + fp) : null;
        const balancedAccuracy = sensitivity !== null && specificity !== null
          ? (sensitivity + specificity) / 2
          : null;
        const positiveRate = (tp + fn) / evaluated;
        const majorityBaseline = Math.max(positiveRate, 1 - positiveRate);
        statisticalAccuracyByMarket[market] = {
          evaluated,
          correct: correctCount,
          accuracy: Number((correctCount / evaluated * 100).toFixed(2)),
          positive_actual: tp + fn,
          negative_actual: tn + fp,
          predicted_over: tp + fp,
          predicted_under: tn + fn,
          true_positive: tp,
          true_negative: tn,
          false_positive: fp,
          false_negative: fn,
          positive_rate_percent: Number((positiveRate * 100).toFixed(2)),
          sensitivity_percent: sensitivity === null ? null : Number((sensitivity * 100).toFixed(2)),
          specificity_percent: specificity === null ? null : Number((specificity * 100).toFixed(2)),
          balanced_accuracy_percent: balancedAccuracy === null ? null : Number((balancedAccuracy * 100).toFixed(2)),
          majority_baseline_accuracy_percent: Number((majorityBaseline * 100).toFixed(2)),
          beats_majority_baseline: correctCount / evaluated > majorityBaseline,
          decision_threshold_percent: 50,
          brier_score: Number((brier / evaluated).toFixed(4)),
          log_loss: Number((logLoss / evaluated).toFixed(4)),
          calibration
        };
      }

      // Analisi per soglia: misura accuracy e copertura senza nascondere
      // quante previsioni vengono scartate. Le soglie non vengono ottimizzate
      // sullo stesso campione e non costituiscono una garanzia futura.
      const thresholdAnalysis = {};
      const binaryThresholdKeys = selectedMarketKeys.filter(key => !["1", "X", "2"].includes(key));
      for (const key of binaryThresholdKeys) {
        const actualKey = key;
        const rows = results.filter(row =>
          Number.isFinite(Number(row.probabilities?.[key])) &&
          typeof row.actual_markets?.[actualKey] === "boolean"
        );
        thresholdAnalysis[key] = [50, 55, 60, 65, 70, 75, 80, 85, 90].map(threshold => {
          const selected = rows.filter(row => Number(row.probabilities[key]) >= threshold);
          const correctCount = selected.filter(row => row.actual_markets[actualKey]).length;
          return {
            threshold_percent: threshold,
            evaluated: selected.length,
            correct: correctCount,
            precision_percent: selected.length ? Number((correctCount / selected.length * 100).toFixed(2)) : null,
            coverage_percent: rows.length ? Number((selected.length / rows.length * 100).toFixed(2)) : null
          };
        });
      }
      thresholdAnalysis["1X2_top_pick"] = [50, 55, 60, 65, 70, 75, 80, 85, 90].map(threshold => {
        const selected = results.filter(row => {
          const top = Math.max(...["1", "X", "2"].map(key => Number(row.probabilities?.[key]) || 0));
          return top >= threshold;
        });
        const hits = selected.filter(row => row.correct_1x2).length;
        return {
          threshold_percent: threshold,
          evaluated: selected.length,
          correct: hits,
          accuracy_percent: selected.length ? Number((hits / selected.length * 100).toFixed(2)) : null,
          coverage_percent: evaluated ? Number((selected.length / evaluated * 100).toFixed(2)) : null
        };
      });

      const responsePayload = {
        ok: true,
        league_id: leagueId,
        season,
        target_date: targetDate,
        from_date: fromDate,
        to_date: toDate,
        requested_matches: limit,
        all_seasons: allSeasons,
        offset: includeStats ? offset : null,
        available_history_matches: history.length,
        matches_on_target_date: dateMatches.length,
        evaluation_matches_selected: evaluationMatches.length,
        next_offset: includeStats ? offset + evaluationMatches.length : null,
        done: includeStats ? offset + evaluationMatches.length >= dateMatches.length : null,
        evaluation_period: {
          from: evaluationMatches[0]?.match_date || null,
          to: evaluationMatches[evaluationMatches.length - 1]?.match_date || null
        },
        evaluated_matches: evaluated,
        accuracy_by_market: accuracyByMarket,
        threshold_analysis: thresholdAnalysis,
        statistical_accuracy_by_market: includeStats ? statisticalAccuracyByMarket : null,
        statistical_backtest: {
          enabled: includeStats,
          evaluated_matches: includeStats ? results.length : 0,
          goal_markets: includeStats ? Object.keys(statisticalMarketRows).filter(key => key.startsWith("double_chance_") || key.startsWith("multigoal_") || key.startsWith("combo_") || key.startsWith("dc_combo_")).length : 0,
          statistical_markets: includeStats ? Object.keys(statisticalMarketRows).filter(key => !key.startsWith("double_chance_") && !key.startsWith("multigoal_") && !key.startsWith("combo_") && !key.startsWith("dc_combo_")).length : 0,
          matches_with_actual_statistics: includeStats ? results.filter(r => r.actual_statistics).length : 0,
          requested_limit: includeStats ? Math.min(limit, statsEvaluationLimit) : 0,
          offset
        },
        advanced_metrics: advancedMetrics,
        model: "Poisson con shrinkage bayesiano",
        results: summaryOnly ? undefined : results,
        results_summary: summaryOnly ? {
          returned: 0,
          omitted_detail_rows: results.length,
          matches_with_actual_statistics: results.filter(r => r.actual_statistics).length,
          matches_with_statistical_forecast: results.filter(r => r.statistical_forecast).length
        } : undefined
      };
      res.json(responsePayload);
    } catch (error) {
      handleError(res, error);
    }
  }
);

// Riconciliazione nomi campionati con checkpoint persistente su Supabase.
// La procedura riprende dal cursore salvato anche dopo un riavvio di Render.
const LEAGUE_NAME_REPAIR_JOB_KEY = "league_name_repair";
const leagueNameRepairJob = {
  running: false, started_at: null, finished_at: null, error: null,
  scanned: 0, rows_updated: 0, unchanged: 0, missing_names: 0,
  conflicting_names: 0, unmapped_league_ids: 0, cursor: null,
  total_batches: 0, batch_size: 1000, status: "idle"
};

function applyPersistedLeagueRepairState(row) {
  if (!row) return;
  for (const key of [
    "started_at", "finished_at", "error", "scanned", "rows_updated",
    "unchanged", "missing_names", "conflicting_names",
    "unmapped_league_ids", "cursor", "total_batches", "batch_size", "status"
  ]) {
    if (row[key] !== undefined) leagueNameRepairJob[key] = row[key];
  }
}

async function readPersistedLeagueRepairState() {
  const { data, error } = await supabase.from("data_repair_jobs")
    .select("*").eq("job_key", LEAGUE_NAME_REPAIR_JOB_KEY).maybeSingle();
  if (error) throw error;
  return data || null;
}

async function persistLeagueRepairState(extra = {}) {
  const row = {
    job_key: LEAGUE_NAME_REPAIR_JOB_KEY,
    status: leagueNameRepairJob.status,
    started_at: leagueNameRepairJob.started_at,
    finished_at: leagueNameRepairJob.finished_at,
    error: leagueNameRepairJob.error,
    scanned: leagueNameRepairJob.scanned,
    rows_updated: leagueNameRepairJob.rows_updated,
    unchanged: leagueNameRepairJob.unchanged,
    missing_names: leagueNameRepairJob.missing_names,
    conflicting_names: leagueNameRepairJob.conflicting_names,
    unmapped_league_ids: leagueNameRepairJob.unmapped_league_ids,
    cursor: leagueNameRepairJob.cursor,
    total_batches: leagueNameRepairJob.total_batches,
    batch_size: leagueNameRepairJob.batch_size,
    updated_at: new Date().toISOString(),
    ...extra
  };
  const { error } = await supabase.from("data_repair_jobs")
    .upsert(row, { onConflict: "job_key" });
  if (error) throw error;
}

async function runLeagueNameRepair() {
  if (leagueNameRepairJob.running) return;
  leagueNameRepairJob.running = true;
  leagueNameRepairJob.status = "running";
  leagueNameRepairJob.error = null;
  if (!leagueNameRepairJob.started_at) leagueNameRepairJob.started_at = new Date().toISOString();
  leagueNameRepairJob.finished_at = null;
  try {
    await persistLeagueRepairState();
    const catalog = await getLeagueCatalog();
    const namesById = new Map(catalog.filter(item => item?.id && item?.name)
      .map(item => [String(item.id), String(item.name)]));
    const pageSize = leagueNameRepairJob.batch_size || 1000;
    while (true) {
      let query = supabase.from("matches")
        .select("id,league_id,league_name")
        .order("id", { ascending: true }).limit(pageSize);
      if (leagueNameRepairJob.cursor) query = query.gt("id", leagueNameRepairJob.cursor);
      const { data, error } = await query;
      if (error) throw error;
      const page = data || [];
      if (!page.length) break;
      const grouped = new Map();
      for (const row of page) {
        const name = namesById.get(String(row.league_id || ""));
        if (!name) { leagueNameRepairJob.unmapped_league_ids++; continue; }
        if (String(row.league_name || "").trim() === name) {
          leagueNameRepairJob.unchanged++;
          continue;
        }
        if (!row.league_name) leagueNameRepairJob.missing_names++;
        else leagueNameRepairJob.conflicting_names++;
        if (!grouped.has(name)) grouped.set(name, []);
        grouped.get(name).push(String(row.id));
      }
      for (const [name, ids] of grouped) {
        for (let i = 0; i < ids.length; i += 100) {
          const batchIds = ids.slice(i, i + 100);
          const { data: updatedRows, error: updateError } = await supabase.from("matches")
            .update({ league_name: name }).in("id", batchIds).select("id");
          if (updateError) throw updateError;
          const actualUpdated = (updatedRows || []).length;
          if (actualUpdated !== batchIds.length) {
            throw new Error("Aggiornamento incompleto: richieste " + batchIds.length +
              " righe, confermate " + actualUpdated + " per il campionato " + name + ".");
          }
          leagueNameRepairJob.rows_updated += actualUpdated;
        }
      }
      // Checkpoint solo dopo aver salvato tutte le modifiche della pagina:
      // in caso di crash si ripete al massimo l'ultima pagina (operazione idempotente).
      leagueNameRepairJob.scanned += page.length;
      leagueNameRepairJob.total_batches++;
      leagueNameRepairJob.cursor = String(page[page.length - 1].id);
      await persistLeagueRepairState();
      if (page.length < pageSize) break;
    }
    leagueNameRepairJob.status = "completed";
  } catch (error) {
    leagueNameRepairJob.error = String(error?.message || error);
    leagueNameRepairJob.status = "failed";
  } finally {
    leagueNameRepairJob.running = false;
    leagueNameRepairJob.finished_at = new Date().toISOString();
    try {
      await persistLeagueRepairState();
    } catch (persistError) {
      leagueNameRepairJob.error = [
        leagueNameRepairJob.error,
        "Errore salvataggio checkpoint: " + String(persistError?.message || persistError)
      ].filter(Boolean).join(" | ");
      leagueNameRepairJob.status = "failed";
    }
  }
}

app.get("/api/data/repair-league-names", requireSportApi, requireDatabase, async (req, res) => {
  const action = String(req.query.action || "").toLowerCase();
  try {
    const localRunning = leagueNameRepairJob.running;
    const persisted = await readPersistedLeagueRepairState();
    if (persisted && !localRunning) applyPersistedLeagueRepairState(persisted);
    if (action === "status") {
      return res.json({
        ok: !leagueNameRepairJob.error,
        ...leagueNameRepairJob,
        running: localRunning,
        resumable: !localRunning && persisted?.status === "running"
      });
    }
    const apply = String(req.query.apply || "false").toLowerCase() === "true";
    if (!apply) {
      return res.status(400).json({
        ok: false,
        error: "Per avviare o riprendere l'aggiornamento usa apply=true. Per controllare lo stato usa action=status."
      });
    }
    if (leagueNameRepairJob.running) {
      return res.json({ ok: true, already_running: true, ...leagueNameRepairJob });
    }
    const forceRestart = String(req.query.force || "false").toLowerCase() === "true";
    if (persisted?.status === "completed" && !forceRestart) {
      return res.json({ ok: true, already_completed: true, ...leagueNameRepairJob });
    }
    // force=true avvia un nuovo controllo completo, utile dopo un audit indipendente.
    // Le righe già corrette vengono saltate; ogni update viene verificato con SELECT.
    if (forceRestart) {
      Object.assign(leagueNameRepairJob, {
        running: false, started_at: null, finished_at: null, error: null,
        scanned: 0, rows_updated: 0, unchanged: 0, missing_names: 0,
        conflicting_names: 0, unmapped_league_ids: 0, cursor: null,
        total_batches: 0, batch_size: 1000, status: "idle"
      });
    }
    // Riprende da cursor e contatori persistiti. Se nessun checkpoint esiste,
    // parte dall'inizio; le righe già corrette vengono riconosciute come invariate.
    runLeagueNameRepair();
    return res.status(202).json({
      ok: true,
      started: true,
      forced: forceRestart,
      resumed: !forceRestart && Boolean(persisted?.cursor),
      message: "Aggiornamento avviato o ripreso in background. Controllare action=status.",
      cursor: leagueNameRepairJob.cursor,
      batch_size: leagueNameRepairJob.batch_size
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

// Audit completo e in sola lettura dei nomi campionato in Supabase.
app.get("/api/data/integrity", requireSportApi, requireDatabase, async (req, res) => {
  try {
    const catalog = await getLeagueCatalog();
    const namesById = new Map(catalog.filter(item => item?.id && item?.name)
      .map(item => [String(item.id), String(item.name).trim()]));
    const { count: totalRows, error: countError } = await supabase
      .from("matches").select("id", { count: "exact", head: true });
    if (countError) throw countError;

    const audit = {
      scanned: 0,
      correct_names: 0,
      missing_names: 0,
      conflicting_names: 0,
      unmapped_league_ids: 0,
      null_league_ids: 0,
      by_league: new Map(),
      issues_sample: []
    };
    const pageSize = 1000;
    for (let offset = 0; offset < (totalRows || 0); offset += pageSize) {
      const { data, error } = await supabase.from("matches")
        .select("id,league_id,league_name")
        .order("id", { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (error) throw error;
      const page = data || [];
      if (!page.length) break;
      for (const row of page) {
        audit.scanned++;
        const leagueId = String(row.league_id || "").trim();
        const expectedName = namesById.get(leagueId);
        const currentName = String(row.league_name || "").trim();
        const key = leagueId || "__NULL__";
        if (!audit.by_league.has(key)) {
          audit.by_league.set(key, {
            league_id: leagueId || null,
            expected_name: expectedName || null,
            rows: 0,
            correct_names: 0,
            missing_names: 0,
            conflicting_names: 0
          });
        }
        const group = audit.by_league.get(key);
        group.rows++;
        if (!leagueId) {
          audit.null_league_ids++;
          audit.unmapped_league_ids++;
          if (audit.issues_sample.length < 20) audit.issues_sample.push({
            match_id: row.id, issue: "null_league_id", league_name: row.league_name
          });
        } else if (!expectedName) {
          audit.unmapped_league_ids++;
          if (audit.issues_sample.length < 20) audit.issues_sample.push({
            match_id: row.id, issue: "unmapped_league_id", league_id: leagueId,
            league_name: row.league_name
          });
        } else if (currentName === expectedName) {
          audit.correct_names++;
          group.correct_names++;
        } else if (!currentName) {
          audit.missing_names++;
          group.missing_names++;
          if (audit.issues_sample.length < 20) audit.issues_sample.push({
            match_id: row.id, issue: "missing_league_name", league_id: leagueId,
            expected_name: expectedName
          });
        } else {
          audit.conflicting_names++;
          group.conflicting_names++;
          if (audit.issues_sample.length < 20) audit.issues_sample.push({
            match_id: row.id, issue: "conflicting_league_name", league_id: leagueId,
            expected_name: expectedName, actual_name: row.league_name
          });
        }
      }
    }

    const byLeague = [...audit.by_league.values()]
      .sort((a, b) => b.rows - a.rows || String(a.league_id).localeCompare(String(b.league_id)));
    const issues = audit.missing_names + audit.conflicting_names +
      audit.unmapped_league_ids;
    res.json({
      ok: issues === 0 && audit.scanned === (totalRows || 0),
      audit: "read_only_league_name_integrity",
      generated_at: new Date().toISOString(),
      catalog_leagues: namesById.size,
      database_rows: totalRows || 0,
      scanned: audit.scanned,
      correct_names: audit.correct_names,
      missing_names: audit.missing_names,
      conflicting_names: audit.conflicting_names,
      unmapped_league_ids: audit.unmapped_league_ids,
      null_league_ids: audit.null_league_ids,
      by_league: byLeague,
      issues_sample: audit.issues_sample,
      note: "Controllo in sola lettura; nessun dato è stato modificato."
    });
  } catch (error) {
    handleError(res, error);
  }
});

// Report giornaliero CSV delle previsioni. Senza quote affidabili non
// calcola value/ROI e segnala esplicitamente "nessuna giocata".
app.get("/api/reports/daily.csv", requireSportApi, requireDatabase, async (req, res) => {
  try {
    const date = String(req.query.date || new Date().toISOString().slice(0, 10));
    const leagueId = req.query.league_id ? String(req.query.league_id) : null;
    const dateStart = new Date(date + "T00:00:00Z");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !Number.isFinite(dateStart.getTime()) ||
        dateStart.toISOString().slice(0, 10) !== date) {
      return res.status(400).json({ ok: false, error: "Data non valida. Usa YYYY-MM-DD." });
    }
    if (leagueId && !/^l_[A-Za-z0-9_-]+$/.test(leagueId)) {
      return res.status(400).json({ ok: false, error: "ID campionato non valido." });
    }
    let query = supabase.from("matches").select("*")
      .gte("match_date", date + "T00:00:00.000Z")
      .lt("match_date", new Date(Date.parse(date + "T00:00:00Z") + 86400000).toISOString())
      .order("match_date", { ascending: true }).limit(500);
    if (leagueId) query = query.eq("league_id", leagueId);
    const { data: fixtures, error } = await query;
    if (error) throw error;
    const catalog = await getLeagueCatalog();
    const leagueNamesById = new Map(catalog.filter(item => item?.id && item?.name)
      .map(item => [String(item.id), String(item.name)]));
    const historyByLeague = new Map();
    const csvRows = [];
    for (const fixture of fixtures || []) {
      if (isFinished(fixture)) continue;
      const id = String(fixture.league_id);
      if (!historyByLeague.has(id)) {
        historyByLeague.set(id, await getLeagueMatchesFromDatabase(id, fixture.season));
      }
      const prediction = calculatePrediction(fixture, historyByLeague.get(id));
      if (!prediction?.ok || !prediction.probabilities) continue;
      const p = prediction.probabilities;
      const fields = [
        date, fixture.match_date, leagueNamesById.get(String(fixture.league_id)) || fixture.league_name || "", fixture.season || "",
        fixture.id, fixture.home_team, fixture.away_team,
        p["1"], p["X"], p["2"], p.over_1_5, p.under_1_5,
        p.over_2_5, p.under_2_5, p.over_3_5, p.under_3_5,
        p.btts_yes, p.btts_no,
        "", "", "NESSUNA_GIOCATA_QUOTE_NON_DISPONIBILI"
      ];
      csvRows.push(fields);
    }
    const headers = [
      "report_date","kickoff","league","season","match_id","home_team","away_team",
      "p_1","p_x","p_2","p_over_1_5","p_under_1_5","p_over_2_5","p_under_2_5",
      "p_over_3_5","p_under_3_5","p_btts_yes","p_btts_no",
      "odds","value_p_times_odds","decision"
    ];
    const escapeCsv = value => {
      if (value === null || value === undefined) return "";
      const text = String(value);
      return /[",\r\n;]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    };
    const csv = [headers, ...csvRows].map(row => row.map(escapeCsv).join(";")).join("\r\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="football-predictor-' + date + '.csv"');
    res.send("\uFEFF" + csv);
  } catch (error) {
    handleError(res, error);
  }
});

// Normalizza le statistiche PitchAPI: supporta gruppi/items, stats indicizzate,
// periodi differenti e varianti dei nomi delle statistiche.
function normalizeStatKey(value) {
  return String(value || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

const STAT_ALIASES = {
  corners: ["corners", "corner_kicks", "corner", "total_corners"],
  total_shots: ["total_shots", "shots", "shots_total", "totalshots"],
  shots_on_target: ["shots_on_target", "shotson target", "shotson_target", "shotsongoal", "shots_on_goal", "on_target"],
  shots_off_target: ["shots_off_target", "shots_off_goal", "off_target"],
  blocked_shots: ["blocked_shots", "blockedshots"],
  yellow_cards: ["yellow_cards", "yellowcards", "yellow_card"],
  red_cards: ["red_cards", "redcards", "red_card"],
  fouls: ["fouls", "total_fouls", "fouls_committed"],
  offsides: ["offsides", "offside"],
  possession: ["ball_possession", "ballpossession", "possession", "ball_possesion"],
  expected_goals: ["expected_goals", "expectedgoals", "xg"],
  saves: ["saves", "goalkeeper_saves"],
  passes: ["passes", "total_passes"],
  accurate_passes: ["accurate_passes", "passes_accurate"],
  tackles: ["tackles", "total_tackles"],
  big_chances: ["big_chances", "big_chances_created"],
  big_chances_missed: ["big_chances_missed"],
  hit_woodwork: ["hit_woodwork", "woodwork"],
  crosses: ["crosses", "total_crosses"],
  long_balls: ["long_balls", "longballs"],
  duels_won: ["duels_won", "duels"],
  aerials_won: ["aerials_won", "aerial_duels_won"],
  interceptions: ["interceptions"],
  clearances: ["clearances"],
  xg_open_play: ["xg_open_play", "open_play_xg"],
  xg_set_play: ["xg_set_play", "set_play_xg"],
  npxg: ["npxg", "non_penalty_xg"],
  ppda: ["ppda", "passes_per_defensive_action"],
  field_tilt: ["field_tilt"],
  box_entries: ["box_entries", "penalty_area_entries"],
  progressive_passes: ["progressive_passes"],
  progressive_carries: ["progressive_carries"],
  key_passes: ["key_passes"],
  shot_assists: ["shot_assists"],
  xg_chain: ["xg_chain"],
  xg_buildup: ["xg_buildup"],
  xa: ["xa", "expected_assists"],
  xt: ["xt", "expected_threat"],
  vaep: ["vaep", "vaep_total"]
};

function extractPitchApiStatRows(body) {
  const roots = [
    body?.data?.periods, body?.response?.data?.periods, body?.periods,
    body?.data?.statistics, body?.response?.data?.statistics,
    body?.statistics, body?.data, body?.response
  ];
  const rows = [];
  const seen = new Set();
  const add = (key, home, away, period) => {
    if (key == null) return;
    const normalized = normalizeStatKey(key);
    const signature = [normalized, home, away, period].join("|");
    if (seen.has(signature)) return;
    seen.add(signature);
    rows.push({ key: normalized, home: getNumber(home), away: getNumber(away), period });
  };
  const walk = (node, period = "all") => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, period);
      return;
    }
    if (typeof node !== "object") return;
    const nextPeriod = String(node.period || node.type || period).toLowerCase();
    if (Array.isArray(node.groups)) {
      for (const group of node.groups) {
        for (const item of group?.items || []) {
          const key = item.key || item.name || item.type;
          add(key, item.home ?? item.home_value ?? item.values?.home,
            item.away ?? item.away_value ?? item.values?.away, nextPeriod);
          if (item.stat && typeof item.stat === "object") {
            add(key, item.stat.home ?? item.stat.home_value,
              item.stat.away ?? item.stat.away_value, nextPeriod);
          }
        }
      }
    }
    if (node.key || node.name) {
      add(node.key || node.name, node.home ?? node.home_value ?? node.values?.home,
        node.away ?? node.away_value ?? node.values?.away, nextPeriod);
    }
    for (const [key, value] of Object.entries(node)) {
      if (["groups", "items", "periods"].includes(key)) continue;
      if (Array.isArray(value) || (value && typeof value === "object")) walk(value, nextPeriod);
    }
  };
  for (const root of roots) walk(root);
  return rows;
}

function parseCsvRows(csv) {
 const rows=[]; let row=[], field="", quoted=false;
 for(let i=0;i<csv.length;i++){const ch=csv[i]; if(quoted){if(ch==='"'&&csv[i+1]==='"'){field+='"';i++;}else if(ch==='"')quoted=false;else field+=ch;}else if(ch==='"')quoted=true;else if(ch===","){row.push(field);field="";}else if(ch==="\n"){row.push(field.replace(/\r$/,""));if(row.some(v=>v!==""))rows.push(row);row=[];field="";}else field+=ch;}
 if(field!==""||row.length){row.push(field.replace(/\r$/,""));if(row.some(v=>v!==""))rows.push(row);}
 if(!rows.length)return[];const headers=rows.shift().map(v=>v.trim());
 return rows.map(values=>Object.fromEntries(headers.map((key,i)=>[key,values[i]??""])));
}
function normalizeExternalTeamName(value){
 const name=String(value||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]/g,"");
 const aliases={internazionale:"inter",internazionalefc:"inter",intermilano:"inter",acmilan:"milan",asroma:"roma",sscnapoli:"napoli",juventusfc:"juventus"};
 return aliases[name]||name;
}

function getNormalizedMatchStats(body) {
  const rows = extractPitchApiStatRows(body);
  const result = {};
  for (const [field, aliases] of Object.entries(STAT_ALIASES)) {
    const accepted = new Set(aliases.map(normalizeStatKey));
    const candidates = rows.filter(row => accepted.has(row.key));
    const preferred = candidates.find(row => row.period === "all" || row.period === "match") || candidates[0];
    result[field] = preferred ? { home: preferred.home, away: preferred.away, source_key: preferred.key } : { home: null, away: null, source_key: null };
  }
  return result;
}

// ==========================================
// MEDIE E STATISTICHE SQUADRA
// ==========================================


// Importatore Open-Matchday: associa esclusivamente partite già presenti in PitchAPI
// tramite campionato, data, squadre e risultato; non crea ID sintetici.
app.post("/api/data-sources/open-matchday/sync", requireDatabase, async (req, res) => {
  try {
    const leagueId = String(req.query.league_id || "").trim();
    const folder = String(req.query.folder || "").trim();
    const season = String(req.query.season || "2026/2027");
    if (!/^l_[A-Za-z0-9_-]+$/.test(leagueId)) {
      return res.status(400).json({ ok: false, error: "league_id PitchAPI non valido." });
    }
    if (!/^[A-Z]{3,4}_[A-Z0-9]+_[a-z0-9-]+$/.test(folder)) {
      return res.status(400).json({ ok: false, error: "folder non valido. Usa il nome esatto di una cartella in LEAGUE_INDEX.md." });
    }
    if (season !== "2026/2027") {
      return res.status(400).json({ ok: false, error: "Open-Matchday pubblica in questo importer solo la stagione 2026/2027." });
    }
    const countryCode = folder.split("_")[0];
    const europeanFolderCodes = new Set(["ALB","AND","ARM","AUT","AZE","BEL","BIH","BLR","BUL","CRO","CYP","CZE","DEN","ENG","ESP","EST","FIN","FRA","FRO","GEO","GER","GRE","HUN","IRL","ISL","ISR","ITA","KAZ","KOS","LIE","LTU","LUX","LVA","MDA","MKD","MLT","MNE","NED","NIR","NOR","POL","POR","ROU","RUS","SCO","SMR","SRB","SVK","SVN","SWE","SUI","TUR","UKR","WAL","UEFA"]);
    if (!europeanFolderCodes.has(countryCode)) {
      return res.status(400).json({ ok: false, error: "Questo importer accetta solo competizioni europee." });
    }

    const [indexResponse, catalog] = await Promise.all([
      fetch("https://raw.githubusercontent.com/oladeeayo/open-matchday/master/LEAGUE_INDEX.md", {
        headers: { Accept: "text/markdown" }, signal: AbortSignal.timeout(20000)
      }),
      getEuropeanLeagueCatalog()
    ]);
    if (!indexResponse.ok) throw Object.assign(new Error("Indice Open-Matchday non raggiungibile."), { status: 502 });
    const indexText = await indexResponse.text();
    const indexRow = indexText.split(/\r?\n/).find(line => line.startsWith("| `" + folder + "` |"));
    if (!indexRow) return res.status(404).json({ ok: false, error: "Cartella non presente nell'indice Open-Matchday." });

    const cells = indexRow.split("|").map(value => value.trim());
    const externalLeagueName = (cells[2] || "").replace(/\`/g, "");
    const pitchLeague = catalog.find(item => String(item.id) === leagueId);
    if (!pitchLeague) return res.status(404).json({ ok: false, error: "Campionato non trovato nel catalogo europeo PitchAPI." });
    const pitchLeagueName = String(pitchLeague.name || pitchLeague.league_name || "");
    if (!pitchLeagueName || normalizeExternalTeamName(pitchLeagueName) !== normalizeExternalTeamName(externalLeagueName)) {
      return res.status(409).json({
        ok: false, error: "Il nome del campionato non coincide: importazione bloccata per evitare associazioni errate.",
        pitchapi_league: pitchLeagueName, open_matchday_league: externalLeagueName
      });
    }

    const csvUrl = "https://raw.githubusercontent.com/oladeeayo/open-matchday/master/data/" +
      folder + "/results_2627.csv";
    const csvResponse = await fetch(csvUrl, {
      headers: { Accept: "text/csv" }, signal: AbortSignal.timeout(30000)
    });
    if (!csvResponse.ok) throw Object.assign(new Error("CSV Open-Matchday non disponibile (HTTP " + csvResponse.status + ")."), { status: 502 });
    const rows = parseCsvRows(await csvResponse.text());
    const required = ["date","home","away","ft_home","ft_away","home_shots","away_shots","home_target","away_target","home_fouls","away_fouls","home_corners","away_corners","home_yellow","away_yellow","home_red","away_red"];
    if (!rows.length || required.some(key => !(key in rows[0]))) {
      throw Object.assign(new Error("Schema CSV Open-Matchday non riconosciuto."), { status: 502 });
    }

    const { data: matches, error: matchError } = await supabase.from("matches")
      .select("id,league_id,season,home_team,away_team,match_date,home_goals,away_goals")
      .eq("league_id", leagueId).eq("season", season);
    if (matchError) throw matchError;
    const index = new Map();
    for (const match of matches || []) {
      const key = [String(match.match_date || "").slice(0, 10),
        normalizeExternalTeamName(match.home_team), normalizeExternalTeamName(match.away_team)].join("|");
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(match);
    }

    const candidates = [];
    let unmatched = 0, scoreConflicts = 0, ambiguous = 0;
    for (const external of rows) {
      const date = String(external.date || "").slice(0, 10);
      if (!validDate(date)) { unmatched++; continue; }
      const found = index.get([date, normalizeExternalTeamName(external.home),
        normalizeExternalTeamName(external.away)].join("|")) || [];
      if (found.length !== 1) { if (found.length > 1) ambiguous++; else unmatched++; continue; }
      const match = found[0], homeGoals = getNumber(external.ft_home), awayGoals = getNumber(external.ft_away);
      if (homeGoals === null || awayGoals === null ||
          getNumber(match.home_goals) !== homeGoals || getNumber(match.away_goals) !== awayGoals) {
        scoreConflicts++; continue;
      }
      candidates.push({ match, external });
    }

    const ids = candidates.map(item => String(item.match.id));
    const existing = new Map();
    for (let offset = 0; offset < ids.length; offset += 200) {
      const { data, error } = await supabase.from("match_statistics")
        .select("match_id,normalized_stats").in("match_id", ids.slice(offset, offset + 200));
      if (error) throw error;
      for (const row of data || []) existing.set(String(row.match_id), row.normalized_stats || {});
    }
    const columns = [
      ["total_shots","home_shots","away_shots"], ["shots_on_target","home_target","away_target"],
      ["fouls","home_fouls","away_fouls"], ["corners","home_corners","away_corners"],
      ["yellow_cards","home_yellow","away_yellow"], ["red_cards","home_red","away_red"]
    ];
    const upserts = [];
    let importedMatches = 0, fieldsImported = 0, preserved = 0;
    for (const { match, external } of candidates) {
      const merged = { ...(existing.get(String(match.id)) || {}) };
      let added = 0;
      for (const [field, homeColumn, awayColumn] of columns) {
        const home = getNumber(external[homeColumn]), away = getNumber(external[awayColumn]);
        if (home === null && away === null) continue;
        const previous = merged[field];
        if (previous && (getNumber(previous.home) !== null || getNumber(previous.away) !== null)) {
          preserved++; continue;
        }
        merged[field] = { home, away, source_key: "open-matchday:" + homeColumn + "/" + awayColumn, source: "open-matchday" };
        added++;
      }
      if (added) {
        upserts.push({ match_id: String(match.id), league_id: leagueId,
          match_date: match.match_date, normalized_stats: merged, updated_at: new Date().toISOString() });
        importedMatches++; fieldsImported += added;
      }
    }
    for (let offset = 0; offset < upserts.length; offset += 100) {
      const { error } = await supabase.from("match_statistics")
        .upsert(upserts.slice(offset, offset + 100), { onConflict: "match_id" });
      if (error) throw error;
    }
    res.json({
      ok: true, source: "open-matchday", usage: "private_non_commercial_only",
      league_id: leagueId, league: pitchLeagueName, folder, season,
      csv_rows: rows.length, strict_matches_matched: candidates.length,
      matches_with_new_statistics: importedMatches, statistic_fields_imported: fieldsImported,
      existing_values_preserved: preserved, unmatched_rows: unmatched,
      score_conflicts: scoreConflicts, ambiguous_matches: ambiguous,
      note: "Abbinamento rigoroso su campionato, data, squadre e risultato. Nessun ID sintetico; statistiche già presenti preservate; campi vuoti non convertiti in zero."
    });
  } catch (error) { handleError(res, error); }
});

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

      const allSeasons = String(req.query.all_seasons || "").toLowerCase() === "true";
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
        possession: [],
        shots_off_target: [],
        blocked_shots: [],
        offsides: [],
        saves: [],
        passes: [],
        accurate_passes: [],
        tackles: []
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
        possession: "BallPossesion",
        shots_off_target: "ShotsOffTarget",
        blocked_shots: "BlockedShots",
        offsides: "Offsides",
        saves: "Saves",
        passes: "Passes",
        accurate_passes: "AccuratePasses",
        tackles: "Tackles"
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

          const normalizedStats = getNormalizedMatchStats(statsResponse);
          const values = {};
          for (const field of Object.keys(statKeys)) {
            values[field] = normalizedStats[field]
              ? normalizedStats[field][isHome ? "home" : "away"]
              : null;
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
        possession: calculateWeightedStat(statSamples.possession),
        shots_off_target: calculateWeightedStat(statSamples.shots_off_target),
        blocked_shots: calculateWeightedStat(statSamples.blocked_shots),
        offsides: calculateWeightedStat(statSamples.offsides),
        saves: calculateWeightedStat(statSamples.saves),
        passes: calculateWeightedStat(statSamples.passes),
        accurate_passes: calculateWeightedStat(statSamples.accurate_passes),
        tackles: calculateWeightedStat(statSamples.tackles)
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

      const europeanLeagues = await getEuropeanLeagueCatalog();
      const europeanIds = europeanLeagues.map(item => String(item.id));
      if (!europeanIds.length) throw new Error("Nessun campionato europeo disponibile nel catalogo PitchAPI.");
      const { data: fixtures, error } = await supabase
        .from("matches")
        .select("*")
        .in("league_id", europeanIds)
        .gte("match_date", `${date}T00:00:00`)
        .lt("match_date", `${date}T23:59:59.999`)
        .order("match_date", { ascending: true });
      if (error) throw error;

      // Scarica una sola volta il foglio Sisal per tutta la multipla.
      let sisalData = { available: false, stale: true, events: [], updated_at: null, age_minutes: null };
      try {
        const pdfResponse = await fetch(SISAL_BASE_PDF_URL, {
          headers: { "User-Agent": "FootballPredictorAI/1.0", "Accept": "application/pdf" },
          signal: AbortSignal.timeout(20000)
        });
        if (pdfResponse.ok) {
          const pdfBuffer = Buffer.from(await pdfResponse.arrayBuffer());
          if (pdfBuffer.subarray(0, 5).toString("ascii") === "%PDF-" && pdfBuffer.length >= 1000 && pdfBuffer.length <= 15 * 1024 * 1024) {
            const pdfResult = await pdfParse(pdfBuffer);
            const parsed = parseSisalOddsPdfText(pdfResult.text || "");
            const updated = parsed.updated_at ? Date.parse(parsed.updated_at) : NaN;
            const age = Number.isFinite(updated) ? Math.max(0, Math.round((Date.now() - updated) / 60000)) : null;
            sisalData = { available: parsed.events.length > 0 && age !== null && age <= 360, stale: age === null || age > 360, events: parsed.events, updated_at: parsed.updated_at, age_minutes: age, diagnostics: parsed.diagnostics };
          }
        }
      } catch (sisalError) {
        console.error("Sisal multipla:", sisalError.message);
      }

      const historyCache = {};
      const candidates = [];
      const diagnostics = {
        fixtures_found: (fixtures || []).length,
        fixtures_analyzed: 0,
        fixtures_matched_sisal: 0,
        fixtures_without_sisal_match: 0,
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
        const sisalEvent = sisalData.available ? findSisalEventForFixture(sisalData.events, match) : null;
        if (!sisalEvent) {
          diagnostics.fixtures_without_sisal_match = (diagnostics.fixtures_without_sisal_match || 0) + 1;
          continue;
        }
        diagnostics.fixtures_matched_sisal = (diagnostics.fixtures_matched_sisal || 0) + 1;

        const oddsKeys = {
          "1": "1", "X": "X", "2": "2",
          over_1_5: "over_1_5", under_1_5: "under_1_5",
          over_2_5: "over_2_5", under_2_5: "under_2_5",
          over_3_5: "over_3_5", under_3_5: "under_3_5",
          btts_yes: "goal", btts_no: "no_goal"
        };
        const pairedMarkets = {
          "1": ["1", "X", "2"], "X": ["1", "X", "2"], "2": ["1", "X", "2"],
          over_1_5: ["over_1_5", "under_1_5"], under_1_5: ["over_1_5", "under_1_5"],
          over_2_5: ["over_2_5", "under_2_5"], under_2_5: ["over_2_5", "under_2_5"],
          over_3_5: ["over_3_5", "under_3_5"], under_3_5: ["over_3_5", "under_3_5"],
          btts_yes: ["goal", "no_goal"], btts_no: ["goal", "no_goal"]
        };
        const addCandidate = (market, probability, sampleSize, label) => {
          const oddsKey = oddsKeys[market];
          const odds = oddsKey ? sisalEvent.markets[oddsKey] : null;
          if (!Number.isFinite(Number(odds)) || Number(odds) <= 1) return;
          const value = Number(probability);
          if (!Number.isFinite(value) || value < minProbability || value > 100) return;
          const pair = pairedMarkets[market] || [];
          const pairOdds = pair.map(key => Number(sisalEvent.markets[key])).filter(value => Number.isFinite(value) && value > 1);
          const rawImplied = 1 / Number(odds);
          const pairTotal = pairOdds.reduce((sum, odd) => sum + 1 / odd, 0);
          const marketProbability = pairTotal > 0 ? (rawImplied / pairTotal) * 100 : null;
          candidates.push({
            match_id: match.id, league: match.league_name,
            home_team: match.home_team, away_team: match.away_team,
            market, label, probability: Number(value.toFixed(2)),
            model_probability: Number(value.toFixed(2)),
            sisal_odds: Number(Number(odds).toFixed(2)),
            market_probability: marketProbability === null ? null : Number(marketProbability.toFixed(2)),
            probability_edge: marketProbability === null ? null : Number((value - marketProbability).toFixed(2)),
            source: "poisson+sisal", sample_size: sampleSize ?? null
          });
        };

        for (const [market, probability] of Object.entries(prediction.probabilities)) {
          addCandidate(market, probability,
            prediction.samples?.home && prediction.samples?.away ? Math.min(prediction.samples.home, prediction.samples.away) : null,
            marketLabels[market] || market);
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
        sisal_feed: { available: sisalData.available, stale: sisalData.stale, updated_at: sisalData.updated_at, age_minutes: sisalData.age_minutes, events_count: sisalData.events.length },
        market_policy: "Selezioni mostrate solo quando la partita è abbinata in modo univoco al PDF Sisal aggiornato e la quota del mercato è presente.",
        minimum_probability: minProbability,
        max_matches: maxMatches,
        max_selections: maxSelections,
        selected_matches: new Set(selected.map(item => item.match_id)).size,
        selected_selections: selected.length,
        naive_combined_probability: Number(naiveCombinedProbability.toFixed(4)),
        selections: selected,
        diagnostics,
        warning:
          "Probabilità stimate dal modello Poisson e quote lette dal PDF ufficiale Sisal. Le quote non garantiscono esiti; la probabilità combinata è una stima semplificata e non considera tutte le correlazioni."
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
  "1", "X", "2", "handicap_line", "handicap_1", "handicap_X", "handicap_2",
  "double_chance_1X", "double_chance_X2", "double_chance_12",
  "under_1_5", "over_1_5", "under_2_5", "over_2_5", "under_3_5", "over_3_5",
  "goal", "no_goal", "home_scores_yes", "home_scores_no", "away_scores_yes", "away_scores_no"
];

function normalizeSisalText(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/&/g, " e ").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function parseSisalOddsPdfText(text) {
  const lines = String(text || "").split(/\r?\n/);
  const updatedMatch = String(text || "").match(/Dati aggiornati al\s+(\d{2})\/(\d{2})\/(\d{4})\s*-\s*ore\s*(\d{2}:\d{2}:\d{2})/i);
  const updatedAt = updatedMatch ? updatedMatch[3] + "-" + updatedMatch[2] + "-" + updatedMatch[1] + "T" + updatedMatch[4] + "+01:00" : null;
  const monthNames = { gennaio:"01", febbraio:"02", marzo:"03", aprile:"04", maggio:"05", giugno:"06", luglio:"07", agosto:"08", settembre:"09", ottobre:"10", novembre:"11", dicembre:"12" };
  let currentDateLabel = null;
  let currentEvent = null;
  const events = [];
  let candidateLines = 0;
  let rejectedRows = 0;
  const sampleLines = [];
  const previewLines = lines.map(line => String(line).replace(/\s+/g, " ").trim()).filter(Boolean).slice(18, 68);

  const finishEvent = () => {
    if (!currentEvent) return;
    const combined = currentEvent.parts.join(" ").replace(/\s+/g, " ").trim();
    const firstOdd = combined.search(/\d{1,3},\d{2}(?!\d)/);
    if (firstOdd < 0) {
      rejectedRows++;
      currentEvent = null;
      return;
    }
    const teamText = combined.slice(0, firstOdd).replace(/[\s|]+$/g, "").trim();
    const oddsText = combined.slice(firstOdd);
    const oddsTokens = (oddsText.match(/\d{1,3},\d{2}/g) || []).slice(0, 3);
    const odds = oddsTokens.map(token => Number(token.replace(",", ".")));
    if (!teamText || odds.length !== 3 || odds.some(value => !Number.isFinite(value) || value <= 1 || value > 1000)) {
      rejectedRows++;
      currentEvent = null;
      return;
    }
    events.push({
      date_label: currentEvent.date_label,
      time: currentEvent.time,
      competition_code: currentEvent.competition_code,
      schedule_id: currentEvent.schedule_id,
      event_id: currentEvent.event_id,
      home_team_text: teamText,
      team_text: teamText,
      markets: { "1": odds[0], "X": odds[1], "2": odds[2] },
      parsed_odds_columns: oddsTokens.length
    });
    currentEvent = null;
  };

  for (const rawLine of lines) {
    const line = String(rawLine).replace(/\s+/g, " ").trim();
    if (!line) continue;
    const normalizedLine = normalizeSisalText(line);
    const dateHeading = normalizedLine.match(/^(?:(?:lunedi|martedi|mercoledi|giovedi|venerdi|sabato|domenica)[,]?\s+)?(\d{1,2})\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)\b/i);
    if (dateHeading) {
      finishEvent();
      currentDateLabel = dateHeading[1].padStart(2, "0") + "/" + monthNames[dateHeading[2]];
      continue;
    }

    // Il PDF Sisal può concatenare codice, orario e quote precedenti,
    // poi riportare palinsesto e avvenimento sulla stessa riga o sulle successive.
    const marker = line.match(/^([A-Z]{2,8})(\d{1,2}\.\d{2})(.*)$/i);
    if (marker) {
      finishEvent();
      candidateLines++;
      if (sampleLines.length < 8) sampleLines.push(line.slice(0, 240));
      const ids = marker[3].match(/(36\d{3})\s*(\d{1,7})(?:\s|$)/);
      if (!ids) {
        rejectedRows++;
        currentEvent = null;
        continue;
      }
      const idEnd = marker[3].indexOf(ids[0]) + ids[0].length;
      const afterIds = marker[3].slice(idEnd).trim();
      currentEvent = {
        date_label: currentDateLabel,
        time: marker[2],
        competition_code: marker[1].toUpperCase(),
        schedule_id: ids[1],
        event_id: ids[2],
        parts: afterIds ? [afterIds] : []
      };
      continue;
    }

    if (currentEvent) currentEvent.parts.push(line);
  }
  finishEvent();

  return {
    updated_at: updatedAt,
    events,
    diagnostics: {
      text_lines: lines.length,
      candidate_event_lines: candidateLines,
      parsed_events: events.length,
      rejected_candidate_lines: rejectedRows,
      sample_lines: sampleLines,
      preview_lines: previewLines
    }
  };
}
function findSisalEventForFixture(events, fixture) {
  const home = normalizeSisalText(fixture.home_team);
  const away = normalizeSisalText(fixture.away_team);
  const fixtureDate = String(fixture.match_date || fixture.date || "").slice(0, 10);
  if (!home || !away || !/^\d{4}-\d{2}-\d{2}$/.test(fixtureDate)) return null;
  const parts = fixtureDate.split("-");
  const expectedLabel = parts[2] + "/" + parts[1];
  const matches = events.filter(event => {
    const value = normalizeSisalText(event.team_text);
    return event.date_label === expectedLabel && value.includes(home) && value.includes(away);
  });
  return matches.length === 1 ? matches[0] : null;
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
    const stale = ageMinutes === null || ageMinutes > 360;

    res.json({
      ok: true,
      provider: "Sisal",
      source: SISAL_BASE_PDF_URL,
      source_type: "official_public_pdf",
      available: parsed.events.length > 0 && !stale,
      updated_at: parsed.updated_at,
      age_minutes: ageMinutes,
      stale,
      stale_after_minutes: 360,
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

app.get("/api/sync/automatic/status", (req, res) => {
  res.json({
    ok: true,
    enabled: Boolean(supabase && PITCHAPI_KEY),
    running: automaticResultsSyncRunning,
    interval_hours: 12,
    last_run: automaticResultsSyncLastRun,
    last_report: automaticResultsSyncLastReport,
    statistics_sync: {
      enabled: Boolean(supabase && PITCHAPI_KEY),
      running: automaticStatisticsSyncRunning,
      last_run: automaticStatisticsSyncLastRun,
      last_report: automaticStatisticsSyncLastReport
    },
    open_matchday_sync: { enabled: Boolean(supabase && ACCESS_TOKEN), running: automaticOpenMatchdayRunning, interval_hours: 24, last_run: automaticOpenMatchdayLastRun, last_report: automaticOpenMatchdayLastReport },
    note: "Sincronizza i risultati conclusi delle stagioni piu' recenti dei campionati gia' presenti in Supabase. Su hosting con sospensione del processo, il job riparte quando il servizio viene riattivato."
  });
});

// Copertura reale dello storico: confronta gli ID delle partite concluse
// con gli ID presenti in match_statistics, senza assumere che i conteggi coincidano.
app.get("/api/sync/statistics/coverage", requireDatabase, async (req, res) => {
  try {
    const pageSize = 1000;
    let offset = 0;
    let completedMatches = 0;
    let matchesWithStatistics = 0;
    let matchesWithoutStatistics = 0;
    let invalidMatchIds = 0;
    const now = new Date().toISOString();

    while (true) {
      const { data: matches, error: matchesError } = await supabase
        .from("matches")
        .select("id")
        .not("home_goals", "is", null)
        .not("away_goals", "is", null)
        .not("match_date", "is", null)
        .lte("match_date", now)
        .order("match_date", { ascending: false })
        .range(offset, offset + pageSize - 1);
      if (matchesError) throw matchesError;

      const page = matches || [];
      if (!page.length) break;
      completedMatches += page.length;

      const ids = page.map(row => String(row.id)).filter(Boolean);
      invalidMatchIds += page.length - ids.length;
      if (ids.length) {
        const { data: stats, error: statsError } = await supabase
          .from("match_statistics")
          .select("match_id")
          .in("match_id", ids);
        if (statsError) throw statsError;
        const present = new Set((stats || []).map(row => String(row.match_id)));
        matchesWithStatistics += present.size;
        matchesWithoutStatistics += ids.length - present.size;
      }

      if (page.length < pageSize) break;
      offset += page.length;
    }

    res.json({
      ok: true,
      completed_matches: completedMatches,
      matches_with_statistics: matchesWithStatistics,
      matches_without_statistics: matchesWithoutStatistics,
      coverage_percent: completedMatches
        ? Number((matchesWithStatistics / completedMatches * 100).toFixed(2))
        : 0,
      invalid_match_ids: invalidMatchIds,
      page_size: pageSize,
      note: "Conteggio calcolato confrontando gli ID delle partite concluse con match_statistics; una riga presente non garantisce che ogni singola metrica sia valorizzata."
    });
  } catch (error) {
    handleError(res, error);
  }
});

// Avvio manuale protetto: utile anche su hosting che sospende il processo.
app.post("/api/sync/automatic/run", requireSportApi, requireDatabase, async (req, res) => {
  if (automaticResultsSyncRunning || automaticStatisticsSyncRunning) {
    return res.status(409).json({
      ok: false,
      running: true,
      message: "Una sincronizzazione è già in corso. Controlla /api/sync/automatic/status."
    });
  }

  try {
    const results = await runAutomaticResultsSync();
    const statistics = await runAutomaticStatisticsSync();
    res.json({
      ok: true,
      triggered_manually: true,
      results_report: results || automaticResultsSyncLastReport,
      statistics_report: statistics || automaticStatisticsSyncLastReport
    });
  } catch (error) {
    handleError(res, error);
  }
});


// ==========================================
 // OTTIMIZZATORE SPERIMENTALE MODELLI (read-only)
 // Confronta configurazioni Poisson con valutazione temporale senza leakage.
 app.get("/api/model/optimizer/:leagueId", requireSportApi, requireDatabase, async (req, res) => {
  try {
    const leagueId=String(req.params.leagueId);
    if(!/^l_[A-Za-z0-9_-]+$/.test(leagueId)) return res.status(400).json({ok:false,error:"ID campionato non valido."});
    const catalog=await getEuropeanLeagueCatalog();
    if(!catalog.some(x=>String(x.id)===leagueId)) return res.status(404).json({ok:false,error:"Campionato non ammesso."});
    const testLimit=Math.min(Math.max(Number(req.query.limit)||250,50),500);
    const {data,error}=await supabase.from("matches").select("*").eq("league_id",leagueId)
      .not("home_goals","is",null).not("away_goals","is",null).order("match_date",{ascending:false}).limit(5000);
    if(error) throw error;
    const history=(data||[]).filter(m=>isFinished(m)&&m.match_date&&getNumber(m.home_goals)!==null&&getNumber(m.away_goals)!==null)
      .sort((a,b)=>new Date(a.match_date)-new Date(b.match_date));
    const test=history.slice(-testLimit),preTest=history.slice(0,-test.length);
    const valSize=Math.min(250,Math.max(100,Math.floor(preTest.length*0.25)));
    const validation=preTest.slice(-valSize),training=preTest.slice(0,-validation.length);
    if(training.length<100||validation.length<50||test.length<50)return res.status(422).json({ok:false,error:"Storico insufficiente per split temporale train/validation/test.",counts:{history:history.length,training:training.length,validation:validation.length,test:test.length}});
    const configs=[];for(const w of [10,20,25,30])for(const d of [0.75,0.9,0.95,1])for(const vb of [0.1,0.3,0.5,0.7])for(const prior of [0,3,5])configs.push({window:w,decay:d,venue_blend:vb,prior_matches:prior});
    const baseline={window:10,decay:0.75,venue_blend:0.7,prior_matches:3};
    const weighted=(vals,d)=>{if(!vals.length)return null;let s=0,ws=0;vals.forEach((v,i)=>{const w=Math.pow(d,i);s+=v*w;ws+=w;});return ws?s/ws:null;};
    const samples=(team,date,venue,source)=>{const t=String(team||"").toLowerCase();return source.filter(m=>new Date(m.match_date)<new Date(date)&&((venue==="home"?String(m.home_team||"").toLowerCase()===t:venue==="away"?String(m.away_team||"").toLowerCase()===t:String(m.home_team||"").toLowerCase()===t||String(m.away_team||"").toLowerCase()===t))).sort((a,b)=>new Date(b.match_date)-new Date(a.match_date)).map(m=>{const h=String(m.home_team||"").toLowerCase()===t;return{for:Number(h?m.home_goals:m.away_goals),against:Number(h?m.away_goals:m.home_goals)};});};
    const poisson=(l,k)=>{if(l<=0)return k===0?1:0;let f=1;for(let z=2;z<=k;z++)f*=z;return Math.exp(-l)*Math.pow(l,k)/f;};
    function predict(match,cfg,source){const date=match.match_date,prior=source.filter(m=>new Date(m.match_date)<new Date(date)).slice(-300);if(prior.length<30)return null;
      const lh0=prior.reduce((s,m)=>s+Number(m.home_goals),0)/prior.length,la0=prior.reduce((s,m)=>s+Number(m.away_goals),0)/prior.length;
      const h=samples(match.home_team,date,"all",source).slice(0,cfg.window),a=samples(match.away_team,date,"all",source).slice(0,cfg.window),hv=samples(match.home_team,date,"home",source).slice(0,5),av=samples(match.away_team,date,"away",source).slice(0,5);if(h.length<5||a.length<5)return null;
      const hf=weighted(h.map(x=>x.for),cfg.decay),ha=weighted(h.map(x=>x.against),cfg.decay),af=weighted(a.map(x=>x.for),cfg.decay),aa=weighted(a.map(x=>x.against),cfg.decay);
      const hvf=hv.length>=3?weighted(hv.map(x=>x.for),cfg.decay):hf,hva=hv.length>=3?weighted(hv.map(x=>x.against),cfg.decay):ha,avf=av.length>=3?weighted(av.map(x=>x.for),cfg.decay):af,ava=av.length>=3?weighted(av.map(x=>x.against),cfg.decay):aa;
      const priorMatches=Math.max(0,Number(cfg.prior_matches??3)),shrink=(v,p,n)=>(v*n+p*priorMatches)/(n+priorMatches||1),hFor=shrink(hf,lh0,h.length),hAgainst=shrink(ha,la0,h.length),aFor=shrink(af,la0,a.length),aAgainst=shrink(aa,lh0,a.length);
      const hVFor=shrink(hvf,hFor,hv.length),hVAgainst=shrink(hva,hAgainst,hv.length),aVFor=shrink(avf,aFor,av.length),aVAgainst=shrink(ava,aAgainst,av.length);
      const oh=lh0*(hFor/lh0)*(aAgainst/la0),oa=la0*(aFor/la0)*(hAgainst/lh0),vh=lh0*(hVFor/lh0)*(aVAgainst/la0),va=la0*(aVFor/la0)*(hVAgainst/lh0);
      const lH=Math.max(.1,Math.min(4.5,(1-cfg.venue_blend)*oh+cfg.venue_blend*vh)),lA=Math.max(.1,Math.min(4.5,(1-cfg.venue_blend)*oa+cfg.venue_blend*va));
      let p1=0,px=0,p2=0,o05=0,o15=0,o25=0,o35=0,o45=0,btts=0,sum=0,mat=[];for(let h=0;h<=8;h++)for(let a=0;a<=8;a++){const v=poisson(lH,h)*poisson(lA,a);mat.push({h,a,v});sum+=v;}for(const x of mat){const v=x.v/sum;if(x.h>x.a)p1+=v;else if(x.h===x.a)px+=v;else p2+=v;if(x.h+x.a>=1)o05+=v;if(x.h+x.a>=2)o15+=v;if(x.h+x.a>=3)o25+=v;if(x.h+x.a>=4)o35+=v;if(x.h+x.a>=5)o45+=v;if(x.h>0&&x.a>0)btts+=v;}return{"1":p1,"X":px,"2":p2,over_0_5:o05,under_0_5:1-o05,over_1_5:o15,under_1_5:1-o15,over_2_5:o25,under_2_5:1-o25,over_3_5:o35,under_3_5:1-o35,over_4_5:o45,under_4_5:1-o45,btts};
    }
    function score(rows){const out={};for(const market of ["1X2","over_0_5","under_0_5","over_1_5","under_1_5","over_2_5","under_2_5","over_3_5","under_3_5","over_4_5","under_4_5","btts"]){const rs=rows.filter(r=>r.market===market);if(!rs.length)continue;let acc,brier,ll,mean,rate;if(market==="1X2"){const cls=["1","X","2"];acc=rs.filter(r=>cls.reduce((b,c)=>r.p[c]>r.p[b]?c:b,cls[0])===r.y).length/rs.length;brier=rs.reduce((s,r)=>s+cls.reduce((q,c)=>q+(r.p[c]-(r.y===c?1:0))**2,0)/3,0)/rs.length;ll=rs.reduce((s,r)=>s-Math.log(Math.max(1e-6,r.p[r.y])),0)/rs.length;mean=rs.reduce((s,r)=>s+r.p[r.y],0)/rs.length;rate=null;}else{acc=rs.filter(r=>(r.p>=.5)===r.y).length/rs.length;brier=rs.reduce((s,r)=>s+(r.p-(r.y?1:0))**2,0)/rs.length;ll=rs.reduce((s,r)=>s-r.y*Math.log(Math.max(1e-6,r.p))-(1-r.y)*Math.log(Math.max(1e-6,1-r.p)),0)/rs.length;mean=rs.reduce((s,r)=>s+r.p,0)/rs.length;rate=rs.filter(r=>r.y).length/rs.length;}out[market]={n:rs.length,accuracy_percent:+(acc*100).toFixed(2),brier:+brier.toFixed(4),log_loss:+ll.toFixed(4),mean_probability_percent:+(mean*100).toFixed(2),actual_rate_percent:rate===null?null:+(rate*100).toFixed(2)};}return out;}
    function evaluate(matches,cfg,source){const rows=[];for(const m of matches){const p=predict(m,cfg,source);if(!p)continue;const h=Number(m.home_goals),a=Number(m.away_goals),tot=h+a;rows.push({market:"1X2",p,y:h>a?"1":h===a?"X":"2"});for(const market of ["over_0_5","under_0_5","over_1_5","under_1_5","over_2_5","under_2_5","over_3_5","under_3_5","over_4_5","under_4_5","btts"])rows.push({market,p:p[market],y:market==="btts"?h>0&&a>0:market.startsWith("over_")?tot>={"over_0_5":1,"over_1_5":2,"over_2_5":3,"over_3_5":4,"over_4_5":5}[market]:tot<={"under_0_5":0,"under_1_5":1,"under_2_5":2,"under_3_5":3,"under_4_5":4}[market]});}return rows;}
    const valResults=configs.map(c=>{const rows=evaluate(validation,c,history);const markets=score(rows),vals=Object.values(markets);return{config:c,markets,mean_brier:vals.length?+(vals.reduce((s,m)=>s+m.brier,0)/vals.length).toFixed(4):null,scored_matches:rows.filter(r=>r.market==="1X2").length};}).filter(r=>r.mean_brier!==null).sort((a,b)=>a.mean_brier-b.mean_brier);
    let selected=valResults[0]?.config;
    const fixedWindow=Number(req.query.fixed_window),fixedDecay=Number(req.query.fixed_decay),fixedVenue=Number(req.query.fixed_venue);
    const hasFixed=[fixedWindow,fixedDecay,fixedVenue].every(Number.isFinite);
    if(hasFixed){if(![20,25,30].includes(fixedWindow)||![0.9,0.95,1].includes(fixedDecay)||![0.1,0.2,0.3].includes(fixedVenue))return res.status(400).json({ok:false,error:"Configurazione fissa non ammessa."});selected={window:fixedWindow,decay:fixedDecay,venue_blend:fixedVenue};}
    if(!selected)throw new Error("Nessuna configurazione valutabile.");
    const baselineRows=evaluate(test,baseline,history),selectedRows=evaluate(test,selected,history);
    const baseScore=score(baselineRows),selectedScore=score(selectedRows);
    const comparisons={};for(const m of Object.keys(selectedScore))comparisons[m]={baseline:baseScore[m]||null,optimized:selectedScore[m]||null,brier_delta:selectedScore[m]&&baseScore[m]?+(selectedScore[m].brier-baseScore[m].brier).toFixed(4):null,accuracy_delta_pp:selectedScore[m]&&baseScore[m]?+(selectedScore[m].accuracy_percent-baseScore[m].accuracy_percent).toFixed(2):null};
    res.json({ok:true,optimizer:"V3 chronological train-validation-test; untouched holdout; strict pre-match history",league_id:leagueId,split:{history_matches:history.length,training_matches:training.length,validation_matches:validation.length,test_matches:test.length,training_dates:training.length?[training[0].match_date,training.at(-1).match_date]:null,validation_dates:[validation[0].match_date,validation.at(-1).match_date],test_dates:[test[0].match_date,test.at(-1).match_date]},selected_config:selected,selected_validation:hasFixed?(valResults.find(v=>v.config.window===selected.window&&v.config.decay===selected.decay&&v.config.venue_blend===selected.venue_blend)||null):valResults[0],validation_top_10:valResults.slice(0,10),evaluation_mode:hasFixed?"fixed_config_cross_league_candidate":"optimizer_selected",baseline_config:baseline,baseline_test:baseScore,selected_test:selectedScore,test_comparison:comparisons,validation_configurations_tested:configs.length,warning:"Configurazione selezionata esclusivamente sulla validation. Test cronologico non usato per selezione; nessuna modifica al modello produzione. ROI non calcolabile senza quote storiche affidabili."});
  }catch(error){handleError(res,error);}
});
 

// ==========================================
// VALIDAZIONE MULTI-CAMPIONATO IN BACKGROUND
// Job singleton: esecuzione sequenziale, retry, stato e risultati in memoria.
// ==========================================
let multiLeagueJob = null;
async function runMultiLeagueJob(job) {
  job.status = "running";
  job.current = "Recupero catalogo campionati da PitchAPI…";
  job.phase = "catalog_loading";
  job.updated_at = new Date().toISOString();
  let catalog;
  try {
    catalog = await Promise.race([
      getEuropeanLeagueCatalog(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout catalogo campionati: 30 secondi")), 30000))
    ]);
  } catch (catalogError) {
    job.status = "failed";
    job.phase = "catalog_error";
    job.error = catalogError.message;
    job.updated_at = new Date().toISOString();
    job.finished_at = job.updated_at;
    return;
  }
  // Solo i principali campionati europei: whitelist esplicita, niente coppe o serie minori.
  const MAIN_EUROPEAN_LEAGUE_PATTERNS = [
    /\b(premier league)\b/i,
    /\b(serie a)\b/i,
    /\b(la liga|primera division)\b/i,
    /\b(bundesliga)\b/i,
    /\b(ligue 1)\b/i,
    /\b(eredivisie)\b/i,
    /\b(primeira liga|liga portugal)\b/i,
    /\b(pro league|jupiler pro league)\b/i,
    /\b(super lig|super league)\b/i,
    /\b(scottish premiership|premiership)\b/i
  ];
  const catalogLeagues = catalog.filter(x => x && x.id && x.name &&
    !/women|femmin|femen|frauen|cup|coppa|pokal|copa|super cup/i.test(String(x.name)) &&
    MAIN_EUROPEAN_LEAGUE_PATTERNS.some(pattern => pattern.test(String(x.name))));
  job.phase = "ranking_leagues_by_data";
  job.current = "Selezione dei principali campionati europei con più storico…";
  job.updated_at = new Date().toISOString();
  const leagueCounts = await mapWithConcurrency(catalogLeagues, 5, async league => {
    try {
      const { count, error } = await supabase.from("matches").select("id", { count: "exact", head: true }).eq("league_id", String(league.id));
      if (error) throw error;
      return { id:String(league.id), name:String(league.name), matches_count:Number(count || 0) };
    } catch (e) {
      return { id:String(league.id), name:String(league.name), matches_count:0, count_error:e.message };
    }
  });
  const MIN_MATCHES_FOR_BATCH = 500;
  const MAX_BATCH_LEAGUES = 10;
  const leagues = leagueCounts
    .filter(x => x.matches_count >= MIN_MATCHES_FOR_BATCH)
    .sort((a,b) => b.matches_count - a.matches_count)
    .slice(0, MAX_BATCH_LEAGUES);
  job.selection = { method:"Supabase match count per league", minimum_matches:MIN_MATCHES_FOR_BATCH, maximum_leagues:MAX_BATCH_LEAGUES, catalog_leagues_checked:catalogLeagues.length, eligible_leagues:leagueCounts.filter(x=>x.matches_count>=MIN_MATCHES_FOR_BATCH).length, selected:leagues.map(x=>({id:x.id,name:x.name,matches_count:x.matches_count})), skipped_low_data:leagueCounts.filter(x=>x.matches_count<MIN_MATCHES_FOR_BATCH).length, count_errors:leagueCounts.filter(x=>x.count_error).length };
  job.leagues = leagues.map(x => ({id:x.id,name:x.name,matches_count:x.matches_count}));
  job.total = leagues.length;
  job.phase = "testing_leagues";
  job.current = leagues.length ? "Preparazione primo campionato…" : "Nessun campionato con almeno 500 partite nello storico.";
  job.updated_at = new Date().toISOString();
  for (const league of leagues) {
    if (job.completed.some(x => x.league_id === String(league.id))) continue;
    job.current = league.name;
    let result = null, error = null;
    for (let attempt=1; attempt<=2 && !result; attempt++) {
      job.attempt = attempt;
      try {
        job.phase = "testing_league";
        job.current = league.name + " (tentativo " + attempt + "/2)";
        job.updated_at = new Date().toISOString();
        const url = "http://127.0.0.1:"+PORT+"/api/model/optimizer/"+encodeURIComponent(league.id)+"?limit=250&fixed_window=25&fixed_decay=1&fixed_venue=0.1";
        const response = await fetch(url,{headers:{Authorization:"Bearer "+ACCESS_TOKEN},signal:AbortSignal.timeout(60000)});
        const body = await response.json();
        if (!response.ok || body?.ok !== true) throw new Error(body?.error || "HTTP "+response.status);
        result = body;
      } catch(e) {
        error = e;
        // Errori di dati/HTTP 4xx non vanno ritentati; solo timeout o 5xx temporanei.
        if (attempt < 2 && (e.name === "TimeoutError" || e.name === "AbortError" || Number(e.status || 0) >= 500 || /HTTP 5\d\d|fetch failed|network/i.test(e.message))) {
          await new Promise(r=>setTimeout(r,2000));
        } else {
          break;
        }
      }
    }
    if (result) job.completed.push({league_id:String(league.id),league_name:String(league.name),result,completed_at:new Date().toISOString()});
    else job.failed.push({league_id:String(league.id),league_name:String(league.name),error:error?.message||"Errore sconosciuto"});
    job.processed = job.completed.length + job.failed.length;
    job.phase = "league_completed";
    job.updated_at = new Date().toISOString();
    // Pausa breve: un campionato fallito non deve rallentare tutto il batch.
    await new Promise(r=>setTimeout(r,400));
  }
  job.current = null;
  job.phase = "finished";
  job.status = job.failed.length ? "completed_with_errors" : "completed";
  job.finished_at = new Date().toISOString();
  job.updated_at = job.finished_at;
}
app.post("/api/model/optimizer/batch/start", requireAccess, requireSportApi, requireDatabase, async (req,res)=>{
  if (multiLeagueJob && ["queued","running"].includes(multiLeagueJob.status)) return res.json({ok:true,message:"Job già attivo.",job:multiLeagueJob});
  multiLeagueJob={id:"mlv-"+Date.now(),status:"queued",config:{window:25,decay:1,venue_blend:0.1},holdout:250,total:0,processed:0,current:null,attempt:0,completed:[],failed:[],started_at:new Date().toISOString(),updated_at:new Date().toISOString()};
  runMultiLeagueJob(multiLeagueJob).catch(e=>{multiLeagueJob.status="failed";multiLeagueJob.error=e?.message||String(e);multiLeagueJob.finished_at=new Date().toISOString();});
  res.json({ok:true,message:"Validazione multi-campionato avviata in background.",job_id:multiLeagueJob.id});
});
app.get("/api/model/optimizer/batch/status", requireAccess, requireDatabase, (req,res)=>{
  if(!multiLeagueJob) return res.json({ok:true,job:null,message:"Nessun job avviato in questo processo server."});
  const j=multiLeagueJob;
  const compact={...j,completed:(j.completed||[]).map(x=>({league_id:x.league_id,league_name:x.league_name,completed_at:x.completed_at,result:{split:x.result?.split,selected_config:x.result?.selected_config,baseline_config:x.result?.baseline_config,test_comparison:x.result?.test_comparison}}))};
  res.json({ok:true,job:compact});
});

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

// Sincronizzazione giornaliera Open-Matchday tramite endpoint interno autenticato.
let automaticOpenMatchdayRunning = false;
let automaticOpenMatchdayLastRun = null;
let automaticOpenMatchdayLastReport = null;
async function runAutomaticOpenMatchdaySync() {
  if (!supabase || !ACCESS_TOKEN || automaticOpenMatchdayRunning) return null;
  automaticOpenMatchdayRunning = true;
  const report = { started_at: new Date().toISOString(), competitions_seen: 0, competitions_attempted: 0, competitions_succeeded: 0, csv_rows: 0, strict_matches_matched: 0, matches_with_new_statistics: 0, statistic_fields_imported: 0, existing_values_preserved: 0, unmatched_rows: 0, score_conflicts: 0, ambiguous_matches: 0, errors: [] };
  try {
    const response = await fetch('https://raw.githubusercontent.com/oladeeayo/open-matchday/master/LEAGUE_INDEX.md', { headers: { Accept: 'text/markdown' }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('Indice Open-Matchday HTTP ' + response.status);
    const [indexText, catalog] = await Promise.all([response.text(), getEuropeanLeagueCatalog()]);
    const codes = new Set(['ALB','AND','ARM','AUT','AZE','BEL','BIH','BLR','BUL','CRO','CYP','CZE','DEN','ENG','ESP','EST','FIN','FRA','FRO','GEO','GER','GRE','HUN','IRL','ISL','ISR','ITA','KAZ','KOS','LIE','LTU','LUX','LVA','MDA','MKD','MLT','MNE','NED','NIR','NOR','POL','POR','ROU','RUS','SCO','SMR','SRB','SVK','SVN','SWE','SUI','TUR','UKR','WAL','UEFA']);
    const rows = indexText.split(/\r?\n/).filter(line => /^\| \`[A-Za-z0-9_-]+\` \|/.test(line));
    report.competitions_seen = rows.length;
    for (const line of rows) {
      const cells = line.split('|').map(value => value.trim());
      const folder = String(cells[1] || '').replace(/^\`|\`$/g, '');
      const leagueName = cells[2] || '';
      if (!codes.has(folder.split('_')[0])) continue;
      const league = catalog.find(item => normalizeExternalTeamName(item.name || item.league_name) === normalizeExternalTeamName(leagueName));
      if (!league || !/^l_[A-Za-z0-9_-]+$/.test(String(league.id || ''))) continue;
      report.competitions_attempted++;
      try {
        const url = 'http://127.0.0.1:' + PORT + '/api/data-sources/open-matchday/sync?league_id=' + encodeURIComponent(String(league.id)) + '&folder=' + encodeURIComponent(folder) + '&season=2026%2F2027';
        const result = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + ACCESS_TOKEN, Accept: 'application/json' }, signal: AbortSignal.timeout(90000) });
        const body = await result.json().catch(() => ({}));
        if (!result.ok || !body.ok) throw new Error(body.error || ('Endpoint HTTP ' + result.status));
        report.competitions_succeeded++;
        for (const key of ['csv_rows','strict_matches_matched','matches_with_new_statistics','statistic_fields_imported','existing_values_preserved','unmatched_rows','score_conflicts','ambiguous_matches']) report[key] += Number(body[key] || 0);
      } catch (error) { report.errors.push({ folder: folder, league_id: String(league.id), error: error.message }); }
      await new Promise(resolve => setTimeout(resolve, 1100));
    }
  } catch (error) { report.errors.push({ error: error.message }); }
  finally { report.finished_at = new Date().toISOString(); automaticOpenMatchdayLastRun = report.finished_at; automaticOpenMatchdayLastReport = report; automaticOpenMatchdayRunning = false; console.log('Open-Matchday sync report:', JSON.stringify(report)); }
  return report;
}
// ==========================================
// AVVIO SERVER
// Sincronizzazione automatica dei risultati conclusi per i campionati
// gia' presenti in Supabase. I dati nuovi entrano nello storico rolling;
// calculatePrediction continua a usare solo gare precedenti al fixture.

let automaticResultsSyncRunning = false;
let automaticResultsSyncLastRun = null;
let automaticResultsSyncLastReport = null;

async function runAutomaticResultsSync() {
  if (!supabase || !PITCHAPI_KEY || automaticResultsSyncRunning) return;
  automaticResultsSyncRunning = true;
  const startedAt = new Date().toISOString();
  const report = {
    started_at: startedAt,
    leagues_in_catalog: 0,
    league_seasons_checked: 0,
    matches_received: 0,
    rows_upserted: 0,
    errors: []
  };

  try {
    // Inizializzazione completa: ogni campionato europeo e ogni stagione
    // dichiarata dal catalogo PitchAPI, non soltanto quelli già in Supabase.
    const europeanLeagues = await getEuropeanLeagueCatalog();
    if (!europeanLeagues.length) {
      throw new Error("Catalogo europeo vuoto: importazione interrotta per sicurezza.");
    }
    report.leagues_in_catalog = europeanLeagues.length;

    for (const league of europeanLeagues) {
      const leagueId = String(league.id || "");
      if (!/^l_[A-Za-z0-9_-]+$/.test(leagueId)) continue;
      const seasons = Array.isArray(league.seasons)
        ? league.seasons.filter(value => { const text = String(value); return /^\d{4}$/.test(text) || (text.length === 9 && text[4] === "/" && /^\d{4}$/.test(text.slice(0, 4)) && /^\d{4}$/.test(text.slice(5))); })
        : [];

      for (const season of seasons) {
        report.league_seasons_checked++;
        try {
          const body = await sportGet(
            `/leagues/${encodeURIComponent(leagueId)}/matches?season=${encodeURIComponent(season)}&status=all`
          );
          const matches = getMatches(body);
          const saved = await saveMatchesToDatabase(matches, String(season), leagueId);
          report.matches_received += matches.length;
          report.rows_upserted += saved;
        } catch (error) {
          report.errors.push({
            league_id: leagueId,
            league: league.name || null,
            season: String(season),
            error: error.message
          });
          console.error(`Sync storico fallita per ${leagueId} ${season}:`, error.message);
        }
      }
    }
  } catch (error) {
    report.errors.push({ error: error.message });
    console.error("Sync automatica risultati fallita:", error.message);
  } finally {
    report.finished_at = new Date().toISOString();
    automaticResultsSyncLastRun = report.finished_at;
    automaticResultsSyncLastReport = report;
    automaticResultsSyncRunning = false;
    console.log("Inizializzazione/sync europea completata:", JSON.stringify(report));
  }

  return report;
}

// Backfill progressivo delle statistiche dettagliate su tutto lo storico disponibile.
// Batch prudente: raddoppia la velocità di recupero mantenendo concorrenza API a 5.
const AUTOMATIC_STATISTICS_SYNC_BATCH_SIZE = 200;
let automaticStatisticsSyncRunning = false;
let automaticStatisticsSyncLastRun = null;
let automaticStatisticsSyncLastReport = null;

async function runAutomaticStatisticsSync() {
  if (!supabase || !PITCHAPI_KEY || automaticStatisticsSyncRunning) return;
  automaticStatisticsSyncRunning = true;
  const report = { started_at: new Date().toISOString(), matches_scanned: 0, statistics_saved: 0, already_present: 0, failed: 0, errors: [] };
  try {
    const now = new Date();
    const retryBefore = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const currentSeason = now.getUTCMonth() >= 6
      ? `${now.getUTCFullYear()}/${now.getUTCFullYear() + 1}`
      : `${now.getUTCFullYear() - 1}/${now.getUTCFullYear()}`;
    const europeanLeagues = await getEuropeanLeagueCatalog();
    const europeanIds = europeanLeagues.map(item => String(item.id));
    if (!europeanIds.length) throw new Error("Catalogo europeo PitchAPI vuoto: sincronizzazione interrotta per sicurezza.");
    const baseQuery = () => supabase
      .from("matches")
      .select("id,league_id,season,match_date")
      .in("league_id", europeanIds)
      .not("home_goals", "is", null)
      .not("away_goals", "is", null)
      .not("match_date", "is", null)
      .lte("match_date", now.toISOString())
      .or("statistics_sync_attempted_at.is.null,statistics_sync_attempted_at.lt." + retryBefore)
      .order("match_date", { ascending: false })
      .order("id", { ascending: true });

    // Priorità: gare recenti prima, poi lo storico più vecchio. Il backfill
    // prosegue a blocchi anche sulle stagioni precedenti, fino al 2021.
    const priorityQueries = [
      baseQuery().eq("league_id", "l_0ALvwF").eq("season", currentSeason).limit(AUTOMATIC_STATISTICS_SYNC_BATCH_SIZE),
      baseQuery().neq("league_id", "l_0ALvwF").eq("season", currentSeason).limit(AUTOMATIC_STATISTICS_SYNC_BATCH_SIZE),
      baseQuery().neq("season", currentSeason).limit(AUTOMATIC_STATISTICS_SYNC_BATCH_SIZE)
    ];
    const selectedById = new Map();
    for (const query of priorityQueries) {
      if (selectedById.size >= AUTOMATIC_STATISTICS_SYNC_BATCH_SIZE) break;
      const { data, error } = await query;
      if (error) throw error;
      for (const match of data || []) {
        if (!selectedById.has(String(match.id)) && selectedById.size < AUTOMATIC_STATISTICS_SYNC_BATCH_SIZE) {
          selectedById.set(String(match.id), match);
        }
      }
    }
    const matches = Array.from(selectedById.values());

    const scanned = matches || [];
    report.matches_scanned = scanned.length;
    if (scanned.length) {
      const ids = scanned.map(match => String(match.id));
      const { data: existing, error: existingError } = await supabase
        .from("match_statistics").select("match_id").in("match_id", ids);
      if (existingError) throw existingError;
      const existingIds = new Set((existing || []).map(row => String(row.match_id)));
      const missing = scanned.filter(match => !existingIds.has(String(match.id)));
      report.already_present = scanned.length - missing.length;

      const fetched = await mapWithConcurrency(missing, 5, async match => {
        try {
          const body = await sportGet("/matches/" + encodeURIComponent(match.id) + "/stats");
          const normalized = getNormalizedMatchStats(body);
          return normalized
            ? { match_id: String(match.id), league_id: String(match.league_id), match_date: match.match_date,
                normalized_stats: normalized, updated_at: new Date().toISOString() }
            : { match_id: String(match.id), unavailable: true };
        } catch (error) {
          return { match_id: String(match.id), error: error.message };
        }
      });

      const successful = fetched.filter(row => row && row.normalized_stats);
      if (successful.length) {
        const { error } = await supabase.from("match_statistics").upsert(successful, { onConflict: "match_id" });
        if (error) throw error;
      }
      report.statistics_saved = successful.length;
      const failures = fetched.filter(row => row?.error);
      report.failed = failures.length;
      report.unavailable = fetched.filter(row => row?.unavailable).length;
      report.errors = failures.slice(0, 10).map(row => ({ match_id: row.match_id, error: row.error }));

      // Segna ogni tentativo: i record non disponibili o falliti vengono riprovati dopo 7 giorni.
      const attemptedAt = new Date().toISOString();
      const { error: markError } = await supabase
        .from("matches")
        .update({ statistics_sync_attempted_at: attemptedAt })
        .in("id", ids);
      if (markError) throw markError;
    }
  } catch (error) {
    report.errors.push({ error: error.message });
  } finally {
    report.finished_at = new Date().toISOString();
    automaticStatisticsSyncLastRun = report.finished_at;
    automaticStatisticsSyncLastReport = report;
    automaticStatisticsSyncRunning = false;
    console.log("Backfill statistiche automatico completato:", JSON.stringify(report));
  }
  return report;
}

// Render puo' sospendere i servizi gratuiti inattivi: il job parte all'avvio
// e poi ogni 12 ore mentre il processo rimane attivo.
const AUTOMATIC_RESULTS_SYNC_INTERVAL_MS = 12 * 60 * 60 * 1000;

app.listen(PORT, () => {
  console.log(`Football Predictor Server attivo sulla porta ${PORT}`);
  setTimeout(() => {
    runAutomaticResultsSync().catch(error =>
      console.error("Avvio sync automatica non riuscito:", error.message)
    ).finally(() => runAutomaticStatisticsSync().catch(error =>
      console.error("Avvio backfill statistiche non riuscito:", error.message)
    ));
  }, 60 * 1000);
  setInterval(() => {
    runAutomaticResultsSync().catch(error =>
      console.error("Sync periodica non riuscita:", error.message)
    );
  }, AUTOMATIC_RESULTS_SYNC_INTERVAL_MS);
  setTimeout(() => runAutomaticOpenMatchdaySync().catch(error => console.error("Open-Matchday iniziale:", error.message)), 3 * 60 * 1000);
  setInterval(() => runAutomaticOpenMatchdaySync().catch(error => console.error("Open-Matchday periodico:", error.message)), 24 * 60 * 60 * 1000);
  // Le statistiche vengono recuperate più spesso, a piccoli blocchi, per completare
  // progressivamente lo storico senza lanciare migliaia di richieste tutte insieme.
  setInterval(() => {
    runAutomaticStatisticsSync().catch(error =>
      console.error("Backfill statistiche periodico non riuscito:", error.message)
    );
  }, 60 * 60 * 1000);
});
