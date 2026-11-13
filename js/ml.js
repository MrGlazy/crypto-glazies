// AI price predictor: two machine-learning models trained in the browser on past candles.
//  - Ridge regression on ~23 market features (momentum, trend, volatility, volume, time of day…)
//  - Pattern matching (k-nearest neighbours): finds the most similar past setups and looks at
//    what price did next.
// The ensemble averages both. Everything here is pure (no DOM) so it also runs in a Web Worker.
//
// Targets are volatility-normalised: y = log(P[t+h] / P[t]) / (σ20 · √h), which keeps the
// problem comparable across calm and wild markets. Walk-forward back-testing only ever trains on
// samples whose outcome was already known at prediction time (no look-ahead).

import { ema, rsi, macd, bollinger } from './indicators.js';

export const HORIZONS = {
  '1h': { key: '1h', label: 'Next hour', span: '1 hour', interval: '15m', barSec: 900, h: 4 },
  '1d': { key: '1d', label: 'Next day', span: '1 day', interval: '1h', barSec: 3600, h: 24 },
  '1w': { key: '1w', label: 'Next week', span: '1 week', interval: '4h', barSec: 14400, h: 42 },
};

export const FEATURES = [
  ['ret1', 'Last candle move'], ['ret4', 'Move over 4 candles'], ['ret12', 'Move over 12 candles'],
  ['ret24', 'Move over 24 candles'], ['ret72', 'Move over 72 candles'], ['ret168', 'Move over 168 candles'],
  ['volRegime', 'Volatility vs normal'], ['rsi', 'RSI 14'], ['macd', 'MACD histogram'], ['bb', 'Bollinger position'],
  ['ema20', 'Distance from EMA 20'], ['ema50', 'Distance from EMA 50'], ['ema200', 'Distance from EMA 200'],
  ['volZ', 'Volume vs normal'], ['volPress', 'Buy / sell volume pressure'], ['range', 'Candle range'],
  ['closeLoc', 'Close within candle'], ['hourSin', 'Time of day'], ['hourCos', 'Time of day'],
  ['dowSin', 'Day of week'], ['dowCos', 'Day of week'], ['fromHigh', 'Distance from 50-candle high'],
  ['fromLow', 'Distance from 50-candle low'],
];
const NF = FEATURES.length;
const START = 210; // enough history for EMA 200 and 168-bar returns

const clip = (x, a = 5) => (x > a ? a : x < -a ? -a : x);
const fin = Number.isFinite;

/* ------------------------------------------------------------------ */
/* Features                                                            */
/* ------------------------------------------------------------------ */
function rollStd(r, n) {
  const out = new Float64Array(r.length).fill(NaN);
  let s = 0, s2 = 0;
  for (let i = 0; i < r.length; i++) {
    s += r[i]; s2 += r[i] * r[i];
    if (i >= n) { s -= r[i - n]; s2 -= r[i - n] * r[i - n]; }
    if (i >= n - 1) out[i] = Math.sqrt(Math.max(s2 / n - (s / n) ** 2, 1e-12));
  }
  return out;
}

export function buildFeatures(candles, h) {
  const n = candles.length;
  const c = candles.map((x) => x.close);
  const lc = c.map(Math.log);
  const r = lc.map((x, i) => (i ? x - lc[i - 1] : 0));
  const sd20 = rollStd(r, 20), sd100 = rollStd(r, 100);
  const e20 = ema(c, 20), e50 = ema(c, 50), e200 = ema(c, 200);
  const R = rsi(c, 14), M = macd(c), B = bollinger(c, 20, 2);
  const lv = candles.map((x) => Math.log((x.volume || 0) + 1));

  const X = new Array(n).fill(null);
  const y = new Float64Array(n).fill(NaN);
  const scale = new Float64Array(n).fill(NaN);
  for (let i = START; i < n; i++) {
    const sd = sd20[i];
    if (!(sd > 0)) continue;
    const k = candles[i];
    const ret = (m) => (lc[i] - lc[i - m]) / (sd * Math.sqrt(m));
    let mv = 0, mv2 = 0, pv = 0, tv = 0, hi = -Infinity, lo = Infinity;
    for (let j = i - 49; j <= i; j++) { mv += lv[j]; mv2 += lv[j] * lv[j]; hi = Math.max(hi, candles[j].high); lo = Math.min(lo, candles[j].low); }
    for (let j = i - 19; j <= i; j++) { const v = candles[j].volume || 0; pv += v * Math.sign(candles[j].close - candles[j].open); tv += v; }
    mv /= 50; const vs = Math.sqrt(Math.max(mv2 / 50 - mv * mv, 1e-9));
    const d = new Date(k.time * 1000);
    const hr = (d.getUTCHours() + d.getUTCMinutes() / 60) / 24 * 2 * Math.PI;
    const dw = (d.getUTCDay() + hr / (2 * Math.PI)) / 7 * 2 * Math.PI;
    const bw = B.upper[i] - B.lower[i];
    const f = [
      ret(1), ret(4), ret(12), ret(24), ret(72), ret(168),
      Math.log(sd / sd100[i]),
      (R[i] - 50) / 25,
      M.hist[i] / (c[i] * sd),
      bw > 0 ? ((c[i] - B.lower[i]) / bw - 0.5) * 2 : 0,
      Math.log(c[i] / e20[i]) / (sd * Math.sqrt(20)),
      Math.log(c[i] / e50[i]) / (sd * Math.sqrt(50)),
      Math.log(c[i] / e200[i]) / (sd * Math.sqrt(200)),
      (lv[i] - mv) / vs,
      tv > 0 ? (pv / tv) * 2 : 0,
      Math.log(k.high / k.low) / sd - 1,
      k.high > k.low ? ((k.close - k.low) / (k.high - k.low) - 0.5) * 2 : 0,
      Math.sin(hr), Math.cos(hr), Math.sin(dw), Math.cos(dw),
      Math.log(c[i] / hi) / (sd * Math.sqrt(50)),
      Math.log(c[i] / lo) / (sd * Math.sqrt(50)),
    ];
    if (!f.every(fin)) continue;
    X[i] = f.map((v) => clip(v));
    scale[i] = sd * Math.sqrt(h);
    if (i + h < n) y[i] = clip((lc[i + h] - lc[i]) / scale[i], 6);
  }
  return { X, y, scale, c, n };
}

/* ------------------------------------------------------------------ */
/* Models                                                              */
/* ------------------------------------------------------------------ */
function solve(A, b) {
  // Gaussian elimination with partial pivoting (A is small: NF x NF)
  const m = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < m; col++) {
    let p = col;
    for (let r = col + 1; r < m; r++) if (Math.abs(M[r][col]) > Math.abs(M[p][col])) p = r;
    [M[col], M[p]] = [M[p], M[col]];
    const d = M[col][col] || 1e-12;
    for (let r = 0; r < m; r++) {
      if (r === col) continue;
      const f = M[r][col] / d;
      if (!f) continue;
      for (let k = col; k <= m; k++) M[r][k] -= f * M[col][k];
    }
  }
  return M.map((row, i) => row[m] / (row[i] || 1e-12));
}

const quantile = (sorted, q) => {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

/** Fit both models on the given sample indices. */
export function fit(F, idx, { lambda = 2, k = 150 } = {}) {
  const N = idx.length;
  const mu = new Float64Array(NF), sg = new Float64Array(NF);
  for (const i of idx) for (let j = 0; j < NF; j++) mu[j] += F.X[i][j];
  for (let j = 0; j < NF; j++) mu[j] /= N;
  for (const i of idx) for (let j = 0; j < NF; j++) sg[j] += (F.X[i][j] - mu[j]) ** 2;
  for (let j = 0; j < NF; j++) sg[j] = Math.sqrt(sg[j] / N) || 1;

  const Z = new Array(N), Y = new Float64Array(N);
  let ym = 0;
  for (let a = 0; a < N; a++) {
    const x = F.X[idx[a]], z = new Float64Array(NF);
    for (let j = 0; j < NF; j++) z[j] = (x[j] - mu[j]) / sg[j];
    Z[a] = z; Y[a] = F.y[idx[a]]; ym += Y[a];
  }
  ym /= N;

  // Ridge: (ZᵀZ + λN·I) β = Zᵀ(y − ȳ)
  const A = Array.from({ length: NF }, () => new Array(NF).fill(0));
  const b = new Array(NF).fill(0);
  for (let a = 0; a < N; a++) {
    const z = Z[a], yy = Y[a] - ym;
    for (let j = 0; j < NF; j++) {
      b[j] += z[j] * yy;
      const zj = z[j], Aj = A[j];
      for (let l = j; l < NF; l++) Aj[l] += zj * z[l];
    }
  }
  for (let j = 0; j < NF; j++) { for (let l = 0; l < j; l++) A[j][l] = A[l][j]; A[j][j] += lambda * N; }
  const beta = solve(A, b);

  // Residual spread of the ridge model (for price ranges)
  const res = new Float64Array(N);
  for (let a = 0; a < N; a++) { let p = ym; for (let j = 0; j < NF; j++) p += beta[j] * Z[a][j]; res[a] = Y[a] - p; }
  const rs = [...res].sort((p, q) => p - q);
  let rv = 0;
  for (const v of res) rv += v * v;
  return {
    mu, sg, beta, ym, Z, Y, k: Math.min(k, N),
    sdRes: Math.sqrt(rv / N) || 1,
    q: { q025: quantile(rs, 0.025), q16: quantile(rs, 0.16), q50: quantile(rs, 0.5), q84: quantile(rs, 0.84), q975: quantile(rs, 0.975) },
  };
}

/** Predict normalised move for one feature row. */
export function predictRow(m, x) {
  const z = new Float64Array(NF);
  for (let j = 0; j < NF; j++) z[j] = (x[j] - m.mu[j]) / m.sg[j];
  let ridge = m.ym;
  const contrib = new Array(NF);
  for (let j = 0; j < NF; j++) { contrib[j] = m.beta[j] * z[j]; ridge += contrib[j]; }

  // k nearest neighbours (squared Euclidean distance), keep top-k in a small sorted buffer
  const K = m.k, bestD = new Float64Array(K).fill(Infinity), bestY = new Float64Array(K);
  for (let a = 0; a < m.Z.length; a++) {
    const za = m.Z[a];
    let d = 0;
    for (let j = 0; j < NF && d < bestD[K - 1]; j++) { const t = za[j] - z[j]; d += t * t; }
    if (d >= bestD[K - 1]) continue;
    let p = K - 1;
    while (p > 0 && bestD[p - 1] > d) { bestD[p] = bestD[p - 1]; bestY[p] = bestY[p - 1]; p--; }
    bestD[p] = d; bestY[p] = m.Y[a];
  }
  let ky = 0, up = 0;
  for (let a = 0; a < K; a++) { ky += bestY[a]; if (bestY[a] > 0) up++; }
  // shrink the neighbour average toward the overall mean (it is noisy)
  const knn = m.ym + (ky / K - m.ym) * 0.6;
  return { ridge, knn, ensemble: (ridge + knn) / 2, knnUp: up / K, contrib };
}

// Standard normal CDF
function Phi(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}
const probUp = (m, zhat) => Math.min(0.97, Math.max(0.03, Phi(zhat / m.sdRes)));

/* ------------------------------------------------------------------ */
/* Live prediction                                                     */
/* ------------------------------------------------------------------ */
/**
 * Predict the move over the horizon from the last closed candle.
 * `anchor` = current live price the predicted % move is applied to.
 */
export function predictNow(candles, hKey, { window = 3000, model = 'ensemble', anchor } = {}) {
  const H = HORIZONS[hKey];
  const F = buildFeatures(candles, H.h);
  const last = F.n - 1;
  if (!F.X[last]) throw new Error('Not enough data');
  const idx = [];
  for (let i = Math.max(START, last - H.h - window); i <= last - H.h; i++) if (F.X[i] && fin(F.y[i])) idx.push(i);
  if (idx.length < 300) throw new Error('Not enough history to train');
  const m = fit(F, idx);
  const pr = predictRow(m, F.X[last]);
  const z = pr[model];
  const s = F.scale[last];
  const P0 = anchor || F.c[last];
  const px = (zz) => P0 * Math.exp(zz * s);
  const drivers = pr.contrib
    .map((v, j) => ({ key: FEATURES[j][0], label: FEATURES[j][1], value: v }))
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .filter((d, i, arr) => arr.findIndex((e) => e.label === d.label) === i)
    .slice(0, 4);
  return {
    hKey, z, pUp: probUp(m, z), price: P0, expected: px(z), move: Math.exp(z * s) - 1,
    r68: [px(z + m.q.q16), px(z + m.q.q84)], r95: [px(z + m.q.q025), px(z + m.q.q975)],
    models: { ridge: pr.ridge, knn: pr.knn, ensemble: pr.ensemble }, knnUp: pr.knnUp,
    drivers, trainedOn: idx.length, from: candles[idx[0]].time, to: candles[last].time,
    endTime: candles[last].time + H.h * H.barSec,
  };
}

/* ------------------------------------------------------------------ */
/* Walk-forward back-test                                              */
/* ------------------------------------------------------------------ */
/**
 * opts: model ('ensemble' | 'ridge' | 'knn'), testFrac (share of history used as the test period),
 * window (max training samples), retrain (re-fit every N candles), threshold (min |p − 0.5| to trade),
 * feeBps (per side, in basis points).
 */
export function backtest(candles, hKey, opts = {}, onProgress) {
  const { model = 'ensemble', testFrac = 0.4, window = 3000, retrain = 0, threshold = 0, feeBps = 4.5, fitOpts } = opts;
  const H = HORIZONS[hKey], h = H.h;
  const F = buildFeatures(candles, h);
  const labelled = [];
  for (let i = START; i < F.n; i++) if (F.X[i] && fin(F.y[i])) labelled.push(i);
  if (labelled.length < 600) throw new Error('Not enough history for a backtest');
  const testFrom = labelled[Math.floor(labelled.length * (1 - testFrac))];
  const tests = labelled.filter((i) => i >= testFrom);
  const every = retrain || Math.max(h, 12);

  let m = null, fitAt = -Infinity;
  const rows = [];
  for (let a = 0; a < tests.length; a++) {
    const t = tests[a];
    if (t - fitAt >= every || !m) {
      const idx = [];
      for (let i = Math.max(START, t - h - window); i <= t - h; i++) if (F.X[i] && fin(F.y[i])) idx.push(i);
      if (idx.length < 300) continue;
      m = fit(F, idx, fitOpts); fitAt = t;
    }
    const pr = predictRow(m, F.X[t]);
    const P0 = F.c[t], P1 = F.c[t + h], s = F.scale[t];
    const zr = Math.log(P1 / P0) / s;
    const row = { i: t, time: candles[t].time, P0, P1, actual: P1 / P0 - 1, mom: Math.sign(Math.log(P0 / F.c[t - h])) };
    for (const k of ['ensemble', 'ridge', 'knn']) row[k] = { z: pr[k], p: probUp(m, pr[k]) };
    const z = pr[model];
    row.pred = P0 * Math.exp(z * s);
    row.in68 = zr >= z + m.q.q16 && zr <= z + m.q.q84;
    row.in95 = zr >= z + m.q.q025 && zr <= z + m.q.q975;
    rows.push(row);
    if (onProgress && a % 150 === 0) onProgress(a / tests.length);
  }
  if (rows.length < 50) throw new Error('Not enough test points');

  const decided = rows.filter((r) => r.actual !== 0);
  const accOf = (fn) => decided.filter((r) => Math.sign(r.actual) === fn(r)).length / decided.length;
  const pOf = (r) => r[model].p;
  const conf = decided.filter((r) => Math.abs(pOf(r) - 0.5) >= threshold && pOf(r) !== 0.5);
  const upShare = decided.filter((r) => r.actual > 0).length / decided.length;
  const acc = accOf((r) => (pOf(r) > 0.5 ? 1 : -1));
  const nEff = Math.max(1, decided.length / h); // overlapping windows → fewer independent samples
  const zScore = (acc - Math.max(upShare, 1 - upShare)) / Math.sqrt(0.25 / nEff);

  // Trading simulation on non-overlapping windows
  const fee = (feeBps / 10000) * 2;
  let eq = 1, bh = 1, peak = 1, mdd = 0, trades = 0, wins = 0;
  const equity = [], hold = [];
  for (let a = 0; a < rows.length; a += h) {
    const r = rows[a], p = pOf(r);
    const pos = Math.abs(p - 0.5) >= threshold && p !== 0.5 ? Math.sign(p - 0.5) : 0;
    if (pos) {
      const ret = pos * r.actual - fee;
      eq *= 1 + ret; trades++; if (ret > 0) wins++;
    }
    bh *= 1 + r.actual;
    peak = Math.max(peak, eq); mdd = Math.max(mdd, 1 - eq / peak);
    const t = r.time + h * H.barSec;
    equity.push({ time: t, value: eq }); hold.push({ time: t, value: bh });
  }

  const mae = rows.reduce((s, r) => s + Math.abs(r.pred / r.P1 - 1), 0) / rows.length;
  const maeNaive = rows.reduce((s, r) => s + Math.abs(r.P0 / r.P1 - 1), 0) / rows.length;
  if (onProgress) onProgress(1);
  return {
    hKey, model, threshold, n: rows.length, from: rows[0].time, to: rows[rows.length - 1].time,
    acc,
    accBy: {
      ensemble: accOf((r) => (r.ensemble.p > 0.5 ? 1 : -1)),
      ridge: accOf((r) => (r.ridge.p > 0.5 ? 1 : -1)),
      knn: accOf((r) => (r.knn.p > 0.5 ? 1 : -1)),
      alwaysUp: upShare,
      momentum: accOf((r) => r.mom || 1),
    },
    confAcc: conf.length ? conf.filter((r) => Math.sign(r.actual) === Math.sign(pOf(r) - 0.5)).length / conf.length : null,
    coverage: conf.length / decided.length,
    band68: rows.filter((r) => r.in68).length / rows.length,
    band95: rows.filter((r) => r.in95).length / rows.length,
    mae, maeNaive, zScore, significant: zScore > 2,
    strategy: { ret: eq - 1, hold: bh - 1, mdd, trades, winRate: trades ? wins / trades : null, equity, holdCurve: hold },
    recent: rows.slice(-40).reverse().map((r) => ({ time: r.time, P0: r.P0, P1: r.P1, pred: r.pred, p: pOf(r), hit: Math.sign(r.actual) === Math.sign(pOf(r) - 0.5) })),
  };
}
