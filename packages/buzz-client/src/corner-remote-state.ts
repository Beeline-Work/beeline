import type { NostrEvent } from '@beeline/nostr';

export const CORNER_REMOTE_STATE_KIND = 30078;
export const CORNER_REMOTE_STATE_TAG = 'buzz-corner-remote-state';

export type CornerRemoteStateName = 'working' | 'in-review' | 'gone' | 'unknown';
export type CornerCheckState = 'passing' | 'failing' | 'pending' | 'unknown';
export type CornerMergeability = 'clean' | 'dirty' | 'unknown';

export interface CornerPullRequestFact {
  number: number;
  url: string;
  title: string;
  targetBranch: string;
  headSha: string;
  /** GitHub's conflict-only verdict. `clean` may still have failing checks. */
  mergeability?: CornerMergeability;
  /** Base generation used to re-arm conflict repair when the target moves. */
  baseSha?: string;
  mergedAt?: string;
  mergedBy?: string;
}

export interface CornerRemoteState {
  version: 1;
  cornerId: string;
  branch: string;
  state: CornerRemoteStateName;
  checks: CornerCheckState;
  observedAt: number;
  branchTip?: string;
  pr?: CornerPullRequestFact;
  outcome?: 'landed' | 'abandoned';
  reason?: string;
}

export function cornerRemoteStateKey(cornerId: string): string {
  return `buzz-corner-remote-state:${cornerId}`;
}

function isPullRequestFact(value: unknown): value is CornerPullRequestFact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(record.number) &&
    Number(record.number) > 0 &&
    typeof record.url === 'string' &&
    /^https:\/\/github\.com\/[^\s]+$/i.test(record.url) &&
    typeof record.title === 'string' &&
    Boolean(record.title.trim()) &&
    typeof record.targetBranch === 'string' &&
    Boolean(record.targetBranch.trim()) &&
    typeof record.headSha === 'string' &&
    /^[0-9a-f]{40}$/i.test(record.headSha) &&
    (record.mergeability === undefined ||
      ['clean', 'dirty', 'unknown'].includes(String(record.mergeability))) &&
    (record.baseSha === undefined ||
      (typeof record.baseSha === 'string' && /^[0-9a-f]{40}$/i.test(record.baseSha))) &&
    (record.mergedAt === undefined ||
      (typeof record.mergedAt === 'string' && Boolean(record.mergedAt.trim()))) &&
    (record.mergedBy === undefined ||
      (typeof record.mergedBy === 'string' && Boolean(record.mergedBy.trim())))
  );
}

export function parseCornerRemoteStateContent(content: string): CornerRemoteState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const value = parsed as Record<string, unknown>;
  if (
    value.version !== 1 ||
    typeof value.cornerId !== 'string' ||
    !value.cornerId ||
    typeof value.branch !== 'string' ||
    !value.branch ||
    !['working', 'in-review', 'gone', 'unknown'].includes(String(value.state)) ||
    !['passing', 'failing', 'pending', 'unknown'].includes(String(value.checks)) ||
    !Number.isSafeInteger(value.observedAt)
  )
    return undefined;
  if (value.branchTip !== undefined && !/^[0-9a-f]{40}$/i.test(String(value.branchTip)))
    return undefined;
  if (value.pr !== undefined && !isPullRequestFact(value.pr)) return undefined;
  if (value.outcome !== undefined && value.outcome !== 'landed' && value.outcome !== 'abandoned')
    return undefined;
  if (value.reason !== undefined && typeof value.reason !== 'string') return undefined;
  return value as unknown as CornerRemoteState;
}

export function parseCornerRemoteState(
  event: Pick<NostrEvent, 'kind' | 'tags' | 'content'>,
): CornerRemoteState | undefined {
  if (
    event.kind !== CORNER_REMOTE_STATE_KIND ||
    !event.tags.some((tag) => tag[0] === 't' && tag[1] === CORNER_REMOTE_STATE_TAG)
  )
    return undefined;
  return parseCornerRemoteStateContent(event.content);
}
