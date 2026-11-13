// Market data: Hyperliquid (primary) and Binance (fallback), REST + WebSocket.

export const HL_INFO = 'https://api.hyperliquid.xyz/info';
export const HL_WS = 'wss://api.hyperliquid.xyz/ws';

export const INTERVAL_SEC = {
  '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800,
};

const BINANCE_SYMBOL = { BTC: 'BTCUSDT' };

async function hlInfo(body, signal) {
  const r = await fetch(HL_INFO, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!r.ok) throw new Error(`Hyperliquid ${r.status}`);
  return r.json();
}

const mapHL = (c) => ({
  time: Math.floor(c.t / 1000),
  open: +c.o, high: +c.h, low: +c.l, close: +c.c, volume: +c.v,
});
const mapBN = (k) => ({
  time: Math.floor(k[0] / 1000),
  open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
});

function dedupeSort(rows) {
  const m = new Map();
  for (const r of rows) m.set(r.time, r);
  return [...m.values()].sort((a, b) => a.time - b.time);
}

/** Latest ~`bars` candles for coin/interval. */
export async function fetchCandles(source, coin, interval, bars = 5000) {
  const now = Date.now();
  const span = INTERVAL_SEC[interval] * 1000 * bars;
  if (source === 'hyperliquid') {
    const rows = await hlInfo({
      type: 'candleSnapshot',
      req: { coin, interval, startTime: now - span, endTime: now },
    });
    if (!Array.isArray(rows) || !rows.length) throw new Error('No candles from Hyperliquid');
    return dedupeSort(rows.map(mapHL));
  }
  // Binance: 1000 per request, page backwards
  const sym = BINANCE_SYMBOL[coin];
  let end = now;
  let all = [];
  const pages = Math.ceil(Math.min(bars, 3000) / 1000);
  for (let i = 0; i < pages; i++) {
    const u = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${interval}&limit=1000&endTime=${end}`;
    const r = await fetch(u);
    if (!r.ok) throw new Error(`Binance ${r.status}`);
    const k = await r.json();
    if (!k.length) break;
    all = k.map(mapBN).concat(all);
    end = k[0][0] - 1;
    if (k.length < 1000) break;
  }
  if (!all.length) throw new Error('No candles from Binance');
  return dedupeSort(all);
}

/** Market price at a past moment (open of the finest candle that still has data). */
export async function fetchPriceAt(source, coin, tsMs) {
  const tries = ['1m', '15m', '1h', '1d'];
  for (const iv of tries) {
    const ms = INTERVAL_SEC[iv] * 1000;
    try {
      let rows;
      if (source === 'hyperliquid') {
        rows = (await hlInfo({ type: 'candleSnapshot', req: { coin, interval: iv, startTime: tsMs - ms, endTime: tsMs + ms } })).map(mapHL);
      } else {
        const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${BINANCE_SYMBOL[coin]}&interval=${iv}&startTime=${tsMs - ms}&endTime=${tsMs + ms}&limit=5`);
        rows = (await r.json()).map(mapBN);
      }
      const t = tsMs / 1000;
      const c = rows.find((x) => x.time <= t && t < x.time + INTERVAL_SEC[iv]);
      if (c) {
        // interpolate inside the candle between open and close
        const f = (t - c.time) / INTERVAL_SEC[iv];
        return { price: c.open + (c.close - c.open) * f, interval: iv };
      }
    } catch { /* try coarser */ }
  }
  throw new Error('No price data for that time');
}

/** Perp context: mark, oracle, funding, OI, max leverage. */
export async function fetchMarketCtx(coin) {
  const [meta, ctxs] = await hlInfo({ type: 'metaAndAssetCtxs' });
  const idx = meta.universe.findIndex((u) => u.name === coin);
  if (idx < 0) throw new Error('coin not found');
  const c = ctxs[idx];
  return {
    maxLeverage: meta.universe[idx].maxLeverage,
    mark: +c.markPx, oracle: +c.oraclePx, mid: c.midPx ? +c.midPx : null,
    funding: +c.funding, openInterest: +c.openInterest,
    prevDayPx: +c.prevDayPx, dayNtlVlm: +c.dayNtlVlm,
  };
}

/** Auto-reconnecting live feed. Emits onCandle(bar) and onCtx(ctx). */
export class LiveFeed {
  constructor({ onCandle, onCtx, onStatus }) {
    Object.assign(this, { onCandle, onCtx, onStatus });
    this.ws = null; this.timer = null; this.ping = null; this.closed = false;
  }
  start(source, coin, interval) {
    this.stop();
    this.closed = false;
    Object.assign(this, { source, coin, interval });
    this._connect();
  }
  stop() {
    this.closed = true;
    clearTimeout(this.timer); clearInterval(this.ping);
    if (this.ws) { this.ws.onclose = null; try { this.ws.close(); } catch {} }
    this.ws = null;
  }
  _connect() {
    const { source, coin, interval } = this;
    this.onStatus?.('connecting');
    let ws;
    try {
      ws = source === 'hyperliquid'
        ? new WebSocket(HL_WS)
        : new WebSocket(`wss://stream.binance.com:9443/ws/${BINANCE_SYMBOL[coin].toLowerCase()}@kline_${interval}`);
    } catch { return this._retry(); }
    this.ws = ws;
    ws.onopen = () => {
      this.onStatus?.('live');
      if (source === 'hyperliquid') {
        ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'candle', coin, interval } }));
        ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'activeAssetCtx', coin } }));
        this.ping = setInterval(() => ws.readyState === 1 && ws.send('{"method":"ping"}'), 30000);
      }
    };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (source === 'hyperliquid') {
        if (m.channel === 'candle' && m.data) {
          if (m.data.i === this.interval) this.onCandle?.(mapHL(m.data));
        } else if (m.channel === 'activeAssetCtx' && m.data?.ctx) {
          const c = m.data.ctx;
          this.onCtx?.({
            mark: +c.markPx, oracle: +c.oraclePx, mid: c.midPx ? +c.midPx : null,
            funding: +c.funding, openInterest: +c.openInterest,
            prevDayPx: +c.prevDayPx, dayNtlVlm: +c.dayNtlVlm,
          });
        }
      } else if (m.k) {
        const k = m.k;
        this.onCandle?.({ time: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v });
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => { clearInterval(this.ping); this._retry(); };
  }
  _retry() {
    if (this.closed) return;
    this.onStatus?.('off');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._connect(), 3000);
  }
}
