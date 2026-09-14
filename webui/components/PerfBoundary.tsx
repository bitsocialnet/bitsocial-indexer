'use client';

import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from 'react';

const recordRender: ProfilerOnRenderCallback = (...args) => {
  window.__REACT_PERF__?.onProfilerRender(...args);
};

/** Measures the client subtree; Server Component execution is outside this boundary. */
export function PerfBoundary({ children }: { children: ReactNode }) {
  if (
    process.env.NODE_ENV !== 'development' && process.env.NEXT_PUBLIC_REACT_PERF !== '1'
  ) {
    return children;
  }

  return <Profiler id="webui" onRender={recordRender}>{children}</Profiler>;
}
