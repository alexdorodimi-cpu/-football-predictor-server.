const BASE_URL = (process.env.BASE_URL || "").replace(/\/$/, "");
const TOKEN = process.env.PREDICTOR_ACCESS_TOKEN || "";
const MATCH_ID = process.env.TEST_MATCH_ID || "";

if (!BASE_URL) {
  console.error("FAIL: BASE_URL non configurato.");
  process.exit(2);
}
if (!TOKEN) {
  console.error("FAIL: PREDICTOR_ACCESS_TOKEN non configurato.");
  process.exit(2);
}

let failures = 0;

async function request(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(30000)
  });

  const raw = await response.text();
  let body = null;
  try { body = raw ? JSON.parse(raw) : {}; } catch {}
  return { status: response.status, body };
}

function check(name, condition, detail = "") {
  if (condition) {
    console.log(`PASS  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}

async function run() {
  console.log(`Smoke test Football Predictor: ${BASE_URL}`);

  const status = await request("/api/status");
  check("server status HTTP 200", status.status === 200, `HTTP ${status.status}`);
  check("server status payload", status.body?.ok === true, "campo ok non true");
  check("PitchAPI configurata e raggiungibile", status.body?.providerConnected === true,
    "providerConnected non true");

  const auth = await request("/api/auth-diagnostic", {
    headers: { Authorization: `Bearer ${TOKEN}` }
  });
  check("diagnostica autenticazione HTTP 200", auth.status === 200, `HTTP ${auth.status}`);
  check("token accettato dal server", auth.body?.tokenMatchesServer === true,
    "tokenMatchesServer non true");

  const rejected = await request("/api/test-database", {
    headers: { Authorization: "Bearer token-di-test-non-valido" }
  });
  check("token errato rifiutato (HTTP 401)", rejected.status === 401,
    `atteso 401, ricevuto ${rejected.status}`);

  const provider = await request("/api/test-pitchapi", {
    headers: { Authorization: `Bearer ${TOKEN}` }
  });
  check("endpoint test PitchAPI", provider.status === 200 && provider.body?.connected === true,
    `HTTP ${provider.status}`);

  const database = await request("/api/test-database", {
    headers: { Authorization: `Bearer ${TOKEN}` }
  });
  check("connessione Supabase", database.status === 200 && database.body?.connected === true,
    `HTTP ${database.status}`);

  if (MATCH_ID) {
    const prediction = await request(
      `/api/fixture/${encodeURIComponent(MATCH_ID)}/predictions`,
      { headers: { Authorization: `Bearer ${TOKEN}` } }
    );
    check("endpoint pronostici", prediction.status === 200 && prediction.body?.ok === true,
      `HTTP ${prediction.status}; verificare che la partita sia sincronizzata in Supabase`);
    check("struttura pronostico", prediction.body?.probabilities != null &&
      prediction.body?.expected_goals != null && prediction.body?.reliability != null,
      "mancano probabilities, expected_goals o reliability");

    const reliabilityEntries = Object.values(prediction.body?.reliability || {});
    check("rating qualità dati con campioni reali",
      reliabilityEntries.length > 0 && reliabilityEntries.every(item =>
        Number.isFinite(Number(item?.score)) &&
        Number(item?.sample_size?.home) > 0 &&
        Number(item?.sample_size?.away) > 0 &&
        item?.components != null
      ),
      "rating incompleto o campioni casa/trasferta mancanti");
  } else {
    console.log("SKIP  test pronostico: TEST_MATCH_ID non configurato.");
  }

  const leagueId = process.env.TEST_LEAGUE_ID || "l_0ALvwF";
  const backtest = await request(
    `/api/backtest/${encodeURIComponent(leagueId)}?limit=10&season=2026%2F2027`,
    { headers: { Authorization: `Bearer ${TOKEN}` } }
  );
  check("endpoint backtest", backtest.status === 200 && backtest.body?.ok === true,
    `HTTP ${backtest.status}`);
  if (backtest.body?.advanced_metrics) {
    check("metriche avanzate backtest pubblicate", backtest.body.advanced_metrics?.["1X2"] != null &&
      backtest.body.advanced_metrics?.expected_goals_error != null &&
      backtest.body.advanced_metrics?.exact_score_top_1 != null,
      "risposta advanced_metrics incompleta");
  } else {
    console.log("INFO  metriche avanzate non ancora presenti sul Render live: saranno disponibili dopo il merge e il deploy della pull request.");
  }

  console.log(`\nRisultato: ${failures === 0 ? "TUTTI I TEST SUPERATI" : `${failures} TEST FALLITI`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run().catch((error) => {
  // Non stampare header o variabili d'ambiente: possono contenere credenziali.
  console.error("FAIL: errore durante i test:", error.name, error.message);
  process.exitCode = 1;
});
