/**
 * The merge worker — the one new load-bearing piece of the gate.
 *
 * It holds the ONLY identity in the repo's push-allowed set (the repo owner,
 * Admin+ on `main`). Branch protection means no other identity can advance
 * `main`; this worker will only do so after it has independently verified a
 * schnorr-signed approval from the trusted reviewer that binds to the EXACT
 * commit being landed. Compose the two and an unapproved merge is impossible
 * while an approved one lands — with zero changes to Buzz's Rust.
 *
 * `attemptMerge` is fail-closed: any missing/mismatched/forged approval, or any
 * git error, refuses the merge and leaves `main` untouched.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NostrEvent } from '@buzzy/nostr';
import type { Identity } from './identity.js';
import { git, gitAuthed, lsRemoteRef } from './git.js';
import { gitRepoUrl } from './config.js';
import { queryEvents } from './relay.js';
import { APPROVAL_MARKER, verifyApproval, type MergeTarget } from './approval.js';
import { KIND_STREAM_MESSAGE } from './buzz.js';
import { isRegisteredAgentIdentity } from './agent-identity.js';
import { resolveChannelRole, type ChannelRole } from './provisioning.js';

export interface MergeRequest {
  /** Repo owner + push identity. */
  worker: Identity;
  /** Hex pubkey whose approvals the worker will honor (and no other). */
  trustedReviewer: string;
  /** Repo id (`{repo}` in the URL). Owner is `worker.publicKey`. */
  repo: string;
  /** Channel the repo is bound to (where approvals are posted). */
  channelId: string;
  /** Short target branch name, e.g. `main`. */
  targetBranch: string;
  /** Short feature branch name the agent already pushed. */
  featureBranch: string;
}

export interface MergeOutcome {
  merged: boolean;
  reason: string;
  /** The feature tip the merge would land (the commit that must be approved). */
  featureTip?: string;
  /** `main` before the attempt. */
  targetTipBefore?: string;
  /** `main` after the attempt (unchanged on refusal). */
  targetTipAfter?: string;
}

/** Clone the repo fresh as the worker and return the checkout path. */
function cloneFresh(req: MergeRequest): string {
  const owner = req.worker.publicKey;
  const dir = mkdtempSync(join(tmpdir(), 'buzzy-worker-'));
  const url = gitRepoUrl(owner, req.repo);
  const res = gitAuthed(dir, req.worker, owner, req.repo, ['clone', url, 'work']);
  if (!res.ok) {
    throw new Error(`worker clone failed: ${res.stderr}`);
  }
  return join(dir, 'work');
}

/** Fetch the approvals the reviewer posted for this repo/channel. */
async function fetchApprovals(req: MergeRequest): Promise<NostrEvent[]> {
  return queryEvents(
    [
      {
        kinds: [KIND_STREAM_MESSAGE],
        authors: [req.trustedReviewer],
        '#h': [req.channelId],
        '#t': [APPROVAL_MARKER],
      },
    ],
    req.worker.publicKey,
  );
}

/**
 * Attempt to land `featureBranch` onto `targetBranch`. Merges + pushes ONLY if
 * a valid reviewer-signed approval binds to the feature tip; otherwise refuses.
 */
export async function attemptMerge(req: MergeRequest): Promise<MergeOutcome> {
  const owner = req.worker.publicKey;
  const targetRef = `refs/heads/${req.targetBranch}`;
  const work = cloneFresh(req);

  const featureTip = git(work, ['rev-parse', `origin/${req.featureBranch}`]).stdout.trim();
  const targetTipBefore = git(work, ['rev-parse', `origin/${req.targetBranch}`]).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(featureTip)) {
    return {
      merged: false,
      reason: `feature branch ${req.featureBranch} not found`,
      targetTipBefore,
    };
  }

  const target: MergeTarget = { repo: `${owner}/${req.repo}`, branch: targetRef, tip: featureTip };

  // Identity is checked before role. An agent stays forbidden even if someone
  // accidentally grants it admin/owner or configures it as trustedReviewer.
  let signerIsAgent: boolean;
  try {
    signerIsAgent = await isRegisteredAgentIdentity(req.trustedReviewer, req.worker.publicKey);
  } catch (error) {
    return {
      merged: false,
      reason: `cannot prove approval signer is human; agent identity lookup failed: ${String(error)}`,
      featureTip,
      targetTipBefore,
      targetTipAfter: targetTipBefore,
    };
  }
  if (signerIsAgent) {
    return {
      merged: false,
      reason: `merge approval REFUSED: signer ${req.trustedReviewer} is a registered agent identity; agents can never approve merges`,
      featureTip,
      targetTipBefore,
      targetTipAfter: targetTipBefore,
    };
  }

  let reviewerRole: ChannelRole | null;
  try {
    reviewerRole = await resolveChannelRole(
      req.channelId,
      req.trustedReviewer,
      req.worker.publicKey,
    );
  } catch (error) {
    return {
      merged: false,
      reason: `cannot prove approval signer is a human admin; role lookup failed: ${String(error)}`,
      featureTip,
      targetTipBefore,
      targetTipAfter: targetTipBefore,
    };
  }
  if (reviewerRole !== 'owner' && reviewerRole !== 'admin') {
    return {
      merged: false,
      reason: `merge approval REFUSED: human admin role required (signer role=${reviewerRole ?? 'none'})`,
      featureTip,
      targetTipBefore,
      targetTipAfter: targetTipBefore,
    };
  }

  const approvals = await fetchApprovals(req);
  const valid = approvals.find((ev) => verifyApproval(ev, req.trustedReviewer, target));
  if (!valid) {
    return {
      merged: false,
      reason: `no valid approval binding ${target.repo} ${targetRef} -> ${featureTip}`,
      featureTip,
      targetTipBefore,
      targetTipAfter: targetTipBefore,
    };
  }

  // Approval is valid and binds to the exact tip — perform the merge as owner.
  git(work, ['checkout', req.targetBranch]);
  const merge = git(work, ['merge', '--ff-only', `origin/${req.featureBranch}`]);
  if (!merge.ok) {
    return {
      merged: false,
      reason: `ff merge failed: ${merge.stderr}`,
      featureTip,
      targetTipBefore,
    };
  }
  const push = gitAuthed(work, req.worker, owner, req.repo, ['push', 'origin', req.targetBranch]);
  if (!push.ok || /\brejected\b|denied|forbidden/i.test(push.stderr)) {
    return {
      merged: false,
      reason: `worker push refused by relay: ${push.stderr}`,
      featureTip,
      targetTipBefore,
    };
  }

  const targetTipAfter = lsRemoteRef(work, req.worker, owner, req.repo, targetRef);
  return {
    merged: targetTipAfter === featureTip,
    reason: targetTipAfter === featureTip ? 'merged' : `post-push tip mismatch: ${targetTipAfter}`,
    featureTip,
    targetTipBefore,
    targetTipAfter,
  };
}

/** Config for standalone-service mode (secret key as hex, JSON-safe). */
interface WorkerServiceConfig {
  workerSecretKeyHex: string;
  trustedReviewer: string;
  repo: string;
  channelId: string;
  targetBranch: string;
  featureBranch: string;
  pollMs?: number;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('odd-length hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Standalone-service mode: poll for approvals and land any that validate.
 * `npm run worker -- <config-json-path>`. The money-shot proof drives
 * `attemptMerge` directly for deterministic assertions; this is the long-lived
 * shape the product would ship.
 */
async function main(): Promise<void> {
  const cfgPath = process.argv[2];
  if (!cfgPath) {
    console.error('usage: worker <request-config.json>');
    process.exit(2);
  }
  const { readFileSync } = await import('node:fs');
  const { getPublicKey } = await import('@buzzy/nostr');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as WorkerServiceConfig;
  const secretKey = hexToBytes(cfg.workerSecretKeyHex);
  const req: MergeRequest = {
    worker: { name: 'worker', secretKey, publicKey: getPublicKey(secretKey) },
    trustedReviewer: cfg.trustedReviewer,
    repo: cfg.repo,
    channelId: cfg.channelId,
    targetBranch: cfg.targetBranch,
    featureBranch: cfg.featureBranch,
  };
  for (;;) {
    const outcome = await attemptMerge(req);
    console.log(JSON.stringify(outcome));
    if (outcome.merged) break;
    await new Promise((r) => setTimeout(r, cfg.pollMs ?? 3000));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
