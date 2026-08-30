/**
 * Merge approval builder — same event shape as `@beeline/gate` `buildApproval`.
 *
 * kind:9 stream message with:
 *   ["h", <corner id>], ["t", "buzz-merge-approval"], ["repo", …],
 *   ["branch", …], plus the tip and patch identity visible when approved.
 *
 * Crypto is @beeline/nostr signEvent (BIP-340). Do not invent a second format;
 * the gate worker verifies this exact tag binding.
 */
import { signEvent, verifyEvent, type NostrEvent } from '@beeline/nostr';
import { KIND_STREAM_MESSAGE, TAG_MERGE_APPROVAL } from './kinds.js';
import { CORNER_REJECTION_TAG } from './corner-product-state.js';
import { tagValue } from './parse.js';
import type { Identity, MergeTarget } from './types.js';

export { TAG_MERGE_APPROVAL as APPROVAL_MARKER };

/** Build a signed approval for this corner's one merge into `target.branch`. */
export function buildMergeApproval(
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
        ['t', TAG_MERGE_APPROVAL],
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

/** Build the mutually-exclusive human rejection verdict for this review. */
export function buildMergeRejection(
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
        ['t', CORNER_REJECTION_TAG],
        ['repo', target.repo],
        ['branch', target.branch],
        ['tip', target.tip],
        ...(target.patchId ? [['patch-id', target.patchId]] : []),
      ],
      content: `REJECT this corner's reviewed change for ${target.repo} into ${target.branch}`,
    },
    reviewer.secretKey,
  );
}

/**
 * Return true iff `event` is a valid approval by `trustedReviewer` for this
 * corner's one merge into `target.branch`. The signed tip and patch id record
 * what was visible at approval time; later commits in the same corner do not
 * spend the grant.
 */
export function verifyMergeApproval(
  event: NostrEvent,
  trustedReviewer: string,
  target: MergeTarget,
  channelId: string,
): boolean {
  if (event.kind !== KIND_STREAM_MESSAGE) return false;
  if (tagValue(event, 't') !== TAG_MERGE_APPROVAL) return false;
  if (event.pubkey !== trustedReviewer) return false;
  if (!verifyEvent(event)) return false;
  if (tagValue(event, 'h') !== channelId) return false;
  if (tagValue(event, 'repo') !== target.repo) return false;
  if (tagValue(event, 'branch') !== target.branch) return false;
  return true;
}

export function verifyMergeRejection(
  event: NostrEvent,
  trustedReviewer: string,
  target: MergeTarget,
  channelId: string,
): boolean {
  return (
    event.kind === KIND_STREAM_MESSAGE &&
    tagValue(event, 't') === CORNER_REJECTION_TAG &&
    event.pubkey === trustedReviewer &&
    verifyEvent(event) &&
    tagValue(event, 'h') === channelId &&
    tagValue(event, 'repo') === target.repo &&
    tagValue(event, 'branch') === target.branch
  );
}
