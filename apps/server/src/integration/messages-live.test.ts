import { claimAgentCommand } from '.././agent-command.js';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PhoneService } from '.././phone-service.js';
import { type RoomView } from '@beeline/api-contract/phone';
import { monolithFixture, HUMAN, AGENT, WORKSPACE, ROOM, next } from '../test-fixtures/test-support-monolith.js';

describe('monolith integration: messages-live', () => {
const fixture = monolithFixture();


  it('toggles a fixed reaction and projects its identity roster for the viewer', async () => {
    const messageId = '9'.repeat(64);
    expect(
      (await fixture.operation('sendRoomMessage', { roomId: ROOM, messageId, text: 'React here' })).status,
    ).toBe(200);
    const reactionReceipt = await fixture.operation('reactToMessage', { roomId: ROOM, messageId, emoji: '👍' });
    expect(reactionReceipt.status).toBe(200);
    expect((await reactionReceipt.json()).reactions).toEqual([
      expect.objectContaining({ emoji: '👍', count: 1, reacted: true }),
    ]);

    const reacted = (await (await fixture.request(`/v1/phone/rooms/${ROOM}`, 'GET')).json()) as RoomView;
    expect(reacted.messages.find((message) => message.id === messageId)?.reactions).toEqual([
      {
        emoji: '👍',
        count: 1,
        reacted: true,
        members: [{ pubkey: HUMAN, kind: 'human', name: 'Owner', handle: 'owner' }],
      },
    ]);

    await fixture.database.query(`UPDATE messages SET reactions=$2::jsonb WHERE id=$1`, [
      messageId,
      JSON.stringify({ '👍': [HUMAN, AGENT] }),
    ]);
    const multiple = (await (await fixture.request(`/v1/phone/rooms/${ROOM}`, 'GET')).json()) as RoomView;
    expect(multiple.messages.find((message) => message.id === messageId)?.reactions).toEqual([
      {
        emoji: '👍',
        count: 2,
        reacted: true,
        members: [
          { pubkey: HUMAN, kind: 'human', name: 'Owner', handle: 'owner' },
          { pubkey: AGENT, kind: 'agent', name: 'Bee', handle: 'bee' },
        ],
      },
    ]);
    expect((await fixture.phone.readHistory(ROOM, HUMAN))?.messages.at(-1)?.reactions).toEqual(
      multiple.messages.find((message) => message.id === messageId)?.reactions,
    );
    await fixture.database.query(`UPDATE messages SET reactions=$2::jsonb WHERE id=$1`, [
      messageId,
      JSON.stringify({ '👍': [HUMAN] }),
    ]);

    expect(
      (await fixture.operation('reactToMessage', { roomId: ROOM, messageId, emoji: '👍' })).status,
    ).toBe(200);
    const cleared = (await (await fixture.request(`/v1/phone/rooms/${ROOM}`, 'GET')).json()) as RoomView;
    expect(cleared.messages.find((message) => message.id === messageId)?.reactions).toBeUndefined();
  });


  it('proves send -> read -> daemon prompt -> reply -> WebSocket delta and overlays', async () => {
    const socket = new WebSocket(`${fixture.origin.replace('http', 'ws')}/v1/phone/live`, [
      `bearer.${fixture.accessToken}`,
    ]);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    socket.send(JSON.stringify({ type: 'subscribe', roomId: ROOM }));
    await next(socket, 'subscribed');
    const sent = await fixture.request('/v1/phone/operations/sendRoomMessage', 'POST', {
      roomId: ROOM,
      messageId: 'c'.repeat(64),
      text: 'Please inspect this',
    });
    expect(sent.status).toBe(200);
    const { messageId } = (await sent.json()) as { messageId: string };
    expect(messageId).toBe('c'.repeat(64));
    const room = (await (await fixture.request(`/v1/phone/rooms/${ROOM}`)).json()) as {
      messages: Array<{ id: string; text: string }>;
    };
    expect(room.messages).toContainEqual(
      expect.objectContaining({ id: messageId, text: 'Please inspect this' }),
    );
    const threaded = await fixture.request('/v1/phone/operations/sendRoomReply', 'POST', {
      roomId: ROOM,
      messageId: 'd'.repeat(64),
      parentMessageId: messageId,
      text: '@bee What is your soul?',
      mentions: [AGENT],
    });
    expect(threaded.status).toBe(200);
    const { messageId: threadedMessageId } = (await threaded.json()) as { messageId: string };
    expect(threadedMessageId).toBe('d'.repeat(64));
    const threadedRoom = (await (await fixture.request(`/v1/phone/rooms/${ROOM}`)).json()) as {
      messages: Array<{
        id: string;
        text: string;
        reply?: { channelId: string; eventId: string; rootId: string };
      }>;
    };
    expect(threadedRoom.messages).toContainEqual(
      expect.objectContaining({
        id: threadedMessageId,
        text: '@bee What is your soul?',
        reply: { channelId: ROOM, eventId: messageId, rootId: messageId },
      }),
    );
    const conversation = await fixture.request(
      '/v1/daemon/operations/getRoomConversation',
      'POST',
      { roomId: ROOM },
      fixture.daemonToken,
    );
    // The helper is unreachable right now, but the mention is still durably
    // queued, so the send writes no premature did-not-answer line. The message
    // that caused it stands last.
    const conversationItems = ((await conversation.json()) as { items: Array<{ body: string }> })
      .items;
    expect(conversationItems.at(-1)?.body).toBe('@bee What is your soul?');
    expect(conversationItems.some((item) => item.body.includes('did not answer'))).toBe(false);
    // Each human input keeps its own pending command.
    const queued = (await fixture.database.query<{ id: string }>(
      `SELECT id FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND source_message_id=$3`,
      [ROOM, AGENT, messageId],
    )).rows[0];
    const claimed = await claimAgentCommand(fixture.database, ROOM, AGENT, queued.id, 'fixture-generation');
    expect(claimed.source_message_id).toBe(messageId);
    expect((await fixture.database.query('SELECT state FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2', [threadedMessageId, AGENT])).rows).toEqual([{state:'pending'}]);
    const delivered = next(socket, 'message-delta');
    const reply = await fixture.daemonOperation(
      'postRoomMessage',
      { roomId: ROOM, requestId: messageId, text: 'I am Terra.' },
      fixture.daemonToken,
    );
    expect(reply.status).toBe(200);
    expect(await delivered).toEqual(
      expect.objectContaining({
        type: 'message-delta',
        roomId: ROOM,
        message: expect.objectContaining({ requestId: messageId, text: 'I am Terra.' }),
      }),
    );
    const answeredRoom = (await (await fixture.request(`/v1/phone/rooms/${ROOM}`)).json()) as {
      messages: Array<{ requestId?: string; text: string }>;
    };
    expect(answeredRoom.messages).toContainEqual(
      expect.objectContaining({ requestId: messageId, text: 'I am Terra.' }),
    );
    await fixture.daemonOperation(
      'postAgentDraft',
      { agentId: AGENT, roomId: ROOM, turnId: 'turn-1', text: 'Working' },
      fixture.daemonToken,
    );
    expect(await new PhoneService(fixture.database, fixture.origin).liveDraftSnapshot(ROOM)).toEqual([]);
    const toolRequestId = 'tool-request';
    expect(
      (
        await fixture.daemonOperation('postAgentTurnReceipt', {
          agentId: AGENT,
          roomId: ROOM,
          requestId: toolRequestId,
          status: 'working',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fixture.daemonOperation('postAgentActivity', {
          agentId: AGENT,
          roomId: ROOM,
          requestId: toolRequestId,
          activity: [
            {
              kind: 'tool',
              title: 'Bash',
              operation: 'execute',
              command: 'npm test -- ActivityTimeline',
              status: 'exit 0',
              output: 'first result line\nlast result line',
              files: [{ path: 'apps/mobile/sources/components/buzz/ActivityTimeline.tsx' }],
            },
          ],
        })
      ).status,
    ).toBe(200);
    const activityRoom = (await (await fixture.request(`/v1/phone/rooms/${ROOM}`)).json()) as {
      messages: Array<{ presentation: string; activity?: unknown }>;
    };
    expect(activityRoom.messages).toContainEqual(
      expect.objectContaining({
        presentation: 'activity',
        activity: [
          {
            kind: 'tool',
            title: 'Bash',
            operation: 'execute',
            command: 'npm test -- ActivityTimeline',
            status: 'exit 0',
            output: 'first result line\nlast result line',
            files: [{ path: 'apps/mobile/sources/components/buzz/ActivityTimeline.tsx' }],
          },
        ],
      }),
    );
    socket.close();
  });


  it('never reports unread for the viewer’s own latest message', async () => {
    // A live helper is the quiet case: with a fresh presence heartbeat the send
    // writes no unread-mention notice, so the only rows here are the two the
    // test is about (`agent-access.test.ts` owns the noisy case).
    await fixture.database.query(
      `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body)
       VALUES($1,$2,'presence','presence',$3::jsonb)`,
      [
        ROOM,
        AGENT,
        JSON.stringify({ status: 'online', observedAt: Math.floor(Date.now() / 1000) }),
      ],
    );
    const sent = await fixture.operation('sendRoomMessage', {
      roomId: ROOM,
      messageId: 'c'.repeat(64),
      text: 'My own note',
    });
    expect(sent.status).toBe(200);
    const readChats = async () =>
      (
        (await (await fixture.request(`/v1/phone/workspaces/${WORKSPACE}/chats`)).json()) as {
          chats: Array<{ room: { id: string }; unread: boolean }>;
        }
      ).chats.find((chat) => chat.room.id === ROOM)!;
    expect((await readChats()).unread).toBe(false);

    await fixture.daemonOperation('postRoomMessage', {
      roomId: ROOM,
      requestId: 'd'.repeat(64),
      text: 'Agent reply',
    });
    expect((await readChats()).unread).toBe(true);

    const agentMessage = (
      (await (await fixture.request(`/v1/phone/rooms/${ROOM}`)).json()) as {
        messages: Array<{ id: string; text: string }>;
      }
    ).messages.find((message) => message.text === 'Agent reply');
    expect(
      (await fixture.request(`/v1/phone/rooms/${ROOM}/read`, 'POST', { messageId: agentMessage!.id }))
        .status,
    ).toBe(204);
    expect((await readChats()).unread).toBe(false);
  });


  it('treats concurrent retries of the same message write as one successful send', async () => {
    const payload = {
      roomId: ROOM,
      messageId: 'd'.repeat(64),
      text: '@bee Send this once',
      mentions: [AGENT],
    };

    const [foreground, outbox] = await Promise.all([
      fixture.request('/v1/phone/operations/sendRoomMessage', 'POST', payload),
      fixture.request('/v1/phone/operations/sendRoomMessage', 'POST', payload),
    ]);

    expect([foreground.status, outbox.status]).toEqual([200, 200]);
    expect(await foreground.json()).toMatchObject({
      messageId: payload.messageId,
      activeSteerAgentIds: [],
      message: { id: payload.messageId, text: payload.text },
    });
    expect(await outbox.json()).toMatchObject({ messageId: payload.messageId, activeSteerAgentIds: [],
      message: { id: payload.messageId, text: payload.text } });
    const stored = await fixture.database.query<{ count: string }>(
      `SELECT count(*)::text FROM messages WHERE id=$1`,
      [payload.messageId],
    );
    expect(stored.rows[0]?.count).toBe('1');

    const conflicting = await fixture.request('/v1/phone/operations/sendRoomMessage', 'POST', {
      ...payload,
      text: 'Different payload',
    });
    expect(conflicting.status).toBe(400);
  });
});
