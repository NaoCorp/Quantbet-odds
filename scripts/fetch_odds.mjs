import fs from "node:fs";

const rawKey = (process.env.ODDS_API_KEY || "").trim();
const match32 = rawKey.match(/[a-f0-9]{32}/i);
const API_KEY = (match32 ? match32[0] : "").toLowerCase();

if (API_KEY.length !== 32) {
  console.error("ERROR: El secreto ODDS_API_KEY no tiene 32 caracteres hexadecimales.");
  process.exit(1);
}

// 6 ligas principales x 2 mercados = 12 créditos por ejecución (~360/mes)
const WATCHLIST = [
  { key: "soccer_epl", markets: "h2h,totals" },
  { key: "soccer_spain_la_liga", markets: "h2h,totals" },
  { key: "soccer_italy_serie_a", markets: "h2h,totals" },
  { key: "soccer_uefa_champs_league", markets: "h2h,totals" },
  { key: "soccer_conmebol_copa_libertadores", markets: "h2h,totals" },
  { key: "basketball_nba", markets: "h2h,totals" },
];

const BOOKMAKER_PRIORITY = [
  "pinnacle",
  "betsson",
  "coolbet",
  "onexbet",
  "williamhill",
  "marathonbet",
  "unibet_eu",
  "betfair_ex_eu",
  "nordicbet",
];

const REQUEST_HEADERS = {
  Accept: "application/json",
  "User-Agent": "QuantBet-Sync/1.0",
};

function sortBookmakers(bookmakers = []) {
  return [...bookmakers]
    .sort((a, b) => {
      const ia = BOOKMAKER_PRIORITY.indexOf(a.key);
      const ib = BOOKMAKER_PRIORITY.indexOf(b.key);
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    })
    .slice(0, 6)
    .map((b) => ({
      key: b.key,
      title: b.title,
      last_update: b.last_update,
      markets: (b.markets || []).map((m) => ({
        key: m.key,
        outcomes: m.outcomes || [],
      })),
    }));
}

async function safeFetch(url) {
  try {
    return await fetch(url, { headers: REQUEST_HEADERS });
  } catch {
    // Evita imprimir la URL con la API key en caso de error de red
    throw new Error("Fallo de conexión de red al consultar el proveedor.");
  }
}

async function run() {
  const now = new Date();
  const minTime = now.getTime() - 15 * 60 * 1000;
  const maxTime = now.getTime() + 72 * 60 * 60 * 1000;

  const errors = [];
  const allEvents = [];
  let creditsRemaining = null;
  let creditsUsed = null;

  const sportsRes = await safeFetch(
    `https://api.the-odds-api.com/v4/sports/?apiKey=${API_KEY}`
  );

  if (!sportsRes.ok) {
    errors.push(`sports HTTP ${sportsRes.status}`);
  } else {
    const activeSports = await sportsRes.json();
    const activeKeys = new Set(
      activeSports.filter((s) => s.active).map((s) => s.key)
    );

    for (const item of WATCHLIST) {
      if (!activeKeys.has(item.key)) continue;

      if (creditsRemaining !== null && creditsRemaining < 20) {
        errors.push("Freno de seguridad: menos de 20 créditos restantes.");
        break;
      }

      const url =
        `https://api.the-odds-api.com/v4/sports/${item.key}/odds/` +
        `?apiKey=${API_KEY}` +
        `&regions=eu` +
        `&markets=${item.markets}` +
        `&oddsFormat=decimal`;

      const res = await safeFetch(url);
      const remHeader = res.headers.get("x-requests-remaining");
      const usedHeader = res.headers.get("x-requests-used");
      if (remHeader !== null) creditsRemaining = Number(remHeader);
      if (usedHeader !== null) creditsUsed = Number(usedHeader);

      if (!res.ok) {
        let code = `HTTP ${res.status}`;
        try {
          const body = await res.json();
          if (body?.error_code) code += ` (${body.error_code})`;
        } catch {}
        errors.push(`${item.key}: ${code}`);
        continue;
      }

      const events = await res.json();
      for (const ev of events) {
        const startMs = Date.parse(ev.commence_time);
        if (
          Number.isFinite(startMs) &&
          (startMs < minTime || startMs > maxTime)
        ) {
          continue;
        }
        allEvents.push({
          id: ev.id,
          sport_key: ev.sport_key,
          sport_title: ev.sport_title,
          commence_time: ev.commence_time,
          home_team: ev.home_team,
          away_team: ev.away_team,
          bookmakers: sortBookmakers(ev.bookmakers),
        });
      }
    }
  }

  const output = {
    updated_at: now.toISOString(),
    window_hours: 72,
    total_events: allEvents.length,
    credits_remaining: creditsRemaining,
    credits_used: creditsUsed,
    errors,
    events: allEvents,
  };

  fs.writeFileSync("odds.json", JSON.stringify(output, null, 2), "utf8");
  console.log(
    `Finalizado -> Eventos: ${allEvents.length} | Créditos restantes: ${creditsRemaining} | Errores: ${errors.length}`
  );
}

run().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
