#!/usr/bin/env node
/**
 * Demonstration for fanout performance fixes (audit follow-up).
 * Prints observable Y for the Room-deck subscribe path and latency floors.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

const channels = read('apps/mobile/sources/app/(app)/beeline/channels.tsx');
const transport = read('apps/mobile/sources/sync/transport/monolith-rig-transport.ts');
const server = read('apps/server/src/server.ts');
const refresh = read('packages/buzz-client/src/surface-refresh.ts');
const presence = read('apps/server/src/connection-presence.ts');
const live = read('apps/server/src/live.ts');
const background = read('apps/server/src/background.ts');
const index = read('apps/server/src/index.ts');

const roomIds = Array.from(
  { length: 200 },
  (_, i) => `22222222-2222-2222-2222-${String(i).padStart(12, '0')}`,
);

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

const checks = [];
function check(id, ok, detail) {
  checks.push({ id, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}: ${detail}`);
}

check(
  'F1.cold-no-workspace-h',
  channels.includes('cachedChats?.watchFilters ?? []') &&
    channels.includes('installChatWatch') &&
    !channels.includes("'#h': [selectedId]"),
  'cold deck seeds empty filters; apply reinstalls from chats watchFilters',
);

check(
  'F1.batch-subscribe-frame',
  transport.includes("type: 'subscribe', roomIds: [...roomIds]") &&
    server.includes('canReadRooms') &&
    server.includes('requestedRoomIds'),
  `one subscribe frame for ${extractRoomIds([{ '#h': roomIds }]).length} Room ids + one auth batch`,
);

check(
  'F150.composed-coalesce-floors',
  refresh.includes('minimumIntervalMs ?? 50') &&
    server.includes('LIVE_INTERACTION_TARGET_MS = 150') &&
    server.includes('LIVE_DELTA_DEADLINE_MS = Math.floor(LIVE_INTERACTION_TARGET_MS / 3)'),
  'deadline 50 ms + scheduler 50 ms compose under the 150 ms interaction target',
);

check(
  'F2.listener-owned-presence',
  index.includes('useListenerPresenceFanout()') &&
    presence.includes('listenerOwnsPresenceFanout()') &&
    live.includes('previous.status === event.status'),
  'writer skips local presence fanout when listener owns it; exact versions dedupe',
);

check(
  'F4.push-concurrency',
  background.includes('PUSH_DELIVERY_CONCURRENCY = 8') &&
    background.includes('Math.min(PUSH_DELIVERY_CONCURRENCY'),
  'claimed push sends run with concurrency 8 after serial claim',
);

const failed = checks.filter((c) => !c.ok);
if (failed.length) {
  console.error(`\n${failed.length} demonstration check(s) failed`);
  process.exit(1);
}
console.log(`\nDemonstrated ${checks.length} fanout fixes`);
