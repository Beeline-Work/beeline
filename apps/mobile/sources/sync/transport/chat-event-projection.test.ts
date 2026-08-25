import { describe, expect, it } from 'vitest';
import {
  createWorkspaceSnapshot,
  reduceWorkspaceEvents,
  type Activity,
  type AgentMessage,
  type Control,
  type HumanMessage,
  type IdentityRecord,
} from '@beeline/buzz-client';
import { projectReadEvent, transcriptMessages } from './buzz-event-projection';

const ROOM = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const HUMAN = '11'.repeat(32);
const AGENT = '22'.repeat(32);

const identities = [
  { kind: 'human', pubkey: HUMAN, displayName: 'Captain', revision: '1' },
  { kind: 'agent', pubkey: AGENT, displayName: 'Bee', revision: '1' },
] as unknown as IdentityRecord[];

function message(
  type: 'human-message' | 'agent-message',
  eventId: string,
  authorPubkey: string,
  body: string,
  createdAt: number,
): HumanMessage | AgentMessage {
  return {
    type,
    eventId,
    authorPubkey,
    createdAt,
    sourceKind: 9,
    signature: 'verified',
    scope: 'channel',
    channelId: ROOM,
    workspaceId: 'workspace',
    body,
    attachments: [],
    mentionPubkeys: [],
  } as HumanMessage | AgentMessage;
}

describe('typed mobile read-model projection', () => {
  it('renders verified human and agent messages once from a snapshot', () => {
    const human = message('human-message', 'human-1', HUMAN, 'hello', 1);
    const agent = message('agent-message', 'agent-1', AGENT, 'hi', 2);
    const snapshot = reduceWorkspaceEvents(
      createWorkspaceSnapshot({ workspaceId: 'workspace', identities }),
      [agent, human, human],
    );

    expect(transcriptMessages(snapshot, ROOM, HUMAN).map(({ id, text }) => ({ id, text }))).toEqual(
      [
        { id: 'human-1', text: 'hello' },
        { id: 'agent-1', text: 'hi' },
      ],
    );
  });

  it('maps activity to a machine ledger item, never conversational prose', () => {
    const activity = {
      type: 'activity',
      eventId: 'activity-1',
      authorPubkey: AGENT,
      createdAt: 3,
      sourceKind: 9,
      signature: 'verified',
      scope: 'channel',
      channelId: ROOM,
      workspaceId: 'workspace',
      sessionId: 'session-1',
      stepId: 'tool-1',
      status: 'updated',
      detail: { kind: 'tool', title: 'Read', operation: 'tool_activity' },
    } as Activity;

    expect(projectReadEvent(activity, HUMAN).message).toMatchObject({
      id: 'activity-1',
      isAgentActivity: true,
    });
  });

  it('maps declared control cards only as system presentation', () => {
    const control = {
      type: 'control',
      eventId: 'control-1',
      authorPubkey: AGENT,
      createdAt: 4,
      sourceKind: 9,
      signature: 'verified',
      scope: 'channel',
      channelId: ROOM,
      workspaceId: 'workspace',
      visibility: 'system-line',
      payload: { kind: 'system', text: 'Queued', status: 'queued' },
    } as Control;

    expect(projectReadEvent(control, HUMAN).message).toMatchObject({
      id: 'control-1',
      isSystemNotice: true,
    });
  });
});
