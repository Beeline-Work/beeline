import { repairDeadlineFamilies, BackgroundRecordDeadlines } from './background-deadlines.js';

import { BackgroundWork } from './background-work.js';

import { INSTITUTIONAL_MEMORY_ON } from './institutional-memory-shadow.js';

import { readFileSync } from 'node:fs';

import { cornerRunStateSql } from './corner-run.js';

import { mkdtemp, rm, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { AcpClient } from '../../body/src/acp.js';

import { assembleTurnPrompt, cornerReviewerInstruction } from '../../body/src/prompt-assembly.js';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { seedCornerOpening, PgliteDatabase, migratedDatabase, assignCornerWorker, insertCornerFacts } from './test-support.js';

import { PhoneService } from './phone-service.js';

import { HelperDaemonService as DaemonService } from './test-fixtures/helper-daemon.js';

import { announceAgentLifecycle } from './connection-presence.js';

import { LiveHub } from './live.js';

import { PushDeliveryLoop, MediaExpiryLoop } from './background.js';

import { systemLine } from './system-line.js';

import { createAgentCommand, reconcileConfiguredCornerReviewers, REVIEWER_DISPATCH_REASONS, reviewerDispatchCarriesHead, routeSystemCommand } from './agent-command.js';

import { advanceCorner } from './corner-lifecycle.js';

import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';

import type { AgentCommand } from '@beeline/api-contract/daemon';

export const H = 'a'.repeat(64),
  A = 'b'.repeat(64),
  B = 'c'.repeat(64);

export const W = '11111111-1111-4111-8111-111111111111',
  R = '22222222-2222-4222-8222-222222222222',
  C = '33333333-3333-4333-8333-333333333333';

export let db: PgliteDatabase, phone: PhoneService, daemon: DaemonService;

export const commands = (agentId = A, roomId = R) =>
  daemon.execute('getAgentCommands', { roomId }, agentId).then((r) => r.commands);

export async function claim(c: AgentCommand, generationId = 'g1') {
  await daemon.execute(
    'claimAgentCommand',
    { roomId: c.roomId, commandId: c.id, generationId },
    c.agentId,
  );
  await daemon.execute(
    'postAgentTurnReceipt',
    {
      roomId: c.roomId,
      agentId: c.agentId,
      requestId: c.turnRequestId,
      generationId,
      status: 'working',
    },
    c.agentId,
  );
}

export const result = (c: AgentCommand, text: string, generationId = 'g1', extra = {}) =>
  daemon.execute(
    'postRoomMessage',
    {
      roomId: c.roomId,
      requestId: c.turnRequestId,
      generationId,
      text,
      ...extra,
    },
    c.agentId,
  );

beforeAll(async () => {
  db = await migratedDatabase();
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Human','human'),($2,'agent','Hoots','hoots'),($3,'agent','Goosy','goosy')`,
    [H, A, B],
  );
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`, [A, B, H]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Attribution')`, [W]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$3,'Room'),($2,$3,'Corner')`, [
    R,
    C,
    W,
  ]);
  await db.query(`UPDATE rooms SET parent_id=$1,created_by=$3 WHERE id=$2`, [R, C, A]);
  // A repository Room: its corners have a pull request path.
  await db.query(
    `UPDATE rooms SET repository_key='owner/widgets',repository_resolution='repository' WHERE id=$1`,
    [R],
  );
  await insertCornerFacts(db, { cornerId: C, ownerAgentId: A, lifecycle: '{"checks":"unknown"}' });
  for (const who of [H, A, B])
    for (const room of [null, R])
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`,
        [W, room, who],
      );
  phone = new PhoneService(db, 'http://test');
}, 30_000);

afterAll(async () => db?.close());

beforeEach(async () => {
  daemon = new DaemonService(db, new LiveHub());
  // These lifecycle fixtures model an independent PR author; provider checks have separate coverage.
  Object.assign(daemon, { github: { assertCornerReviewerNotAuthor: async () => {} } });
  await db.query('DELETE FROM free_agents WHERE agent_id=$1', [B]);
  // Each case starts a fresh failure episode despite reusing the same corner.
  await db.query(`DELETE FROM agent_startup_backoff`);
  await db.query(`DELETE FROM agent_commands`);
  await db.query(`DELETE FROM corner_merge_approvals`);
  await db.query(`DELETE FROM agent_turns`);
  await db.query(`DELETE FROM live_outputs`);
  await db.query(`DELETE FROM messages WHERE room_id=$1`, [C]);
  await db.query(`DELETE FROM corner_brief_revisions WHERE corner_id=$1`, [C]);
  await db.query(`UPDATE agents SET access_policy='{"type":"everyone"}'::jsonb`);
  await db.query(`UPDATE memberships SET removed_at=NULL`);
  await db.query(`DELETE FROM agent_subscriptions WHERE source='room'`);
  await db.query(`UPDATE rooms SET reviewer_agent_id=NULL`);
  await db.query(
    `UPDATE corner_github_cache SET lifecycle='{"checks":"unknown"}'::jsonb`,
  );
  await seedCornerOpening(db, { cornerId: C, commissionedBy: H });
});


/** Put the corner in the state a green transition leaves it in. */
export async function greenHead(number: number, headSha: string, checks = 'passing') {
  await db.query(
    `UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`,
    [
      C,
      JSON.stringify({
        checks,
        lifecycle: 'in-review',
        pr: { number, url: `https://github.com/acme/repo/pull/${number}`, headSha },
      }),
    ],
  );
  await systemLine(db, {
    roomId: C,
    authorId: H,
    subject: { kind: 'github', name: 'GitHub' },
    verb: 'passed a check',
    kind: 'check-passed',
  });
}
export const rootFixture = {
get db(){return db;}, set db(value: typeof db){db=value;},
get phone(){return phone;}, set phone(value: typeof phone){phone=value;},
get daemon(){return daemon;}, set daemon(value: typeof daemon){daemon=value;},
};

export { repairDeadlineFamilies, BackgroundRecordDeadlines } from './background-deadlines.js';
export { BackgroundWork } from './background-work.js';
export { INSTITUTIONAL_MEMORY_ON } from './institutional-memory-shadow.js';
export { readFileSync } from 'node:fs';
export { cornerRunStateSql } from './corner-run.js';
export { mkdtemp, rm, writeFile } from 'node:fs/promises';
export { tmpdir } from 'node:os';
export { join } from 'node:path';
export { AcpClient } from '../../body/src/acp.js';
export { assembleTurnPrompt, cornerReviewerInstruction } from '../../body/src/prompt-assembly.js';
export { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
export { seedCornerOpening, PgliteDatabase, migratedDatabase, assignCornerWorker, insertCornerFacts } from './test-support.js';
export { PhoneService } from './phone-service.js';
export { HelperDaemonService as DaemonService } from './test-fixtures/helper-daemon.js';
export { announceAgentLifecycle } from './connection-presence.js';
export { LiveHub } from './live.js';
export { PushDeliveryLoop, MediaExpiryLoop } from './background.js';
export { systemLine } from './system-line.js';
export { createAgentCommand, reconcileConfiguredCornerReviewers, REVIEWER_DISPATCH_REASONS, reviewerDispatchCarriesHead, routeSystemCommand } from './agent-command.js';
export { advanceCorner } from './corner-lifecycle.js';
export { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
export type { AgentCommand } from '@beeline/api-contract/daemon';
