/** Per-community crawl scheduling backed by the `crawl_queue` table. */
import { getDb } from '../db/index.js';

const nowSec = () => Math.floor(Date.now() / 1000);

export interface QueueRow {
  community_address: string;
  status: string;
  attempts: number;
  last_success_at: number | null;
  last_error: string | null;
  next_run_at: number | null;
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

/** Communities whose next_run_at is due (or never run). */
export function due(): QueueRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM crawl_queue
        WHERE status != 'running' AND (next_run_at IS NULL OR next_run_at <= @now)
        ORDER BY next_run_at ASC NULLS FIRST`,
    )
    .all({ now: nowSec() }) as QueueRow[];
}

export function markRunning(address: string): void {
  getDb().prepare(`UPDATE crawl_queue SET status = 'running' WHERE community_address = @address`).run({ address });
}

export function markSuccess(address: string, nextRunAt: number): void {
  getDb()
    .prepare(
      `UPDATE crawl_queue
          SET status = 'success', attempts = 0, last_error = NULL,
              last_success_at = @now, next_run_at = @next
        WHERE community_address = @address`,
    )
    .run({ address, now: nowSec(), next: nextRunAt });
}

export function markFailed(address: string, error: string, retryAt: number): void {
  getDb()
    .prepare(
      `UPDATE crawl_queue
          SET status = 'failed', attempts = attempts + 1,
              last_error = @error, next_run_at = @retry
        WHERE community_address = @address`,
    )
    .run({ address, error: error.slice(0, 500), retry: retryAt });
}
