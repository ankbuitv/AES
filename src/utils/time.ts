/** Time helpers. All timestamps in D1 are unix SECONDS (integer). */

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

export const SECOND = 1;
export const MINUTE = 60;
export const HOUR = 3600;
export const DAY = 86400;
export const WEEK = 604800;

export function fromNow(seconds: number): number {
  return now() + seconds;
}

export function toIso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

export function dayKey(unixSeconds: number = now()): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/** Human relative time used by SSR output ("3h ago"). */
export function relativeTime(unixSeconds: number, reference: number = now()): string {
  const diff = Math.max(0, reference - unixSeconds);
  if (diff < 45) return 'just now';
  if (diff < 90) return '1m';
  if (diff < HOUR) return `${Math.round(diff / MINUTE)}m`;
  if (diff < DAY) return `${Math.round(diff / HOUR)}h`;
  if (diff < WEEK) return `${Math.round(diff / DAY)}d`;
  if (diff < DAY * 365) {
    return new Date(unixSeconds * 1000).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
  }
  return new Date(unixSeconds * 1000).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Reddit-style hot score: log-scaled engagement plus a time term, so new
 * content can outrank old content without a full re-sort of the table.
 */
export function hotScore(
  reactions: number,
  comments: number,
  views: number,
  createdAt: number,
): number {
  const engagement = reactions * 3 + comments * 4 + Math.min(views, 10_000) * 0.05;
  const order = Math.log10(Math.max(Math.abs(engagement), 1));
  const sign = engagement > 0 ? 1 : engagement < 0 ? -1 : 0;
  // Epoch: 2024-01-01T00:00:00Z. 45_000s ≈ 12.5h half-life per order of magnitude.
  const seconds = createdAt - 1_704_067_200;
  return Number((sign * order + seconds / 45_000).toFixed(7));
}
