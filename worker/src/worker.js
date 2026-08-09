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

// seconds. Finnhub's free tier is 60 calls/min, and the edge cache is
// per-colo, so a few viewers in different regions multiply the upstream
// call rate. These are deliberately generous — none of this data is
// tick-by-tick, and the Binance side of the dashboard is what needs to be live.
const TTL = { news: 300, earnings: 21600, quote: 60, status: 300 };

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

class RateLimited extends Error {}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchFinnhub(path, env) {
  const url = `${FINNHUB}/${path}${path.includes("?") ? "&" : "?"}token=${env.FINNHUB_KEY}`;

  // 429s on the free tier are common and usually transient — a short backoff
  // clears them far more often than it fails. Two tries, then give up and let
  // the caller decide how to degrade.
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, { cf: { cacheTtl: 60, cacheEverything: true } });
    if (r.ok) return r.json();
    if (r.status === 429) {
      if (attempt < 2) { await sleep(400 * (attempt + 1)); continue; }
      throw new RateLimited("finnhub rate limit");
    }
    throw new Error(`finnhub ${r.status}`);
  }
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
      // Rate limiting is an expected state on the free tier, not a fault.
      // Report it distinctly so the dashboard can say "retrying" rather than
      // showing the user a broken panel.
      if (e instanceof RateLimited) {
        return new Response(
          JSON.stringify({ error: "rate limited", retry: true }),
          { status: 429,
            headers: { "Content-Type": "application/json",
                       "Retry-After": "30", ...corsHeaders(origin) } });
      }
      return err(502, String(e.message || e), origin);
    }
  }
};
