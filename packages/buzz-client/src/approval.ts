/**
 * Merge approval builder — same event shape as `@beeline/gate` `buildApproval`.
 *
 * kind:9 stream message with:
 *   ["t", "buzz-merge-approval"], ["repo", …], ["branch", …], ["tip", …]
 *   and, for new review cards, ["patch-id", …].
 *
 * Crypto is @beeline/nostr signEvent (BIP-340). Do not invent a second format;
 * the gate worker verifies this exact tag binding.
 */
import { signEvent, verifyEvent, type NostrEvent } from '@beeline/nostr';
import { KIND_STREAM_MESSAGE, TAG_MERGE_APPROVAL } from './kinds.js';
import { tagValue } from './parse.js';
import type { Identity, MergeTarget } from './types.js';

export { TAG_MERGE_APPROVAL as APPROVAL_MARKER };

/** Build a signed approval binding the reviewer's grant to `target`. */
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
      content: `APPROVE merge of ${target.repo} ${target.branch} -> ${target.tip}`,
    },
    reviewer.secretKey,
  );
}

/**
 * Return true iff `event` is a valid approval by `trustedReviewer` that binds
 * to `target`. Legacy approvals remain exact-tip only. New approvals may also
 * authorize a rebased tip when both sides name the same stable patch identity.
 */
export function verifyMergeApproval(
  event: NostrEvent,
  trustedReviewer: string,
  target: MergeTarget,
): boolean {
  if (event.kind !== KIND_STREAM_MESSAGE) return false;
  if (tagValue(event, 't') !== TAG_MERGE_APPROVAL) return false;
  if (event.pubkey !== trustedReviewer) return false;
  if (!verifyEvent(event)) return false;
  if (tagValue(event, 'repo') !== target.repo) return false;
  if (tagValue(event, 'branch') !== target.branch) return false;
  if (tagValue(event, 'tip') === target.tip) return true;
  const approvedPatch = tagValue(event, 'patch-id');
  return Boolean(approvedPatch && target.patchId && approvedPatch === target.patchId);
}
