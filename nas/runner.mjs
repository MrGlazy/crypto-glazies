// Runs on the NAS (Docker, Node 20): retrains every few minutes and uploads to the website.
//   SITE_URL       https://crypto.glazzy.site
//   UPLOAD_TOKEN   secret matching the hash in api/predictions.php
//   EVERY_MIN      minutes between prediction updates (default 5)
//   BACKTEST_MIN   minutes between track-record backtests (default 60)
//   RESTART_HOURS  exit after this long so Docker restarts with the latest code (default 12)
import { computeAll, upload } from './compute.mjs';

const SITE = process.env.SITE_URL || 'https://crypto.glazzy.site';
const TOKEN = process.env.UPLOAD_TOKEN || '';
const EVERY = +(process.env.EVERY_MIN || 5) * 60e3;
const BT_EVERY = +(process.env.BACKTEST_MIN || 60) * 60e3;
const RESTART = +(process.env.RESTART_HOURS || 12) * 3600e3;
const log = (...a) => console.log(new Date().toISOString(), ...a);

if (!TOKEN) { log('UPLOAD_TOKEN is not set — stopping.'); process.exit(1); }

const started = Date.now();
let prev = null, lastBt = 0;
for (;;) {
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
  await new Promise((r) => setTimeout(r, Math.max(30e3, EVERY - (Date.now() - t0))));
}
