#!/usr/bin/env -S node --import tsx
/**
 * Client half of the target-branch repro (see
 * `apps/body/scripts/repro-target-branch-proposal.ts`, which invokes this).
 *
 * Takes the control event the daemon actually published and runs it through
 * the app's own `projectChatEvent`, printing the card a reader would see.
 * Lives here rather than in apps/body because this app is isolated from the
 * root workspace and resolves `@/…` through its own tsconfig.
 */
import { readFileSync } from 'node:fs';
import { projectChatEvent } from '../sources/sync/transport/buzz-event-projection';
import type { SessionEvent } from '../sources/sync/transport/rig-transport';

const path = process.argv[2];
if (!path) throw new Error('usage: repro-target-branch-card.ts <event.json>');
const event = JSON.parse(readFileSync(path, 'utf8')) as {
  id?: string;
  pubkey: string;
  content: string;
  created_at: number;
  tags: string[][];
};

// A live relay delivery, exactly as `sessionEventsSubscribe` hands it over.
const sessionEvent: SessionEvent = {
  type: 'raw',
  sessionId: 'room',
  payload: {
    id: event.id ?? 'proposal-1',
    pubkey: event.pubkey,
    content: event.content,
    createdAt: event.created_at,
    tags: event.tags,
  },
};

const projected = projectChatEvent(sessionEvent, 'f'.repeat(64));
const proposal = projected.message?.targetBranchProposal;
console.log('    card text:', JSON.stringify(projected.message?.text));
console.log('    card data:', JSON.stringify(proposal));
if (!proposal?.from || !proposal.to) {
  console.error('    no proposal card was rendered');
  process.exit(1);
}
console.log(`    renders: "Change target branch: ${proposal.from} → ${proposal.to}" with Confirm`);
