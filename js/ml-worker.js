// Runs the AI predictor off the main thread so the chart stays smooth.
import { predictNow, backtest } from './ml.js';

self.onmessage = (e) => {
  const { id, kind, candles, hKey, opts } = e.data;
  try {
    const result = kind === 'predict'
      ? predictNow(candles, hKey, opts)
      : backtest(candles, hKey, opts, (p) => self.postMessage({ id, progress: p }));
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: err.message || String(err) });
  }
};
