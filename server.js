
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

// TEST TEMPORANEO CONFIGURAZIONE
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
  res.status(err.status || 502).json({
    ok: false,
    error: err.message,
    details: err.details
  });
}

function validMatchId(id) {
  return /^m_[A-Za-z0-9]{6}$/.test(id);
}

app.use(express.static("public"));

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "football-predictor-ai",
    time: new Date().toISOString()
  });
});

// Verifica collegamento PitchAPI
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

// Partite di un giorno
app.get("/api/fixtures", requireConfig, requireAccess, async (req, res) => {
  const date = req.query.date;

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({
      ok: false,
      error: "Inserisci la data nel formato YYYY-MM-DD."
    });
  }

  const status = req.query.status || "all";

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

// Funzione per creare le rotte delle statistiche
function addMatchRoute(route, endpoint) {
  app.get(route, requireConfig, requireAccess, async (req, res) => {
    const id = req.params.id;

    if (!validMatchId(id)) {
      return res.status(400).json({
        ok: false,
        error: "ID partita non valido. Usa un ID PitchAPI."
      });
    }

    try {
      const data = await pitchGet(
        `/v1/matches/${id}${endpoint}`
      );

      res.json({ ok: true, response: data });
    } catch (err) {
      handleError(res, err);
    }
  });
}

// Dettagli della partita
addMatchRoute("/api/fixture/:id", "");

// Statistiche delle due squadre
addMatchRoute("/api/fixture/:id/statistics", "/stats");

// Tiri e tiri in porta
addMatchRoute("/api/fixture/:id/shots", "/shots");

// Gol, cartellini e sostituzioni
addMatchRoute("/api/fixture/:id/events", "/events");

// Statistiche dei giocatori
addMatchRoute("/api/fixture/:id/players", "/players");

// Formazioni
addMatchRoute("/api/fixture/:id/lineups", "/lineups");

// Andamento della partita
addMatchRoute("/api/fixture/:id/momentum", "/momentum");

// Statistiche avanzate e xG
addMatchRoute("/api/fixture/:id/advanced", "/advanced");

// Precedenti tra le squadre
addMatchRoute("/api/fixture/:id/h2h", "/h2h");

// Statistiche in diretta
addMatchRoute("/api/fixture/:id/live", "/live");

// Mappa dei tiri e delle azioni
addMatchRoute("/api/fixture/:id/heatmaps", "/heatmaps");

// Pronostici e quote non sono forniti da PitchAPI
app.get(
  "/api/fixture/:id/predictions",
  requireConfig,
  requireAccess,
  (req, res) => {
    res.status(501).json({
      ok: false,
      error: "I pronostici saranno generati dal nostro modello di analisi."
    });
  }
);

app.get(
  "/api/fixture/:id/odds",
  requireConfig,
  requireAccess,
  (req, res) => {
    res.status(501).json({
      ok: false,
      error: "Le quote richiedono una fonte dati separata."
    });
  }
);

// Campionati e relative partite
app.get("/api/league/:id/matches", requireConfig, requireAccess, async (req, res) => {
  const id = req.params.id;
  const season = req.query.season;
  const status = req.query.status || "played";

  if (!/^l_[A-Za-z0-9]{6}$/.test(id)) {
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

// Medie statistiche delle squadre
app.get("/api/team/:id/averages", requireConfig, requireAccess, async (req, res) => {
  const teamId = req.params.id;
  const leagueId = req.query.league;
  const season = req.query.season;
  const last = Number(req.query.last || 10);

  if (!/^t_[A-Za-z0-9]{6}$/.test(teamId)) {
    return res.status(400).json({ ok: false, error: "ID squadra non valido." });
  }

  if (!/^l_[A-Za-z0-9]{6}$/.test(leagueId || "")) {
    return res.status(400).json({ ok: false, error: "ID campionato non valido." });
  }

  if (!season || !Number.isInteger(last) || last < 1 || last > 10) {
    return res.status(400).json({
      ok: false,
      error: "Stagione o numero di partite non valido. Il massimo è 10."
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

    if (matches.length === 0) {
      return res.json({
        ok: true,
        team_id: teamId,
        matches_analyzed: 0,
        message: "Nessuna partita trovata per questa squadra."
      });
    }

    const keys = {
      goals_for: null,
      goals_against: null,
      corners: "corners",
      total_shots: "total_shots",
      shots_on_target: "ShotsOnTarget",
      yellow_cards: "yellow_cards",
      red_cards: "red_cards",
      fouls: "fouls"
    };

    const sums = {};
    const counts = {};

    for (const key of Object.keys(keys)) {
      sums[key] = 0;
      counts[key] = 0;
    }

    let statsMatchesAnalyzed = 0;
    let teamName = teamId;
    const matchDetails = [];

    for (const match of matches) {
      const isHome = match.home_team?.id === teamId;

      teamName = isHome
        ? match.home_team.name
        : match.away_team.name;

      const goalsFor = Number(isHome ? match.score_home : match.score_away);
      const goalsAgainst = Number(isHome ? match.score_away : match.score_home);

      if (Number.isFinite(goalsFor)) {
        sums.goals_for += goalsFor;
        counts.goals_for++;
      }

      if (Number.isFinite(goalsAgainst)) {
        sums.goals_against += goalsAgainst;
        counts.goals_against++;
      }

      matchDetails.push({
        date: match.date,
        opponent: isHome ? match.away_team?.name : match.home_team?.name,
        venue: isHome ? "Casa" : "Trasferta",
        score: `${match.score_home}-${match.score_away}`
      });

      try {
        const stats = await pitchGet(`/v1/matches/${match.id}/stats`);
        const allPeriod = (stats.periods || []).find(p => p.period === "All");

        if (!allPeriod) continue;

        const found = {};

        for (const group of allPeriod.groups || []) {
          for (const item of group.items || []) {
            if (
              item.key &&
              Object.values(keys).includes(item.key) &&
              found[item.key] === undefined
            ) {
              found[item.key] = item;
            }
          }
        }

        let hasStats = false;

        for (const [name, statKey] of Object.entries(keys)) {
          if (!statKey) continue;

          const item = found[statKey];
          if (!item) continue;

          const rawValue = isHome ? item.home : item.away;
          const value = parseInt(String(rawValue), 10);

          if (Number.isFinite(value)) {
            sums[name] += value;
            counts[name]++;
            hasStats = true;
          }
        }

        if (hasStats) statsMatchesAnalyzed++;
      } catch (statsError) {
        // Se mancano le statistiche di una partita, continua con le altre.
      }
    }

    const averages = {};

    for (const key of Object.keys(sums)) {
      averages[key] = counts[key]
        ? Number((sums[key] / counts[key]).toFixed(2))
        : null;
    }

    res.json({
      ok: true,
      team: {
        id: teamId,
        name: teamName
      },
      league_id: leagueId,
      season,
      matches_requested: last,
      matches_analyzed: matches.length,
      stats_matches_analyzed: statsMatchesAnalyzed,
      averages,
      sample_counts: counts,
      matches: matchDetails
    });

  } catch (err) {
    handleError(res, err);
  }
});

// Gestione errori
app.use((err, req, res, next) => {
  console.error("Errore server:", err.message);
  res.status(500).json({
    ok: false,
    error: "Errore interno del server."
  });
});

app.use(express.static("public"));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Football Predictor AI attivo sulla porta ${PORT}`);
});
