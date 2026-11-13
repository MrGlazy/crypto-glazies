// Technical indicators. All return arrays aligned 1:1 with the input (NaN where undefined).

export function sma(v, n) {
  const out = new Array(v.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    s += v[i];
    if (i >= n) s -= v[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

export function ema(v, n) {
  const out = new Array(v.length).fill(NaN);
  const k = 2 / (n + 1);
  let prev = NaN;
  for (let i = 0; i < v.length; i++) {
    if (Number.isNaN(v[i])) continue;
    if (Number.isNaN(prev)) {
      if (i >= n - 1) {
        let s = 0, ok = true;
        for (let j = i - n + 1; j <= i; j++) { if (Number.isNaN(v[j])) { ok = false; break; } s += v[j]; }
        if (ok) prev = s / n;
      }
    } else prev = v[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function stdev(v, n) {
  const m = sma(v, n);
  const out = new Array(v.length).fill(NaN);
  for (let i = n - 1; i < v.length; i++) {
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (v[j] - m[i]) ** 2;
    out[i] = Math.sqrt(s / n);
  }
  return out;
}

export function bollinger(v, n = 20, k = 2) {
  const mid = sma(v, n), sd = stdev(v, n);
  return {
    mid,
    upper: mid.map((m, i) => m + k * sd[i]),
    lower: mid.map((m, i) => m - k * sd[i]),
  };
}

export function rsi(v, n = 14) {
  const out = new Array(v.length).fill(NaN);
  let g = 0, l = 0;
  for (let i = 1; i < v.length; i++) {
    const d = v[i] - v[i - 1];
    const up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) {
      g += up; l += dn;
      if (i === n) { g /= n; l /= n; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
    } else {
      g = (g * (n - 1) + up) / n;
      l = (l * (n - 1) + dn) / n;
      out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
  }
  return out;
}

export function macd(v, f = 12, s = 26, sig = 9) {
  const ef = ema(v, f), es = ema(v, s);
  const line = ef.map((x, i) => x - es[i]);
  const signal = ema(line, sig);
  return { line, signal, hist: line.map((x, i) => x - signal[i]) };
}

/** Rolling VWAP over n bars (typical price). */
export function vwap(c, n = 50) {
  const out = new Array(c.length).fill(NaN);
  let pv = 0, vv = 0;
  for (let i = 0; i < c.length; i++) {
    const tp = (c[i].high + c[i].low + c[i].close) / 3;
    pv += tp * c[i].volume; vv += c[i].volume;
    if (i >= n) {
      const o = c[i - n];
      pv -= ((o.high + o.low + o.close) / 3) * o.volume; vv -= o.volume;
    }
    if (i >= n - 1 && vv > 0) out[i] = pv / vv;
  }
  return out;
}

export function atr(c, n = 14) {
  const tr = c.map((x, i) => (i === 0 ? x.high - x.low : Math.max(x.high - x.low, Math.abs(x.high - c[i - 1].close), Math.abs(x.low - c[i - 1].close))));
  return ema(tr, n);
}

export function heikinAshi(c) {
  const out = [];
  for (let i = 0; i < c.length; i++) {
    const x = c[i];
    const close = (x.open + x.high + x.low + x.close) / 4;
    const open = i === 0 ? (x.open + x.close) / 2 : (out[i - 1].open + out[i - 1].close) / 2;
    out.push({ time: x.time, open, close, high: Math.max(x.high, open, close), low: Math.min(x.low, open, close) });
  }
  return out;
}

/** Least-squares slope of y over its index for the last n points ending at i. */
export function slopeAt(y, i, n) {
  if (i - n + 1 < 0) return NaN;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let k = 0; k < n; k++) {
    const yy = y[i - n + 1 + k];
    sx += k; sy += yy; sxy += k * yy; sxx += k * k;
  }
  return (n * sxy - sx * sy) / (n * sxx - sx * sx);
}
