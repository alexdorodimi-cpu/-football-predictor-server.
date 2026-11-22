
const express = require("express");
const rateLimit = require("express-rate-limit");
const { createClient } = require("@supabase/supabase-js");

const app = express();

const PORT = process.env.PORT || 10000;
const SPORTAPI_URL = "https://sportapi.ai/api";

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));

app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false
}));

// DATABASE SUPABASE
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

// CONTROLLO ACCESSO AL SOFTWARE
function requireAccess(req, res, next) {
  const token = process.env.PREDICTOR_ACCESS_TOKEN;

  if (!token) {
    return res.status(500).json({
      ok: false,
      error: "PREDICTOR_ACCESS_TOKEN non configurato"
    });
  }

  const auth = req.headers.authorization || "";
  const supplied = auth.startsWith("Bearer ")
    ? auth.slice(7)
    : "";

  if (supplied !== token) {
    return res.status(401).json({
      ok: false,
      error: "Accesso non autorizzato"
    });
  }

  next();
}

// COLLEGAMENTO SPORTAPI
async function sportGet(path) {
  const apiKey = process.env.SPORTAPI_KEY;

  if (!apiKey) {
    throw new Error("SPORTAPI_KEY non configurata");
  }

  const response = await fetch(
    `${SPORTAPI_URL}${path}`,
    {
      method: "GET",
      headers: {
        "X-Api-Key": apiKey,
        "Accept": "application/json"
      },
      signal: AbortSignal.timeout(20000)
    }
  );

  const text = await response.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Risposta non valida da SportAPI");
  }

  if (!response.ok) {
    const error = new Error(
      data.error || data.message || "Errore SportAPI"
    );
    error.status = response.status;
    throw error;
  }

  return data;
}

// GESTIONE ERRORI SPORTAPI
function handleError(res, error) {
  console.error("Errore:", error.message);

  return res.status(error.status || 500).json({
    ok: false,
    error: error.message
  });
}

// STATUS SERVER
app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    server: "Football Predictor AI",
    provider: "SportAPI",
    database: "Supabase configurato",
    sportapiKeyConfigured: Boolean(process.env.SPORTAPI_KEY),
    accessTokenConfigured: Boolean(process.env.PREDICTOR_ACCESS_TOKEN)
  });
});
// TEST SPORTAPI
app.get("/api/test-sportapi", requireAccess, async (req, res) => {
  try {
    const data = await sportGet("/leagues");

    res.json({
      ok: true,
      connected: true,
      competitions: Array.isArray(data.data)
        ? data.data.length
        : null,
      message: "Collegamento SportAPI riuscito"
    });
  } catch (error) {
    handleError(res, error);
  }
});

// TEST DATABASE
app.get("/api/test-database", requireAccess, async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({
        ok: false,
        connected: false,
        error: "Configurazione Supabase mancante"
      });
    }

    const { error } = await supabase
      .from("matches")
      .select("id")
      .limit(1);

    if (error) throw error;

    res.json({
      ok: true,
      connected: true,
      database: "Supabase",
      message: "Collegamento al database riuscito"
    });
  } catch (error) {
    handleError(res, error);
  }
});

// CAMPIONATI
app.get("/api/leagues", requireAccess, async (req, res) => {
  try {
    const data = await sportGet("/leagues");
    res.json(data);
  } catch (error) {
    handleError(res, error);
  }
});

// CLASSIFICHE
app.get("/api/standings/leagues", requireAccess, async (req, res) => {
  try {
    const data = await sportGet("/standings/leagues");
    res.json(data);
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/standings/:leagueId", requireAccess, async (req, res) => {
  try {
    const data = await sportGet(
      `/standings/${encodeURIComponent(req.params.leagueId)}`
    );
    res.json(data);
  } catch (error) {
    handleError(res, error);
  }
});

// PARTITE DI UNA DATA
app.get("/api/fixtures/date/:date", requireAccess, async (req, res) => {
  try {
    const date = req.params.date;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({
        ok: false,
        error: "Data non valida. Usa YYYY-MM-DD"
      });
    }

    const data = await sportGet(`/fixtures/date/${date}`);
    res.json(data);
  } catch (error) {
    handleError(res, error);
  }
});

// DETTAGLIO PARTITA
app.get("/api/fixture/:id", requireAccess, async (req, res) => {
  try {
    const data = await sportGet(
      `/fixtures/${encodeURIComponent(req.params.id)}`
    );
    res.json(data);
  } catch (error) {
    handleError(res, error);
  }
});

// STATISTICHE PARTITA
app.get("/api/fixture/:id/statistics", requireAccess, async (req, res) => {
  try {
    const data = await sportGet(
      `/fixtures/${encodeURIComponent(req.params.id)}/stats`
    );
    res.json(data);
  } catch (error) {
    handleError(res, error);
  }
});

// FORMAZIONI
app.get("/api/fixture/:id/lineups", requireAccess, async (req, res) => {
  try {
    const data = await sportGet(
      `/fixtures/${encodeURIComponent(req.params.id)}/lineups`
    );
    res.json(data);
  } catch (error) {
    handleError(res, error);
  }
});

// EVENTI
app.get("/api/fixture/:id/events", requireAccess, async (req, res) => {
  try {
    const data = await sportGet(
      `/fixtures/${encodeURIComponent(req.params.id)}/events`
    );
    res.json(data);
  } catch (error) {
    handleError(res, error);
  }
});

// SQUADRA
app.get("/api/team/:id", requireAccess, async (req, res) => {
  try {
    const data = await sportGet(
      `/teams/${encodeURIComponent(req.params.id)}`
    );
    res.json(data);
  } catch (error) {
    handleError(res, error);
  }
});

// ROSA SQUADRA
app.get("/api/team/:id/players", requireAccess, async (req, res) => {
  try {
    const data = await sportGet(
      `/teams/${encodeURIComponent(req.params.id)}/squad`
    );
    res.json(data);
  } catch (error) {
    handleError(res, error);
  }
});

// PROFILO GIOCATORE
app.get("/api/player/:slug", requireAccess, async (req, res) => {
  try {
    const data = await sportGet(
      `/players/${encodeURIComponent(req.params.slug)}`
    );
    res.json(data);
  } catch (error) {
    handleError(res, error);
  }
});

// STATISTICHE INDIVIDUALI GIOCATORE
app.get("/api/player-stats", requireAccess, async (req, res) => {
  try {
    const { name, team_id, shirt_number } = req.query;

    if (!name || !team_id) {
      return res.status(400).json({
        ok: false,
        error: "Servono name e team_id"
      });
    }

    const params = new URLSearchParams({
      name: String(name),
      team_id: String(team_id)
    });

    if (shirt_number) {
      params.set("shirt_number", String(shirt_number));
    }

    const data = await sportGet(`/players/stats?${params}`);
    res.json(data);
  } catch (error) {
    handleError(res, error);
  }
});

// MARCATORI
app.get("/api/league/:id/topscorers", requireAccess, async (req, res) => {
  try {
    const data = await sportGet(
      `/leagues/${encodeURIComponent(req.params.id)}/topscorers`
    );
    res.json(data);
  } catch (error) {
    handleError(res, error);
  }
});

// ASSIST
app.get("/api/league/:id/topassists", requireAccess, async (req, res) => {
  try {
    const data = await sportGet(
      `/leagues/${encodeURIComponent(req.params.id)}/topassists`
    );
    res.json(data);
  } catch (error) {
    handleError(res, error);
  }
});

// CARTELLINI
app.get("/api/league/:id/topcards", requireAccess, async (req, res) => {
  try {
    const data = await sportGet(
      `/leagues/${encodeURIComponent(req.params.id)}/topcards`
    );
    res.json(data);
  } catch (error) {
    handleError(res, error);
  }
});

// TESTATA SITO
app.get("/", (req, res) => {
  res.send("Football Predictor AI - Server attivo");
});

// FILE DEL SITO WEB
app.use(express.static("public"));

// PAGINA NON TROVATA
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "Endpoint non trovato"
  });
});

// AVVIO SERVER
app.listen(PORT, () => {
  console.log(
    `Football Predictor Server attivo sulla porta ${PORT}`
  );
});
