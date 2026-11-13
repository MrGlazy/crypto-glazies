// Heavy version of the site's AI predictor, meant to run on a NAS / server.
// Same models as js/ml.js, but trained on far more history (years of Binance candles
// instead of the ~5,000 the browser gets from Hyperliquid). Works in Node 18+ and browsers.
import { HORIZONS, predictNow, backtest } from '../js/ml.js';

// How much history to pull per horizon, and how many samples to train on.
export const DEPTH = {
  '1h': { bars: 20000, window: 15000 }, // 15m candles ≈ 7 months
  '1d': { bars: 20000, window: 15000 }, // 1h candles  ≈ 2.3 years
  '1w': { bars: 12000, window: 10000 }, // 4h candles  ≈ 5.5 years
};
const MODELS = ['ensemble', 'ridge', 'knn'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Every request in this module gets a hard 60 s timeout, so a stalled connection can never freeze the runner.
const fetch = (url, opts = {}) => globalThis.fetch(url, { signal: AbortSignal.timeout(60e3), ...opts });
const mapBN = (k) => ({ time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] });
const mapHL = (c) => ({ time: Math.floor(c.t / 1000), open: +c.o, high: +c.h, low: +c.l, close: +c.c, volume: +c.v });

async function binance(interval, bars) {
  let end = Date.now(), all = [];
  while (all.length < bars) {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=1000&endTime=${end}`);
    if (!r.ok) throw new Error(`Binance ${r.status}`);
    const k = await r.json();
    if (!k.length) break;
    all = k.map(mapBN).concat(all);
    end = k[0][0] - 1;
    if (k.length < 1000) break;
    await sleep(150); // be polite to the API
  }
  return all;
}

async function hyperliquid(body) {
  const r = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Hyperliquid ${r.status}`);
  return r.json();
}

export async function candles(hKey) {
  const H = HORIZONS[hKey], D = DEPTH[hKey];
  let rows, source;
  try {
    rows = await binance(H.interval, D.bars); source = 'binance';
    if (rows.length < 3000) throw new Error('short history');
  } catch {
    const now = Date.now();
    rows = (await hyperliquid({ type: 'candleSnapshot', req: { coin: 'BTC', interval: H.interval, startTime: now - H.barSec * 1000 * 5000, endTime: now } })).map(mapHL);
    source = 'hyperliquid';
  }
  const m = new Map();
  for (const r of rows) m.set(r.time, r);
  rows = [...m.values()].sort((a, b) => a.time - b.time);
  if (rows.length && rows[rows.length - 1].time + H.barSec > Date.now() / 1000) rows = rows.slice(0, -1); // unfinished candle
  return { rows, source };
}

export async function livePrice() {
  try {
    const [meta, ctxs] = await hyperliquid({ type: 'metaAndAssetCtxs' });
    const i = meta.universe.findIndex((u) => u.name === 'BTC');
    return +ctxs[i].markPx;
  } catch { return null; }
}

/** Slim the backtest down to what the website shows. */
const slimBt = (b) => ({
  n: b.n, from: b.from, to: b.to, acc: b.acc, accBy: b.accBy, zScore: b.zScore, significant: b.significant,
  band68: b.band68, band95: b.band95, mae: b.mae, maeNaive: b.maeNaive,
  strategy: { ret: b.strategy.ret, hold: b.strategy.hold, mdd: b.strategy.mdd, trades: b.strategy.trades, winRate: b.strategy.winRate },
});

/**
 * Compute predictions for every horizon (and every model).
 * `prev` = previous payload: its backtests are reused unless `withBacktest` is set.
 */
export async function computeAll({ withBacktest = true, prev = null, log = () => {} } = {}) {
  const anchor = await livePrice();
  const out = { version: 1, generated: Date.now(), price: anchor, horizons: {} };
  for (const hKey of Object.keys(HORIZONS)) {
    const t0 = Date.now();
    const { rows, source } = await candles(hKey);
    const D = DEPTH[hKey];
    const preds = {};
    for (const model of MODELS) preds[model] = predictNow(rows, hKey, { model, window: D.window, anchor: anchor || rows[rows.length - 1].close });
    let bt = prev?.horizons?.[hKey]?.backtest || null;
    if (withBacktest || !bt) {
      bt = slimBt(backtest(rows, hKey, { model: 'ensemble', testFrac: 0.3, window: D.window, retrain: Math.max(HORIZONS[hKey].h, 48) }));
      bt.computed = Date.now();
    }
    out.horizons[hKey] = { source, candles: rows.length, preds, backtest: bt };
    log(`${hKey}: ${rows.length} ${source} candles, ${preds.ensemble.pUp.toFixed(3)} up, backtest ${(bt.acc * 100).toFixed(1)}% (${Math.round((Date.now() - t0) / 1000)}s)`);
  }
  return out;
}

/** Pause switch set from the website (AI Predictor card → Pause). Unknown → treat as running. */
export async function isPaused(siteUrl) {
  try {
    const r = await fetch(`${siteUrl.replace(/\/$/, '')}/api/predictions.php`, { headers: { 'X-Glazies': '1' } });
    return !!(await r.json())?.control?.paused;
  } catch { return false; }
}

export async function upload(siteUrl, token, payload) {
  const r = await fetch(`${siteUrl.replace(/\/$/, '')}/api/predictions.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Glazies': '1', Authorization: `Bearer ${token}`, 'X-Upload-Token': token },
    body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.error || `Upload failed (${r.status})`);
  return j;
}
