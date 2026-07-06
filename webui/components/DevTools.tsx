'use client';

import { useEffect } from 'react';

/**
 * Development-only React tooling, mirroring the 5chan client's setup:
 *
 * - react-scan: render highlighting + toolbar; the report API is exposed as
 *   window.__getReactScanReport for profiling agents.
 * - react-grab: element → component grabbing for agents/tooling, exposed as
 *   window.__REACT_GRAB__ (plus a "react-grab:init" event). Toolbar activation
 *   only — the keyboard shortcut is disabled to avoid copy/paste conflicts.
 *
 * Both imports live inside a `NODE_ENV === 'development'` branch, which the
 * bundler evaluates at build time, so neither package (nor this effect body)
 * reaches a production bundle — verified by grepping the build output.
 */
export function DevTools() {
  useEffect(() => {
    if (process.env.NODE_ENV === 'development') {
      import('react-scan').then(({ scan, getReport }) => {
        scan({ enabled: true });
        (window as unknown as Record<string, unknown>).__getReactScanReport = getReport;
      });
      import('react-grab/core').then((mod) => {
        const api = mod.init({ activationKey: () => false });
        (window as unknown as Record<string, unknown>).__REACT_GRAB__ = api;
        window.dispatchEvent(new CustomEvent('react-grab:init', { detail: api }));
      });
    }
  }, []);
  return null;
}
