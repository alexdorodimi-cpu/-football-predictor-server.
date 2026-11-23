const baseUrl = String(process.env.BASE_URL || "").replace(/\/$/, "");
const token = String(process.env.PREDICTOR_ACCESS_TOKEN || "");
const leagueId = String(process.env.LEAGUE_ID || "l_0ALvwF");
const batchSize = Math.min(100, Math.max(10, Number(process.env.BATCH_SIZE) || 50));
const pauseMs = Math.max(0, Number(process.env.REQUEST_PAUSE_MS) || 500);

if (!baseUrl || !token) throw new Error("BASE_URL e PREDICTOR_ACCESS_TOKEN sono obbligatori.");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(offset) {
  const url = new URL(`${baseUrl}/api/sync/league/${encodeURIComponent(leagueId)}/statistics`);
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("batch_size", String(batchSize));
  const response = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(180000)
  });
  const raw = await response.text();
  let body;
  try { body = JSON.parse(raw); }
  catch { throw new Error(`Offset ${offset}: HTTP ${response.status}, risposta non JSON: ${raw.slice(0,300)}`); }
  if (!response.ok || body.ok !== true) throw new Error(`Offset ${offset}: HTTP ${response.status}: ${body.error || raw.slice(0,300)}`);
  return body;
}

async function main() {
  let offset = Math.max(0, Number(process.env.START_OFFSET) || 0);
  let totalSelected = 0, totalSaved = 0, totalFailed = 0, batches = 0;
  while (true) {
    let result;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try { result = await request(offset); break; }
      catch (error) {
        console.error(`Batch offset ${offset}, tentativo ${attempt}/4: ${error.message}`);
        if (attempt === 4) throw error;
        await sleep(attempt * 5000);
      }
    }
    batches++;
    totalSelected += result.matches_selected;
    totalSaved += result.statistics_saved;
    totalFailed += result.failed;
    console.log(JSON.stringify({
      league_id: leagueId, batch: batches, offset,
      matches_selected: result.matches_selected,
      statistics_saved: result.statistics_saved,
      failed: result.failed,
      next_offset: result.next_offset,
      done: result.done
    }));
    if (result.failed) console.error("Dettagli errori batch:", JSON.stringify(result.failures));
    if (result.done || result.matches_selected === 0) break;
    offset = result.next_offset;
    await sleep(pauseMs);
  }
  console.log(JSON.stringify({
    summary: true, league_id: leagueId, batches,
    matches_selected: totalSelected, statistics_saved: totalSaved,
    failed: totalFailed, completed_at: new Date().toISOString()
  }));
  if (totalFailed) throw new Error(`Import statistiche terminato con ${totalFailed} partite non recuperate. Rieseguire dal punto di controllo.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
