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
import { verifyEvent, type NostrEvent } from '@beeline/nostr';
import type { Identity } from './identity.js';
import { git, gitAuthed, lsRemoteRef } from './git.js';
import { gitRepoUrl } from './config.js';
import { createRelayClient, type RelayReader } from './relay.js';
import { APPROVAL_MARKER, verifyApproval, type MergeTarget } from './approval.js';
import { KIND_STREAM_MESSAGE } from './buzz.js';
import { isRegisteredAgentIdentity } from './agent-identity.js';
import { resolveChannelRole, type ChannelRole } from './provisioning.js';
import { serializeRepoLanding } from './land-queue.js';

export interface MergeRequest {
  /** Dedicated push-capable merge worker identity. */
  worker: Identity;
  /** Repo owner hex. Defaults to worker.publicKey for the original owner-worker mode. */
  ownerHex?: string;
  /** Hex pubkey whose approvals the worker will honor (and no other). */
  trustedReviewer: string;
  /**
   * Authority provenance for the reviewer key. Existing Beeline reviewer keys
   * are device-held; any future managed/remote signer must identify itself and
   * is refused before role lookup.
   */
  trustedReviewerCustody: ReviewerKeyCustody;
  /** Repo id (`{repo}` in the URL). */
  repo: string;
  /** Channel the repo is bound to (where approvals are posted). */
  channelId: string;
  /** Short target branch name, e.g. `main`. */
  targetBranch: string;
  /** Short feature branch name the agent already pushed. */
  featureBranch: string;
  /** Authenticated relay reader; defaults to one bound to `worker`. */
  relay?: RelayReader;
}

export interface MergeOutcome {
  merged: boolean;
  reason: string;
  /** True only for a refusal a retry cannot fix (see `ReviewerAuthorityResult.terminal`).
   *  False (the safe default) for every transient failure — network/relay
   *  hiccups, a not-yet-visible feature branch, a push race — so those keep
   *  being retried on the next poll tick instead of being given up on. */
  terminal?: boolean;
  /** The feature tip the merge would land (the commit that must be approved). */
  featureTip?: string;
  /** `main` before the attempt. */
  targetTipBefore?: string;
  /** `main` after the attempt (unchanged on refusal). */
  targetTipAfter?: string;
}

export type ReviewerKeyCustody = 'device' | 'managed' | 'remote';

export interface ReviewerAuthorityDependencies {
  isRegisteredAgent(pubkey: string, relay: RelayReader): Promise<boolean>;
  resolveRole(channelId: string, pubkey: string, relay: RelayReader): Promise<ChannelRole | null>;
}

export interface ReviewerAuthorityResult {
  authorized: boolean;
  reason: string;
  /** True only for a genuine authorization refusal that a retry cannot fix
   *  (wrong signer, non-device custody, non-admin role) — false for a
   *  transient lookup failure (fail-closed on uncertainty, but retryable)
   *  or when authorized. */
  terminal: boolean;
}

/**
 * Enforce reviewer identity in security order: registered-agent lookup first
 * and fail-closed, then device custody, then the mutable Room role projection.
 */
export async function authorizeReviewer(
  input: {
    pubkey: string;
    relay: RelayReader;
    channelId: string;
    custody: ReviewerKeyCustody;
  },
  dependencies: ReviewerAuthorityDependencies = {
    isRegisteredAgent: isRegisteredAgentIdentity,
    resolveRole: resolveChannelRole,
  },
): Promise<ReviewerAuthorityResult> {
  let signerIsAgent: boolean;
  try {
    signerIsAgent = await dependencies.isRegisteredAgent(input.pubkey, input.relay);
  } catch (error) {
    return {
      authorized: false,
      terminal: false,
      reason: `cannot prove approval signer is human; agent identity lookup failed: ${String(error)}`,
    };
  }
  if (signerIsAgent) {
    return {
      authorized: false,
      terminal: true,
      reason: `merge approval REFUSED: signer ${input.pubkey} is a registered agent identity; agents can never approve merges`,
    };
  }
  if (input.custody !== 'device') {
    return {
      authorized: false,
      terminal: true,
      reason: `merge approval REFUSED: trusted reviewer key custody must be device-held (custody=${input.custody})`,
    };
  }

  let reviewerRole: ChannelRole | null;
  try {
    reviewerRole = await dependencies.resolveRole(input.channelId, input.pubkey, input.relay);
  } catch (error) {
    return {
      authorized: false,
      terminal: false,
      reason: `cannot prove approval signer is a human admin; role lookup failed: ${String(error)}`,
    };
  }
  if (reviewerRole !== 'owner' && reviewerRole !== 'admin') {
    return {
      authorized: false,
      terminal: true,
      reason: `merge approval REFUSED: human admin role required (signer role=${reviewerRole ?? 'none'})`,
    };
  }
  return { authorized: true, terminal: false, reason: 'authorized device-held human admin' };
}

/** Clone the repo fresh as the worker and return the checkout path. */
async function cloneFresh(req: MergeRequest): Promise<string> {
  const owner = req.ownerHex ?? req.worker.publicKey;
  const dir = mkdtempSync(join(tmpdir(), 'buzzy-worker-'));
  const url = gitRepoUrl(owner, req.repo);
  const res = await gitAuthed(dir, req.worker, owner, req.repo, ['clone', url, 'work']);
  if (!res.ok) {
    throw new Error(`worker clone failed: ${res.stderr}`);
  }
  return join(dir, 'work');
}

/** Fetch the approvals the reviewer posted for this repo/channel. */
async function fetchApprovals(req: MergeRequest): Promise<NostrEvent[]> {
  const relay = req.relay ?? createRelayClient(req.worker);
  return relay.queryEvents([
    {
      kinds: [KIND_STREAM_MESSAGE],
      authors: [req.trustedReviewer],
      '#h': [req.channelId],
      '#t': [APPROVAL_MARKER],
    },
  ]);
}

/**
 * Attempt to land `featureBranch` onto `targetBranch`. Merges + pushes ONLY if
 * a valid reviewer-signed approval binds to this corner and target; otherwise refuses.
 */
export async function attemptMerge(req: MergeRequest): Promise<MergeOutcome> {
  const owner = req.ownerHex ?? req.worker.publicKey;
  const targetRef = `refs/heads/${req.targetBranch}`;
  const work = await cloneFresh(req);

  const featureTip = (await git(work, ['rev-parse', `origin/${req.featureBranch}`])).stdout.trim();
  const targetTipBefore = (
    await git(work, ['rev-parse', `origin/${req.targetBranch}`])
  ).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(featureTip)) {
    return {
      merged: false,
      reason: `feature branch ${req.featureBranch} not found`,
      targetTipBefore,
    };
  }

  const target: MergeTarget = { repo: `${owner}/${req.repo}`, branch: targetRef, tip: featureTip };
  const relay = req.relay ?? createRelayClient(req.worker);

  const reviewerAuthority = await authorizeReviewer({
    pubkey: req.trustedReviewer,
    relay,
    channelId: req.channelId,
    custody: req.trustedReviewerCustody,
  });
  if (!reviewerAuthority.authorized) {
    return {
      merged: false,
      reason: reviewerAuthority.reason,
      terminal: reviewerAuthority.terminal,
      featureTip,
      targetTipBefore,
      targetTipAfter: targetTipBefore,
    };
  }

  const approvals = await fetchApprovals(req);
  const valid = approvals.find((ev) =>
    verifyApproval(ev, req.trustedReviewer, target, req.channelId),
  );
  if (!valid) {
    return {
      merged: false,
      reason: `no valid approval binding ${target.repo} ${targetRef} -> ${featureTip}`,
      featureTip,
      targetTipBefore,
      targetTipAfter: targetTipBefore,
    };
  }

  // Approval is valid for this corner's merge — land its current feature tip.
  await git(work, ['checkout', req.targetBranch]);
  const merge = await git(work, ['merge', '--ff-only', `origin/${req.featureBranch}`]);
  if (!merge.ok) {
    return {
      merged: false,
      reason: `ff merge failed: ${merge.stderr}`,
      featureTip,
      targetTipBefore,
    };
  }
  const push = await gitAuthed(work, req.worker, owner, req.repo, [
    'push',
    'origin',
    req.targetBranch,
  ]);
  if (!push.ok || /\brejected\b|denied|forbidden/i.test(push.stderr)) {
    return {
      merged: false,
      reason: `worker push refused by relay: ${push.stderr}`,
      featureTip,
      targetTipBefore,
    };
  }

  const targetTipAfter = await lsRemoteRef(work, req.worker, owner, req.repo, targetRef);
  return {
    merged: targetTipAfter === featureTip,
    reason: targetTipAfter === featureTip ? 'merged' : `post-push tip mismatch: ${targetTipAfter}`,
    featureTip,
    targetTipBefore,
    targetTipAfter,
  };
}

/** One durable gate serves every agent-opened change in a repository Room. */
export interface RoomMergeServiceConfig {
  worker: Identity;
  ownerHex: string;
  repo: string;
  channelId: string;
  targetBranch: string;
  /** Optional explicit relay binding for custom/local daemon configurations. */
  relay?: RelayReader;
}

export interface RoomMergeCandidate {
  subchannelId: string;
  featureBranch: string;
  agentPubkey: string;
}

export interface RoomMergeAttempt {
  candidate: RoomMergeCandidate;
  approvalId: string;
  reviewer: string;
  outcome: MergeOutcome;
}

function tagValue(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

function fullTargetRef(branch: string): string {
  return branch.startsWith('refs/heads/') ? branch : `refs/heads/${branch}`;
}

function shortTargetBranch(branch: string): string {
  return branch.replace(/^refs\/heads\//, '');
}

/** Pure parser for the signed body-control records that define Room changes. */
export function roomMergeCandidates(
  events: NostrEvent[],
  config: Pick<RoomMergeServiceConfig, 'ownerHex' | 'repo' | 'targetBranch'>,
): RoomMergeCandidate[] {
  const repoId = `${config.ownerHex}/${config.repo}`;
  const targetRef = fullTargetRef(config.targetBranch);
  const candidates = new Map<string, RoomMergeCandidate>();
  for (const event of events) {
    const subchannelId = tagValue(event, 'subchannel');
    const featureBranch = tagValue(event, 'feature');
    const agentPubkey = tagValue(event, 'agent');
    if (
      !verifyEvent(event) ||
      tagValue(event, 'status') !== 'open' ||
      tagValue(event, 'repo') !== repoId ||
      tagValue(event, 'branch') !== targetRef ||
      !subchannelId ||
      !featureBranch ||
      !agentPubkey ||
      event.pubkey !== agentPubkey
    ) {
      continue;
    }
    candidates.set(subchannelId, { subchannelId, featureBranch, agentPubkey });
  }
  return [...candidates.values()];
}

/**
 * Durable dynamic gate. It discovers every agent-authored change from the Room,
 * then delegates each corner-scoped approval to `attemptMerge`
 * enforcement path. No reviewer or feature branch is configured ahead of time.
 */
export class DurableMergeGate {
  private readonly terminalApprovalIds = new Set<string>();
  private readonly relay: RelayReader;

  constructor(private readonly config: RoomMergeServiceConfig) {
    this.relay = config.relay ?? createRelayClient(config.worker);
  }

  async poll(): Promise<RoomMergeAttempt[]> {
    const roomEvents = await this.relay.queryEvents([
      {
        kinds: [KIND_STREAM_MESSAGE],
        '#h': [this.config.channelId],
        '#t': ['body-control'],
        limit: 500,
      },
    ]);
    const candidates = roomMergeCandidates(roomEvents, this.config);
    const attempts: RoomMergeAttempt[] = [];
    const targetRef = fullTargetRef(this.config.targetBranch);
    const targetRepo = `${this.config.ownerHex}/${this.config.repo}`;

    for (const candidate of candidates) {
      // Only irreversible, self-signed agent identities may announce changes.
      if (!(await isRegisteredAgentIdentity(candidate.agentPubkey, this.relay))) {
        continue;
      }
      const featureRef = `refs/heads/${candidate.featureBranch}`;
      const featureTip = await lsRemoteRef(
        tmpdir(),
        this.config.worker,
        this.config.ownerHex,
        this.config.repo,
        featureRef,
      );
      if (!featureTip) continue;
      const targetTip = await lsRemoteRef(
        tmpdir(),
        this.config.worker,
        this.config.ownerHex,
        this.config.repo,
        targetRef,
      );
      if (targetTip === featureTip) continue;

      const approvals = await this.relay.queryEvents([
        {
          kinds: [KIND_STREAM_MESSAGE],
          '#h': [candidate.subchannelId],
          '#t': [APPROVAL_MARKER],
          limit: 100,
        },
      ]);
      const exactTarget: MergeTarget = { repo: targetRepo, branch: targetRef, tip: featureTip };
      for (const approval of approvals) {
        if (
          this.terminalApprovalIds.has(approval.id) ||
          !verifyApproval(approval, approval.pubkey, exactTarget, candidate.subchannelId)
        ) {
          continue;
        }
        const outcome = await serializeRepoLanding(targetRepo, () =>
          attemptMerge({
            worker: this.config.worker,
            ownerHex: this.config.ownerHex,
            trustedReviewer: approval.pubkey,
            trustedReviewerCustody: 'device',
            repo: this.config.repo,
            channelId: candidate.subchannelId,
            targetBranch: shortTargetBranch(this.config.targetBranch),
            featureBranch: candidate.featureBranch,
            relay: this.relay,
          }),
        );
        attempts.push({
          candidate,
          approvalId: approval.id,
          reviewer: approval.pubkey,
          outcome,
        });
        if (outcome.merged || outcome.terminal) {
          this.terminalApprovalIds.add(approval.id);
        }
        if (outcome.merged) break;
      }
    }
    return attempts;
  }
}

/** Config for standalone-service mode (secret key as hex, JSON-safe). */
interface WorkerServiceConfig {
  workerSecretKeyHex: string;
  ownerHex?: string;
  repo: string;
  channelId: string;
  targetBranch: string;
  pollMs?: number;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('odd-length hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Standalone-service mode: discover all Room changes and land approved tips.
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
  const { getPublicKey } = await import('@beeline/nostr');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as WorkerServiceConfig;
  const secretKey = hexToBytes(cfg.workerSecretKeyHex);
  const worker = { name: 'worker', secretKey, publicKey: getPublicKey(secretKey) };
  const gate = new DurableMergeGate({
    worker,
    ownerHex: cfg.ownerHex ?? worker.publicKey,
    repo: cfg.repo,
    channelId: cfg.channelId,
    targetBranch: cfg.targetBranch,
  });
  for (;;) {
    const attempts = await gate.poll();
    for (const attempt of attempts) console.log(JSON.stringify(attempt));
    await new Promise((r) => setTimeout(r, cfg.pollMs ?? 3000));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
