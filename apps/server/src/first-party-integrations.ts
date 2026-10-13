import { createAgentCommand, type CommandRow } from './agent-command.js';
import type { SqlDatabase } from './database.js';
import { systemLine } from './system-line.js';
import type { LinkAgentWallet } from './link-agent-wallet.js';

/** First-party sign-ins take precedence over external discovery and saved pending routes. */
export const FIRST_PARTY_INTEGRATIONS = [{
  key: 'link', name: 'Link', website: 'link.com',
  appId: '00000000-0000-4000-8000-000000000001',
  aliases: ['link', 'stripe link', 'link.com', 'stripe link (link.com)'],
  intents: ['add a card', 'payment card', 'pay', 'checkout'],
  provider: (services: { linkWallet?: LinkAgentWallet }) => services.linkWallet,
}] as const;

export function firstPartyIntegration(service: string) {
  const normalized = service.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  let host: string | undefined;
  try { host = new URL(`https://${normalized}`).hostname.replace(/^www\./, ''); }
  catch { /* Product names need no URL parsing. */ }
  return FIRST_PARTY_INTEGRATIONS.find(entry => entry.website === host || entry.aliases.some(alias => alias === normalized));
}

/** Called after the provider verifies OAuth, in the same transaction as card settlement. */
export async function settleFirstPartySignIn(database: SqlDatabase, ownerId: string, key: string) {
  const cards = (await database.query<{ id: string; room_id: string;
    card: { name: string; agentId: string; commandId?: string; resumeOnConnect?: boolean } }>(
    `SELECT id,room_id,card FROM messages WHERE card_type='app-sign-in'
      AND card->>'appKey'=$1 AND card->>'ownerId'=$2
      AND card->>'status'='pending' FOR UPDATE`, [key, ownerId],
  )).rows;
  for (const card of cards) {
    await database.query(`UPDATE messages SET card=jsonb_set(card,'{status}','"connected"'::jsonb)
      WHERE id=$1`, [card.id]);
    if (card.card.resumeOnConnect === false) continue;
    const source = await systemLine(database, { roomId: card.room_id, authorId: ownerId,
      subject: { kind: 'person', id: ownerId, name: 'A member' }, verb: 'connected',
      object: card.card.name, consequence: 'The request can continue.' });
    const parent = card.card.commandId ? (await database.query<CommandRow>(
      `SELECT * FROM agent_commands WHERE id=$1 AND room_id=$2 AND agent_id=$3`,
      [card.card.commandId, card.room_id, card.card.agentId],
    )).rows[0] : undefined;
    if (parent?.state === 'cancelled') continue;
    await createAgentCommand(database, { roomId: card.room_id, agentId: card.card.agentId,
      sourceMessageId: source.id, reason: 'app_connected',
      ...(parent ? { parent, retainDepth: true } : {}) });
  }
  return [...new Set(cards.map(card => card.room_id))];
}
