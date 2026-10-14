import { AGENT_SIGN_IN_SERVICE_LABELS, shortenAsk, type AgentSignInHarness } from '@beeline/api-contract/phone';

/** Explicit asks are stored with approval cards; full ceremony text stays intact. */
export function approvalAsk(type: string | undefined, card: Record<string, unknown>): string | undefined {
  if (typeof card.ask === 'string' && card.ask.trim()) return shortenAsk(card.ask);
  const field = (key: string) => typeof card[key] === 'string' ? String(card[key]) : '';
  switch (type) {
    case 'choice': return shortenAsk(field('prompt'));
    case 'permission': return shortenAsk(`Approve ${card.purpose === 'squire-spending' ? 'spending with ' + field('tool') : 'write access to ' + field('repository')}?`);
    case 'connector-offer': return shortenAsk(`Connect ${field('connectorName')}?`);
    case 'app-sign-in': return shortenAsk(`Sign in to ${field('name')}?`);
    case 'agent-sign-in': return shortenAsk(`Sign in to ${AGENT_SIGN_IN_SERVICE_LABELS[field('harness') as AgentSignInHarness] ?? field('harness')}?`);
    case 'squire-approval': return shortenAsk(`${card.linkKind === 'passkey' ? 'Use your passkey for' : card.linkKind === 'vouch' ? 'Vouch for' : 'Approve'} ${field('title')}?`);
    case 'grant-request': {
      const grant = Array.isArray(card.grants) ? card.grants[0] : undefined;
      if (!grant) return undefined;
      return shortenAsk(`Allow ${grant.kind === 'command' ? 'running' : 'access to'} ${grant.target}?`);
    }
    default: return undefined;
  }
}

