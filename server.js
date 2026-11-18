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

app.get("/", (req, res) => {
  res.type("html").send(`
    <!doctype html>
    <html lang="it">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Football Predictor AI</title>
    <body style="font-family:system-ui;max-width:680px;margin:40px auto;padding:0 18px">
    <h1>Football Predictor AI</h1>
    <p>Server attivo e collegato a PitchAPI.</p>
    <p><a href="/health">Controllo server</a></p>
    </body>
    </html>
  `);
});

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

app.use((err, req, res, next) => {
  console.error("Errore server:", err.message);
  res.status(500).json({
    ok: false,
    error: "Errore interno del server."
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Football Predictor AI attivo sulla porta ${PORT}`);
});
