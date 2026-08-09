/**
 * stock-dash equity data proxy
 *
 * Holds the Finnhub key server-side so the dashboard — a public static page —
 * never ships a credential. Also caches aggressively, because Finnhub's free
 * tier is 60 calls/min and a dashboard polling on an interval will burn that
 * fast with several symbols in the watchlist.
 *
 * Routes:
 *   /news?symbol=TSLA      company news, newest first
 *   /earnings?symbol=TSLA  next scheduled earnings (date + amc/bmo)
 *   /quote?symbol=TSLA     live cash quote for the underlying
 *   /status                US market status incl. holiday
 */

const FINNHUB = "https://finnhub.io/api/v1";

// Only these origins may call the worker. A public URL with a key behind it
// is an open proxy otherwise.
const ALLOWED_ORIGINS = [
  "https://bluewinsg.github.io",
  "http://localhost:8765",
  "http://127.0.0.1:8765"
];

// seconds
const TTL = { news: 120, earnings: 3600, quote: 30, status: 60 };

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}

function json(body, origin, ttl) {
  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${ttl}`,
      ...corsHeaders(origin)
    }
  });
}

function err(status, message, origin) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) }
  });
}

// Binance perp symbols carry a quote-asset suffix the equity APIs don't know
// about: SPCXUSDT -> SPCX, SPCXUSD1 -> SPCX.
function toTicker(raw) {
  return (raw || "").toUpperCase().replace(/(USDT|USD1|USDC)$/, "");
}

// Reject anything that isn't a plausible ticker before it reaches Finnhub.
function validTicker(t) {
  return /^[A-Z][A-Z.\-]{0,9}$/.test(t);
}

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

async function fetchFinnhub(path, env) {
  const url = `${FINNHUB}/${path}${path.includes("?") ? "&" : "?"}token=${env.FINNHUB_KEY}`;
  const r = await fetch(url, { cf: { cacheTtl: 30, cacheEverything: true } });
  if (!r.ok) throw new Error(`finnhub ${r.status}`);
  return r.json();
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "GET") return err(405, "GET only", origin);
    if (!env.FINNHUB_KEY) return err(500, "FINNHUB_KEY secret not set on the worker", origin);

    // Serve from the edge cache when we can — keeps us inside the free tier.
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    const route = url.pathname.replace(/\/+$/, "") || "/";
    const ticker = toTicker(url.searchParams.get("symbol"));

    try {
      let body, ttl;

      if (route === "/status") {
        body = await fetchFinnhub("stock/market-status?exchange=US", env);
        ttl = TTL.status;

      } else if (route === "/news") {
        if (!validTicker(ticker)) return err(400, "bad symbol", origin);
        const to = new Date();
        const from = new Date(to.getTime() - 7 * 864e5);
        const raw = await fetchFinnhub(
          `company-news?symbol=${ticker}&from=${ymd(from)}&to=${ymd(to)}`, env);
        body = {
          symbol: ticker,
          articles: (raw || []).slice(0, 40).map(a => ({
            t: a.datetime, headline: a.headline, source: a.source,
            url: a.url, summary: (a.summary || "").slice(0, 300)
          }))
        };
        ttl = TTL.news;

      } else if (route === "/earnings") {
        if (!validTicker(ticker)) return err(400, "bad symbol", origin);
        const from = new Date();
        const to = new Date(from.getTime() + 200 * 864e5);
        const raw = await fetchFinnhub(
          `calendar/earnings?symbol=${ticker}&from=${ymd(from)}&to=${ymd(to)}`, env);
        const list = ((raw && raw.earningsCalendar) || [])
          .slice()
          .sort((a, b) => a.date.localeCompare(b.date));
        body = { symbol: ticker, next: list[0] || null, upcoming: list.slice(0, 4) };
        ttl = TTL.earnings;

      } else if (route === "/quote") {
        if (!validTicker(ticker)) return err(400, "bad symbol", origin);
        const q = await fetchFinnhub(`quote?symbol=${ticker}`, env);
        body = { symbol: ticker, price: q.c, change: q.d, changePct: q.dp,
                 high: q.h, low: q.l, open: q.o, prevClose: q.pc, t: q.t };
        ttl = TTL.quote;

      } else {
        return err(404, "routes: /news /earnings /quote /status", origin);
      }

      const res = json(body, origin, ttl);
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return res;

    } catch (e) {
      return err(502, String(e.message || e), origin);
    }
  }
};
