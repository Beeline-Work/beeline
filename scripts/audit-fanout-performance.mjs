#!/usr/bin/env node
/**
 * Structural demonstration for the fanout/performance audit.
 * Prints observable Y for each ranked finding by reading the committed sources
 * and simulating the deck subscribe id extraction (same rules as
 * MonolithRigTransport.surfaceSubscribe). Does not mutate product code.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return readFileSync(join(root, rel), 'utf8');
}

function extractRoomIds(filters) {
  return [
    ...new Set(
      filters
        .flatMap((filter) => [
          ...(filter['#h'] ?? []),
          ...(filter['#d'] ?? []).map((value) => value.split(':').at(-1) ?? ''),
        ])
        .filter(Boolean),
    ),
  ];
}

const channels = read('apps/mobile/sources/app/(app)/beeline/channels.tsx');
const transport = read('apps/mobile/sources/sync/transport/monolith-rig-transport.ts');
const server = read('apps/server/src/server.ts');
const presence = read('apps/server/src/connection-presence.ts');
const postgresLive = read('apps/server/src/postgres-live.ts');
const live = read('apps/server/src/live.ts');
const phone = read('apps/server/src/phone-service.ts');
const corpus = read('apps/server/src/production-corpus-hot-reads.test.ts');
const background = read('apps/server/src/background.ts');
const apns = read('apps/server/src/apns-push.ts');
const index = read('apps/server/src/index.ts');
const navEvidence = read('apps/mobile/evidence/navigation-performance-api36.md');
const roomSession = read('apps/mobile/sources/app/(app)/beeline/chat/useRoomSurfaceSession.ts');
const budgets = read('apps/server/src/production-corpus-performance.ts');

const workspaceId = '11111111-1111-1111-1111-111111111111';
const roomIds = Array.from(
  { length: 200 },
  (_, i) => `22222222-2222-2222-2222-${String(i).padStart(12, '0')}`,
);

const coldFilters = [{ kinds: [9, 9000, 9001, 9007], '#h': [workspaceId] }];
const cachedFilters = [{ kinds: [9, 9000, 9001, 9002, 9007, 9008], '#h': roomIds }];
const coldSubscribeIds = extractRoomIds(coldFilters);
const cachedSubscribeIds = extractRoomIds(cachedFilters);

const checks = [];

function check(id, ok, detail) {
  checks.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}: ${detail}`);
}

check(
  'F1.cold-filter-uses-workspace',
  channels.includes("cachedChats?.watchFilters ?? [{ kinds: [9, 9000, 9001, 9007], '#h': [selectedId] }]") &&
    channels.includes('workspaceId: selectedId'),
  `cold deck would subscribe roomIds=${JSON.stringify(coldSubscribeIds)} (workspace UUID, not Room)`,
);

check(
  'F1.deck-never-reinstalls-watch',
  channels.includes('surfaceSubscribe') &&
    !channels.includes('nextWatchKey') &&
    roomSession.includes('if (fresh && nextWatchKey !== watchKey) void installWatch'),
  'channels.tsx has no watch reinstall; useRoomSurfaceSession does — deck stays on first filters',
);

check(
  'F1.per-room-subscribe-frames',
  transport.includes('for (const roomId of roomIds) next.send(JSON.stringify({ type: \'subscribe\', roomId }))') &&
    transport.includes('30_000') &&
    server.includes('canReadRoom(item.roomId, principal.identityId)'),
  `cached deck would emit ${cachedSubscribeIds.length} subscribe frames, each authorized alone; poll=${30_000}ms`,
);

check(
  'F1.chats-watchFilters-width',
  phone.includes("ORDER BY COALESCE(lm.created_at,r.updated_at) DESC,r.id LIMIT 201") &&
    phone.includes("'#h': rooms.rows.map((row) => row.id)"),
  'readChats returns watchFilters over up to 201 Room ids',
);

check(
  'F2.writer-broadcasts-then-listener',
  presence.includes('if (changed.rowCount) await broadcastAgentPresence(database, live, agentId)') &&
    presence.includes('async function broadcastAgentPresence') &&
    postgresLive.includes("if (payload.kind === 'presence')") &&
    postgresLive.includes('this.live.publish({\n            type: \'presence\''),
  'evidence write calls broadcastAgentPresence; postgres-live repeats membership fanout on NOTIFY',
);

check(
  'F2.livehub-no-equal-online-dedupe',
  live.includes("previous.observedAt === event.observedAt && previous.status === 'offline'") &&
    !live.includes("previous.status === event.status"),
  'LiveHub suppresses only newer/equal-offline presence; equal online re-emits',
);

check(
  'F3.corpus-one-room-one-corner',
  corpus.includes("($1,$3,NULL,$4,'Hot Room'),($2,$3,$1,$4,'Hot Corner')") &&
    phone.includes('JOIN rooms corner ON corner.parent_id=room.id') &&
    phone.includes('LEFT JOIN LATERAL(\n             SELECT * FROM messages WHERE room_id=corner.id'),
  '35,100-message corpus seeds one Room+corner; topLevelRoomRows laterals every visible corner',
);

check(
  'F4.serial-push-on-leader',
  background.includes('for (const candidate of candidates.rows)') &&
    background.includes("LIMIT 100") &&
    apns.includes('APNS_REQUEST_TIMEOUT_MS = 15_000') &&
    background.includes('PUSH_DELIVERY_MIN_INTERVAL_MS = 5_000') &&
    index.includes('if (push) await push.runIfDue()') &&
    index.includes('await schedules.runOnce()'),
  'push serializes ≤100 sends (APNs timeout 15s) on the same BackgroundLeader cycle as schedules/expiry',
);

check(
  'F5.client-evidence-relay-era',
  navEvidence.includes('public Buzz relay') &&
    navEvidence.includes('306 ms') &&
    navEvidence.includes('430 ms') &&
    navEvidence.includes('486 ms'),
  'navigation-performance-api36.md paints are relay-era; no monolith deck/transcript paint bench in that file',
);

check(
  'targets.hot-read-and-live-delta',
  budgets.includes("'room-view': 250") &&
    budgets.includes("'room-list': 100") &&
    server.includes('LIVE_DELTA_DEADLINE_MS = 400'),
  'hot-read budgets 100–250 ms; live-delta fallback deadline 400 ms',
);

const failed = checks.filter((c) => !c.ok);
console.log('');
console.log('RANKING');
console.log('1. P1 F1 Room-deck live subscribe miswire (outranks F2: correctness + pool)');
console.log('2. P1 F2 Duplicate presence fanout on writer');
console.log('3. P2 F3 Hot-read corpus lacks family width');
console.log('4. P2 F4 Push delivery serializes on sole leader');
console.log('5. P2 F5 Client paint evidence is relay-era');
console.log('');
console.log(
  failed.length === 0
    ? `Y: all ${checks.length} structural checks confirmed; subscription batching outranks duplicate presence fanout`
    : `Y: ${failed.length} structural check(s) failed — audit evidence drifted`,
);
process.exit(failed.length === 0 ? 0 : 1);
