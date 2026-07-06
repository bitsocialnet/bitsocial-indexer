/** Compact relative time from a unix-seconds timestamp. */
export function timeAgo(sec: number): string {
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - sec);
  const units: [number, string][] = [
    [31_536_000, 'y'],
    [2_592_000, 'mo'],
    [604_800, 'w'],
    [86_400, 'd'],
    [3_600, 'h'],
    [60, 'm'],
  ];
  for (const [s, label] of units) {
    if (delta >= s) return `${Math.floor(delta / s)}${label} ago`;
  }
  return 'just now';
}

/** Single-line excerpt for meta descriptions / OG tags. */
export function excerpt(text: string | null | undefined, max = 160): string {
  if (!text) return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}
