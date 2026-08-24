/**
 * The merge-approval event — the human's signed "yes, land this corner."
 *
 * It is a schnorr-signed Nostr channel message (kind:9, so the Buzz relay
 * stores and fans it out like any repo-channel post — the relay rejects
 * unknown kinds) whose tags BIND the grant to one specific corner merge:
 *   - ["h", "<corner id>"]             which corner
 *   - ["t", "buzz-merge-approval"]      marker for filtering
 *   - ["repo", "<ownerHex>/<repo>"]     which repository
 *   - ["branch", "refs/heads/main"]     which protected target ref
 *   - ["tip", "<40-hex sha>"]           work tip visible at approval time
 *   - ["patch-id", "<40-hex id>"]       optional visible-content snapshot
 *
 * The gate is the conjunction the worker checks (see verifyApproval):
 *   1. schnorr signature valid over the event id, AND
 *   2. event.pubkey === the trusted reviewer, AND
 *   3. corner id + repo + branch match.
 * Tip and patch-id are review/audit snapshots, not authorization pins. A human
 * who approves a corner explicitly trusts its ongoing work until its one merge
 * lands; another corner still cannot reuse that grant. Note kind:46011 is a
 * Buzz *workflow* kind, deliberately NOT reused here.
 */
import { signEvent, verifyEvent, type NostrEvent } from '@beeline/nostr';
import type { Identity } from './identity.js';
import { KIND_STREAM_MESSAGE } from './buzz.js';

export const APPROVAL_MARKER = 'buzz-merge-approval';

export interface MergeTarget {
  /** `<ownerHex>/<repo>` — matches the git URL path. */
  repo: string;
  /** Full target ref, e.g. `refs/heads/main`. */
  branch: string;
  /** Current 40-hex work tip; signed events retain the approval-time snapshot. */
  tip: string;
  /** Stable reviewed-content snapshot. Omitted by legacy clients. */
  patchId?: string;
}

/** Build a signed approval for this corner's one merge into `target.branch`. */
export function buildApproval(
  reviewer: Identity,
  channelId: string,
  target: MergeTarget,
): NostrEvent {
  return signEvent(
    {
      pubkey: reviewer.publicKey,
      created_at: Math.floor(Date.now() / 1000),
      kind: KIND_STREAM_MESSAGE,
      tags: [
        ['h', channelId],
        ['t', APPROVAL_MARKER],
        ['repo', target.repo],
        ['branch', target.branch],
        ['tip', target.tip],
        ...(target.patchId ? [['patch-id', target.patchId]] : []),
      ],
      content:
        `APPROVE this corner's merge of ${target.repo} into ${target.branch}; ` +
        `covers its ongoing work until it lands (current tip ${target.tip})`,
    },
    reviewer.secretKey,
  );
}

function tagValue(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((t) => t[0] === name)?.[1];
}

/**
 * Return true iff `event` is a valid approval by `trustedReviewer` for this
 * corner's one merge into `target.branch`. Every clause must hold. The signed
 * tip and patch id remain informational snapshots as the corner advances.
 */
export function verifyApproval(
  event: NostrEvent,
  trustedReviewer: string,
  target: MergeTarget,
  channelId: string,
): boolean {
  if (event.kind !== KIND_STREAM_MESSAGE) return false;
  if (tagValue(event, 't') !== APPROVAL_MARKER) return false;
  if (event.pubkey !== trustedReviewer) return false;
  if (!verifyEvent(event)) return false; // schnorr sig over the id
  if (tagValue(event, 'h') !== channelId) return false;
  if (tagValue(event, 'repo') !== target.repo) return false;
  if (tagValue(event, 'branch') !== target.branch) return false;
  return true;
}
