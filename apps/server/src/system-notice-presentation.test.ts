import { describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { systemLine, ensureSystemIdentity } from './system-line.js';
import { systemNoticePresentation } from './system-notice-presentation.js';

// Inventory includes legacy cards and producers already requesting system lines.
const notices = [
  'wallet-tx', 'wallet-insufficient', 'wallet-delegation', 'wallet-signature',
  'squire-approval-decision', 'connection-receipt', 'workflow-handoff',
  'corner-workflow-handoff', 'github-corner-note', 'connector-offer-decision',
  'grant-decision', 'member-joined', 'member-left', 'member-removed',
  'room-visibility', 'agent-yolo', 'turn-failed', 'choice-answered',
  'choice-skipped', 'poll-closed', 'future-notice',
];
const controls = [
  'permission', 'grant-request', 'squire-approval', 'computer-session',
  'connector-offer', 'app-sign-in', 'agent-sign-in', 'choice',
  'target-branch', 'github-event', 'daemon-fact', 'corner', 'corner-app', 'voice-call',
];

describe('system notice presentation', () => {
  it.each(controls)('preserves the %s control surface', (type) => {
    expect(systemNoticePresentation('card', type)).toBe('card');
  });
  it('does not promote activity or ordinary messages', () => {
    expect(systemNoticePresentation('activity', 'workflow-handoff')).toBe('activity');
    expect(systemNoticePresentation('message', undefined)).toBe('message');
  });
  it('stores notices small and projects legacy notice cards small through the Room read', async () => {
    const db = new PgliteDatabase();
    try {
      await migrate(db);
      const person = 'a'.repeat(64);
      const workspace = '11111111-1111-4111-8111-111111111111';
      const room = '22222222-2222-4222-8222-222222222222';
      await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Viewer')`, [person]);
      await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Test')`, [workspace]);
      await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Notices')`, [room, workspace, person]);
      await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner'),($1,NULL,$3,'owner')`, [workspace, room, person]);
      const ids: string[] = [];
      for (const type of notices) {
        const line = await systemLine(db, { roomId: room, authorId: person,
          subject: { kind: 'system', name: 'System' }, verb: 'recorded', object: type,
          presentation: 'card', cardType: type, card: {} });
        ids.push(line.id);
      }
      const stored = await db.query<{ presentation: string }>(`SELECT presentation FROM messages WHERE id=ANY($1::text[])`, [ids]);
      expect(stored.rows).toHaveLength(notices.length);
      expect(stored.rows.every(row => row.presentation === 'system')).toBe(true);
      const fresh = await new PhoneService(db, 'http://local.test').readRoom(room, person);
      for (const message of fresh?.messages ?? []) {
        expect(message.presentation).toBe('system');
        expect(message.walletTx ?? message.walletInsufficient ?? message.walletDelegation).toBeUndefined();
      }
      // Simulate cards written by older servers, without changing metadata.
      await db.query(`UPDATE messages SET presentation='card' WHERE id=ANY($1::text[])`, [ids]);
      await ensureSystemIdentity(db);
      await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type) VALUES('legacy-plain',$1,$2,'System handed off implement','card','workflow-handoff')`, [room, SYSTEM_IDENTITY_ID]);
      const interactive = await systemLine(db, { roomId: room, authorId: person,
        subject: { kind: 'github', name: 'GitHub' }, verb: 'opened', object: 'PR',
        presentation: 'card', cardType: 'github-event',
        card: { type: 'pull-request', action: 'opened', title: 'PR', url: 'https://github.com/o/r/pull/1', actor: 'viewer' } });
      await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation) VALUES('human-card',$1,$2,'Human content','card')`, [room, person]);
      const view = await new PhoneService(db, 'http://local.test').readRoom(room, person);
      expect(view?.messages.find(message => message.id === 'legacy-plain')?.presentation).toBe('system');
      expect(view?.messages.find(message => message.id === interactive.id)).toMatchObject({
        presentation: 'card', githubEvent: { type: 'pull-request', title: 'PR' },
      });
      expect(view?.messages.find(message => message.id === 'human-card')?.presentation).toBe('card');
      for (const [index, id] of ids.entries()) {
        const message = view?.messages.find(message => message.id === id);
        if (['grant-decision', 'connector-offer-decision', 'corner-workflow-handoff'].includes(notices[index]!)) expect(message).toBeUndefined();
        else expect(message?.presentation, notices[index]).toBe('system');
      }
    } finally { await db.close(); }
  }, 30_000);
});
