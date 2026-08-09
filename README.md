# stock-dash

Day-trading console for **Binance TradFi equity perpetuals** — the USDT-margined perps on US
stocks and ETFs (`SPCXUSDT`, `TSLAUSDT`, `NVDAUSDT`, `QQQUSDT`, …), not US equities themselves.

Single `index.html`. No build, no dependencies, no API keys. All data comes from Binance's
public `fapi` endpoints, which serve `access-control-allow-origin: *`, so it runs as a static
page with no proxy.

**Read-only by design — there is no order entry.**

## Why this isn't a crypto dashboard with different tickers

Equity perps behave differently from crypto perps in three ways the panels are built around:

| | Crypto perp | TradFi equity perp |
|---|---|---|
| Index price | live 24/7 | **frozen while the cash market is closed** |
| Mark price off-hours | spot-driven | EWMA-smoothed, drifts from contract price |
| Real risk window | continuous | 09:30 ET open gap, earnings, halts |
| Leverage | 20x–125x | 10x–25x by symbol |

Liquidity is the binding constraint. Median 24h volume across the ~135 listed equity perps is
under $1M, and most cannot absorb a leveraged position without walking the book.

## Panels

- **Session clock** — SGT + ET, holiday and half-day aware, with an explicit `INDEX FROZEN` badge
- **Position & liquidation** — isolated/cross liq price, distance expressed in **ATR multiples**
- **Portfolio heat** — checks margin-per-trade × max-concurrent against account size
- **Basis monitor** — (mark − index) ÷ index with a z-score against ~500h of that symbol's own premium history
- **Open-gap board** — how far each perp has drifted from the last cash print
- **Depth & slippage** — walks the live book for your actual notional; flags when position > visible depth
- **Volatility & survivability** — how many of the last 90 sessions had an intraday range exceeding your liquidation distance
- **Funding & OI** — 8h funding as a share of *your* margin, OI delta, long/short account ratio
- **Liquidity gate** — classifies every equity perp against your position size

## Catalysts and news (optional)

Two sources, because "news" is two different problems.

**Scheduled — what you can see coming.** `macro-2026.json` holds high-impact US macro releases
with dates taken from the primary publishers (BLS schedule pages for CPI/PPI/Employment Situation,
the Fed for FOMC). Weekly jobless claims are generated in code. Add rows to that file and the
dashboard picks them up with no code change. This needs no key and works out of the box.

**Unscheduled + per-symbol.** Company news and earnings dates come from Finnhub via a Cloudflare
Worker in `worker/`. The Worker exists so the API key stays server-side — a key in client-side
code on a public Pages site is readable by anyone.

### Deploying the worker

```
cd worker
npx wrangler login
npx wrangler secret put FINNHUB_KEY      # prompts; paste the key here, never in a file
npx wrangler deploy
```

Then paste the resulting `https://stock-dash-api.<you>.workers.dev` URL into the News panel.
It persists to `localStorage`. Until it is set, the macro calendar still works and the news
panel shows setup instructions.

Routes: `/news?symbol=` · `/earnings?symbol=` · `/quote?symbol=` · `/status`.
Responses are edge-cached (news 120s, earnings 1h, quote 30s) to stay inside Finnhub's free tier,
and CORS is restricted to the Pages origin so the Worker isn't an open proxy.

Binance symbols are mapped to tickers automatically (`SPCXUSDT` → `SPCX`).

### The warning band

The point of the catalyst data is not a headline list — it's a banner on the position panel that
combines a scheduled event with *your* actual exposure:

> **NVDA earnings in 4d 6h** (amc). It prints after the 16:00 ET close, when the cash index is
> frozen but the perp keeps trading. You are LONG 20x on NVDA, liq 4.00% away. Largest single-day
> range in the last 90 sessions: X%.

`amc` earnings are called out specifically: they land while the cash market is shut, so the perp
reprices against a frozen index with no open to wait for and no circuit breaker.

## Configuration

Account size, margin per trade, leverage, MMR and max concurrent positions are set in the UI and
persist to `localStorage`.

Set **MMR** from the real risk-limit tier for each symbol (Binance Futures → leverage slider →
Risk Limit). The 1.0% default is a placeholder; the tier value makes the liquidation price exact.

## Endpoints used

`exchangeInfo` · `premiumIndex` · `ticker/24hr` · `ticker/bookTicker` · `depth` · `klines` ·
`premiumIndexKlines` · `futures/data/openInterestHist` · `futures/data/globalLongShortAccountRatio`

## Notes

Not investment advice. Leveraged perpetuals can lose the full position margin, and at high
leverage the liquidation price is often inside a single session's normal range — which is
precisely what the survivability panel is there to show you.
