// Branding, read at request time (server components) so an operator can
// re-label their instance via env without rebuilding. Defaults to Bitsocial.
export const siteName = process.env.SITE_NAME ?? 'Bitsocial';
export const siteBadge = process.env.SITE_BADGE ?? 'Indexer';
export const siteTitle = [siteName, siteBadge].filter(Boolean).join(' ');
