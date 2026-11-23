const baseUrl = String(process.env.BASE_URL || "").replace(/\/$/, "");
const token = String(process.env.PREDICTOR_ACCESS_TOKEN || "");
const onlyLeague = String(process.env.LEAGUE_ID || "").trim();
const pauseMs = Math.max(150, Number(process.env.REQUEST_PAUSE_MS) || 300);

if (!baseUrl || !token) throw new Error("BASE_URL e PREDICTOR_ACCESS_TOKEN sono obbligatori.");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function request(path, method = "GET") {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`
    },
    signal: AbortSignal.timeout(120000)
  });
  const raw = await response.text();
  let body;
  try { body = raw ? JSON.parse(raw) : {}; } catch {
    throw new Error(`Risposta non JSON HTTP ${response.status}`);
  }
  if (!response.ok || body.ok === false) {
    throw new Error(`HTTP ${response.status}: ${String(body.error || raw).slice(0, 500)}`);
  }
  return body;
}

async function main() {
  const catalogue = await request("/api/leagues");
  const leagues = catalogue?.response?.data?.leagues ||
    catalogue?.response?.leagues || [];
  if (!Array.isArray(leagues) || !leagues.length) {
    throw new Error("PitchAPI non ha restituito l'elenco dei campionati.");
  }

  const selected = onlyLeague
    ? leagues.filter(league => String(league.id) === onlyLeague)
    : leagues;
  if (!selected.length) throw new Error("Campionato richiesto non presente nel catalogo.");

  const summary = {
    started_at: new Date().toISOString(),
    leagues_available: leagues.length,
    leagues_selected: selected.length,
    leagues_completed: 0,
    leagues_failed: 0,
    seasons_imported: 0,
    received_matches: 0,
    upserted_rows: 0,
    failures: []
  };

  for (const league of selected) {
    try {
      const result = await request(
        `/api/sync/league/${encodeURIComponent(league.id)}/history`,
        "POST"
      );
      summary.leagues_completed++;
      summary.seasons_imported += Number(result.seasons_imported || 0);
      summary.received_matches += Number(result.received_matches || 0);
      summary.upserted_rows += Number(result.upserted_rows || 0);
      console.log(JSON.stringify({
        league: league.name,
        id: league.id,
        seasons: result.seasons_imported,
        received: result.received_matches,
        upserted: result.upserted_rows
      }));
    } catch (error) {
      summary.leagues_failed++;
      summary.failures.push({ league: league.name, id: league.id, error: error.message });
      console.error(`IMPORT ERROR ${league.name} (${league.id}): ${error.message}`);
    }
    await sleep(pauseMs);
  }

  summary.finished_at = new Date().toISOString();
  console.log("IMPORT SUMMARY");
  console.log(JSON.stringify(summary, null, 2));
  if (summary.leagues_completed === 0) process.exitCode = 1;
}

main().catch(error => {
  console.error("Historical import failed:", error.message);
  process.exitCode = 1;
});
