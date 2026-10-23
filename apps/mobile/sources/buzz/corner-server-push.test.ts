import React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { CHOICE_CARD_TYPE, readCornerListView, readChatListView } from '@beeline/api-contract/phone';
import { migrate } from '../../../server/src/database';
import { PgliteDatabase } from '../../../server/src/test-support';
import { PhoneService } from '../../../server/src/phone-service';
import { PushDeliveryLoop, type PushSender } from '../../../server/src/background';
import { apnsPushRequest } from '../../../server/src/apns-push';
import { createTranscriptScrollController, requestMessageJump } from './transcript-scroll-controller';
import { pushMessageData, firebasePushMessage } from '../../../server/src/firebase-push';
import { cornerHeaderItem, cornerDisplayState } from './corner-display-state';
import { roomRowPresentation } from './room-list-row';

vi.mock('react-native', async () => {
  const react = await import('react');
  return { Text: (props: any) => react.createElement('Text', props, props.children),
    View: (props: any) => react.createElement('View', props, props.children) };
});
vi.mock('react-native-unistyles', () => ({ StyleSheet: { create: () => ({ metaCaps: {} }) } }));
import { CornerHeaderAgentText } from '@/components/buzz/HeaderLadder';

const db = new PgliteDatabase();
const human = 'a'.repeat(64), agent = 'b'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const room = '22222222-2222-4222-8222-222222222222';
const phone = new PhoneService(db, 'http://local.test');
const send = vi.fn<PushSender['send']>().mockResolvedValue(undefined);
const loop = new PushDeliveryLoop(db, { send });

beforeAll(async () => {
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name,handle,push_level) VALUES
    ($1,'human','Owner','owner','full'),($2,'agent','Jellybean','jellybean','full')`, [human, agent]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [workspace]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Room')`, [room, workspace]);
  for (const channel of [null, room]) {
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,$2,$3,'owner'),($1,$2,$4,'member')`, [workspace, channel, human, agent]);
  }
  await db.query(`INSERT INTO push_devices(token,identity_id,platform,environment)
    VALUES('parity-device-token-12345678901234567890',$1,'android','physical')`, [human]);
  await loop.runOnce();
}, 30_000);
afterAll(() => db.close());

it.each([
  { index: 1, reason: 'approve' as const, type: 'squire-approval', card: { approvalId: 'approval', status: 'pending' } },
  { index: 2, reason: 'connect' as const, type: 'connector-offer', card: { status: 'pending', addressee: { pubkey: human } } },
  { index: 3, reason: 'question' as const, type: CHOICE_CARD_TYPE, card: { mode: 'question', status: 'open', requester: { pubkey: human }, mentionIds: [human] } },
  { index: 4, reason: undefined, type: null, card: null },
])('R1: $reason server state agrees on header, Room list, Corners list and push (case $index)', async ({ index, reason, type, card }) => {
  const corner = `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`;
  const messageId = index.toString(16).padStart(64, '0');
  await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name,created_by)
    VALUES($1,$2,$3,$4,$5)`, [corner, workspace, room, `Corner ${index}`, human]);
  await db.query(`INSERT INTO corner_facts(corner_id,owner_agent_id,commissioned_by)
    VALUES($1,$2,$3)`, [corner, agent, human]);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation,card_type,card,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,CASE WHEN $5='card' THEN now()-interval '1 minute' ELSE now() END)`,
  [messageId, corner, agent, reason ? '@owner please respond' : 'done: @owner finished',
    reason ? 'card' : 'message', type, JSON.stringify(card)]);

  // The blocker predates the delivery floor. An ordinary addressed update
  // exercises the existing push policy without changing which cards push.
  const notificationId = reason ? (index + 20).toString(16).padStart(64, '0') : messageId;
  if (reason) await db.query(`INSERT INTO messages(id,room_id,author_id,text)
    VALUES($1,$2,$3,'@owner an update on the open request')`, [notificationId, corner, agent]);

  const corners = readCornerListView(await phone.readCorners(room, human));
  const page = corners!.corners.find(item => item.corner.id === corner)!;
  const chats = readChatListView(await phone.readChats(workspace, human));
  const row = chats!.chats.find(item => item.room.id === room)!.openCorners!.find(item => item.id === corner)!;
  const header = cornerHeaderItem(page, false)!;
  const state = reason ? 'waiting' : 'idle';
  expect(cornerDisplayState(header).status).toBe(state);
  expect(page.state).toBe(state);
  const roomProjection = roomRowPresentation({ corners: [{ ...row, openerPubkey: agent }] }, new Map());
  expect(roomProjection.corners[0]?.state).toBe(state);

  const before = send.mock.calls.length;
  expect(await loop.runOnce()).toBe(1);
  const delivery = send.mock.calls.slice(before).find(([, message]) => message.messageId === notificationId)![1];
  const payload = pushMessageData(delivery);
  expect(JSON.parse(payload.cornerState!)).toEqual(reason
    ? { state, reason, itemId: messageId, blocker: { kind: 'message', personId: human, personName: 'Owner' } } : { state });
  expect(firebasePushMessage('device', delivery).data?.cornerState).toBe(payload.cornerState);
  expect(apnsPushRequest('device', delivery, 'app.usebeeline', 'test-provider').payload.cornerState).toBe(payload.cornerState);
  expect(header.reason).toBe(reason);
  expect(row.reason).toBe(reason);

  // A loaded transcript row stands in for the native list, with its real
  // scroll controller receiving the source-link destination.
  const toRow = vi.fn(() => true);
  const read = vi.fn();
  const transcript = [{ id: messageId }];
  const controller = createTranscriptScrollController({
    rows: () => transcript,
    rowIndex: (destination, rows) => rows.findIndex(row => row.id === destination.messageId),
    list: () => ({ toNewest: vi.fn(), toOffset: vi.fn(), toEstimatedRow: vi.fn(), shiftBy: vi.fn(), toRow }),
    schedule: callback => callback(),
  });
  let tree: ReturnType<typeof create>;
  act(() => { tree = create(React.createElement(CornerHeaderAgentText, {
    name: 'Jellybean', stateWord: header.state, waitingReason: header.reason, blocker: header.blocker, viewerId: human,
    onReasonPress: header.itemId ? () => requestMessageJump(controller, header.itemId!, read) : undefined,
  })); });
  const texts = tree!.root.findAllByType('Text' as never);
  expect(texts[0]!.props.children[0]).toBe('JELLYBEAN');
  const link = texts.find((node: any) => node.props.accessibilityRole === 'link');
  if (reason) {
    expect(link?.props.children).toBe('waiting');
    act(() => link!.props.onPress());
    expect(toRow).toHaveBeenCalledWith(0, messageId, 'top');
    expect(read).toHaveBeenCalledWith(messageId);
  } else expect(link).toBeUndefined();
  console.log(`R1 ${reason ?? 'done-only'}: header=${header.state}, Room=${row.state}, Corners=${page.state}, push=${JSON.parse(payload.cornerState!).state}`);
}, 30_000);


it('R1: a real hold reaches the header through server reads with its source message link', async () => {
  const corner = '33333333-3333-4333-8333-000000000099';
  await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name,created_by)
    VALUES($1,$2,$3,'Held corner',$4)`, [corner, workspace, room, human]);
  await db.query(`INSERT INTO corner_merge_holds(corner_id,actor_id,standing)
    VALUES($1,$2,'owner')`, [corner, human]);
  const page = readCornerListView(await phone.readCorners(room, human))!.corners.find(item => item.corner.id === corner)!;
  const row = readChatListView(await phone.readChats(workspace, human))!.chats.find(item => item.room.id === room)!.openCorners!.find(item => item.id === corner)!;
  expect(page.blocker).toEqual({ kind: 'merge-hold', personId: human, personName: 'Owner' });
  expect(row.blocker).toEqual(page.blocker);
  expect(page.itemId).toBeTruthy();
  expect(row.itemId).toBe(page.itemId);
  let tree: ReturnType<typeof create>;
  const jump = vi.fn();
  act(() => { tree = create(React.createElement(CornerHeaderAgentText, { name: 'Ruby', state: page.state,
    waitingReason: page.reason, blocker: page.blocker, viewerId: human, onReasonPress: jump })); });
  const texts = tree!.root.findAllByType('Text' as never);
  expect(texts[0]!.props.children[0]).toBe('RUBY');
  const link=texts.find((node:any)=>node.props.accessibilityRole==='link');
  act(()=>link!.props.onPress());
  expect(jump).toHaveBeenCalledOnce();
});
