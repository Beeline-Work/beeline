import { describe, expect, it, vi } from 'vitest';

import {
  BackgroundJobRunner,
  createPushTestSender,
  MediaExpiryLoop,
  PUSH_DELIVERY_CONCURRENCY,
  PushDeliveryLoop,
  READ_CLEAR_INTERVAL_SECONDS,
  READ_CLEAR_MAX_CHANNELS,
  READ_CLEAR_MAX_MESSAGE_IDS,
  runMaintenance,
} from './background.js';

import { TokenAuth } from './auth.js';

import { DaemonService } from './daemon-service.js';

import { LiveHub } from './live.js';

import { seedCornerOpening, MemoryObjectStorage, migratedDatabase, insertCornerFacts } from './test-support.js';

import {
  ARTIFACT_TTL_HOURS,
  MEDIA_SWEEP_INTERVAL_MS,
  MEDIA_TTL_HOURS,
  mediaTtlHours,
} from './media-ttl.js';

import { ObjectService } from './object-service.js';

import { PhoneService } from './phone-service.js';

import { APNS_MAX_PAYLOAD_BYTES, ApnsPushError, apnsReadClearRequest } from './apns-push.js';

import { ensureSystemDirectMessageRoom, ensureSystemIdentity } from './system-line.js';

import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';

import { cornerTitle, type ReadClear as ReadClearCursor } from '@beeline/api-contract/phone';

export function fixtureScope2() {

  const owner = 'c'.repeat(64);

  const fresh = '33333333-3333-4333-8333-333333333333';

  const stale = '44444444-4444-4444-8444-444444444444';


  async function seed() {
    const db = await migratedDatabase();
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner')`, [owner]);
    const storage = new MemoryObjectStorage();
    await storage.putObject(`media/${owner}/${'a'.repeat(64)}`, Buffer.from([0]), 'image/png');
    await storage.putObject(`media/${owner}/${'b'.repeat(64)}`, Buffer.from([1]), 'image/png');
    await db.query(
      `INSERT INTO objects(id,owner_id,kind,key,mime,title,size,sha256,state,created_at,expires_at)
       VALUES($1,$3,'media',$6,'image/png','fresh.png',1,$4,'ready',now()-interval '23 hours',now()+interval '1 hour'),
             ($2,$3,'media',$7,'image/png','stale.png',1,$5,'ready',now()-interval '25 hours',now()-interval '1 hour')`,
      [
        fresh,
        stale,
        owner,
        'a'.repeat(64),
        'b'.repeat(64),
        `media/${owner}/${'a'.repeat(64)}`,
        `media/${owner}/${'b'.repeat(64)}`,
      ],
    );
    const service = new ObjectService(db, storage.asStorage(), 'http://x');
    return { db, storage, service };
  }
return {
owner,
fresh,
stale,
seed,
};
}
export { describe, expect, it, vi } from 'vitest';
export { BackgroundJobRunner, createPushTestSender, MediaExpiryLoop, PUSH_DELIVERY_CONCURRENCY, PushDeliveryLoop, READ_CLEAR_INTERVAL_SECONDS, READ_CLEAR_MAX_CHANNELS, READ_CLEAR_MAX_MESSAGE_IDS, runMaintenance } from './background.js';
export { TokenAuth } from './auth.js';
export { DaemonService } from './daemon-service.js';
export { LiveHub } from './live.js';
export { seedCornerOpening, MemoryObjectStorage, migratedDatabase, insertCornerFacts } from './test-support.js';
export { ARTIFACT_TTL_HOURS, MEDIA_SWEEP_INTERVAL_MS, MEDIA_TTL_HOURS, mediaTtlHours } from './media-ttl.js';
export { ObjectService } from './object-service.js';
export { PhoneService } from './phone-service.js';
export { APNS_MAX_PAYLOAD_BYTES, ApnsPushError, apnsReadClearRequest } from './apns-push.js';
export { ensureSystemDirectMessageRoom, ensureSystemIdentity } from './system-line.js';
export { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
export { cornerTitle } from '@beeline/api-contract/phone';
export type { ReadClear as ReadClearCursor } from '@beeline/api-contract/phone';
