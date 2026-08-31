import type {
  CornerCheckState,
  CornerPullRequestFact,
  CornerRemoteState,
} from './corner-remote-state.js';

export type CornerLifecycle = 'working' | 'in-review' | 'unknown' | 'done';

/** Paint-ready lifecycle derived only from daemon-observed git/GitHub facts. */
export type CornerLifecycleView = {
  readonly lifecycle: CornerLifecycle;
  readonly branch?: string;
  readonly checks: CornerCheckState;
  readonly pr?: CornerPullRequestFact;
  readonly outcome?: 'landed' | 'abandoned';
  readonly reason?: string;
};

export function deriveCornerLifecycle(input: {
  readonly archived: boolean;
  readonly remote?: CornerRemoteState;
}): CornerLifecycleView {
  if (input.archived) {
    return {
      lifecycle: 'done',
      checks: input.remote?.checks ?? 'unknown',
      ...(input.remote?.branch ? { branch: input.remote.branch } : {}),
      ...(input.remote?.pr ? { pr: input.remote.pr } : {}),
      ...(input.remote?.outcome ? { outcome: input.remote.outcome } : {}),
    };
  }
  if (!input.remote) return { lifecycle: 'working', checks: 'unknown' };
  return {
    lifecycle:
      input.remote.state === 'gone'
        ? 'done'
        : input.remote.state === 'in-review'
          ? 'in-review'
          : input.remote.state === 'unknown'
            ? 'unknown'
            : 'working',
    branch: input.remote.branch,
    checks: input.remote.checks,
    ...(input.remote.pr ? { pr: input.remote.pr } : {}),
    ...(input.remote.outcome ? { outcome: input.remote.outcome } : {}),
    ...(input.remote.reason ? { reason: input.remote.reason } : {}),
  };
}
