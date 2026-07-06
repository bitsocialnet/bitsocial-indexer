import type { Comment } from '@/lib/types';

/**
 * Placeholder body for removed/deleted/taken-down comments: the API serves
 * them with all content fields nulled, so only the fact (and optional mod
 * reason) is shown. Thread structure is preserved — the row still occupies
 * its slot. Operator takedowns show the marker alone: takedown_reason is
 * operator bookkeeping, not public copy.
 */
export function Tombstone({ comment }: { comment: Comment }) {
  if (comment.takedown) {
    return <p className="prose tombstone">[removed — takedown request]</p>;
  }
  const label = comment.removed ? '[removed by moderator]' : '[deleted by author]';
  return (
    <p className="prose tombstone">
      {label}
      {comment.mod_reason ? ` — ${comment.mod_reason}` : ''}
    </p>
  );
}

/** True when the API redacted this comment into a tombstone. */
export function isTombstone(c: Comment): boolean {
  return Boolean(c.removed || c.deleted || c.takedown);
}
