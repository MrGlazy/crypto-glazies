# Glazies Crypto — BTC position tracker

Live site: **https://crypto.glazzy.site**

A static website (HTML/CSS/JS, no server needed) that:

- Shows a live, detailed BTC chart from **Hyperliquid** (falls back to Binance): 1m → 1W timeframes, candles / Heikin Ashi / bars / line / area, log scale, screenshot, fullscreen.
- Indicators: Volume, EMA 20/50/200, SMA 100, Bollinger Bands, rolling VWAP, RSI and MACD panels.
- Lets you log **spot buys** and **Hyperliquid long/short** positions (where, how much, when, price, leverage, isolated/cross, TP/SL, notes) — plotted on the chart as markers plus entry / TP / SL lines.
- Calculates the **liquidation price** with Hyperliquid's formula (maintenance margin = ½ of initial margin at max leverage, 40x for BTC), and shows margin, fees, hourly funding, live PnL / ROE and distance to liquidation.
- **Forecast**: an ensemble of 8 signals (trend, long trend, MACD, RSI, regression slope, rate of change, Bollinger position, volume pressure) → bullish/bearish verdict, probability, projected path with 68% / 95% volatility cone, and a back-tested hit rate.
- Price alert lines (browser notifications), near-liquidation warnings, "what if BTC = X" scenario, closed-trade history with realized PnL, JSON/CSV export and import, light/dark theme, mobile layout.
- **AI Predictor** (`js/ml.js`, runs in a Web Worker): a ridge regression over 23 market features plus a pattern matcher (k-nearest neighbours over similar past setups), retrained in the browser on up to 5,000 candles. **Predictions** tab: chance of BTC being up, expected price and 68% / 95% ranges for the next hour (15m candles), day (1h) and week (4h), with the main drivers and an out-of-sample track record. **Backtest** tab: walk-forward replay (the model only sees data known at each moment), accuracy vs coin-flip / always-up / momentum baselines, a significance check, and a long/short strategy with fees vs buy & hold.

### Accounts
Anyone can **create an account** (email + password). Signed-in users' positions are stored on the server and sync across devices; guests keep positions in the browser. A **Stats** tab shows win rate, profit factor, average win/loss, best/worst trade, hold time, streak, a cumulative PnL curve and a monthly breakdown.

The account API is plain PHP 8.1+ with SQLite (`api/`). The database lives in a private folder **outside** the website (`../../glazies-crypto-data/`, next to `public_html`), so deploys never touch it. To use MySQL instead, create `api/config.local.php` on the server:

```php
<?php return ['dsn' => 'mysql:host=localhost;dbname=DBNAME;charset=utf8mb4', 'user' => 'DBUSER', 'pass' => 'DBPASS'];
```

Passwords are hashed with `password_hash`, sessions are HttpOnly cookies, and login attempts are rate-limited.

## Deploy

Every push to `main` uploads the site to Hostinger via FTP (`.github/workflows/deploy.yml`).
Set these in GitHub → Settings → Secrets and variables → Actions:

| Name | Type | Value |
|---|---|---|
| `FTP_SERVER` | secret | FTP host from hPanel → Files → FTP Accounts (e.g. `ftp.glazzy.site`) |
| `FTP_USERNAME` | secret | FTP username |
| `FTP_PASSWORD` | secret | FTP password |
| `FTP_SERVER_DIR` | variable (optional) | Subdomain folder, default `public_html/crypto/` |

## Run locally

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

Charts: TradingView Lightweight Charts™ (Apache-2.0), vendored in `vendor/`.
