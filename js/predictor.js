// AI Predictor card: "Predictions" (next hour / day / week) and "Backtest" tabs.
import { fetchCandles } from './data.js';
import { HORIZONS } from './ml.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const nf = (d) => new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const NF0 = nf(0), NF1 = nf(1), NF2 = nf(2);
const usd = (v) => (Number.isFinite(v) ? '$' + NF0.format(v) : '—');
const pct = (v, d = 2) => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + nf(d).format(v * 100) + '%' : '—');
const pc = (v) => (Number.isFinite(v) ? NF1.format(v * 100) + '%' : '—');
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const day = (s) => new Date(s * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const when = (s) => new Date(s * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const MODEL_NAME = { ensemble: 'Ensemble', ridge: 'Ridge regression', knn: 'Pattern matching' };

/* ---------- worker plumbing ---------- */
let worker = null, seq = 0;
const pending = new Map();
try {
  worker = new Worker(new URL('./ml-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const { id, progress, result, error } = e.data;
    const job = pending.get(id);
    if (!job) return;
    if (progress !== undefined) return job.onProgress?.(progress);
    pending.delete(id);
    error ? job.reject(new Error(error)) : job.resolve(result);
  };
  worker.onerror = () => { worker = null; for (const j of pending.values()) j.reject(new Error('worker failed')); pending.clear(); };
} catch { worker = null; }

async function run(kind, candles, hKey, opts, onProgress) {
  if (worker) {
    try {
      return await new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject, onProgress });
        worker.postMessage({ id, kind, candles, hKey, opts });
      });
    } catch (e) { if (worker) throw e; /* worker died → fall through */ }
  }
  const ml = await import('./ml.js');
  await new Promise((r) => setTimeout(r, 0));
  return kind === 'predict' ? ml.predictNow(candles, hKey, opts) : ml.backtest(candles, hKey, opts, onProgress);
}

/* ---------- data ---------- */
const cache = new Map();
async function candlesFor(source, hKey) {
  const H = HORIZONS[hKey];
  const key = `${source}:${H.interval}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60e3) return hit.rows;
  let rows = await fetchCandles(source, 'BTC', H.interval, 5000);
  const now = Date.now() / 1000;
  if (rows.length && rows[rows.length - 1].time + H.barSec > now) rows = rows.slice(0, -1); // drop the unfinished candle
  cache.set(key, { at: Date.now(), rows });
  return rows;
}

export function initPredictor({ getSource, getPrice, themeOpts, localization, css, LC }) {
  const card = $('#aiCard');
  const ui = { tab: 'predict', model: 'ensemble', busy: false, loaded: false, visible: false, btH: '1d', chart: null, series: null };
  try { Object.assign(ui, JSON.parse(localStorage.getItem('glazies.ai.v1') || '{}'), { busy: false, loaded: false, visible: false, chart: null }); } catch {}
  const persist = () => { try { localStorage.setItem('glazies.ai.v1', JSON.stringify({ tab: ui.tab, model: ui.model, btH: ui.btH })); } catch {} };

  /* tabs */
  const setTab = (t, user = false) => {
    ui.tab = t; persist();
    $$('#aiTabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
    $('#aiPredict').classList.toggle('hidden', t !== 'predict');
    $('#aiBacktest').classList.toggle('hidden', t !== 'backtest');
    $('#aiRefresh').classList.toggle('hidden', t !== 'predict');
    if (user && t === 'predict') refresh();
  };
  $$('#aiTabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab, true)));
  $('#aiModel').value = ui.model;
  $('#aiModel').addEventListener('change', (e) => { ui.model = e.target.value; persist(); refresh(true); });
  $('#aiRefresh').addEventListener('click', () => { cache.clear(); refresh(true); });
  setTab(ui.tab);

  /* ---------- predictions ---------- */
  const skeleton = (H) => `<div class="ai-pred loading" data-h="${H.key}"><div class="ai-pred-head"><h3>${H.label}</h3><span class="muted small">training…</span></div><div class="ai-skel"></div><div class="ai-skel short"></div><div class="ai-skel"></div></div>`;

  function renderCard(H, p, bt, err) {
    const el = $(`.ai-pred[data-h="${H.key}"]`);
    if (!el) return;
    if (err) { el.className = 'ai-pred'; el.innerHTML = `<div class="ai-pred-head"><h3>${H.label}</h3></div><p class="muted small">Couldn't run the model: ${err}</p>`; return; }
    const up = p.pUp >= 0.5;
    const conf = Math.abs(p.pUp - 0.5);
    const strength = conf < 0.03 ? 'Toss-up' : conf < 0.08 ? (up ? 'Leaning up' : 'Leaning down') : (up ? 'Likely up' : 'Likely down');
    const by = new Date(Date.now() + H.h * H.barSec * 1000).toLocaleString(undefined, H.key === '1w' ? { weekday: 'short', month: 'short', day: 'numeric' } : { weekday: H.key === '1d' ? 'short' : undefined, hour: '2-digit', minute: '2-digit' });
    let track = '<span class="muted">checking track record…</span>';
    if (bt) {
      const base = Math.max(bt.accBy.alwaysUp, 1 - bt.accBy.alwaysUp);
      const edge = bt.significant ? '<span class="tag edge">proven edge</span>' : '<span class="tag noedge">no proven edge</span>';
      track = `Right <b>${pc(bt.acc)}</b> of the time over ${day(bt.from)} – ${day(bt.to)} (baseline ${pc(base)}) ${edge}`;
    } else if (bt === false) track = '<span class="muted">track record unavailable</span>';
    el.className = `ai-pred ${up ? 'is-up' : 'is-down'}`;
    el.innerHTML = `
      <div class="ai-pred-head"><h3>${H.label}</h3><span class="muted small">by ${by}</span></div>
      <div class="ai-call ${up ? 'up' : 'down'}">
        <span class="arrow">${up ? '▲' : '▼'}</span>
        <div><div class="call">${strength}</div><div class="muted small">${pc(up ? p.pUp : 1 - p.pUp)} chance of going ${up ? 'up' : 'down'}</div></div>
      </div>
      <div class="ai-meter" title="Probability BTC is higher in ${H.span}"><span class="down-side"></span><i style="left:${(p.pUp * 100).toFixed(1)}%"></i></div>
      <div class="ai-meter-lbl muted small"><span>Down</span><span>${pc(p.pUp)} up</span><span>Up</span></div>
      <div class="calc ai-nums">
        <span>Expected</span><b class="mono ${cls(p.move)}">${usd(p.expected)} <small>${pct(p.move)}</small></b>
        <span>Likely range (68%)</span><b class="mono">${usd(p.r68[0])} – ${usd(p.r68[1])}</b>
        <span>Wide range (95%)</span><b class="mono">${usd(p.r95[0])} – ${usd(p.r95[1])}</b>
      </div>
      <div class="ai-track small">${track}</div>
      <div class="ai-why"><div class="mini-head">What the model is looking at</div>
        <ul>${p.drivers.map((d) => `<li><span>${d.label}</span><span class="tag ${d.value > 0 ? 'long' : 'short'}">${d.value > 0 ? 'pushes up' : 'pushes down'}</span></li>`).join('')}</ul>
      </div>
      <div class="muted tiny">Trained on ${NF0.format(p.trainedOn)} past ${H.interval} candles (${day(p.from)} – ${day(p.to)}).</div>`;
  }

  async function refresh(force = false) {
    if (ui.busy || (!force && ui.loaded)) return;
    ui.busy = true; ui.loaded = true;
    $('#aiCards').innerHTML = Object.values(HORIZONS).map(skeleton).join('');
    $('#aiUpdated').textContent = 'updating…';
    const source = getSource();
    for (const H of Object.values(HORIZONS)) {
      try {
        const rows = await candlesFor(source, H.key);
        const p = await run('predict', rows, H.key, { model: ui.model, anchor: getPrice() || rows[rows.length - 1].close });
        renderCard(H, p, null);
        run('backtest', rows, H.key, { model: ui.model, testFrac: 0.3 })
          .then((bt) => renderCard(H, p, bt))
          .catch(() => renderCard(H, p, false));
      } catch (e) { renderCard(H, null, null, e.message); }
    }
    $('#aiUpdated').textContent = `updated ${new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
    ui.busy = false;
  }

  // Train lazily the first time the card scrolls into view, then every 5 minutes while visible
  new IntersectionObserver((ents) => {
    ui.visible = ents.some((e) => e.isIntersecting);
    if (ui.visible) refresh();
  }, { rootMargin: '200px' }).observe(card);
  setInterval(() => { if (ui.visible && ui.tab === 'predict' && !document.hidden) refresh(true); }, 5 * 60e3);

  /* ---------- backtest ---------- */
  $$('#btHorizon button').forEach((b) => {
    b.classList.toggle('active', b.dataset.h === ui.btH);
    b.addEventListener('click', () => { ui.btH = b.dataset.h; persist(); $$('#btHorizon button').forEach((x) => x.classList.toggle('active', x === b)); });
  });
  $('#btForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (ui.btBusy) return;
    ui.btBusy = true;
    const btn = $('#btRun'), bar = $('#btProgress');
    btn.disabled = true; btn.textContent = 'Running…';
    bar.classList.remove('hidden'); bar.firstElementChild.style.width = '2%';
    $('#btEmpty').classList.add('hidden');
    try {
      const rows = await candlesFor(getSource(), ui.btH);
      const opts = { model: ui.model, testFrac: +$('#btTest').value, threshold: +$('#btThr').value, feeBps: +$('#btFee').value };
      const r = await run('backtest', rows, ui.btH, opts, (p) => { bar.firstElementChild.style.width = `${Math.max(2, p * 100)}%`; });
      renderBacktest(r);
    } catch (err) {
      $('#btResult').classList.add('hidden');
      $('#btEmpty').classList.remove('hidden');
      $('#btEmpty').innerHTML = `<p>Backtest failed: ${err.message}</p>`;
    }
    btn.disabled = false; btn.textContent = 'Run backtest';
    bar.classList.add('hidden');
    ui.btBusy = false;
  });

  function renderBacktest(r) {
    const H = HORIZONS[r.hKey];
    const base = Math.max(r.accBy.alwaysUp, 1 - r.accBy.alwaysUp);
    const s = r.strategy;
    const stat = (label, val, sub = '', c = '') => `<div class="stat"><label>${label}</label><div class="val ${c}">${val}</div><div class="sub">${sub}</div></div>`;
    $('#btStats').innerHTML = [
      stat('Direction right', pc(r.acc), `coin flip 50% · always-${r.accBy.alwaysUp >= 0.5 ? 'up' : 'down'} ${pc(base)}`, r.acc > base ? 'up' : 'down'),
      stat('Confident calls', r.confAcc == null || !r.threshold ? '—' : pc(r.confAcc), r.threshold ? `${pc(r.coverage)} of the time it was ≥ ${pc(0.5 + r.threshold)} sure` : 'set a confidence filter to see this'),
      stat('Real edge?', r.significant ? 'Yes' : 'Not proven', `z-score ${NF2.format(r.zScore)} (needs > 2)`, r.significant ? 'up' : 'warn'),
      stat('Strategy return', pct(s.ret, 1), `buy &amp; hold ${pct(s.hold, 1)}`, cls(s.ret)),
      stat('Max drawdown', pc(s.mdd), 'worst peak-to-low drop', s.mdd > 0.25 ? 'down' : ''),
      stat('Trades', NF0.format(s.trades), s.winRate == null ? '' : `${pc(s.winRate)} profitable`),
      stat('Price error', pc(r.mae), `"no change" guess: ${pc(r.maeNaive)}`, r.mae < r.maeNaive ? 'up' : 'down'),
      stat('Inside 68% range', pc(r.band68), 'should be ≈ 68% if ranges are honest'),
      stat('Test period', `${day(r.from)} – ${day(r.to)}`, `${NF0.format(r.n)} predictions, ${H.span} ahead`),
    ].join('');

    const rowsCmp = [
      ['Ensemble (both)', r.accBy.ensemble], ['Ridge regression', r.accBy.ridge], ['Pattern matching', r.accBy.knn],
      ['Momentum (repeat last move)', r.accBy.momentum], [`Always ${r.accBy.alwaysUp >= 0.5 ? 'up' : 'down'}`, base], ['Coin flip', 0.5],
    ];
    $('#btCompare').innerHTML = rowsCmp.map(([n, a]) => `<tr><td>${n}</td><td class="num mono">${pc(a)}</td><td class="bar-cell"><span class="acc-bar ${a > base ? 'good' : ''}" style="width:${Math.max(0, Math.min(100, (a - 0.4) / 0.2 * 100))}%"></span></td></tr>`).join('');

    $('#btRecent').innerHTML = r.recent.map((x) => `<tr><td>${when(x.time)}</td><td class="num mono">${usd(x.P0)}</td><td class="num mono">${usd(x.pred)}</td><td class="num mono">${usd(x.P1)}</td><td class="num mono">${pc(x.p)}</td><td class="num">${x.hit ? '<span class="up">✓</span>' : '<span class="down">✗</span>'}</td></tr>`).join('');

    let verdict;
    if (r.significant && s.ret > s.hold) verdict = `Over this period the ${MODEL_NAME[r.model].toLowerCase()} model called the ${H.span} direction correctly ${pc(r.acc)} of the time — better than the ${pc(base)} baseline by more than luck would explain — and its simple strategy beat buy &amp; hold. Past results still don't guarantee future ones.`;
    else if (r.acc > base) verdict = `The model was right ${pc(r.acc)} of the time vs a ${pc(base)} baseline — slightly better, but not by enough to rule out luck. Treat its calls as a weak hint, not a signal.`;
    else verdict = `The model was right ${pc(r.acc)} of the time, no better than the ${pc(base)} baseline. Over this period it had no usable edge for ${H.span} moves — which is normal: short-term crypto prices are very close to random.`;
    $('#btVerdict').innerHTML = verdict;

    $('#btResult').classList.remove('hidden');
    if (!ui.chart) {
      ui.chart = LC.createChart($('#btChart'), { ...themeOpts(), autoSize: true, localization: { ...localization, priceFormatter: (p) => `${p >= 0 ? '+' : ''}${NF1.format(p)}%` } });
      ui.chart.applyOptions({ rightPriceScale: { minimumWidth: 60 }, layout: { attributionLogo: false } });
      ui.hold = ui.chart.addLineSeries({ color: css('--muted'), lineWidth: 1.5, title: 'Buy & hold', priceLineVisible: false });
      ui.series = ui.chart.addLineSeries({ color: css('--accent'), lineWidth: 2, title: 'AI strategy', priceLineVisible: false });
    }
    const toPct = (a) => a.map((p) => ({ time: p.time, value: +((p.value - 1) * 100).toFixed(2) }));
    ui.series.setData(toPct(s.equity));
    ui.hold.setData(toPct(s.holdCurve));
    ui.chart.timeScale().fitContent();
  }

  return {
    applyTheme() {
      if (!ui.chart) return;
      ui.chart.applyOptions(themeOpts());
      ui.hold.applyOptions({ color: css('--muted') });
      ui.series.applyOptions({ color: css('--accent') });
    },
    sourceChanged() { if (ui.loaded) refresh(true); },
  };
}
