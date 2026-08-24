/**
 * Operator gate audit: run the gateway's REAL metadata resolution + suppression
 * gates against the production relay for a registered identity and print one
 * verdict per candidate room.
 *
 * Usage:
 *   npx tsx scripts/audit-suppression.ts <pubkey-prefix> [room-id ...]
 *
 * With no room ids, the owner-visible kind:9 traffic from the last 14 days
 * names the candidate rooms. Each line shows the resolved NotificationContext,
 * whether the quiet default policy qualifies a chat-shaped event, and whether
 * the suppression gates would block it — exactly what handleRelayEvent decides.
 */
import { readFile } from 'node:fs/promises';
import { queryEvents } from '@beeline/buzz-client';
import { isSuppressedFixtureNotification, mapEventToNotification } from '../src/mapping.js';
import { NotificationMetadataResolver } from '../src/metadata.js';

const relayHttp = {
  baseUrl: process.env.BUZZY_RELAY_URL ?? 'http://127.0.0.1:3410',
  host: process.env.BUZZY_RELAY_HOST ?? 'relay.buzzrouter.com',
};

async function resolvePubkey(prefix: string): Promise<string> {
  const registryFile = process.env.BUZZY_PUSH_REGISTRY_FILE ?? '.data/registrations.json';
  const registry = JSON.parse(await readFile(registryFile, 'utf8')) as {
    registrations: Array<{ pubkey: string; tokens: string[] }>;
  };
  const match = registry.registrations.find((entry) => entry.pubkey.startsWith(prefix));
  if (!match) throw new Error(`no registered pubkey matches prefix ${prefix}`);
  return match.pubkey;
}

async function activeRooms(readerPubkey: string): Promise<string[]> {
  const since = Math.floor(Date.now() / 1000) - 14 * 24 * 3600;
  const events = await queryEvents(relayHttp, [{ kinds: [9], limit: 500, since }], readerPubkey);
  const rooms = new Map<string, number>();
  for (const event of events) {
    const channel = event.tags.find((tag) => tag[0] === 'h')?.[1];
    if (channel) rooms.set(channel, Math.max(rooms.get(channel) ?? 0, event.created_at));
  }
  return [...rooms.entries()].sort((left, right) => right[1] - left[1]).map(([id]) => id);
}

async function main(): Promise<void> {
  const [prefix, ...roomIds] = process.argv.slice(2);
  if (!prefix) {
    console.error('usage: tsx scripts/audit-suppression.ts <pubkey-prefix|full> [roomId ...]');
    process.exitCode = 1;
    return;
  }
  const readerPubkey = /^[0-9a-f]{64}$/.test(prefix) ? prefix : await resolvePubkey(prefix);
  const reader = {
    query: (filters: Record<string, unknown>[]) => queryEvents(relayHttp, filters, readerPubkey),
    disconnect: () => undefined,
  };
  const rooms = roomIds.length > 0 ? roomIds : await activeRooms(readerPubkey);
  console.log(`auditing ${rooms.length} room(s) as ${readerPubkey.slice(0, 16)}…`);
  for (const roomId of rooms) {
    // A plain agent-message marker models an ordinary chat message.
    const probe = {
      id: '0'.repeat(64),
      pubkey: 'f'.repeat(64),
      created_at: 1,
      kind: 9,
      tags: [
        ['h', roomId],
        ['t', 'agent-message'],
      ],
      content: 'audit probe',
      sig: '0'.repeat(128),
    } as const;
    try {
      const context = await new NotificationMetadataResolver().resolve(probe, reader);
      const plan = mapEventToNotification(probe, context);
      const suppressed = plan ? isSuppressedFixtureNotification(probe, context) : null;
      const verdict =
        !plan || suppressed === null
          ? 'fatigue-policy-ambient'
          : suppressed
            ? 'SUPPRESSED'
            : 'would-notify';
      console.log(`${roomId.slice(0, 12)} ${verdict} ${JSON.stringify(context)}`);
    } catch (error) {
      console.log(`${roomId.slice(0, 12)} RESOLVE-ERROR ${String(error).slice(0, 160)}`);
    }
  }
}

void main();
