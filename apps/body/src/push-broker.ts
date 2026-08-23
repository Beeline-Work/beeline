/**
 * Ref-policy push broker — the structural half of "an agent can never land on
 * main without the owner's signed approval".
 *
 * ## The invariant
 *
 * A harness session (Room or corner) never holds a push-capable repository
 * credential. Two layers make that hold:
 *
 * 1. **No handed credentials** — `buildAgentEnv` strips every push-capable
 *    token variable from the ACP child's environment, and the sandbox mount
 *    plan masks the known operator credential stores (`bwrap-sandbox.ts`). The
 *    daemon is the sole credential holder.
 * 2. **One ref-policy funnel** — every git push this system performs goes
 *    through {@link performBrokeredPush}, which classifies each refspec
 *    BEFORE any credential is used:
 *      - the corner's own feature branch → allowed;
 *      - a protected ref (the landing target) → performed only with a valid
 *        owner-signed exact-tip approval artifact (the same `buzz-merge-approval`
 *        signature the gate and `findHumanMergeApproval` verify);
 *      - anything else → refused with a plain-language reason.
 *
 * Every brokered decision is audited as one greppable daemon log line naming
 * the action, ref class, remote, refs, corner and session.
 *
 * ## What this does NOT claim
 *
 * This broker governs pushes PERFORMED BY THE DAEMON. It cannot govern a push
 * some other process performs with credentials it obtained elsewhere (an
 * ambient host token the sandbox failed to mask, a container-runtime escape,
 * an ssh-agent socket). Closing those is the masking layer above plus the
 * deployment posture documented in `bwrap-sandbox.ts` — on a shared operator
 * machine, ambient secrets remain the operator's exposure; what this module
 * adds is that every credential-carrying push BEELINE makes is policy-checked
 * and visible in one audit trail.
 */
import { relative, isAbsolute } from 'node:path';

/** How a pushed destination ref classifies under the corner's policy. */
export type BrokerRefClass = 'feature' | 'protected' | 'other';

export interface PushBrokerPolicy {
  /**
   * The corner's own feature branch — bare name (`feature/my-work`) or full
   * ref. Pushes to it are ordinary work; nothing else about this repo may be
   * written without an approval.
   */
  featureBranch?: string;
  /** Full protected target refs, e.g. `['refs/heads/main']`. */
  protectedRefs: string[];
}

/** The verified approval binding a reviewer's grant to exactly one tip. */
export interface BrokerApproval {
  repo: string;
  /** Full protected ref the grant names, e.g. `refs/heads/main`. */
  branch: string;
  /** The EXACT commit the protected ref may advance to. */
  tip: string;
  reviewerPubkey: string;
}

export interface VerifiedBrokerApproval {
  verified: true;
  approval: BrokerApproval;
}

export type BrokerDecision =
  | { action: 'allow'; refClass: Extract<BrokerRefClass, 'feature'>; reason: string }
  | {
      action: 'perform-with-approval';
      refClass: Extract<BrokerRefClass, 'protected'>;
      reason: string;
    }
  | { action: 'refuse'; refClass?: BrokerRefClass; reason: string };

const SHA_40 = /^[0-9a-f]{40}$/;

function normalizeBranchRef(name: string): string {
  if (name.startsWith('refs/heads/') || name.startsWith('refs/tags/')) return name;
  return `refs/heads/${name}`;
}

/**
 * Classify ONE push refspec's DESTINATION ref against the corner's policy.
 *
 * Accepts everything `git push` accepts here: `<src>:<dst>`, a bare branch
 * name (dst implied), or a bare 40-hex tip (rejected for classification —
 * callers pushing tips always use the explicit `<tip>:<ref>` shape).
 */
export function classifyRefspec(refspec: string, policy: PushBrokerPolicy): BrokerRefClass {
  const dst = refspec.includes(':') ? refspec.split(':', 2)[1]! : refspec;
  if (!dst || dst.startsWith('^') || dst.includes('*')) return 'other';
  const fullDst = normalizeBranchRef(dst);
  if (policy.featureBranch && normalizeBranchRef(policy.featureBranch) === fullDst) {
    return 'feature';
  }
  if (policy.protectedRefs.some((ref) => normalizeBranchRef(ref) === fullDst)) {
    return 'protected';
  }
  // main/master are protected by NAME even when the caller forgot to list
  // them: the product invariant must not depend on every call site passing a
  // complete list.
  const bare = fullDst.replace(/^refs\/heads\//, '');
  if (bare === 'main' || bare === 'master') return 'protected';
  return 'other';
}

export interface EvaluateBrokeredPushInput {
  /** Exactly the refspecs the underlying `git push` would receive. */
  refspecs: string[];
  remote: string;
  policy: PushBrokerPolicy;
  /**
   * Force-flavoured args already resolved by the caller (`--force`,
   * `--force-with-lease=…`, `--delete`). A lease-protected rewrite of the
   * corner's OWN feature branch is legitimate (a realigned corner republishing
   * rewritten history); force against anything else is refused outright.
   */
  forceArgs?: string[];
  /**
   * The approval artifact state for a protected-ref request. `undefined` or
   * `{verified:false}` means no valid owner-signed exact-tip approval was
   * presented — a protected push is refused.
   */
  approval?: VerifiedBrokerApproval | { verified: false };
}

/**
 * Decide a push BEFORE performing it. All-or-nothing: one refused refspec
 * refuses the whole invocation, so a mixed batch can never smuggle a
 * protected write behind an allowed one.
 */
export function evaluateBrokeredPush(input: EvaluateBrokeredPushInput): BrokerDecision {
  const force = input.forceArgs ?? [];
  const forceDelete = force.some((arg) => arg === '--delete');
  const forceRewrite = force.some(
    (arg) => arg === '--force' || arg.startsWith('--force-with-lease'),
  );

  let seenClass: BrokerRefClass | undefined;
  for (const refspec of input.refspecs) {
    const refClass = classifyRefspec(refspec, input.policy);
    seenClass ??= refClass;
    if (refspec.includes(':') && !SHA_40.test(refspec.split(':', 1)[0] ?? '')) {
      // A non-tip source is fine for a feature branch (a local branch name),
      // but a protected landing is always `<tip>:<ref>` by construction.
      if (refClass === 'protected') {
        return {
          action: 'refuse',
          refClass,
          reason:
            'A protected ref may only be advanced to an exact approved commit ' +
            `(got "${refspec}").`,
        };
      }
    }
    if (forceDelete) {
      return {
        action: 'refuse',
        refClass,
        reason: 'The broker never deletes refs.',
      };
    }
    if (forceRewrite && refClass !== 'feature') {
      return {
        action: 'refuse',
        refClass,
        reason:
          'Force-updating a protected ref is never allowed — land forward-only or rebase the feature branch.',
      };
    }
    if (refClass === 'feature') continue;
    if (refClass === 'other') {
      return {
        action: 'refuse',
        refClass,
        reason:
          `"${refspec}" is neither this corner's feature branch nor an approved landing ` +
          'target. Only the corner’s own feature branch may be pushed directly; ask in the Room to open a corner for other work.',
      };
    }
    // Protected: requires the verified exact-tip artifact binding THIS refspec.
    const approval = input.approval;
    if (!approval || !approval.verified) {
      return {
        action: 'refuse',
        refClass,
        reason:
          `${normalizeBranchRef(refspec.split(':', 2)[1] ?? refspec)} is a protected branch: ` +
          'landing there requires a signed approval from a human admin binding the exact tip. ' +
          'Publish your change for review instead — the approval flow will land it.',
      };
    }
    const [src, dst] = refspec.includes(':') ? refspec.split(':', 2) : [undefined, refspec];
    const boundTip = src && SHA_40.test(src) ? src : undefined;
    if (
      normalizeBranchRef(approval.approval.branch) !== normalizeBranchRef(dst!) ||
      !boundTip ||
      boundTip !== approval.approval.tip
    ) {
      return {
        action: 'refuse',
        refClass,
        reason:
          'The presented approval does not bind this exact ref and tip, so it authorizes nothing. ' +
          'Re-publish the change for review to get a fresh approval card.',
      };
    }
  }
  if (seenClass === 'protected') {
    const reviewer = input.approval?.verified ? input.approval.approval.reviewerPubkey : '';
    return {
      action: 'perform-with-approval',
      refClass: 'protected',
      reason: `protected ref advanced under a verified owner-signed exact-tip approval${reviewer ? ` from ${reviewer.slice(0, 12)}` : ''}`,
    };
  }
  return {
    action: 'allow',
    refClass: 'feature',
    reason: "push to the corner's own feature branch",
  };
}

/** One greppable audit line for every brokered decision. */
export function brokerAuditLine(input: {
  decision: BrokerDecision;
  remote: string;
  refspecs: string[];
  cornerId?: string;
  sessionId?: string;
}): string {
  const parts = [
    '[body] push-broker:',
    `action=${input.decision.action}`,
    `class=${input.decision.refClass ?? 'n/a'}`,
    `remote=${input.remote}`,
    `refs=${input.refspecs.join(',') || '(none)'}`,
    ...(input.cornerId ? [`corner=${input.cornerId}`] : []),
    ...(input.sessionId ? [`session=${input.sessionId}`] : []),
    `reason="${input.decision.reason}"`,
  ];
  return parts.join(' ');
}

export interface BrokerPushResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
  decision?: BrokerDecision;
}

export interface PerformBrokeredPushInput {
  refspecs: string[];
  remote: string;
  policy: PushBrokerPolicy;
  extraArgs?: string[];
  approval?: VerifiedBrokerApproval | { verified: false };
  cornerId?: string;
  sessionId?: string;
  /**
   * The ONLY credential seam: the daemon runs git itself with its own token.
   * The broker never sees or handles the credential.
   */
  runGit: (args: string[]) => Promise<{
    ok: boolean;
    status: number | null;
    stdout: string;
    stderr: string;
  }>;
}

/**
 * Evaluate, audit, then (only when allowed) perform one push with the
 * daemon's own credentials. A refusal never reaches git at all.
 */
export async function performBrokeredPush(
  input: PerformBrokeredPushInput,
): Promise<BrokerPushResult> {
  const forceArgs = (input.extraArgs ?? []).filter(
    (arg) => arg === '--force' || arg.startsWith('--force-with-lease') || arg === '--delete',
  );
  const restArgs = (input.extraArgs ?? []).filter((arg) => !forceArgs.includes(arg));
  const decision = evaluateBrokeredPush({
    refspecs: input.refspecs,
    remote: input.remote,
    policy: input.policy,
    ...(forceArgs.length ? { forceArgs } : {}),
    ...(input.approval ? { approval: input.approval } : {}),
  });
  console.log(
    brokerAuditLine({
      decision,
      remote: input.remote,
      refspecs: input.refspecs,
      ...(input.cornerId ? { cornerId: input.cornerId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    }),
  );
  if (decision.action === 'refuse') {
    return { ok: false, status: null, stdout: '', stderr: decision.reason, decision };
  }
  const result = await input.runGit([
    'push',
    ...restArgs,
    ...forceArgs,
    input.remote,
    ...input.refspecs,
  ]);
  return { ...result, decision };
}

/**
 * True when `path` sits inside `directory` (or equals it). Used by the mount
 * plan to keep mask entries from shadowing writable harness state.
 */
export function pathWithin(path: string, directory: string): boolean {
  const rel = relative(directory, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
