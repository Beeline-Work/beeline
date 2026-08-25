import { describe, expect, it } from 'vitest';
import {
  createWorkspaceSnapshot,
  reduceWorkspaceEvents,
  type Activity,
  type AgentMessage,
  type Control,
  type HumanMessage,
  type IdentityRecord,
  type SessionUpdate,
} from '@beeline/buzz-client';
import { isAgentTurnActive } from '@/buzz/agent-presence';
import { latestAgentTurns, projectReadEvent, transcriptMessages } from './buzz-event-projection';

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

  it('projects the three live lanes and removes them completely when the turn settles', () => {
    const turn = (status: 'working' | 'complete', createdAt: number) =>
      ({
        type: 'session-update',
        eventId: `turn-${status}`,
        authorPubkey: AGENT,
        createdAt,
        sourceKind: 9,
        signature: 'verified',
        scope: 'channel',
        channelId: ROOM,
        workspaceId: 'workspace',
        sessionId: 'session-1',
        update: {
          kind: 'turn',
          agentPubkey: AGENT,
          requestId: 'request-1',
          status,
        },
      }) as SessionUpdate;
    const lane = (kind: 'draft' | 'thought', text: string, createdAt: number) =>
      ({
        type: 'session-update',
        eventId: `${kind}-${createdAt}`,
        authorPubkey: AGENT,
        createdAt,
        sourceKind: 30078,
        signature: 'verified',
        scope: 'channel',
        channelId: ROOM,
        workspaceId: 'workspace',
        sessionId: 'session-1',
        update:
          kind === 'draft'
            ? { kind, agentPubkey: AGENT, requestId: 'request-1', text, closed: false }
            : { kind, agentPubkey: AGENT, text, closed: false },
      }) as SessionUpdate;
    const activity = {
      type: 'activity',
      eventId: 'activity-live',
      authorPubkey: AGENT,
      createdAt: 3,
      sourceKind: 9,
      signature: 'verified',
      scope: 'channel',
      channelId: ROOM,
      workspaceId: 'workspace',
      sessionId: 'session-1',
      stepId: 'tool-1',
      status: 'completed',
      details: [{ kind: 'tool', title: 'Read', operation: 'tool_activity' }],
      detail: { kind: 'tool', title: 'Read', operation: 'tool_activity' },
    } as Activity;
    const liveSnapshot = reduceWorkspaceEvents(
      createWorkspaceSnapshot({ workspaceId: 'workspace', identities }),
      [
        turn('working', 1),
        lane('thought', 'Tracing the flow', 2),
        activity,
        lane('draft', 'Answer', 4),
      ],
    );
    expect(transcriptMessages(liveSnapshot, ROOM, HUMAN)).toEqual([
      expect.objectContaining({
        isAgentLiveTurn: true,
        agentThought: 'Tracing the flow',
        agentMessageDraft: 'Answer',
        activity: [expect.objectContaining({ kind: 'tool' })],
      }),
    ]);

    const settled = reduceWorkspaceEvents(liveSnapshot, [
      message('agent-message', 'answer', AGENT, 'Answer', 5),
      turn('complete', 6),
    ]);
    expect(transcriptMessages(settled, ROOM, HUMAN).map((item) => item.id)).toEqual(['answer']);
  });

  it('projects one settled failure as a non-conversational durable fact', () => {
    const failure = {
      type: 'activity',
      eventId: 'failure-fact',
      authorPubkey: AGENT,
      createdAt: 7,
      sourceKind: 9,
      signature: 'verified',
      scope: 'channel',
      channelId: ROOM,
      workspaceId: 'workspace',
      sessionId: 'session-1',
      stepId: 'gate',
      status: 'failed',
      details: [{ kind: 'tool', title: 'Certification gate', status: 'failed' }],
      detail: { kind: 'tool', title: 'Certification gate', status: 'failed' },
      durableFact: 'failure',
    } as Activity;
    const snapshot = reduceWorkspaceEvents(
      createWorkspaceSnapshot({ workspaceId: 'workspace', identities }),
      [failure],
    );
    expect(transcriptMessages(snapshot, ROOM, HUMAN)).toEqual([
      expect.objectContaining({
        id: 'failure-fact',
        durableFact: { kind: 'failure' },
        isAgentActivity: true,
      }),
    ]);
  });

  it('projects Squire spending confirmation through the typed permission family', () => {
    const control = {
      type: 'control',
      eventId: 'squire-checkout-confirmation',
      authorPubkey: AGENT,
      createdAt: 5,
      sourceKind: 9,
      signature: 'verified',
      scope: 'channel',
      channelId: ROOM,
      workspaceId: 'workspace',
      visibility: 'card',
      payload: {
        kind: 'permission',
        permissionId: 'squire-permission',
        requestId: 'human-request',
        agentPubkey: AGENT,
        tool: 'Trusty Squire checkout',
        repository: 'external:squire',
        purpose: 'squire-spending',
        status: 'pending',
      },
    } as Control;

    expect(projectReadEvent(control, HUMAN).message).toMatchObject({
      id: 'write-permission-squire-permission',
      writePermission: {
        permissionId: 'squire-permission',
        repository: 'external:squire',
        purpose: 'squire-spending',
        status: 'pending',
      },
    });
  });

  it('keeps a bare working receipt alive for the thinking indicator before any content streams', () => {
    const turn = (status: 'working' | 'complete' | 'failed', createdAt: number) =>
      ({
        type: 'session-update',
        eventId: `turn-${status}-${createdAt}`,
        authorPubkey: AGENT,
        createdAt,
        sourceKind: 9,
        signature: 'verified',
        scope: 'channel',
        channelId: ROOM,
        workspaceId: 'workspace',
        sessionId: 'session-1',
        update: {
          kind: 'turn',
          agentPubkey: AGENT,
          requestId: 'request-1',
          status,
        },
      }) as SessionUpdate;

    // The silent window: the daemon publishes its signed WORKING receipt
    // before harness activation, so for a while the journal holds only the
    // human message and that receipt — no draft, thought, or tool fact. The
    // indicator's lifecycle input must survive exactly here.
    const snapshot = reduceWorkspaceEvents(
      createWorkspaceSnapshot({ workspaceId: 'workspace', identities }),
      [message('human-message', 'human-1', HUMAN, 'please look', 1), turn('working', 2)],
    );
    expect(snapshot.rooms[ROOM]!.eventJournal['turn-working-2']).toBeDefined();
    const turns = latestAgentTurns(snapshot, ROOM);
    expect(turns).toEqual([{ requestId: 'request-1', agentPubkey: AGENT, status: 'working' }]);
    // An absent presence snapshot is UNKNOWN, never an offline verdict.
    expect(isAgentTurnActive(turns[0]!)).toBe(true);
    // Lifecycle is presentation state: it spends no conversational row.
    expect(transcriptMessages(snapshot, ROOM, HUMAN).map(({ id }) => id)).toEqual(['human-1']);

    // Completion closes the indicator through the same derivation.
    const settled = reduceWorkspaceEvents(snapshot, [turn('complete', 3)]);
    const settledTurns = latestAgentTurns(settled, ROOM);
    expect(settledTurns).toEqual([
      { requestId: 'request-1', agentPubkey: AGENT, status: 'complete' },
    ]);
    expect(isAgentTurnActive(settledTurns[0]!)).toBe(false);

    // A replayed older marker can never regress a settled status.
    const replayedOldWorking = reduceWorkspaceEvents(settled, [
      { ...turn('working', 2), eventId: 'turn-working-replayed' },
    ]);
    expect(latestAgentTurns(replayedOldWorking, ROOM)[0]).toMatchObject({ status: 'complete' });
  });
});
