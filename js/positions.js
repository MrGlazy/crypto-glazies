// Position math (Hyperliquid margin model) and persistence.

export const HL_FEES = { taker: 0.00045, maker: 0.00015 }; // base tier
const KEY = 'glazies.positions.v1';

/**
 * Hyperliquid liquidation price.
 *   liq = entry - side * marginAvailable / size / (1 - l * side)
 *   l = 1 / maintenanceLeverage, maintenanceLeverage = 2 * maxLeverage
 *   isolated: marginAvailable = isolatedMargin - maintenanceMargin
 *   cross:    marginAvailable = accountValue  - maintenanceMargin
 */
export function calcPosition(p, maxLev = 40) {
  const size = +p.size, entry = +p.entry;
  const notional = size * entry;
  if (p.type === 'spot' || !size || !entry) {
    return { notional, margin: notional, liq: null, l: 0, side: 1, fee: 0 };
  }
  const side = p.type === 'long' ? 1 : -1;
  const lev = Math.max(1, Math.min(+p.leverage || 1, maxLev));
  const l = 1 / (2 * maxLev);
  const initMargin = notional / lev;
  const maint = notional * l;
  const useCross = p.marginMode === 'cross' && +p.accountValue > 0;
  const collateral = useCross ? +p.accountValue : initMargin;
  const avail = collateral - maint;
  let liq = entry - (side * avail) / size / (1 - l * side);
  if (!(liq > 0)) liq = null; // long that cannot be liquidated
  const liqCalc = liq;
  if (+p.liqOverride > 0) liq = +p.liqOverride; // exact value copied from the exchange
  return {
    notional, margin: initMargin, maint, liq, liqCalc, liqFromExchange: +p.liqOverride > 0, l, side, lev, collateral,
    fee: notional * HL_FEES.taker,
    mmRate: l,
  };
}

export function pnlAt(p, price, maxLev) {
  const k = calcPosition(p, maxLev);
  const diff = p.type === 'short' ? +p.entry - price : price - +p.entry;
  const pnl = diff * +p.size;
  const base = p.type === 'spot' ? k.notional : k.margin; // ROE on initial margin, like Hyperliquid
  const roe = base ? pnl / base : 0;
  let liqDist = null;
  if (k.liq) liqDist = Math.abs(price - k.liq) / price;
  return { ...k, pnl, roe, liqDist, value: p.type === 'spot' ? price * +p.size : k.margin + pnl };
}

export function realized(p, maxLev) {
  if (p.status !== 'closed') return 0;
  if (Number.isFinite(p.realizedPnl)) return p.realizedPnl; // exact figure from the exchange
  return pnlAt(p, +p.exit, maxLev).pnl;
}

/** Capital put into a trade: margin for perps, cost for spot. */
export function capitalOf(p, maxLev) {
  if (p.fills?.length) return p.fills.reduce((a, f) => a + +f.usd, 0);
  const k = calcPosition(p, maxLev);
  return p.type === 'spot' ? k.notional : k.margin;
}

/**
 * Imported trades carry fills [{time, usd, entry}] where usd = margin put in.
 * Once every fill has a market price, derive size, average entry and exit.
 */
export function finalizeFromFills(p) {
  if (p.lockEntry && +p.entry > 0 && +p.size > 0) { // exact entry/size known from the exchange
    p.time = Math.min(...p.fills.map((f) => f.time));
    delete p.needsPrice;
    return p;
  }
  const lev = p.type === 'spot' ? 1 : Math.max(1, +p.leverage || 1);
  let size = 0, notional = 0;
  for (const f of p.fills) { const n = +f.usd * lev; notional += n; size += n / f.entry; }
  p.size = size;
  p.entry = notional / size;
  p.time = Math.min(...p.fills.map((f) => f.time));
  if (p.status === 'closed' && Number.isFinite(p.realizedPnl)) {
    p.exit = p.entry + (p.type === 'short' ? -1 : 1) * p.realizedPnl / size;
  }
  delete p.needsPrice;
  return p;
}

export function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; }
}
export function save(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch {}
}
export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export function toCsv(list, maxLev) {
  const head = ['id', 'type', 'venue', 'status', 'entry_time', 'entry', 'size_btc', 'notional_usd', 'leverage', 'margin_mode', 'liq_price', 'tp', 'sl', 'exit_time', 'exit', 'realized_pnl', 'notes'];
  const rows = list.map((p) => {
    const k = calcPosition(p, maxLev);
    return [p.id, p.type, p.venue, p.status, new Date(p.time).toISOString(), p.entry, p.size, k.notional.toFixed(2),
      p.type === 'spot' ? 1 : p.leverage, p.type === 'spot' ? '' : p.marginMode, k.liq ? k.liq.toFixed(2) : '',
      p.tp || '', p.sl || '', p.exitTime ? new Date(p.exitTime).toISOString() : '', p.exit || '',
      p.status === 'closed' ? realized(p, maxLev).toFixed(2) : '', (p.notes || '').replace(/"/g, '""')]
      .map((v) => `"${v}"`).join(',');
  });
  return [head.join(','), ...rows].join('\n');
}
