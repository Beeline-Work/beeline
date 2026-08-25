import { describe, expect, it } from 'vitest';
import {
  createWorkspaceSnapshot,
  reduceWorkspaceEvents,
  type Activity,
  type Control,
  type HumanMessage,
} from '@beeline/buzz-client';
import {
  latestRoomMessage,
  latestRoomMessageSummary,
  previewAuthorLabel,
  roomPreviewText,
} from './room-list-summary';

const ROOM = 'room-1';

function human(id: string, body: string, createdAt: number): HumanMessage {
  return {
    type: 'human-message',
    eventId: id,
    channelId: ROOM,
    workspaceId: 'workspace',
    scope: 'channel',
    authorPubkey: 'human',
    createdAt,
    sourceKind: 9,
    signature: 'verified',
    body,
    attachments: [],
    mentionPubkeys: [],
  } as HumanMessage;
}

function snapshot(...events: Array<HumanMessage | Control | Activity>) {
  return reduceWorkspaceEvents(createWorkspaceSnapshot({ workspaceId: 'workspace' }), events);
}

describe('Room list summary from the normalized snapshot', () => {
  it('returns the newest conversational message with deterministic same-second ordering', () => {
    const model = snapshot(human('event-a', 'first', 3), human('event-z', 'second', 3));
    expect(latestRoomMessage(model, ROOM)).toBe('second');
    expect(latestRoomMessageSummary(model, ROOM)).toMatchObject({
      id: 'event-z',
      text: 'second',
      timestamp: 3,
      authorPubkey: 'human',
    });
  });

  it('never lets control or activity become the preview', () => {
    const control = {
      type: 'control',
      eventId: 'control',
      channelId: ROOM,
      workspaceId: 'workspace',
      scope: 'channel',
      authorPubkey: 'agent',
      createdAt: 2,
      sourceKind: 9,
      signature: 'verified',
      visibility: 'hidden',
      payload: { kind: 'record', recordType: 'body-control' },
    } as Control;
    const activity = {
      type: 'activity',
      eventId: 'activity',
      channelId: ROOM,
      workspaceId: 'workspace',
      scope: 'channel',
      authorPubkey: 'agent',
      createdAt: 3,
      sourceKind: 9,
      signature: 'verified',
      sessionId: 's',
      stepId: 'step',
      status: 'updated',
      detail: { kind: 'tool', title: 'Edit' },
    } as Activity;
    expect(latestRoomMessage(snapshot(human('human', 'keep me', 1), control, activity), ROOM)).toBe(
      'keep me',
    );
  });

  it('keeps the last readable preview when newer prose is only machine plumbing', () => {
    expect(
      latestRoomMessage(
        snapshot(
          human('first', 'real discussion here', 1),
          human('second', 'hint: Updates were rejected because the remote contains work', 2),
        ),
        ROOM,
      ),
    ).toBeNull();
  });
});

describe('roomPreviewText', () => {
  it('flattens readable markdown and drops fenced code', () => {
    expect(roomPreviewText('## Status\n- **done**: `npm test` passes')).toBe(
      'Status done: npm test passes',
    );
    expect(roomPreviewText('here is the fix\n```ts\nconst a = 1;\n```\nships tomorrow')).toBe(
      'here is the fix ships tomorrow',
    );
  });

  it('never shows raw git/tool plumbing or a bare ref', () => {
    for (const raw of [
      'fatal: could not read Username for https://github.com',
      '$ git push --force-with-lease',
      'refs/heads/main',
      'abc1234..def5678  main -> main',
    ])
      expect(roomPreviewText(raw), raw).toBe('');
  });

  it('keeps real prose, shortens object ids, and bounds the row', () => {
    expect(roomPreviewText('landed 0123456789abcdef0123456789abcdef01234567 on main')).toBe(
      'landed 0123456 on main',
    );
    expect(roomPreviewText('x'.repeat(400))).toHaveLength(120);
  });
});

describe('previewAuthorLabel', () => {
  it('bounds and uppercases current identity labels', () => {
    expect(previewAuthorLabel('Bobby')).toBe('BOBBY');
    expect(previewAuthorLabel('Extraordinarily Long Name')).toBe('EXTRAORDINA…');
    expect(previewAuthorLabel(undefined)).toBe('');
  });
});
