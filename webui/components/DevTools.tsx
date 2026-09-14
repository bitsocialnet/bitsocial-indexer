'use client';

import dynamic from 'next/dynamic';

// Keep browser annotation tooling out of server rendering and production bundles.
const Agentation = process.env.NODE_ENV === 'development'
  ? dynamic(() => import('agentation').then((mod) => mod.Agentation), { ssr: false })
  : null;

export function DevTools() {
  return Agentation ? <Agentation /> : null;
}
