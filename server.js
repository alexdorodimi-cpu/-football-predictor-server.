const express = require("express");
const rateLimit = require("express-rate-limit");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.API_FOOTBALL_KEY;
const ACCESS_TOKEN = process.env.PREDICTOR_ACCESS_TOKEN;
const API_BASE = "https://v3.football.api-sports.io";

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
      error: "Configurazione mancante: imposta API_FOOTBALL_KEY e PREDICTOR_ACCESS_TOKEN su Render."
    });
  }
  next();
}

function requireAccess(req, res, next) {
  const auth = req.get("authorization") || "";
  const supplied = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!supplied || supplied !== ACCESS_TOKEN) {
    return res.status(401).json({ ok: false, error: "Accesso non autorizzato." });
  }
  next();
}

async function footballGet(path, params = {}) {
  const url = new URL(API_BASE + path);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url, {
    method: "GET",
    headers: { "x-apisports-key": API_KEY }
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(`API-Football ha risposto con HTTP ${response.status}`);
    err.status = response.status;
    err.details = body;
    throw err;
  }
  return body;
}

app.get("/", (req, res) => {
  res.type("html").send(`
    <!doctype html><html lang="it"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Football Predictor AI</title>
    <body style="font-family:system-ui;max-width:680px;margin:40px auto;padding:0 18px;color:#172b3a">
    <h1>Football Predictor AI</h1>
    <p>Server attivo. Le chiavi sono conservate nelle variabili protette del server.</p>
    <p>Controllo tecnico: <a href="/health">/health</a></p>
    </body></html>
  `);
});

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "football-predictor-api", time: new Date().toISOString() });
});

app.get("/api/status", requireConfig, requireAccess, async (req, res) => {
  try {
    const data = await footballGet("/status");
    res.json({ ok: true, provider: "API-Football", data });
  } catch (err) {
    res.status(err.status || 502).json({ ok: false, error: err.message, details: err.details });
  }
});

app.get("/api/fixtures", requireConfig, requireAccess, async (req, res) => {
  const date = req.query.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ ok: false, error: "Inserisci date nel formato YYYY-MM-DD." });
  }
  try {
    const params = { date, timezone: req.query.timezone || "Europe/Rome" };
    if (req.query.league) params.league = req.query.league;
    if (req.query.season) params.season = req.query.season;
    const data = await footballGet("/fixtures", params);
    res.json({ ok: true, date, results: data.results, response: data.response || [], errors: data.errors });
  } catch (err) {
    res.status(err.status || 502).json({ ok: false, error: err.message, details: err.details });
  }
});

app.get("/api/fixture/:id/statistics", requireConfig, requireAccess, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ ok: false, error: "ID partita non valido." });
  try {
    const data = await footballGet("/fixtures/statistics", { fixture: req.params.id });
    res.json({ ok: true, response: data.response || [], errors: data.errors });
  } catch (err) {
    res.status(err.status || 502).json({ ok: false, error: err.message, details: err.details });
  }
});

app.get("/api/fixture/:id/predictions", requireConfig, requireAccess, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ ok: false, error: "ID partita non valido." });
  try {
    const data = await footballGet("/predictions", { fixture: req.params.id });
    res.json({ ok: true, response: data.response || [], errors: data.errors });
  } catch (err) {
    res.status(err.status || 502).json({ ok: false, error: err.message, details: err.details });
  }
});

app.get("/api/fixture/:id/odds", requireConfig, requireAccess, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ ok: false, error: "ID partita non valido." });
  try {
    const data = await footballGet("/odds", { fixture: req.params.id, page: req.query.page || 1 });
    res.json({ ok: true, response: data.response || [], errors: data.errors });
  } catch (err) {
    res.status(err.status || 502).json({ ok: false, error: err.message, details: err.details });
  }
});

app.use((err, req, res, next) => {
  console.error("Errore server:", err.message);
  res.status(500).json({ ok: false, error: "Errore interno del server." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Football Predictor API in ascolto sulla porta ${PORT}`);
});
