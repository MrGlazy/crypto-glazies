import { fetchCandles, fetchMarketCtx, fetchPriceAt, LiveFeed, INTERVAL_SEC } from './data.js';
import { sma, ema, bollinger, rsi, macd, vwap, heikinAshi } from './indicators.js';
import { forecast } from './forecast.js';
import { calcPosition, pnlAt, realized, load, save, uid, toCsv } from './positions.js';

const LC = window.LightweightCharts;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */
const nf = (d) => new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const NF = { 0: nf(0), 1: nf(1), 2: nf(2), 4: nf(4) };
const fmtUsd = (v, d = 2) => (Number.isFinite(v) ? (v < 0 ? '-$' : '$') + NF[d].format(Math.abs(v)) : '—');
const fmtSigned = (v, d = 2) => (Number.isFinite(v) ? (v >= 0 ? '+' : '-') + '$' + NF[d].format(Math.abs(v)) : '—');
const fmtPct = (v, d = 2) => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + NF[d].format(v * 100) + '%' : '—');
const fmtBtc = (v) => (Number.isFinite(v) ? (+v).toLocaleString('en-US', { maximumFractionDigits: 6 }) : '—');
const fmtCompact = (v) => (Number.isFinite(v) ? '$' + Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(v) : '—');
const fmtDate = (ms) => new Date(ms).toLocaleString(undefined, { year: '2-digit', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toLocalInput = (ms) => { const d = new Date(ms); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const fromLocalInput = (s) => new Date(s).getTime();

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 4200);
  setTimeout(() => el.remove(), 4600);
}
const throttle = (fn, ms) => { let t = 0, pend = null; return (...a) => { const now = Date.now(); if (now - t >= ms) { t = now; fn(...a); } else if (!pend) { pend = setTimeout(() => { pend = null; t = Date.now(); fn(...a); }, ms - (now - t)); } }; };

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */
const SKEY = 'glazies.settings.v1';
const defaults = {
  source: 'hyperliquid', tf: '1h', chartType: 'candles', theme: 'dark',
  ind: ['volume', 'ema20', 'ema50'], forecast: true, showPositions: true, showLiq: true, log: false, horizon: 24, alerts: [],
};
let settings;
try { settings = { ...defaults, ...JSON.parse(localStorage.getItem(SKEY) || '{}') }; } catch { settings = { ...defaults }; }
const persist = () => { try { localStorage.setItem(SKEY, JSON.stringify(settings)); } catch {} };

const state = {
  coin: 'BTC', candles: [], ctx: null, maxLev: 40, lastPrice: null, dayHigh: null, dayLow: null,
  positions: load(), tab: 'open', formType: 'spot', marginMode: 'isolated', editingId: null,
  picking: false, drawing: false, fc: null, warned: new Set(), loadSeq: 0,
};

/* ------------------------------------------------------------------ */
/* Charts                                                              */
/* ------------------------------------------------------------------ */
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const COLORS = {
  ema20: '#f5c542', ema50: '#4da3ff', ema200: '#c77dff', sma100: '#ff8c42', bb: '#38bdf8', vwap: '#f472b6', fc: '#f7931a',
};

function themeOpts() {
  return {
    layout: { background: { type: 'solid', color: css('--card') }, textColor: css('--muted'), fontFamily: 'Inter, system-ui, sans-serif', fontSize: 11 },
    grid: { vertLines: { color: css('--line') + '80' }, horzLines: { color: css('--line') + '80' } },
    rightPriceScale: { borderColor: css('--line'), minimumWidth: 78 },
    timeScale: { borderColor: css('--line') },
    crosshair: {
      mode: LC.CrosshairMode.Normal,
      vertLine: { color: css('--faint'), labelBackgroundColor: css('--card2') },
      horzLine: { color: css('--faint'), labelBackgroundColor: css('--card2') },
    },
  };
}
const localization = {
  timeFormatter: (t) => new Date(t * 1000).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }),
  priceFormatter: (p) => NF[Math.abs(p) >= 1000 ? 1 : 2].format(p),
};
const tickMarkFormatter = (t, type) => {
  const d = new Date(t * 1000);
  if (type === 0) return String(d.getFullYear());
  if (type === 1) return d.toLocaleString(undefined, { month: 'short' });
  if (type === 2) return String(d.getDate());
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
};

const main = LC.createChart($('#mainChart'), {
  ...themeOpts(), autoSize: true, localization,
  timeScale: { ...themeOpts().timeScale, timeVisible: true, secondsVisible: false, rightOffset: 8, tickMarkFormatter },
});
let priceSeries = null;
const volSeries = main.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
main.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

const overlay = {}; // name -> series or [series]
const lineOpts = (color, extra = {}) => ({ color, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...extra });

const fcSeries = {
  u2: main.addLineSeries(lineOpts(COLORS.fc + '55', { lineWidth: 1, lineStyle: LC.LineStyle.Dotted })),
  u1: main.addLineSeries(lineOpts(COLORS.fc + '99', { lineWidth: 1, lineStyle: LC.LineStyle.Dashed })),
  mid: main.addLineSeries(lineOpts(COLORS.fc, { lineWidth: 2, lineStyle: LC.LineStyle.LargeDashed, lastValueVisible: true, title: 'Forecast' })),
  l1: main.addLineSeries(lineOpts(COLORS.fc + '99', { lineWidth: 1, lineStyle: LC.LineStyle.Dashed })),
  l2: main.addLineSeries(lineOpts(COLORS.fc + '55', { lineWidth: 1, lineStyle: LC.LineStyle.Dotted })),
};

// Sub panes (RSI / MACD) — separate charts with synced time scales
const subs = {};
function makeSub(id) {
  const el = $(`#${id} .sub-chart`);
  const ch = LC.createChart(el, {
    ...themeOpts(), autoSize: true, localization,
    timeScale: { ...themeOpts().timeScale, visible: false, rightOffset: 8 },
    handleScroll: false, handleScale: false,
  });
  ch.applyOptions({ layout: { attributionLogo: false } });
  return ch;
}
subs.rsi = { chart: makeSub('rsiPane') };
subs.rsi.line = subs.rsi.chart.addLineSeries(lineOpts('#a78bfa', { lastValueVisible: true }));
subs.rsi.line.createPriceLine({ price: 70, color: '#ea394380', lineStyle: LC.LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false });
subs.rsi.line.createPriceLine({ price: 30, color: '#16c78480', lineStyle: LC.LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false });
subs.rsi.line.createPriceLine({ price: 50, color: '#8a94a840', lineStyle: LC.LineStyle.Dotted, lineWidth: 1, axisLabelVisible: false });
subs.macd = { chart: makeSub('macdPane') };
subs.macd.hist = subs.macd.chart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
subs.macd.line = subs.macd.chart.addLineSeries(lineOpts('#4da3ff'));
subs.macd.signal = subs.macd.chart.addLineSeries(lineOpts('#f5a524'));

let syncing = false;
function syncFrom(src) {
  return (range) => {
    if (syncing || !range) return;
    syncing = true;
    for (const ch of [main, subs.rsi.chart, subs.macd.chart]) if (ch !== src) ch.timeScale().setVisibleLogicalRange(range);
    syncing = false;
  };
}
main.timeScale().subscribeVisibleLogicalRangeChange(syncFrom(main));

function buildPriceSeries() {
  if (priceSeries) { main.removeSeries(priceSeries); priceLines = []; }
  const up = css('--up'), down = css('--down');
  const pf = { type: 'price', precision: 1, minMove: 0.1 };
  switch (settings.chartType) {
    case 'bars': priceSeries = main.addBarSeries({ upColor: up, downColor: down, priceFormat: pf }); break;
    case 'line': priceSeries = main.addLineSeries({ color: css('--accent'), lineWidth: 2, priceFormat: pf }); break;
    case 'area': priceSeries = main.addAreaSeries({ lineColor: css('--accent'), topColor: css('--accent') + '55', bottomColor: css('--accent') + '05', lineWidth: 2, priceFormat: pf }); break;
    default: priceSeries = main.addCandlestickSeries({ upColor: up, downColor: down, borderVisible: false, wickUpColor: up, wickDownColor: down, priceFormat: pf });
  }
}

const isOHLC = () => ['candles', 'heikin', 'bars'].includes(settings.chartType);
function seriesData() {
  const c = state.candles;
  if (settings.chartType === 'heikin') return heikinAshi(c);
  if (isOHLC()) return c.map(({ time, open, high, low, close }) => ({ time, open, high, low, close }));
  return c.map((x) => ({ time: x.time, value: x.close }));
}
const volBar = (x) => ({ time: x.time, value: x.volume, color: (x.close >= x.open ? css('--up') : css('--down')) + '66' });

function lineData(vals) {
  return state.candles.map((c, i) => (Number.isFinite(vals[i]) ? { time: c.time, value: vals[i] } : { time: c.time }));
}

function ensureOverlay(name) {
  if (overlay[name]) return overlay[name];
  if (name === 'bb') {
    overlay.bb = [
      main.addLineSeries(lineOpts(COLORS.bb + 'cc', { lineWidth: 1 })),
      main.addLineSeries(lineOpts(COLORS.bb + '70', { lineWidth: 1, lineStyle: LC.LineStyle.Dashed })),
      main.addLineSeries(lineOpts(COLORS.bb + 'cc', { lineWidth: 1 })),
    ];
  } else overlay[name] = main.addLineSeries(lineOpts(COLORS[name]));
  return overlay[name];
}
function dropOverlay(name) {
  const s = overlay[name];
  if (!s) return;
  (Array.isArray(s) ? s : [s]).forEach((x) => main.removeSeries(x));
  delete overlay[name];
}

let indCache = {};
function renderIndicators() {
  const c = state.candles;
  if (!c.length) return;
  const closes = c.map((x) => x.close);
  const on = new Set(settings.ind);
  indCache = {};
  volSeries.setData(on.has('volume') ? c.map(volBar) : []);
  const lines = { ema20: () => ema(closes, 20), ema50: () => ema(closes, 50), ema200: () => ema(closes, 200), sma100: () => sma(closes, 100), vwap: () => vwap(c, 50) };
  for (const [k, f] of Object.entries(lines)) {
    if (on.has(k)) { indCache[k] = f(); ensureOverlay(k).setData(lineData(indCache[k])); } else dropOverlay(k);
  }
  if (on.has('bb')) {
    const b = bollinger(closes, 20, 2);
    indCache.bb = b;
    const [u, m, l] = ensureOverlay('bb');
    u.setData(lineData(b.upper)); m.setData(lineData(b.mid)); l.setData(lineData(b.lower));
  } else dropOverlay('bb');

  $('#rsiPane').classList.toggle('hidden', !on.has('rsi'));
  if (on.has('rsi')) {
    indCache.rsi = rsi(closes, 14);
    subs.rsi.line.setData(lineData(indCache.rsi));
    $('#rsiVal').textContent = NF[1].format(indCache.rsi.at(-1));
  }
  $('#macdPane').classList.toggle('hidden', !on.has('macd'));
  if (on.has('macd')) {
    const m = macd(closes);
    indCache.macd = m;
    subs.macd.hist.setData(c.map((x, i) => (Number.isFinite(m.hist[i]) ? { time: x.time, value: m.hist[i], color: (m.hist[i] >= 0 ? css('--up') : css('--down')) + '99' } : { time: x.time })));
    subs.macd.line.setData(lineData(m.line));
    subs.macd.signal.setData(lineData(m.signal));
    $('#macdVal').textContent = `${NF[1].format(m.line.at(-1))} / ${NF[1].format(m.signal.at(-1))}`;
  }
  $('#indCount').textContent = settings.ind.length;
  syncSubs();
  requestAnimationFrame(() => setTimeout(syncSubs, 30)); // panes that were just un-hidden need a layout pass first
}
function syncSubs() {
  const r = main.timeScale().getVisibleLogicalRange();
  if (r) { syncing = true; subs.rsi.chart.timeScale().setVisibleLogicalRange(r); subs.macd.chart.timeScale().setVisibleLogicalRange(r); syncing = false; }
}

/* ------------------------------------------------------------------ */
/* Forecast                                                            */
/* ------------------------------------------------------------------ */
function renderForecast() {
  const show = settings.forecast && state.candles.length > 60;
  const fc = state.candles.length > 60 ? forecast(state.candles, +settings.horizon, INTERVAL_SEC[settings.tf]) : null;
  state.fc = fc;
  for (const k in fcSeries) fcSeries[k].setData(show && fc ? fc.path.map((p) => ({ time: p.time, value: p[k] })) : []);
  if (!fc) return;
  const deg = Math.max(-1, Math.min(1, fc.score)) * 90;
  $('#gaugeNeedle').style.transform = `rotate(${deg}deg)`;
  const v = $('#fcVerdict');
  v.textContent = fc.verdict.text;
  v.className = `verdict ${fc.verdict.cls}`;
  $('#fcProb').textContent = `probability of going up: ${Math.round(fc.pUp * 100)}% · score ${fc.score >= 0 ? '+' : ''}${fc.score.toFixed(2)}`;
  const last = state.candles.at(-1).close;
  const t = $('#fcTarget');
  t.textContent = `${fmtUsd(fc.end.mid, 0)} (${fmtPct(fc.end.mid / last - 1)})`;
  t.className = `mono ${cls(fc.end.mid - last)}`;
  $('#fcRange1').textContent = `${fmtUsd(fc.end.l1, 0)} – ${fmtUsd(fc.end.u1, 0)}`;
  $('#fcRange2').textContent = `${fmtUsd(fc.end.l2, 0)} – ${fmtUsd(fc.end.u2, 0)}`;
  $('#fcHit').textContent = fc.hitRate == null ? 'n/a' : `${Math.round(fc.hitRate * 100)}% of ${fc.calls}`;
  $('#fcHit').title = 'How often this model called the direction correctly over the past ~400 bars at this timeframe and horizon';
  $('#fcSignals').innerHTML = fc.signals.map((s) => {
    const w = Math.abs(s.value) * 50;
    const left = s.value >= 0 ? 50 : 50 - w;
    const col = s.value >= 0 ? 'var(--up)' : 'var(--down)';
    return `<li><span class="muted">${s.label}</span><span class="bar"><i style="left:${left}%;width:${w}%;background:${col}"></i></span><span class="v ${cls(s.value)}">${s.value >= 0 ? '+' : ''}${s.value.toFixed(2)}</span></li>`;
  }).join('');
}

/* ------------------------------------------------------------------ */
/* Positions on chart                                                  */
/* ------------------------------------------------------------------ */
let priceLines = [];
function snapTime(sec) {
  const c = state.candles;
  if (!c.length || sec < c[0].time) return null;
  let lo = 0, hi = c.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (c[mid].time <= sec) lo = mid; else hi = mid - 1; }
  return c[lo].time;
}
const posLabel = (p) => (p.type === 'spot' ? `Buy ${fmtBtc(p.size)}` : `${p.type === 'long' ? 'L' : 'S'} ${p.leverage}x ${fmtBtc(p.size)}`);

function renderChartPositions() {
  if (!priceSeries) return;
  priceLines.forEach((l) => priceSeries.removePriceLine(l));
  priceLines = [];
  const add = (o) => priceLines.push(priceSeries.createPriceLine({ lineWidth: 1, axisLabelVisible: true, ...o }));
  const markers = [];
  const up = css('--up'), down = css('--down'), acc = css('--accent');

  if (settings.showPositions) {
    for (const p of state.positions) {
      const col = p.type === 'short' ? down : p.type === 'long' ? up : acc;
      const t = snapTime(p.time / 1000);
      if (t != null) {
        markers.push({
          time: t, position: p.type === 'short' ? 'aboveBar' : 'belowBar', color: col,
          shape: p.type === 'short' ? 'arrowDown' : p.type === 'long' ? 'arrowUp' : 'circle', text: posLabel(p),
        });
      }
      if (p.status === 'closed') {
        const te = snapTime(p.exitTime / 1000);
        if (te != null) markers.push({ time: te, position: p.type === 'short' ? 'belowBar' : 'aboveBar', color: css('--muted'), shape: 'square', text: `Exit ${fmtSigned(realized(p, state.maxLev), 0)}` });
        continue;
      }
      add({ price: +p.entry, color: col, lineStyle: LC.LineStyle.Solid, title: p.type === 'spot' ? 'Buy' : `${p.type === 'long' ? 'Long' : 'Short'} ${p.leverage}x` });
      if (p.tp) add({ price: +p.tp, color: up, lineStyle: LC.LineStyle.Dotted, title: 'TP' });
      if (p.sl) add({ price: +p.sl, color: down, lineStyle: LC.LineStyle.Dotted, title: 'SL' });
    }
    const spot = state.positions.filter((p) => p.type === 'spot' && p.status !== 'closed');
    if (spot.length > 1) {
      const sz = spot.reduce((a, p) => a + +p.size, 0);
      const avg = spot.reduce((a, p) => a + p.entry * p.size, 0) / sz;
      add({ price: avg, color: acc, lineWidth: 2, lineStyle: LC.LineStyle.LargeDashed, title: 'Avg cost' });
    }
  }
  if (settings.showLiq) {
    for (const p of state.positions) {
      if (p.status === 'closed' || p.type === 'spot') continue;
      const k = calcPosition(p, state.maxLev);
      if (k.liq) add({ price: k.liq, color: '#ff4d6d', lineWidth: 2, lineStyle: LC.LineStyle.Dashed, title: `LIQ ${p.type === 'long' ? 'L' : 'S'} ${p.leverage}x` });
    }
  }
  for (const a of settings.alerts) add({ price: a.price, color: css('--blue'), lineStyle: LC.LineStyle.SparseDotted, title: '🔔 Alert' });
  markers.sort((a, b) => a.time - b.time);
  priceSeries.setMarkers(markers);
}

/* ------------------------------------------------------------------ */
/* Legend                                                              */
/* ------------------------------------------------------------------ */
function renderLegend(param) {
  const c = state.candles;
  if (!c.length) return;
  let i = c.length - 1;
  if (param?.time != null) {
    const t = param.time;
    const j = c.findIndex((x) => x.time === t);
    if (j >= 0) i = j;
    else if (t > c.at(-1).time && state.fc) {
      const p = state.fc.path.find((x) => x.time === t);
      if (p) {
        $('#legend').innerHTML = `<span class="lg-title">Forecast</span><span><span class="k">Expected</span>${fmtUsd(p.mid, 0)}</span><span><span class="k">68%</span>${fmtUsd(p.l1, 0)} – ${fmtUsd(p.u1, 0)}</span><span><span class="k">95%</span>${fmtUsd(p.l2, 0)} – ${fmtUsd(p.u2, 0)}</span>`;
        return;
      }
    }
  }
  const x = c[i];
  const ch = (x.close - x.open) / x.open;
  const col = ch >= 0 ? 'up' : 'down';
  const parts = [
    `<span class="lg-title">BTC · ${settings.tf.toUpperCase()} · ${settings.source === 'hyperliquid' ? 'Hyperliquid' : 'Binance'}</span>`,
    `<span><span class="k">O</span><span class="${col}">${NF[1].format(x.open)}</span></span>`,
    `<span><span class="k">H</span><span class="${col}">${NF[1].format(x.high)}</span></span>`,
    `<span><span class="k">L</span><span class="${col}">${NF[1].format(x.low)}</span></span>`,
    `<span><span class="k">C</span><span class="${col}">${NF[1].format(x.close)}</span></span>`,
    `<span class="${col}">${fmtPct(ch)}</span>`,
    `<span><span class="k">Vol</span>${Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(x.volume)}</span>`,
  ];
  const ind = [];
  for (const k of ['ema20', 'ema50', 'ema200', 'sma100', 'vwap']) {
    if (indCache[k] && Number.isFinite(indCache[k][i])) ind.push(`<span style="color:${COLORS[k]}">${k.toUpperCase().replace(/(\D+)(\d+)/, '$1 $2')} ${NF[1].format(indCache[k][i])}</span>`);
  }
  if (indCache.bb && Number.isFinite(indCache.bb.upper[i])) ind.push(`<span style="color:${COLORS.bb}">BB ${NF[0].format(indCache.bb.lower[i])} / ${NF[0].format(indCache.bb.upper[i])}</span>`);
  $('#legend').innerHTML = parts.join('') + (ind.length ? `<div class="row">${ind.join('')}</div>` : '');
  if (indCache.rsi && Number.isFinite(indCache.rsi[i])) $('#rsiVal').textContent = NF[1].format(indCache.rsi[i]);
  if (indCache.macd && Number.isFinite(indCache.macd.line[i])) $('#macdVal').textContent = `${NF[1].format(indCache.macd.line[i])} / ${NF[1].format(indCache.macd.signal[i])}`;
}

main.subscribeCrosshairMove((param) => {
  renderLegend(param);
  // mirror crosshair into sub panes
  for (const [k, s] of Object.entries(subs)) {
    if (!settings.ind.includes(k)) continue;
    try {
      if (param.time != null) {
        const i = state.candles.findIndex((x) => x.time === param.time);
        const val = k === 'rsi' ? indCache.rsi?.[i] : indCache.macd?.line[i];
        if (Number.isFinite(val)) s.chart.setCrosshairPosition(val, param.time, s.line); else s.chart.clearCrosshairPosition();
      } else s.chart.clearCrosshairPosition();
    } catch { /* older API */ }
  }
});

main.subscribeClick((param) => {
  if (!param.point || !priceSeries) return;
  const price = priceSeries.coordinateToPrice(param.point.y);
  if (!Number.isFinite(price)) return;
  if (state.picking) {
    const t = param.time ?? main.timeScale().coordinateToTime(param.point.x);
    const f = $('#posForm');
    f.entry.value = price.toFixed(1);
    if (t != null) f.time.value = toLocalInput(Math.min(t * 1000, Date.now()));
    setPicking(false);
    updateCalc();
    toast(`Entry set to <b>${fmtUsd(price, 1)}</b>${t ? ' at ' + fmtDate(t * 1000) : ''}`);
  } else if (state.drawing) {
    settings.alerts.push({ id: uid(), price, above: price > (state.lastPrice ?? price) });
    persist();
    setDrawing(false);
    renderChartPositions();
    toast(`Price alert at <b>${fmtUsd(price, 1)}</b> — you'll be notified when BTC crosses it.`);
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  }
});

/* ------------------------------------------------------------------ */
/* Ticker / live price                                                 */
/* ------------------------------------------------------------------ */
let prevPx = null;
function renderTicker() {
  const px = state.lastPrice;
  if (!Number.isFinite(px)) return;
  const el = $('#livePrice');
  el.textContent = fmtUsd(px, 1);
  if (prevPx != null && px !== prevPx) {
    el.classList.remove('flash-up', 'flash-down');
    void el.offsetWidth;
    el.classList.add(px > prevPx ? 'flash-up' : 'flash-down');
    setTimeout(() => el.classList.remove('flash-up', 'flash-down'), 600);
  }
  prevPx = px;
  document.title = `${fmtUsd(px, 0)} · BTC · Glazies Crypto`;
  let ref = state.ctx?.prevDayPx;
  if (!ref) {
    const t = Date.now() / 1000 - 86400;
    const c = state.candles.find((x) => x.time >= t);
    ref = c?.open;
  }
  if (ref) {
    const ch = px / ref - 1;
    const chip = $('#liveChange');
    chip.textContent = `${fmtPct(ch)} 24h`;
    chip.className = `chip ${cls(ch)}`;
  }
  if (state.dayHigh != null) {
    state.dayHigh = Math.max(state.dayHigh, px); state.dayLow = Math.min(state.dayLow, px);
    $('#statHigh').textContent = fmtUsd(state.dayHigh, 0);
    $('#statLow').textContent = fmtUsd(state.dayLow, 0);
  }
  const c = state.ctx;
  if (c) {
    $('#statMark').textContent = fmtUsd(c.mark, 1);
    $('#statOracle').textContent = fmtUsd(c.oracle, 1);
    $('#statVol').textContent = fmtCompact(c.dayNtlVlm);
    $('#statOI').textContent = fmtCompact(c.openInterest * px);
    const f = $('#statFunding');
    f.textContent = `${(c.funding * 100).toFixed(4)}%`;
    f.className = `mono ${cls(c.funding)}`;
    f.title = `≈ ${(c.funding * 24 * 365 * 100).toFixed(1)}% APR · positive = longs pay shorts`;
  }
}

function checkAlerts(px) {
  let changed = false;
  settings.alerts = settings.alerts.filter((a) => {
    const hit = a.above ? px >= a.price : px <= a.price;
    if (hit) {
      changed = true;
      notify(`BTC crossed ${fmtUsd(a.price, 0)}`, `Price is now ${fmtUsd(px, 1)}`);
    }
    return !hit;
  });
  for (const p of state.positions) {
    if (p.status === 'closed' || p.type === 'spot' || state.warned.has(p.id)) continue;
    const k = calcPosition(p, state.maxLev);
    if (k.liq && Math.abs(px - k.liq) / px < 0.05) {
      state.warned.add(p.id);
      notify('⚠️ Close to liquidation', `${posLabel(p)} — liq ${fmtUsd(k.liq, 0)}, price ${fmtUsd(px, 0)}`, 'err');
    }
  }
  if (changed) { persist(); renderChartPositions(); }
}
function notify(title, body, kind = 'ok') {
  toast(`<b>${esc(title)}</b><br>${esc(body)}`, kind);
  try { if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body, icon: 'assets/favicon.svg' }); } catch {}
}

/* ------------------------------------------------------------------ */
/* Data loading & live feed                                            */
/* ------------------------------------------------------------------ */
const setConn = (s) => {
  const el = $('#connStatus');
  el.className = `conn ${s === 'live' ? 'live' : s === 'off' ? 'off' : ''}`;
  el.querySelector('span').textContent = s === 'live' ? 'Live' : s === 'off' ? 'Reconnecting' : 'Connecting';
};

const slowRefresh = throttle(() => { renderIndicators(); renderForecast(); renderLegend(); }, 4000);
const fastRefresh = throttle(() => { renderTicker(); renderPortfolio(); updateCalc(); }, 600);

const feed = new LiveFeed({
  onStatus: setConn,
  onCandle: (bar) => {
    const c = state.candles;
    if (!c.length) return;
    const last = c.at(-1);
    let isNew = false;
    if (bar.time === last.time) c[c.length - 1] = bar;
    else if (bar.time > last.time) { c.push(bar); isNew = true; }
    else return;
    if (settings.chartType === 'heikin') {
      const ha = heikinAshi(c.slice(-200)).at(-1);
      priceSeries.update(ha);
    } else priceSeries.update(isOHLC() ? { time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close } : { time: bar.time, value: bar.close });
    if (settings.ind.includes('volume')) volSeries.update(volBar(bar));
    state.lastPrice = bar.close;
    if (isNew) { renderIndicators(); renderForecast(); renderChartPositions(); } else slowRefresh();
    fastRefresh();
    checkAlerts(bar.close);
  },
  onCtx: (ctx) => {
    state.ctx = ctx;
    if (ctx.mid) { state.lastPrice = ctx.mid; checkAlerts(ctx.mid); }
    fastRefresh();
  },
});

async function loadCtx() {
  try {
    const ctx = await fetchMarketCtx(state.coin);
    state.ctx = ctx;
    if (ctx.maxLeverage && ctx.maxLeverage !== state.maxLev) {
      state.maxLev = ctx.maxLeverage;
      const r = $('#posForm').leverage;
      r.max = state.maxLev;
      $('#maxLevLabel').textContent = state.maxLev;
      renderChartPositions();
    }
    renderTicker();
  } catch { /* Hyperliquid context optional */ }
}
async function loadDayRange() {
  try {
    const d = await fetchCandles(settings.source, state.coin, '15m', 96);
    const day = d.filter((x) => x.time >= Date.now() / 1000 - 86400);
    state.dayHigh = Math.max(...day.map((x) => x.high));
    state.dayLow = Math.min(...day.map((x) => x.low));
    renderTicker();
  } catch {}
}

async function loadData({ keepView = false } = {}) {
  const seq = ++state.loadSeq;
  $('#loading').classList.remove('hidden');
  feed.stop();
  let candles;
  try {
    candles = await fetchCandles(settings.source, state.coin, settings.tf);
  } catch (e) {
    const alt = settings.source === 'hyperliquid' ? 'binance' : 'hyperliquid';
    try {
      candles = await fetchCandles(alt, state.coin, settings.tf);
      toast(`${settings.source === 'hyperliquid' ? 'Hyperliquid' : 'Binance'} unavailable — switched to ${alt === 'hyperliquid' ? 'Hyperliquid' : 'Binance'}.`, 'err');
      settings.source = alt; persist();
      $('#sourceSelect').value = alt;
    } catch {
      if (seq === state.loadSeq) {
        $('#loading').innerHTML = '<span>Could not load market data. Check your connection and refresh.</span>';
        setConn('off');
      }
      return;
    }
  }
  if (seq !== state.loadSeq) return;
  state.candles = candles;
  state.lastPrice = candles.at(-1).close;
  const range = keepView ? main.timeScale().getVisibleLogicalRange() : null;
  priceSeries.setData(seriesData());
  renderIndicators();
  renderForecast();
  renderChartPositions();
  if (!range) {
    const n = candles.length;
    main.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 160), to: n + (settings.forecast ? +settings.horizon + 4 : 8) });
  }
  syncSubs();
  renderLegend();
  renderTicker();
  renderPortfolio();
  updateCalc();
  $('#loading').classList.add('hidden');
  feed.start(settings.source, state.coin, settings.tf);
}

/* ------------------------------------------------------------------ */
/* Portfolio                                                           */
/* ------------------------------------------------------------------ */
function markPx() {
  const s = parseFloat($('#scenarioPx').value);
  return Number.isFinite(s) && s > 0 ? s : state.lastPrice;
}

function renderPortfolio() {
  const px = markPx();
  const scenario = px !== state.lastPrice;
  const open = state.positions.filter((p) => p.status !== 'closed').sort((a, b) => b.time - a.time);
  const closed = state.positions.filter((p) => p.status === 'closed').sort((a, b) => b.exitTime - a.exitTime);
  $('#cntOpen').textContent = open.length;
  $('#cntClosed').textContent = closed.length;

  // Summary
  let upnl = 0, exposure = 0, margin = 0, nearest = null;
  let spotSize = 0, spotCost = 0;
  for (const p of open) {
    const r = pnlAt(p, px, state.maxLev);
    upnl += r.pnl;
    exposure += Math.abs(+p.size * px);
    margin += p.type === 'spot' ? r.notional : r.margin;
    if (p.type === 'spot') { spotSize += +p.size; spotCost += p.entry * p.size; }
    if (r.liqDist != null && (!nearest || r.liqDist < nearest.d)) nearest = { d: r.liqDist, p, liq: r.liq };
  }
  const rpnl = closed.reduce((a, p) => a + realized(p, state.maxLev), 0);
  const stat = (label, val, sub = '', c = '') => `<div class="stat"><label>${label}</label><div class="val ${c}">${val}</div><div class="sub">${sub}</div></div>`;
  $('#summary').innerHTML = [
    stat(scenario ? `Unrealized PnL @ ${fmtUsd(px, 0)}` : 'Unrealized PnL', fmtSigned(upnl), margin ? fmtPct(upnl / margin) + ' on capital' : '&nbsp;', cls(upnl)),
    stat('Realized PnL', fmtSigned(rpnl), `${closed.length} closed trade${closed.length === 1 ? '' : 's'}`, cls(rpnl)),
    stat('Exposure', fmtUsd(exposure, 0), `${open.length} open · capital ${fmtUsd(margin, 0)}`),
    stat('Spot BTC', spotSize ? fmtBtc(spotSize) + ' ₿' : '0 ₿', spotSize ? `avg cost ${fmtUsd(spotCost / spotSize, 0)} · worth ${fmtUsd(spotSize * px, 0)}` : 'no spot holdings'),
    stat('Nearest liquidation', nearest ? fmtUsd(nearest.liq, 0) : '—', nearest ? `${(nearest.d * 100).toFixed(1)}% away · ${posLabel(nearest.p)}` : 'no leveraged positions', nearest ? (nearest.d < 0.05 ? 'down' : nearest.d < 0.15 ? 'warn' : '') : ''),
  ].join('');

  // Table
  const thead = $('#posTable thead'), tbody = $('#posTable tbody');
  const list = state.tab === 'open' ? open : closed;
  $('#emptyState').classList.toggle('show', !list.length);
  $('#posTable').classList.toggle('hidden', !list.length);
  const posCell = (p) => `<span class="tag ${p.type}">${p.type === 'spot' ? 'Spot' : p.type}${p.type !== 'spot' ? ' ' + p.leverage + 'x' : ''}</span><span class="venue">${esc(p.venue)}${p.type !== 'spot' ? ' · ' + (p.marginMode === 'cross' ? 'cross' : 'isolated') : ''}</span>${p.notes ? `<span class="sub" title="${esc(p.notes)}">${esc(p.notes.slice(0, 32))}${p.notes.length > 32 ? '…' : ''}</span>` : ''}`;

  if (state.tab === 'open') {
    const scenarioHdr = scenario ? ` @ ${fmtUsd(px, 0)}` : '';
    thead.innerHTML = `<tr><th>Position</th><th>Opened</th><th class="num">Entry</th><th class="num">Size</th><th class="num">PnL${scenarioHdr}</th><th class="num">Liq. price</th><th></th></tr>`;
    tbody.innerHTML = open.map((p) => {
      const r = pnlAt(p, px, state.maxLev);
      let liq = '<span class="muted">—</span>';
      if (r.liq) {
        const d = r.liqDist;
        const risk = Math.max(0, Math.min(1, 1 - d / 0.3));
        const col = d < 0.05 ? 'var(--down)' : d < 0.15 ? 'var(--warn)' : 'var(--up)';
        liq = `${fmtUsd(r.liq, 1)}<span class="sub">${(d * 100).toFixed(1)}% away <span class="risk"><i style="width:${risk * 100}%;background:${col}"></i></span></span>`;
      }
      return `<tr data-id="${p.id}">
        <td>${posCell(p)}</td>
        <td>${fmtDate(p.time)}</td>
        <td class="num">${fmtUsd(+p.entry, 1)}${p.tp || p.sl ? `<span class="sub">${p.tp ? `<span class="up">TP ${fmtUsd(+p.tp, 0)}</span>` : ''}${p.tp && p.sl ? ' · ' : ''}${p.sl ? `<span class="down">SL ${fmtUsd(+p.sl, 0)}</span>` : ''}</span>` : ''}</td>
        <td class="num">${fmtBtc(p.size)} ₿<span class="sub">${fmtUsd(r.notional, 0)}${p.type !== 'spot' ? ' · margin ' + fmtUsd(r.margin, 0) : ''}</span></td>
        <td class="num ${cls(r.pnl)}">${fmtSigned(r.pnl)}<span class="sub ${cls(r.pnl)}">${fmtPct(r.roe)}${p.type !== 'spot' ? ' ROE' : ''}</span></td>
        <td class="num">${liq}</td>
        <td><div class="row-actions"><button data-act="focus" title="Show on chart">◎</button><button data-act="edit" title="Edit">✎</button><button data-act="close" title="Close position">Close</button><button data-act="del" class="danger" title="Delete">✕</button></div></td>
      </tr>`;
    }).join('');
  } else {
    thead.innerHTML = '<tr><th>Position</th><th>Opened</th><th>Closed</th><th class="num">Entry</th><th class="num">Exit</th><th class="num">Size</th><th class="num">Realized PnL</th><th></th></tr>';
    tbody.innerHTML = closed.map((p) => {
      const r = pnlAt(p, +p.exit, state.maxLev);
      return `<tr data-id="${p.id}">
        <td>${posCell(p)}</td><td>${fmtDate(p.time)}</td><td>${fmtDate(p.exitTime)}</td>
        <td class="num">${fmtUsd(+p.entry, 1)}</td><td class="num">${fmtUsd(+p.exit, 1)}</td>
        <td class="num">${fmtBtc(p.size)} ₿<span class="sub">${fmtUsd(r.notional, 0)}</span></td>
        <td class="num ${cls(r.pnl)}">${fmtSigned(r.pnl)}<span class="sub ${cls(r.pnl)}">${fmtPct(r.roe)}</span></td>
        <td><div class="row-actions"><button data-act="focus" title="Show on chart">◎</button><button data-act="reopen">Reopen</button><button data-act="del" class="danger" title="Delete">✕</button></div></td>
      </tr>`;
    }).join('');
  }
}

$('#posTable tbody').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const id = b.closest('tr').dataset.id;
  const p = state.positions.find((x) => x.id === id);
  if (!p) return;
  const act = b.dataset.act;
  if (act === 'del') {
    if (!confirm(`Delete this ${posLabel(p)} position?`)) return;
    state.positions = state.positions.filter((x) => x.id !== id);
    commit('Position deleted');
  } else if (act === 'edit') editPosition(p);
  else if (act === 'close') openClose(p);
  else if (act === 'reopen') { p.status = 'open'; delete p.exit; delete p.exitTime; commit('Position reopened'); }
  else if (act === 'focus') focusTime(p.time / 1000, +p.entry);
});

function focusTime(sec) {
  const t = snapTime(sec);
  if (t == null) { toast('That entry is older than the data loaded for this timeframe — try 1D or 1W.'); return; }
  const i = state.candles.findIndex((x) => x.time === t);
  main.timeScale().setVisibleLogicalRange({ from: i - 60, to: i + 60 });
  $('#chartCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function commit(msg) {
  save(state.positions);
  renderPortfolio();
  renderChartPositions();
  if (msg) toast(msg, 'ok');
}

/* Close dialog */
const dlg = $('#closeDialog');
let closing = null;
function openClose(p) {
  closing = p;
  const f = $('#closeForm');
  f.exit.value = (state.lastPrice ?? p.entry).toFixed(1);
  f.exitTime.value = toLocalInput(Date.now());
  $('#closeInfo').textContent = `${posLabel(p)} @ ${fmtUsd(+p.entry, 1)} · ${p.venue}`;
  updateCloseCalc();
  dlg.showModal();
}
function updateCloseCalc() {
  if (!closing) return;
  const px = parseFloat($('#closeForm').exit.value);
  if (!Number.isFinite(px)) { $('#closeCalc').innerHTML = ''; return; }
  const r = pnlAt(closing, px, state.maxLev);
  $('#closeCalc').innerHTML = `<div><label>Realized PnL</label><b class="${cls(r.pnl)}">${fmtSigned(r.pnl)}</b></div><div><label>Return</label><b class="${cls(r.pnl)}">${fmtPct(r.roe)}</b></div>`;
}
$('#closeForm').exit.addEventListener('input', updateCloseCalc);
dlg.addEventListener('close', () => {
  if (dlg.returnValue === 'ok' && closing) {
    const f = $('#closeForm');
    closing.status = 'closed';
    closing.exit = parseFloat(f.exit.value);
    closing.exitTime = fromLocalInput(f.exitTime.value);
    commit(`Closed for ${fmtSigned(realized(closing, state.maxLev))}`);
  }
  closing = null;
});

/* ------------------------------------------------------------------ */
/* Form                                                                */
/* ------------------------------------------------------------------ */
const form = $('#posForm');
function setType(t) {
  state.formType = t;
  $$('#typeSeg button').forEach((b) => b.classList.toggle('active', b.dataset.type === t));
  $('#levBlock').classList.toggle('hidden', t === 'spot');
  if (t !== 'spot') form.venue.value = 'Hyperliquid';
  updateCalc();
}
function setMargin(m) {
  state.marginMode = m;
  $$('#marginSeg button').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
  $('.cross-only').classList.toggle('hidden', m !== 'cross');
  updateCalc();
}
function readForm() {
  const entry = parseFloat(form.entry.value);
  const amt = parseFloat(form.amount.value);
  const size = form.amountUnit.value === 'usd' ? amt / entry : amt;
  return {
    type: state.formType, venue: form.venue.value, time: fromLocalInput(form.time.value), entry, size,
    leverage: state.formType === 'spot' ? 1 : +form.leverage.value, marginMode: state.marginMode,
    accountValue: parseFloat(form.accountValue.value) || null,
    tp: parseFloat(form.tp.value) || null, sl: parseFloat(form.sl.value) || null, notes: form.notes.value.trim(),
  };
}
function updateCalc() {
  $('#levLabel').textContent = `${form.leverage.value}x`;
  const p = readForm();
  const box = $('#calcBox');
  if (!(p.entry > 0) || !(p.size > 0)) { box.innerHTML = ''; return; }
  const k = calcPosition(p, state.maxLev);
  const rows = [
    ['Size', `${fmtBtc(p.size)} ₿`], ['Notional', fmtUsd(k.notional)],
  ];
  if (p.type !== 'spot') {
    rows.push(['Margin', fmtUsd(k.margin)], ['Est. fee (taker)', fmtUsd(k.fee)]);
    rows.push(['Maint. margin', `${(k.mmRate * 100).toFixed(2)}%`]);
    if (state.ctx) {
      const hourly = k.notional * state.ctx.funding * (p.type === 'long' ? -1 : 1);
      rows.push(['Funding / 1h', `<span class="${cls(hourly)}">${fmtSigned(hourly)}</span>`]);
    }
  }
  if (state.lastPrice && p.time <= Date.now() - 60000) {
    const r = pnlAt(p, state.lastPrice, state.maxLev);
    rows.push(['PnL now', `<span class="${cls(r.pnl)}">${fmtSigned(r.pnl)} (${fmtPct(r.roe)})</span>`]);
  }
  let liqRow = '';
  if (p.type !== 'spot') {
    if (k.liq) {
      const d = Math.abs(p.entry - k.liq) / p.entry;
      liqRow = `<div class="full"><label>Liquidation price (Hyperliquid)</label><span class="liq down">${fmtUsd(k.liq, 1)} · ${(d * 100).toFixed(2)}% from entry</span></div>`;
    } else liqRow = '<div class="full"><label>Liquidation price</label><span class="liq up">None — collateral covers the position</span></div>';
    if (p.marginMode === 'cross' && !p.accountValue) liqRow += '<div class="full muted">Cross: add your account value for a better estimate (using isolated math).</div>';
  }
  box.innerHTML = rows.map(([a, b]) => `<div><label>${a}</label><span class="mono">${b}</span></div>`).join('') + liqRow;
}
function resetForm() {
  form.reset();
  form.id.value = '';
  state.editingId = null;
  form.time.value = toLocalInput(Date.now());
  form.leverage.value = 10;
  setType(state.formType === 'spot' ? 'spot' : state.formType);
  setMargin('isolated');
  $('#formTitle').textContent = 'Add position';
  $('#btnSubmit').textContent = 'Add to chart';
  updateCalc();
}
function editPosition(p) {
  state.editingId = p.id;
  setType(p.type);
  setMargin(p.marginMode || 'isolated');
  form.venue.value = p.venue;
  form.time.value = toLocalInput(p.time);
  form.entry.value = p.entry;
  form.amount.value = p.size;
  form.amountUnit.value = 'coin';
  form.leverage.value = p.leverage || 1;
  form.accountValue.value = p.accountValue || '';
  form.tp.value = p.tp || '';
  form.sl.value = p.sl || '';
  form.notes.value = p.notes || '';
  $('#formTitle').textContent = 'Edit position';
  $('#btnSubmit').textContent = 'Save changes';
  updateCalc();
  $('#formCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const p = readForm();
  if (!(p.entry > 0) || !(p.size > 0) || !Number.isFinite(p.time)) { toast('Please fill in price, amount and time.', 'err'); return; }
  if (p.time > Date.now() + 60000) { toast('Entry time is in the future.', 'err'); return; }
  if (p.type !== 'spot') {
    const k = calcPosition(p, state.maxLev);
    if (k.liq && ((p.type === 'long' && p.sl && p.sl <= k.liq) || (p.type === 'short' && p.sl && p.sl >= k.liq))) toast('Heads up: your stop loss is beyond the liquidation price.', 'err');
  }
  if (state.editingId) {
    const i = state.positions.findIndex((x) => x.id === state.editingId);
    state.positions[i] = { ...state.positions[i], ...p };
    commit('Position updated');
  } else {
    state.positions.push({ id: uid(), coin: state.coin, status: 'open', created: Date.now(), ...p });
    state.tab = 'open';
    $$('#posTabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'open'));
    commit(`Added ${posLabel(p)} @ ${fmtUsd(p.entry, 1)}`);
  }
  resetForm();
});
form.addEventListener('input', updateCalc);
$$('#typeSeg button').forEach((b) => b.addEventListener('click', () => setType(b.dataset.type)));
$$('#marginSeg button').forEach((b) => b.addEventListener('click', () => setMargin(b.dataset.mode)));
$('#btnNow').addEventListener('click', () => { form.time.value = toLocalInput(Date.now()); if (state.lastPrice && !form.entry.value) form.entry.value = state.lastPrice.toFixed(1); updateCalc(); });
$('#btnReset').addEventListener('click', resetForm);
$('#btnHistPx').addEventListener('click', async (e) => {
  const t = fromLocalInput(form.time.value);
  if (!Number.isFinite(t)) return toast('Pick a date & time first.', 'err');
  const b = e.currentTarget;
  b.disabled = true; b.textContent = '…';
  try {
    const r = Date.now() - t < 90000 && state.lastPrice ? { price: state.lastPrice, interval: 'live' } : await fetchPriceAt(settings.source, state.coin, t);
    form.entry.value = r.price.toFixed(1);
    toast(`Market price at ${fmtDate(t)}: <b>${fmtUsd(r.price, 1)}</b> <span class="muted">(${r.interval} data)</span>`);
    updateCalc();
  } catch { toast('No price data found for that time.', 'err'); }
  b.disabled = false; b.textContent = 'At time';
});

function setPicking(on) {
  state.picking = on;
  if (on) setDrawing(false);
  $('#pickHint').classList.toggle('hidden', !on);
  $('.chart-wrap').classList.toggle('picking', on);
  $('#btnPick').classList.toggle('toggle', on);
  $('#btnPick').classList.toggle('on', on);
  if (on) $('#chartCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function setDrawing(on) {
  state.drawing = on;
  if (on && state.picking) setPicking(false);
  $('#toolLine').classList.toggle('on', on);
  $('.chart-wrap').classList.toggle('drawing', on);
  if (on) toast('Click on the chart to place a price alert line.');
}
$('#btnPick').addEventListener('click', () => setPicking(!state.picking));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setPicking(false); setDrawing(false); $('#indDropdown').classList.remove('open'); } });

/* ------------------------------------------------------------------ */
/* Toolbar                                                             */
/* ------------------------------------------------------------------ */
function syncToolbar() {
  $$('#tfSeg button').forEach((b) => b.classList.toggle('active', b.dataset.tf === settings.tf));
  $('#chartType').value = settings.chartType;
  $('#sourceSelect').value = settings.source;
  $$('#indDropdown input[data-ind]').forEach((i) => { i.checked = settings.ind.includes(i.dataset.ind); });
  $('#tglForecast').classList.toggle('on', settings.forecast);
  $('#tglPositions').classList.toggle('on', settings.showPositions);
  $('#tglLiq').classList.toggle('on', settings.showLiq);
  $('#tglLog').classList.toggle('on', settings.log);
  $('#fcHorizon').value = String(settings.horizon);
  document.documentElement.dataset.theme = settings.theme;
}

$$('#tfSeg button').forEach((b) => b.addEventListener('click', () => {
  if (settings.tf === b.dataset.tf) return;
  settings.tf = b.dataset.tf; persist(); syncToolbar(); loadData();
}));
$('#chartType').addEventListener('change', (e) => {
  settings.chartType = e.target.value; persist();
  buildPriceSeries(); priceSeries.setData(seriesData()); renderChartPositions();
});
$('#sourceSelect').addEventListener('change', (e) => { settings.source = e.target.value; persist(); loadData({ keepView: true }); loadDayRange(); });
$('#indDropdown [data-dd-toggle]').addEventListener('click', (e) => { e.stopPropagation(); $('#indDropdown').classList.toggle('open'); });
document.addEventListener('click', (e) => { if (!e.target.closest('#indDropdown')) $('#indDropdown').classList.remove('open'); });
$$('#indDropdown input[data-ind]').forEach((i) => i.addEventListener('change', () => {
  settings.ind = $$('#indDropdown input[data-ind]').filter((x) => x.checked).map((x) => x.dataset.ind);
  persist(); renderIndicators(); renderLegend();
}));
$('#tglForecast').addEventListener('click', () => { settings.forecast = !settings.forecast; persist(); syncToolbar(); renderForecast(); });
$('#tglPositions').addEventListener('click', () => { settings.showPositions = !settings.showPositions; persist(); syncToolbar(); renderChartPositions(); });
$('#tglLiq').addEventListener('click', () => { settings.showLiq = !settings.showLiq; persist(); syncToolbar(); renderChartPositions(); });
$('#tglLog').addEventListener('click', () => {
  settings.log = !settings.log; persist(); syncToolbar();
  main.priceScale('right').applyOptions({ mode: settings.log ? LC.PriceScaleMode.Logarithmic : LC.PriceScaleMode.Normal });
});
$('#fcHorizon').addEventListener('change', (e) => { settings.horizon = +e.target.value; persist(); renderForecast(); });
$('#btnFit').addEventListener('click', () => main.timeScale().fitContent());
$('#btnLive').addEventListener('click', () => {
  const n = state.candles.length;
  main.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 160), to: n + (settings.forecast ? +settings.horizon + 4 : 8) });
});
$('#toolLine').addEventListener('click', () => setDrawing(!state.drawing));
$('#clearLines').addEventListener('click', () => {
  if (!settings.alerts.length) return toast('No alert lines to clear.');
  settings.alerts = []; persist(); renderChartPositions(); toast('Alert lines cleared.');
});
$('#btnShot').addEventListener('click', () => {
  const canvas = main.takeScreenshot();
  canvas.toBlob((b) => download(b, `btc-${settings.tf}-${new Date().toISOString().slice(0, 16).replace(':', '')}.png`));
});
$('#btnFull').addEventListener('click', () => {
  const el = $('#chartCard');
  if (document.fullscreenElement) document.exitFullscreen(); else el.requestFullscreen?.();
});
$('#themeToggle').addEventListener('click', () => {
  settings.theme = settings.theme === 'dark' ? 'light' : 'dark'; persist(); syncToolbar(); applyTheme();
});
function applyTheme() {
  const o = themeOpts();
  for (const ch of [main, subs.rsi.chart, subs.macd.chart]) ch.applyOptions(o);
  document.querySelector('meta[name="theme-color"]').content = css('--bg');
  buildPriceSeries();
  if (state.candles.length) { priceSeries.setData(seriesData()); renderIndicators(); renderChartPositions(); }
}

/* Portfolio toolbar */
$$('#posTabs button').forEach((b) => b.addEventListener('click', () => {
  state.tab = b.dataset.tab;
  $$('#posTabs button').forEach((x) => x.classList.toggle('active', x === b));
  renderPortfolio();
}));
$('#scenarioPx').addEventListener('input', renderPortfolio);
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$('#btnExport').addEventListener('click', () => download(new Blob([JSON.stringify({ version: 1, exported: new Date().toISOString(), positions: state.positions }, null, 2)], { type: 'application/json' }), 'glazies-positions.json'));
$('#btnCsv').addEventListener('click', () => download(new Blob([toCsv(state.positions, state.maxLev)], { type: 'text/csv' }), 'glazies-positions.csv'));
$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const list = Array.isArray(data) ? data : data.positions;
    if (!Array.isArray(list)) throw new Error();
    const valid = list.filter((p) => p && p.id && ['spot', 'long', 'short'].includes(p.type) && +p.entry > 0 && +p.size > 0 && Number.isFinite(+p.time));
    const ids = new Set(state.positions.map((p) => p.id));
    let added = 0;
    for (const p of valid) if (!ids.has(p.id)) { state.positions.push(p); added++; }
    commit(`Imported ${added} position${added === 1 ? '' : 's'}`);
  } catch { toast('That file is not a valid positions export.', 'err'); }
  e.target.value = '';
});

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */
syncToolbar();
buildPriceSeries();
if (settings.log) main.priceScale('right').applyOptions({ mode: LC.PriceScaleMode.Logarithmic });
resetForm();
setType('spot');
renderPortfolio();
loadData();
loadCtx();
loadDayRange();
setInterval(loadCtx, 30000);
setInterval(loadDayRange, 10 * 60000);
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) hiddenAt = Date.now();
  else if (state.candles.length && Date.now() - hiddenAt > 120000) loadData({ keepView: true });
});
