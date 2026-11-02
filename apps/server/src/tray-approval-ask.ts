import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import { CommandRefusalError } from './command-refusal.js';
import { AGENT_SIGN_IN_SERVICE_LABELS, normalizeTrayAsk, shortenAsk, type AgentSignInHarness } from '@beeline/api-contract/phone';

/** Explicit asks are stored with approval cards; full ceremony text stays intact. */
export function approvalAsk(type: string | undefined, card: Record<string, unknown>): string | undefined {
  if (typeof card.ask === 'string' && card.ask.trim()) return shortenAsk(card.ask);
  const field = (key: string) => typeof card[key] === 'string' ? String(card[key]) : '';
  switch (type) {
    case 'choice': return shortenAsk(field('prompt'));
    case 'permission': return shortenAsk(systemMessage("tray-approval-ask.approve", card.purpose === 'squire-spending' ? systemMessage("tray-approval-ask.spending-with") + field('tool') : systemMessage("tray-approval-ask.write-access-to") + field('repository')));
    case 'connector-offer': return shortenAsk(systemMessage("tray-approval-ask.connect", field('connectorName')));
    case 'app-sign-in': return shortenAsk(systemMessage("tray-approval-ask.sign-in-to", field('name')));
    case 'agent-sign-in': return shortenAsk(systemMessage("tray-approval-ask.sign-in-to", AGENT_SIGN_IN_SERVICE_LABELS[field('harness') as AgentSignInHarness] ?? field('harness')));
    case 'squire-approval': return shortenAsk(systemMessage("tray-approval-ask.approval-question", card.linkKind === 'passkey' ? systemMessage("tray-approval-ask.use-your-passkey-for") : card.linkKind === 'vouch' ? systemMessage("tray-approval-ask.vouch-for") : systemMessage("tray-approval-ask.approve-2"), field('title')));
    case 'grant-request': {
      const grant = Array.isArray(card.grants) ? card.grants[0] : undefined;
      if (!grant) return undefined;
      return shortenAsk(systemMessage("tray-approval-ask.allow", grant.kind === 'command' ? systemMessage("tray-approval-ask.running") : systemMessage("tray-approval-ask.access-to"), grant.target));
    }
    default: return undefined;
  }
}

/** Invalid tool asks are caller refusals, not server faults. */
export function normalizeAgentAsk(value: unknown): string {
  try {
    return normalizeTrayAsk(value);
  } catch (error) {
    throw new CommandRefusalError(error instanceof Error ? error.message : 'ask is invalid', 400);
  }
}
