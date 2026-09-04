import type { SystemEvent } from '@beeline/api-contract/daemon';
import type { CornerLifecycleView } from '@beeline/api-contract/phone';

/** The server's own words for a GitHub check note (`github-operations.ts`). */
const COMPLETED_CHECK_NOTE = /\b(passed|failed) a check\b/i;
const STARTED_CHECK_NOTE = /\bstarted a check\b/i;

type InboxLine = {
  readonly type: string;
  readonly body: string;
  readonly systemEvent?: SystemEvent;
};

function verbOf(item: InboxLine): string {
  return item.systemEvent?.verb ?? item.body;
}

/** `passed` / `failed` for a server check note that completed a run, otherwise undefined. */
export function completedCheckNote(item: InboxLine): 'passed' | 'failed' | undefined {
  if (item.type !== 'system') return undefined;
  const match = COMPLETED_CHECK_NOTE.exec(verbOf(item));
  return match ? (match[1]!.toLowerCase() as 'passed' | 'failed') : undefined;
}

/** A server note that a check started (a new head is being checked). */
export function isCheckStartNote(item: InboxLine): boolean {
  return item.type === 'system' && STARTED_CHECK_NOTE.test(verbOf(item));
}

export type CornerChecksState = 'passing' | 'failing' | 'pending';

/** The corner's server-indexed check state, when the server carries one. */
export function checksStateFromLifecycle(
  lifecycle: CornerLifecycleView | undefined,
): CornerChecksState | undefined {
  const state = lifecycle?.checksSummary?.status ?? lifecycle?.checks;
  return state === 'passing' || state === 'failing' || state === 'pending' ? state : undefined;
}

/** The merge-gate verdict for `pr_checks_status`, read from server facts. */
export function checksVerdictFromLifecycle(
  lifecycle: CornerLifecycleView | undefined,
): 'passed' | 'failed' | 'pending' | undefined {
  const state = checksStateFromLifecycle(lifecycle);
  if (state === 'passing') return 'passed';
  if (state === 'failing') return 'failed';
  return state;
}
