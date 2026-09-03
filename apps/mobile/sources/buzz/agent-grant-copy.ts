import type { AgentGrantView } from '@beeline/api-contract/phone';

/**
 * The words on a grant card and on the profile's grant list. One verb per kind
 * (mirrors `AGENT_GRANT_VERBS` in the contract); the card prints
 * `<verb> <target>` and the settled line prints who allowed what, and when,
 * exactly the way the write-permission card settles into its outcome line.
 */
const VERBS: Readonly<Record<AgentGrantView['kind'], string>> = {
  path: 'read',
  host: 'reach',
  secret: 'use',
  device: 'use',
  budget: 'spend',
  command: 'run',
};

export function grantAskLine(grant: Pick<AgentGrantView, 'kind' | 'target'>): string {
  return `${VERBS[grant.kind]} ${grant.target}`;
}

function clock(seconds: number): string {
  return new Date(seconds * 1000).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** `Charles allowed always · 12:41`, `Charles allowed once · 12:41`, `Charles declined · 12:41`. */
export function grantOutcomeLine(
  grant: Pick<AgentGrantView, 'status' | 'decidedBy' | 'decidedAt' | 'auto'>,
): string | null {
  if (grant.status === 'pending') return null;
  const who = grant.auto ? 'yolo' : (grant.decidedBy?.name ?? 'the owner');
  const verb =
    grant.status === 'approved'
      ? grant.auto
        ? 'auto-approved'
        : 'allowed always'
      : grant.status === 'once'
        ? 'allowed once'
        : grant.status === 'denied'
          ? 'declined'
          : 'revoked';
  const stamp = grant.decidedAt !== undefined ? ` · ${clock(grant.decidedAt)}` : '';
  return `${who} ${verb}${stamp}`;
}

/** One profile row: `command · fly deploy -a preview · allowed always by Charles · 3 Sep`. */
export function grantProfileLine(grant: AgentGrantView): string {
  const decided = grant.decidedAt ?? grant.createdAt;
  const date = new Date(decided * 1000).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  const by = grant.auto ? 'auto under yolo' : grant.decidedBy ? `by ${grant.decidedBy.name}` : '';
  const state =
    grant.status === 'approved'
      ? 'always'
      : grant.status === 'once'
        ? grant.expiresAt !== undefined && grant.expiresAt <= Math.floor(Date.now() / 1000)
          ? 'once · used'
          : 'once'
        : grant.status;
  return [grant.kind, grant.target, [state, by].filter(Boolean).join(' '), date].join(' · ');
}

/** Only live rules can be revoked; a denied, revoked, or spent grant is history. */
export function grantIsRevocable(grant: AgentGrantView, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  if (grant.status !== 'approved' && grant.status !== 'once') return false;
  return grant.expiresAt === undefined || grant.expiresAt > nowSeconds;
}
