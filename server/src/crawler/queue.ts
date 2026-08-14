/** Per-community crawl scheduling backed by the `crawl_queue` table. */
import { config } from '../config.js';
import { getDb } from '../db/index.js';

const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * How long a `running` row may hold its slot before another pass may claim it.
 * Generous relative to the per-pass cap: the lease is the backstop for a pass
 * that vanished without settling (killed process, unhandled hang), not the
 * primary bound — `config.crawlTimeoutMs` is.
 */
const leaseSeconds = () => Math.ceil((config.crawlTimeoutMs * 2) / 1000);

export interface QueueRow {
  community_address: string;
  status: string;
  attempts: number;
  last_success_at: number | null;
  last_error: string | null;
  next_run_at: number | null;
  started_at: number | null;
}

export function enqueue(address: string): void {
  getDb()
    .prepare(
      `INSERT INTO crawl_queue (community_address, status, next_run_at)
       VALUES (@address, 'queued', @now)
       ON CONFLICT(community_address) DO NOTHING`,
    )
    .run({ address, now: nowSec() });
}

/**
 * Communities whose next_run_at is due (or never run).
 *
 * A `running` row is claimed by a pass in flight and normally skipped — but one
 * whose lease has expired is due again. Without that, a pass that never settled
 * would hold its row forever and silently retire that community from the
 * archive. `started_at IS NULL` covers rows claimed before the column existed,
 * which are by definition abandoned.
 */
export function due(): QueueRow[] {
  const now = nowSec();
  return getDb()
    .prepare(
      `SELECT * FROM crawl_queue
        WHERE (status != 'running' OR started_at IS NULL OR started_at <= @stale)
          AND (next_run_at IS NULL OR next_run_at <= @now)
        ORDER BY next_run_at ASC NULLS FIRST`,
    )
    .all({ now, stale: now - leaseSeconds() }) as QueueRow[];
}

/**
 * Release leases held by a process that is no longer running. A freshly started
 * crawler owns no in-flight passes, so every `running` row it finds was
 * abandoned mid-crawl (restart, OOM kill, redeploy). Returns the row count.
 */
export function reclaimAbandoned(): number {
  return getDb()
    .prepare(
      `UPDATE crawl_queue
          SET status = 'queued', started_at = NULL, next_run_at = @now
        WHERE status = 'running'`,
    )
    .run({ now: nowSec() }).changes;
}

export function markRunning(address: string): void {
  getDb()
    .prepare(`UPDATE crawl_queue SET status = 'running', started_at = @now WHERE community_address = @address`)
    .run({ address, now: nowSec() });
}

export function markSuccess(address: string, nextRunAt: number): void {
  getDb()
    .prepare(
      `UPDATE crawl_queue
          SET status = 'success', attempts = 0, last_error = NULL, started_at = NULL,
              last_success_at = @now, next_run_at = @next
        WHERE community_address = @address`,
    )
    .run({ address, now: nowSec(), next: nextRunAt });
}

export function markFailed(address: string, error: string, retryAt: number): void {
  getDb()
    .prepare(
      `UPDATE crawl_queue
          SET status = 'failed', attempts = attempts + 1, started_at = NULL,
              last_error = @error, next_run_at = @retry
        WHERE community_address = @address`,
    )
    .run({ address, error: error.slice(0, 500), retry: retryAt });
}
