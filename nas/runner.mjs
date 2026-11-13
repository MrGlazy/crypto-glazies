// Runs on the NAS (Docker, Node 20): retrains every few minutes and uploads to the website.
//   SITE_URL       https://crypto.glazzy.site
//   UPLOAD_TOKEN   secret matching the hash in api/predictions.php
//   EVERY_MIN      minutes between prediction updates (default 5)
//   BACKTEST_MIN   minutes between track-record backtests (default 60)
//   RESTART_HOURS  exit after this long so Docker restarts with the latest code (default 12)
// Pausing: the site owner's Pause button (AI Predictor card) stops all calculations; while paused
// the runner only checks once a minute whether it has been resumed.
import { computeAll, upload, isPaused } from './compute.mjs';

const SITE = process.env.SITE_URL || 'https://crypto.glazzy.site';
const TOKEN = process.env.UPLOAD_TOKEN || '';
const EVERY = +(process.env.EVERY_MIN || 5) * 60e3;
const BT_EVERY = +(process.env.BACKTEST_MIN || 60) * 60e3;
const RESTART = +(process.env.RESTART_HOURS || 12) * 3600e3;
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!TOKEN) { log('UPLOAD_TOKEN is not set — stopping.'); process.exit(1); }

const started = Date.now();
let prev = null, lastBt = 0, wasPaused = false;
for (;;) {
  if (await isPaused(SITE)) {
    if (!wasPaused) log('paused from the website — no calculations until resumed');
    wasPaused = true;
    await sleep(60e3);
    continue;
  }
  if (wasPaused) { log('resumed'); wasPaused = false; }

  const t0 = Date.now();
  try {
    const withBacktest = t0 - lastBt >= BT_EVERY;
    const payload = await computeAll({ withBacktest, prev, log });
    await upload(SITE, TOKEN, payload);
    if (withBacktest) lastBt = t0;
    prev = payload;
    log(`uploaded in ${Math.round((Date.now() - t0) / 1000)}s`);
  } catch (e) {
    log('error:', e.message);
  }
  if (Date.now() - started > RESTART) { log('restarting to pick up new code'); process.exit(0); }
  // wait until the next cycle, checking the pause switch every minute
  const until = t0 + EVERY;
  while (Date.now() < until - 1000) {
    await sleep(Math.min(60e3, until - Date.now()));
    if (await isPaused(SITE)) break;
  }
}
