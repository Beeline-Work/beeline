import { phoneFetch } from '../../../../tests/helpers/phone-operation.js';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isRoomView, isRoomViewMessage, ROOM_VIEW_MESSAGE_LIMIT, type RoomView } from '@beeline/api-contract/phone';
import { monolithFixture, HUMAN, AGENT, ROOM } from '../test-fixtures/test-support-monolith.js';

describe('monolith integration: history-reads', () => {
const fixture = monolithFixture();


  it('keeps settled corner tool rows in the corner read but never in the parent Room', async () => {
    const created = await fixture.daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'tool-corner',
      name: 'Tool-ledger',
      objective: 'Tool ledger',
    });
    expect(created.status).toBe(200);
    const { cornerId } = (await created.json()) as { cornerId: string };
    await fixture.database.query(
      `INSERT INTO messages(id,room_id,author_id,text,created_at)
       SELECT lpad(to_hex(item),64,'0'),$1,$2,'Stored ' || item,to_timestamp(1700000000 + item)
       FROM generate_series(1,$3) AS stored(item)`,
      [cornerId, HUMAN, ROOM_VIEW_MESSAGE_LIMIT + 1],
    );
    expect(
      (
        await fixture.daemonOperation('postAgentTurnReceipt', {
          roomId: cornerId,
          agentId: AGENT,
          requestId: 'corner-turn-1',
          status: 'working',
        })
      ).status,
    ).toBe(200);
    for (let tool = 1; tool <= 15; tool++) {
      expect(
        (
          await fixture.daemonOperation('postAgentActivity', {
            agentId: AGENT,
            roomId: cornerId,
            requestId: 'corner-turn-1',
            activity: [
              {
                kind: 'tool',
                title: 'Bash',
                operation: 'execute',
                command: `npm test -- ActivityTimeline ${tool}`,
                status: 'exit 0',
              },
            ],
          })
        ).status,
      ).toBe(200);
      // Corner narration lands beside the tool rows as durable output
      // activity under the same turn request id.
      if (tool === 5 || tool === 10) {
        expect(
          (
            await fixture.daemonOperation('postAgentActivity', {
              agentId: AGENT,
              roomId: cornerId,
              requestId: 'corner-turn-1',
              activity: [
                {
                  kind: 'output',
                  title: 'Update',
                  text: `Narration after tool ${tool}: updating only the ledger, then committing.`,
                },
              ],
            })
          ).status,
        ).toBe(200);
      }
    }
    expect(
      (
        await fixture.daemonOperation('postAgentActivity', {
          agentId: AGENT,
          roomId: cornerId,
          requestId: 'corner-turn-1',
          activity: [{ kind: 'thinking', title: 'Working', status: 'in_progress' }],
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fixture.daemonOperation('postRoomMessage', {
          roomId: cornerId,
          requestId: 'corner-turn-1',
          text: 'Corner done.',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fixture.daemonOperation('postAgentTurnReceipt', {
          roomId: cornerId,
          agentId: AGENT,
          requestId: 'corner-turn-1',
          status: 'complete',
        })
      ).status,
    ).toBe(200);

    const corner = (await (await fixture.request(`/v1/phone/rooms/${cornerId}`)).json()) as RoomView;
    expect(isRoomView(corner)).toBe(true);
    expect(corner.messages).toHaveLength(ROOM_VIEW_MESSAGE_LIMIT);
    expect(corner.toolRows).toHaveLength(17);
    expect(corner.toolRows).toContainEqual(
      expect.objectContaining({
        presentation: 'activity',
        activity: [
          expect.objectContaining({
            kind: 'tool',
            title: 'Bash',
            command: 'npm test -- ActivityTimeline 1',
          }),
        ],
      }),
    );
    // Live-only lanes (thinking) settle away with the turn; the tool row is the
    // only activity row that survives.
    expect(
      corner.messages.filter(
        (message) => message.presentation === 'activity' && message.activity?.[0]?.kind !== 'tool',
      ),
    ).toEqual([]);
    expect(corner.messages).toContainEqual(
      expect.objectContaining({ text: 'Corner done.', presentation: 'message' }),
    );
    // Narration activity survives the settled turn and is returned through
    // the additive corner activity payload on every reopen.
    const narration = corner.toolRows!.filter(
      (message) => message.activity?.[0]?.kind === 'output',
    );
    expect(narration).toHaveLength(2);
    for (const line of narration) {
      expect(line.presentation).toBe('activity');
      expect(line.requestId).toBe('corner-turn-1');
      expect(line.activity?.[0]?.text).toMatch(/^Narration after tool/);
    }
    expect(corner.toolRows).toHaveLength(17);

    const parent = (await (await fixture.request(`/v1/phone/rooms/${ROOM}`)).json()) as RoomView;
    expect(
      parent.messages.filter(
        (message) => message.presentation === 'activity' && !message.durableFact,
      ),
    ).toEqual([]);
  });


  it('keeps a replayed corner narration activity singular after reopening', async () => {
    await fixture.database.query(`UPDATE agents SET selected_model='grok-4-fast' WHERE agent_id=$1`, [
      AGENT,
    ]);
    const created = await fixture.daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'replayed-narration-corner',
      name: 'Replay-ledger',
      objective: 'Keep one narrated tool row',
    });
    expect(created.status).toBe(200);
    const { cornerId } = (await created.json()) as { cornerId: string };
    const input = {
      agentId: AGENT,
      roomId: cornerId,
      requestId: 'replayed-narration-turn',
      cornerActivityKey: 'read-package',
      activity: [
        { kind: 'output' as const, title: 'Update', text: 'I inspected the package.' },
        { kind: 'tool' as const, title: 'Read package.json', operation: 'read', status: 'ok' },
      ],
    };
    const activityId = createHash('sha256')
      .update(
        JSON.stringify([
          'corner-activity',
          input.roomId,
          input.agentId,
          input.requestId,
          input.cornerActivityKey,
        ]),
      )
      .digest('hex');
    expect(
      (
        await fixture.operation('sendRoomMessage', {
          roomId: cornerId,
          messageId: activityId,
          text: 'Claim the activity row.',
        })
      ).status,
    ).toBe(200);
    expect((await fixture.daemonOperation('postAgentActivity', input)).status).toBe(409);
    const replayInput = { ...input, cornerActivityKey: 'read-package-replay' };
    await fixture.database.query(`UPDATE agents SET selected_model='newer-model' WHERE agent_id=$1`, [
      AGENT,
    ]);
    const pinnedInput = { ...replayInput, agentModel: 'grok-4-fast' };
    expect((await fixture.daemonOperation('postAgentActivity', pinnedInput)).status).toBe(200);
    expect((await fixture.daemonOperation('postAgentActivity', pinnedInput)).status).toBe(200);

    const conversation = await fixture.daemonOperation('getRoomConversation', {
      roomId: cornerId,
      narrationRequestId: input.requestId,
    });
    expect(conversation.status).toBe(200);
    expect((await conversation.json()).savedNarration).toEqual(['I inspected the package.']);

    const reopened = (await (await fixture.request(`/v1/phone/rooms/${cornerId}`)).json()) as RoomView;
    expect(isRoomView(reopened)).toBe(true);
    const replayed = reopened.toolRows?.filter(
      (message) => message.requestId === 'replayed-narration-turn',
    );
    expect(replayed).toHaveLength(1);
    expect(replayed?.[0]).toMatchObject({
      presentation: 'activity',
      agentModel: 'grok-4-fast',
      activity: [
        { kind: 'output', title: 'Update', text: 'I inspected the package.' },
        { kind: 'tool', title: 'Read package.json', operation: 'read', status: 'ok' },
      ],
    });
  });


  it('returns a tool-only corner reply as one durable prose row after reopening', async () => {
    const created = await fixture.daemonOperation('createCorner', {
      roomId: ROOM,
      requestId: 'tool-only-corner',
      name: 'Tool-only-ledger',
      objective: 'Keep one final reply',
    });
    expect(created.status).toBe(200);
    const { cornerId } = (await created.json()) as { cornerId: string };
    expect(
      (
        await fixture.daemonOperation('postAgentActivity', {
          agentId: AGENT,
          roomId: cornerId,
          requestId: 'tool-only-turn',
          cornerActivityKey: '1:tool-0',
          activity: [{ kind: 'tool', title: 'Read package.json', operation: 'read', status: 'ok' }],
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fixture.daemonOperation('postRoomMessage', {
          agentId: AGENT,
          roomId: cornerId,
          requestId: 'tool-only-turn',
          text: 'Inspecting',
        })
      ).status,
    ).toBe(200);

    const reopened = (await (await fixture.request(`/v1/phone/rooms/${cornerId}`)).json()) as RoomView;
    const durableTexts = [
      ...reopened.messages
        .filter((message) => message.presentation === 'message')
        .map((message) => message.text),
      ...(reopened.toolRows ?? []).flatMap((message) =>
        (message.activity ?? []).flatMap((activity) =>
          activity.kind === 'output' ? [activity.text] : [],
        ),
      ),
    ];
    expect(durableTexts).toEqual(['Inspecting']);
  });


  it('retires the agent bytea-media upload and still drains queued attachments', async () => {
    // The agent file-sharing path is post_artifact (object storage); the bytea
    // media store answers a 410 that names the replacement instead of a bare
    // 404, and an unauthenticated daemon still answers 401 first.
    const retired = await phoneFetch(`${fixture.origin}/v1/daemon/media`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${fixture.daemonToken}`,
        'content-type': 'text/plain',
        'x-file-name': 'notes.txt',
      },
      body: Buffer.from('agent-file-bytes'),
    });
    expect(retired.status).toBe(410);
    await expect(retired.json()).resolves.toMatchObject({ error: 'media_store_retired' });
    expect(
      await (
        await phoneFetch(`${fixture.origin}/v1/daemon/media`, { method: 'POST', body: 'x' })
      ).status,
    ).toBe(401);

    // Attachment queueing and the final-reply drain survive the retirement:
    // post_artifact rows land in the same bounded pending-attachment lane.
    const mediaId = '22222222-2222-4222-8222-222222222222';
    const notesDigest = createHash('sha256').update('agent-file-bytes').digest('hex');
    await fixture.objectStorage.putObject(
      `media/${AGENT}/${notesDigest}`,
      Buffer.from('agent-file-bytes'),
      'text/plain',
    );
    await fixture.database.query(
      `INSERT INTO objects(id,owner_id,kind,key,mime,title,size,sha256,state,expires_at)
       VALUES($1,$2,'media',$3,'text/plain','notes.txt',$4,$5,'ready',now()+interval '24 hours')`,
      [mediaId, AGENT, `media/${AGENT}/${notesDigest}`, 16, notesDigest],
    );
    const attachment = {
      url: `${fixture.origin}/v1/media/${mediaId}`,
      name: 'notes.txt',
      mimeType: 'text/plain',
      size: 16,
      sha256: createHash('sha256').update('agent-file-bytes').digest('hex'),
    };
    // Only media owned by the authenticated agent may be queued.
    expect(
      (
        await fixture.daemonOperation('postAgentAttachment', {
          roomId: ROOM,
          attachment: {
            ...attachment,
            url: `${fixture.origin}/v1/media/33333333-3333-4333-8333-333333333333`,
          },
        })
      ).status,
    ).toBe(503);
    expect(
      (
        await fixture.daemonOperation('postAgentAttachment', {
          roomId: ROOM,
          attachment: { ...attachment, url: 'https://elsewhere.example/file.txt' },
        })
      ).status,
    ).toBe(503);

    // Queue then drain onto the agent's final reply.
    expect(
      (
        await fixture.daemonOperation('postAgentAttachment', {
          roomId: ROOM,
          requestId: 'c'.repeat(64),
          attachment,
        })
      ).status,
    ).toBe(200);
    const reply = await fixture.daemonOperation('postRoomMessage', {
      roomId: ROOM,
      requestId: 'c'.repeat(64),
      text: 'Here is the file.',
    });
    expect(reply.status).toBe(200);
    const replyId = ((await reply.json()) as { id: string }).id;
    // A second post must not repeat the drained attachment.
    await fixture.daemonOperation('postRoomMessage', {
      roomId: ROOM,
      requestId: 'd'.repeat(64),
      text: 'No file this time.',
    });

    // 4. A phone reads it back as a valid RoomView attachment.
    const roomView = (await (await fixture.request(`/v1/phone/rooms/${ROOM}`)).json()) as RoomView;
    expect(isRoomView(roomView)).toBe(true);
    const withFile = roomView.messages.filter((message) => message.attachments?.length);
    expect(withFile).toHaveLength(1);
    expect(isRoomViewMessage(withFile[0])).toBe(true);
    expect(withFile[0]).toMatchObject({
      id: replyId,
      text: 'Here is the file.',
      author: expect.objectContaining({ pubkey: AGENT }),
    });
    expect(withFile[0]!.attachments![0]).toMatchObject({
      name: 'notes.txt',
      mimeType: 'text/plain',
      size: 16,
    });
    expect(typeof withFile[0]!.attachments![0].size).toBe('number');
    const media = await phoneFetch(withFile[0]!.attachments![0].url, {
      headers: { authorization: `Bearer ${fixture.accessToken}` },
    });
    expect(Buffer.from(await media.arrayBuffer()).toString()).toBe('agent-file-bytes');
  });
});
