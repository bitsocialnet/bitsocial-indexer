// Next runs this module before hydration. Keep bootstrap synchronous so Bippy
// installs its React hook before the browser renderer commits any application work.
if (process.env.NODE_ENV === 'development' || process.env.NEXT_PUBLIC_REACT_PERF === '1') {
  const { installCollector } = require('./scripts/react-perf/collector.mjs') as typeof import('./scripts/react-perf/collector.mjs');
  installCollector({ buildType: process.env.NODE_ENV === 'development' ? 'development' : 'profiling' });
}

export {};
