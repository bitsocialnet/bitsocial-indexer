// Instance identity, read at request time (server components) so an operator
// can re-label their instance via env without rebuilding. Defaults to Bitsocial.
export const siteName = process.env.SITE_NAME ?? 'Bitsocial';
export const siteBadge = process.env.SITE_BADGE ?? 'Indexer';
export const siteTitle = [siteName, siteBadge].filter(Boolean).join(' ');

/** Public origin of this web UI — canonical URLs, OpenGraph, robots, sitemaps. */
export const siteUrl = (process.env.SITE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

/** UI skin: "default" (Bitsocial dark) or "5chan" (classic imageboard). */
export const theme = process.env.THEME === '5chan' ? '5chan' : 'default';
