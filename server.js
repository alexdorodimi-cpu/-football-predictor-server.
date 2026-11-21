
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

// TEST CONFIGURAZIONE
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

// Rotte statistiche delle partite
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
      const data = await pitchGet(`/v1/matches/${id}${endpoint}`);
      res.json({ ok: true, response: data });
    } catch (err) {
      handleError(res, err);
    }
  });
}

// Dettagli partita
addMatchRoute("/api/fixture/:id", "");

// Statistiche squadre
addMatchRoute("/api/fixture/:id/statistics", "/stats");

// Tiri
addMatchRoute("/api/fixture/:id/shots", "/shots");

// Gol, cartellini e sostituzioni
addMatchRoute("/api/fixture/:id/events", "/events");

// Statistiche giocatori
addMatchRoute("/api/fixture/:id/players", "/players");

// Formazioni
addMatchRoute("/api/fixture/:id/lineups", "/lineups");

// Andamento partita
addMatchRoute("/api/fixture/:id/momentum", "/momentum");

// Statistiche avanzate e xG
addMatchRoute("/api/fixture/:id/advanced", "/advanced");

// Precedenti
addMatchRoute("/api/fixture/:id/h2h", "/h2h");

// Statistiche in diretta
addMatchRoute("/api/fixture/:id/live", "/live");

// Mappa tiri e azioni
addMatchRoute("/api/fixture/:id/heatmaps", "/heatmaps");

// Pronostici
app.get("/api/fixture/:id/predictions", requireConfig, requireAccess, (req, res) => {
  res.status(501).json({
    ok: false,
    error: "I pronostici saranno generati dal nostro modello di analisi."
  });
});

// Quote
app.get("/api/fixture/:id/odds", requireConfig, requireAccess, (req, res) => {
  res.status(501).json({
    ok: false,
    error: "Le quote richiedono una fonte dati separata."
  });
});

// Campionati e partite
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

// MEDIE STATISTICHE DELLE SQUADRE
app.get("/api/team/:id/averages", requireConfig, requireAccess, async (req, res) => {
  const teamId = req.params.id;
  const leagueId = req.query.league;
  const season = req.query.season;
  const last = Number(req.query.last || 10);

  if (!/^t_[A-Za-z0-9]{6}$/.test(teamId)) {
    return res.status(400).json({
      ok: false,
      error: "ID squadra non valido."
    });
  }

  if (!/^l_[A-Za-z0-9]{6}$/.test(leagueId || "")) {
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

    const totals = {
      goals_for: 0,
      goals_against: 0,
      corners: 0,
      total_shots: 0,
      shots_on_target: 0,
      yellow_cards: 0,
      red_cards: 0,
      fouls: 0
    };

    const counts = {};
    const analyzedMatches = [];

    for (const key of Object.keys(totals)) {
      counts[key] = 0;
    }

    for (const match of matches) {
      const isHome = match.home_team?.id === teamId;

      const matchInfo = {
        id: match.id,
        date: match.date,
        opponent: isHome
          ? match.away_team?.name
          : match.home_team?.name
      };

      // Gol fatti e subiti
      const homeScore = Number(
        match.home_score ?? match.score?.home ?? match.home_team?.score
      );

      const awayScore = Number(
        match.away_score ?? match.score?.away ?? match.away_team?.score
      );

      const scored = isHome ? homeScore : awayScore;
      const conceded = isHome ? awayScore : homeScore;

      if (Number.isFinite(scored)) {
        totals.goals_for += scored;
        counts.goals_for++;
      }

      if (Number.isFinite(conceded)) {
        totals.goals_against += conceded;
        counts.goals_against++;
      }

      // Statistiche della partita
      try {
        const data = await pitchGet(`/v1/matches/${match.id}/stats`);

        const periods = data?.periods || [];
        const period = periods.find(p =>
          String(p.key || p.name || "").toLowerCase() === "all"
        ) || periods[0];

        const groups = period?.groups || [];

        for (const group of groups) {
          for (const item of group.items || []) {
            const key = item.key;

            const statMap = {
              corners: "corners",
              total_shots: "total_shots",
              shots_on_target: "shots_on_target",
              yellow_cards: "yellow_cards",
              red_cards: "red_cards",
              fouls: "fouls"
            };

            const target = statMap[key];
            if (!target) continue;

            const side = isHome ? item.home : item.away;

            let value = Number(
              side?.value ?? side?.total ?? side
            );

            if (!Number.isFinite(value)) continue;

            totals[target] += value;
            counts[target]++;
          }
        }
      } catch (error) {
        // Se mancano le statistiche di una partita, continua.
      }

      analyzedMatches.push(matchInfo);
    }

    const averages = {};

    for (const key of Object.keys(totals)) {
      averages[key] = counts[key]
        ? Number((totals[key] / counts[key]).toFixed(2))
        : null;
    }

    res.json({
      ok: true,
      team_id: teamId,
      league_id: leagueId,
      season,
      matches_requested: last,
      matches_analyzed: matches.length,
      averages,
      sample_counts: counts,
      matches: analyzedMatches
    });

  } catch (err) {
    handleError(res, err);
  }
});

app.get("/api/team/:id/averages", requireConfig, requireAccess, async (req, res) => {
  const teamId = req.params.id;
  const leagueId = req.query.league;
  const season = req.query.season;
  const last = Number(req.query.last || 10);

  if (!/^t_[A-Za-z0-9]{6}$/.test(teamId)) {
    return res.status(400).json({
      ok: false,
      error: "ID squadra non valido."
    });
  }

  if (!/^l_[A-Za-z0-9]{6}$/.test(leagueId || "")) {
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
    const keys = {
      corners: ["corners"],
      total_shots: ["total_shots"],
      shots_on_target: ["ShotsOnTarget", "shots_on_target"],
      yellow_cards: ["yellow_cards"],
      red_cards: ["red_cards"],
      fouls: ["fouls"],
      expected_goals: ["expected_goals"],
      possession: ["BallPossesion", "ball_possession"]
    };

    let statsMatches = 0;

    for (const match of matches) {
      const isHome = match.home_team?.id === teamId;
      const team = isHome ? match.home_team : match.away_team;
      const opponent = isHome ? match.away_team : match.home_team;

      const goalsFor = Number(
        isHome ? match.home_score : match.away_score
      );
      const goalsAgainst = Number(
        isHome ? match.away_score : match.home_score
      );

      if (Number.isFinite(goalsFor)) {
        stats.goals_for += goalsFor;
        counts.goals_for = (counts.goals_for || 0) + 1;
      }

      if (Number.isFinite(goalsAgainst)) {
        stats.goals_against += goalsAgainst;
        counts.goals_against = (counts.goals_against || 0) + 1;
      }

      try {
        const data = await pitchGet(`/v1/matches/${match.id}/stats`);
        const period = (data.periods || []).find(p => p.period === "All");

        if (!period) continue;

        const values = {};

        for (const group of period.groups || []) {
          for (const item of group.items || []) {
            values[item.key] = isHome ? item.home : item.away;
          }
        }

        let found = false;

        for (const [name, possibleKeys] of Object.entries(keys)) {
          const key = possibleKeys.find(k => values[k] !== undefined);
          if (!key) continue;

          const value = parseFloat(String(values[key]).replace(",", "."));
          if (!Number.isFinite(value)) continue;

          stats[name] += value;
          counts[name] = (counts[name] || 0) + 1;
          found = true;
        }

        if (found) statsMatches++;
      } catch (error) {
        // Continua con le altre partite se mancano statistiche.
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
        home_score: match.home_score,
        away_score: match.away_score
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

  if (!/^t_[A-Za-z0-9]{6}$/.test(teamId)) {
    return res.status(400).json({
      ok: false,
      error: "ID squadra non valido."
    });
  }

  if (!/^l_[A-Za-z0-9]{6}$/.test(leagueId || "")) {
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
          if (entry.team_id !== teamId || !entry.player?.id) {
            continue;
          }

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
        // Continua anche se mancano i dati di una partita.
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
