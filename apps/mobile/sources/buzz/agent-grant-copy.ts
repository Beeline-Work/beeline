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
