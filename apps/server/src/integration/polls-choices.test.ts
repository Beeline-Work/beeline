import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PushDeliveryLoop } from '.././background.js';
import { isRoomView, readRoomView, type RoomView } from '@beeline/api-contract/phone';
import { monolithFixture, wokenBy, AGENT, WORKSPACE, ROOM } from '../test-fixtures/test-support-monolith.js';

describe('monolith integration: polls-choices', () => {
const fixture = monolithFixture();


  it('pushes a question card and a tagged reply from the same turn once', async () => {
    await fixture.operation('registerPushDevice', {
      token: 'owner-choice-turn-device-token-1234567890',
      platform: 'android',
      environment: 'physical',
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const loop = new PushDeliveryLoop(fixture.database, { send });
    expect(await loop.runOnce()).toBe(0);
    const requestId = 'c'.repeat(64);
    const asked = await fixture.daemonOperation('askRoomChoice', {
      roomId: ROOM,
      requestId,
      prompt: 'Which branch should I use?',
      options: [
        { label: 'Main', consequence: 'Ships today' },
        { label: 'Release', consequence: 'Ships Friday' },
      ],
    });
    expect(asked.status).toBe(200);
    const card = (await asked.json()) as { messageId: string };
    const replied = await fixture.daemonOperation('postRoomMessage', {
      roomId: ROOM,
      requestId,
      text: '@owner the question card above needs your pick.',
    });
    expect(replied.status).toBe(200);
    const reply = (await replied.json()) as { id: string };
    expect(reply.id).toMatch(/^[a-f0-9]{64}$/);
    expect(reply.id).not.toBe(card.messageId);

    expect(await loop.runOnce()).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      'owner-choice-turn-device-token-1234567890',
      expect.objectContaining({
        messageId: reply.id,
        collapseId: reply.id,
        text: 'Bee: @owner the question card above needs your pick.',
      }),
    );
    expect(await loop.runOnce()).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
  });


  it('posts a choice card, settles it in place, shows the pick as a line, and refuses an undersized poll', async () => {
    const posted = await fixture.daemonOperation('askRoomChoice', {
      roomId: ROOM,
      prompt: 'How do you want to push the desk past this?',
      constraint: 'CDP AgentKit needs JWT signing',
      options: [
        { label: 'Kraken paper', consequence: 'Works with plugin auth' },
        { label: 'Keep waiting', consequence: 'Blocked on CDP JWT', costly: true },
      ],
    });
    expect(posted.status).toBe(200);
    const body = (await posted.json()) as { choiceId: string; messageId: string; mode: string };
    expect(body.mode).toBe('question');
    const room = (await (await fixture.request(`/v1/phone/rooms/${ROOM}`)).json()) as RoomView;
    expect(isRoomView(room)).toBe(true);
    const card = room.messages.find((message) => message.choice);
    expect(card?.choice).toEqual(
      expect.objectContaining({
        choiceId: body.choiceId,
        status: 'open',
        prompt: 'How do you want to push the desk past this?',
      }),
    );
    expect(card?.choice?.options).toHaveLength(2);

    const answered = await fixture.operation('answerChoice', { choiceId: body.choiceId, optionId: 'A' });
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual(
      expect.objectContaining({ choiceId: body.choiceId, status: 'answered', roomId: ROOM }),
    );
    const settled = (await (await fixture.request(`/v1/phone/rooms/${ROOM}`)).json()) as RoomView;
    expect(isRoomView(settled)).toBe(true);
    expect(settled.messages.find((message) => message.choice)?.choice).toEqual(
      expect.objectContaining({ status: 'answered', selectedOptionId: 'A' }),
    );
    expect(settled.messages.some((message) => message.choice?.footer?.includes('picked A'))).toBe(
      true,
    );
    const answeredLine = await fixture.database.query<{ id: string }>(
      `SELECT id FROM messages WHERE room_id=$1 AND card_type='choice-answered'`,
      [ROOM],
    );
    expect(answeredLine.rows).toHaveLength(1);
    expect(await wokenBy(fixture.database, answeredLine.rows[0]!.id)).toEqual([AGENT]);
    const pickedLine = settled.messages.find(
      (message) => message.systemEvent?.kind === 'choice-answered',
    );
    expect(pickedLine?.text).toBe('@owner picked A · Kraken paper');

    const again = await fixture.operation('answerChoice', { choiceId: body.choiceId, optionId: 'B' });
    expect(again.status).toBe(409);

    const undersized = await fixture.daemonOperation('openRoomPoll', {
      roomId: ROOM,
      prompt: 'Which paper API?',
      ttlSeconds: 300,
      options: [
        { label: 'Kraken paper', consequence: 'plugin auth' },
        { label: 'Keep waiting', consequence: 'blocked' },
      ],
    });
    expect(undersized.status).toBe(400);
    expect(((await undersized.json()) as { error: string }).error).toContain('ask_choice');

    const memberId = createHash('sha256').update('github:member').digest('hex');
    const memberToken = await fixture.phoneToken('member');
    await fixture.operation('addWorkspaceMember', { workspaceId: WORKSPACE, memberId, role: 'member' });
    await fixture.operation('addRoomMember', { roomId: ROOM, memberId });
    const poll = await fixture.daemonOperation('openRoomPoll', {
      roomId: ROOM,
      prompt: 'Which paper API?',
      ttlSeconds: 300,
      options: [
        { label: 'Kraken paper', consequence: 'plugin auth' },
        { label: 'Keep waiting', consequence: 'blocked' },
      ],
    });
    expect(poll.status).toBe(200);
    const pollBody = (await poll.json()) as { choiceId: string; electorateCount: number };
    expect(pollBody.electorateCount).toBe(2);
    expect(
      (await fixture.operation('answerChoice', { choiceId: pollBody.choiceId, optionId: 'A' })).status,
    ).toBe(200);
    expect(
      (await fixture.operation('answerChoice', { choiceId: pollBody.choiceId, optionId: 'A' }, memberToken))
        .status,
    ).toBe(200);
    const closed = (await (await fixture.request(`/v1/phone/rooms/${ROOM}`)).json()) as RoomView;
    expect(isRoomView(closed)).toBe(true);
    expect(closed.messages.find((message) => message.choice?.status === 'closed')?.choice).toEqual(
      expect.objectContaining({ status: 'closed', outcome: 'winner' }),
    );
  });


  it('lets a Room member create a poll that everyone can vote on', async () => {
    const memberId = createHash('sha256').update('github:member').digest('hex');
    const memberToken = await fixture.phoneToken('member');
    await fixture.operation('addWorkspaceMember', { workspaceId: WORKSPACE, memberId, role: 'member' });
    await fixture.operation('addRoomMember', { roomId: ROOM, memberId });
    const created = await fixture.operation(
      'createRoomPoll',
      {
        roomId: ROOM,
        prompt: 'Which plan?',
        ttlSeconds: 900,
        options: [
          { label: 'Plan A', consequence: 'Plan A' },
          { label: 'Plan B', consequence: 'Plan B' },
        ],
      },
      memberToken,
    );
    expect(created.status).toBe(200);
    const { choiceId, closesAt } = (await created.json()) as { choiceId: string; closesAt: number };
    expect(closesAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    const opened = readRoomView(await (await fixture.request(`/v1/phone/rooms/${ROOM}`)).json());
    expect(
      opened?.messages.find((message) => message.choice?.choiceId === choiceId)?.choice,
    ).toEqual(
      expect.objectContaining({
        mode: 'poll',
        status: 'open',
        agent: expect.objectContaining({ kind: 'human' }),
      }),
    );
    expect((await fixture.operation('answerChoice', { choiceId, optionId: 'A' })).status).toBe(200);
    const voted = readRoomView(await (await fixture.request(`/v1/phone/rooms/${ROOM}`)).json());
    expect(
      voted?.messages.find((message) => message.choice?.choiceId === choiceId)?.choice,
    ).toEqual(expect.objectContaining({ status: 'open', votedCount: 1 }));
    expect((await fixture.operation('answerChoice', { choiceId, optionId: 'B' }, memberToken)).status).toBe(
      200,
    );
    const room = (await (await fixture.request(`/v1/phone/rooms/${ROOM}`)).json()) as RoomView;
    expect(
      readRoomView(room)?.messages.find((message) => message.choice?.choiceId === choiceId)?.choice,
    ).toEqual(
      expect.objectContaining({ mode: 'poll', status: 'closed', outcome: 'tie', votedCount: 2 }),
    );
  });
});
