/**
 * The merge-approval event — the human's signed "yes, land exactly this."
 *
 * It is a schnorr-signed Nostr channel message (kind:9, so the Buzz relay
 * stores and fans it out like any repo-channel post — the relay rejects
 * unknown kinds) whose tags BIND the grant to one specific merge:
 *   - ["t", "buzz-merge-approval"]      marker for filtering
 *   - ["repo", "<ownerHex>/<repo>"]     which repository
 *   - ["branch", "refs/heads/main"]     which protected target ref
 *   - ["tip", "<40-hex sha>"]           the EXACT commit main may advance to
 *
 * The gate is the conjunction the worker checks (see verifyApproval):
 *   1. schnorr signature valid over the event id, AND
 *   2. event.pubkey === the trusted reviewer, AND
 *   3. repo + branch + tip match the merge about to be performed.
 * A grant for merge A therefore cannot authorize merge B: a different branch
 * tip is a different `tip` tag and fails check (3). Note kind:46011 is a Buzz
 * *workflow* kind, deliberately NOT reused here.
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
  /** 40-hex commit the target ref is authorized to advance to. */
  tip: string;
}

/** Build a signed approval binding the reviewer's grant to `target`. */
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
      ],
      content: `APPROVE merge of ${target.repo} ${target.branch} -> ${target.tip}`,
    },
    reviewer.secretKey,
  );
}

function tagValue(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((t) => t[0] === name)?.[1];
}

/**
 * Return true iff `event` is a valid approval by `trustedReviewer` that binds
 * to EXACTLY `target`. Every clause must hold; any mismatch fails closed.
 */
export function verifyApproval(
  event: NostrEvent,
  trustedReviewer: string,
  target: MergeTarget,
): boolean {
  if (event.kind !== KIND_STREAM_MESSAGE) return false;
  if (tagValue(event, 't') !== APPROVAL_MARKER) return false;
  if (event.pubkey !== trustedReviewer) return false;
  if (!verifyEvent(event)) return false; // schnorr sig over the id
  if (tagValue(event, 'repo') !== target.repo) return false;
  if (tagValue(event, 'branch') !== target.branch) return false;
  if (tagValue(event, 'tip') !== target.tip) return false;
  return true;
}
