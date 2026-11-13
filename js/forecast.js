// Price forecast: an ensemble of trend, momentum, mean-reversion and volume signals,
// projected forward with a volatility cone. Also back-tests its own direction calls.
import { ema, rsi, macd, bollinger, stdev, slopeAt } from './indicators.js';

const W = {
  trend: 0.22, longTrend: 0.15, macd: 0.18, rsi: 0.12, regression: 0.15, momentum: 0.10, bands: 0.08, volume: 0.10,
};
const LABELS = {
  trend: 'Trend (EMA 20/50)', longTrend: 'Long trend (EMA 200)', macd: 'MACD momentum', rsi: 'RSI',
  regression: 'Regression slope', momentum: 'Rate of change', bands: 'Bollinger position', volume: 'Volume pressure',
};

function prepare(candles) {
  const c = candles.map((x) => x.close);
  const lc = c.map(Math.log);
  const r = lc.map((x, i) => (i ? x - lc[i - 1] : 0));
  return {
    candles, c, lc,
    sd: stdev(r, 50),
    e20: ema(c, 20), e50: ema(c, 50), e200: ema(c, 200),
    rsi: rsi(c, 14), macd: macd(c), bb: bollinger(c, 20, 2),
  };
}

const clamp = (x, a = -1, b = 1) => Math.max(a, Math.min(b, x));
const ok = (x) => Number.isFinite(x);

function scoreAt(P, i) {
  const { c, lc, candles } = P;
  const sd = P.sd[i] || 0.01;
  const s = {};
  if (ok(P.e20[i]) && ok(P.e50[i])) s.trend = Math.tanh((P.e20[i] - P.e50[i]) / P.e50[i] / (sd * Math.sqrt(20)));
  if (ok(P.e200[i])) s.longTrend = Math.tanh((c[i] - P.e200[i]) / P.e200[i] / (sd * Math.sqrt(100)));
  if (ok(P.macd.hist[i])) s.macd = Math.tanh(P.macd.hist[i] / (c[i] * sd));
  const R = P.rsi[i];
  if (ok(R)) s.rsi = R > 70 ? -(R - 70) / 30 : R < 30 ? (30 - R) / 30 : (R - 50) / 40;
  const sl = i >= 30 ? slopeAt(lc, i, 30) : NaN;
  if (ok(sl)) s.regression = Math.tanh((sl * Math.sqrt(30)) / sd / 2);
  if (i >= 10) s.momentum = Math.tanh((lc[i] - lc[i - 10]) / (sd * Math.sqrt(10)) / 1.5);
  const up = P.bb.upper[i], lo = P.bb.lower[i];
  if (ok(up) && up > lo) s.bands = clamp((0.5 - (c[i] - lo) / (up - lo)) * 1.2);
  if (i >= 20) {
    let pv = 0, tv = 0;
    for (let k = i - 19; k <= i; k++) {
      const v = candles[k].volume || 0;
      pv += v * Math.sign(candles[k].close - candles[k].open); tv += v;
    }
    if (tv > 0) s.volume = clamp((pv / tv) * 1.5);
  }
  let num = 0, den = 0;
  for (const k in s) { num += W[k] * s[k]; den += W[k]; }
  return { score: den ? num / den : 0, signals: s, sd };
}

export function verdictOf(score) {
  if (score > 0.35) return { text: 'Strong bullish', cls: 'up' };
  if (score > 0.1) return { text: 'Bullish', cls: 'up' };
  if (score < -0.35) return { text: 'Strong bearish', cls: 'down' };
  if (score < -0.1) return { text: 'Bearish', cls: 'down' };
  return { text: 'Neutral', cls: '' };
}

export function forecast(candles, horizon, intervalSec) {
  if (candles.length < 60) return null;
  const P = prepare(candles);
  const n = candles.length - 1;
  const { score, signals, sd } = scoreAt(P, n);
  const pUp = clamp(0.5 + 0.3 * score, 0.2, 0.8);
  const mu = score * sd * 0.12; // per-bar log drift
  const last = candles[n];
  const path = [];
  for (let h = 0; h <= horizon; h++) {
    const m = Math.log(last.close) + mu * h;
    const v = sd * Math.sqrt(h);
    path.push({
      time: last.time + h * intervalSec,
      mid: Math.exp(m), u1: Math.exp(m + v), l1: Math.exp(m - v), u2: Math.exp(m + 2 * v), l2: Math.exp(m - 2 * v),
    });
  }

  // Back-test the direction call over the last ~400 bars
  let hits = 0, calls = 0;
  const from = Math.max(60, n - horizon - 400);
  for (let i = from; i <= n - horizon; i += 2) {
    const sc = scoreAt(P, i).score;
    if (Math.abs(sc) < 0.05) continue;
    const realized = P.c[i + horizon] - P.c[i];
    if (realized === 0) continue;
    calls++;
    if (Math.sign(realized) === Math.sign(sc)) hits++;
  }

  return {
    score, pUp, path, end: path[path.length - 1],
    verdict: verdictOf(score),
    signals: Object.entries(signals).map(([k, v]) => ({ key: k, label: LABELS[k], value: v, weight: W[k] })),
    hitRate: calls ? hits / calls : null, calls,
  };
}
