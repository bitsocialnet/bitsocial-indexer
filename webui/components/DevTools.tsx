'use client';

import dynamic from 'next/dynamic';

// Keep browser annotation tooling out of server rendering and production bundles.
const Agentation = process.env.NODE_ENV === 'development' && process.env.NEXT_PUBLIC_REACT_PERF !== '1'
  ? dynamic(() => import('agentation').then((mod) => mod.Agentation), { ssr: false })
  : null;

export function DevTools() {
  return Agentation ? <Agentation /> : null;
}
