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
import {
  latestAgentTurns,
  projectCornerTranscript,
  projectReadEvent,
  transcriptMessages,
  type ChatDisplayMessage,
} from './buzz-event-projection';

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

  it('keeps a Corner live draft/thought lane while suppressing its redundant stall notice', () => {
    const liveSnapshot = reduceWorkspaceEvents(
      createWorkspaceSnapshot({ workspaceId: 'workspace', identities }),
      [
        {
          type: 'session-update',
          eventId: 'turn-working',
          authorPubkey: AGENT,
          createdAt: 8,
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
            status: 'working',
          },
        } as SessionUpdate,
        {
          type: 'session-update',
          eventId: 'thought-live',
          authorPubkey: AGENT,
          createdAt: 9,
          sourceKind: 30078,
          signature: 'verified',
          scope: 'channel',
          channelId: ROOM,
          workspaceId: 'workspace',
          sessionId: 'session-1',
          update: {
            kind: 'thought',
            agentPubkey: AGENT,
            text: 'Tracing the Corner flow',
            closed: false,
          },
        } as SessionUpdate,
        {
          type: 'session-update',
          eventId: 'draft-live',
          authorPubkey: AGENT,
          createdAt: 10,
          sourceKind: 30078,
          signature: 'verified',
          scope: 'channel',
          channelId: ROOM,
          workspaceId: 'workspace',
          sessionId: 'session-1',
          update: {
            kind: 'draft',
            agentPubkey: AGENT,
            requestId: 'request-1',
            text: 'The answer is arriving.',
            closed: false,
          },
        } as SessionUpdate,
      ],
    );
    const [liveLane] = transcriptMessages(liveSnapshot, ROOM, HUMAN);
    expect(liveLane).toMatchObject({
      isAgentLiveTurn: true,
      agentThought: 'Tracing the Corner flow',
      agentMessageDraft: 'The answer is arriving.',
    });
    const stall: ChatDisplayMessage = {
      id: 'stall-1',
      text: 'Still working on this — my coding backend is taking longer than usual to respond.',
      isUser: false,
      timestamp: 11,
      pubkey: AGENT,
      isAgentAuthor: true,
    };
    const historicalStall = { ...stall, id: 'historical-stall', timestamp: 1 };
    const humanCopy: ChatDisplayMessage = {
      id: 'human-copy',
      text: stall.text,
      isUser: true,
      timestamp: 2,
      pubkey: HUMAN,
    };

    expect(
      projectCornerTranscript([historicalStall, humanCopy, liveLane, stall], {
        liveAgentPubkeys: new Set([AGENT]),
      }),
    ).toEqual([historicalStall, humanCopy, liveLane]);
    expect(projectCornerTranscript([stall], { liveAgentPubkeys: new Set() })).toEqual([stall]);
  });

  it('suppresses a trailing stall from a bare working receipt without hiding prior history', () => {
    const stall = (id: string, timestamp: number): ChatDisplayMessage => ({
      id,
      text: 'Still working on this — my coding backend is taking longer than usual to respond.',
      isUser: false,
      timestamp,
      pubkey: AGENT,
      isAgentAuthor: true,
    });
    const boundary: ChatDisplayMessage = {
      id: 'new-request',
      text: 'Try the Corner again',
      isUser: true,
      timestamp: 2,
      pubkey: HUMAN,
    };

    expect(
      projectCornerTranscript(
        [
          stall('historical-stall', 1),
          boundary,
          stall('current-stall-1', 3),
          stall('current-stall-2', 4),
        ],
        { liveAgentPubkeys: new Set([AGENT]) },
      ).map(({ id }) => id),
    ).toEqual(['historical-stall', 'new-request']);
  });

  it('never lets another agent or an archived Corner hide a stall notice', () => {
    const stall: ChatDisplayMessage = {
      id: 'agent-stall',
      text: 'Still working on this — my coding backend is taking longer than usual to respond.',
      isUser: false,
      timestamp: 1,
      pubkey: AGENT,
      isAgentAuthor: true,
    };

    expect(
      projectCornerTranscript([stall], { liveAgentPubkeys: new Set(['33'.repeat(32)]) }),
    ).toEqual([stall]);
    expect(projectCornerTranscript([stall], { liveAgentPubkeys: new Set() })).toEqual([stall]);
  });

  it('transition-dedupes consecutive identical merge-not-ready cards only', () => {
    const card = (id: string, text: string, timestamp: number): ChatDisplayMessage => {
      const projected = projectReadEvent(
        {
          type: 'control',
          eventId: id,
          authorPubkey: AGENT,
          createdAt: timestamp,
          sourceKind: 9,
          signature: 'verified',
          scope: 'channel',
          channelId: ROOM,
          workspaceId: 'workspace',
          visibility: 'card',
          payload: { kind: 'merge', action: 'not-ready', text },
        } as Control,
        HUMAN,
      ).message;
      expect(projected?.mergeNotReadyTransition).toBe(text);
      return projected!;
    };
    const human: ChatDisplayMessage = {
      id: 'human-transition',
      text: 'try again',
      isUser: true,
      timestamp: 5,
      pubkey: HUMAN,
    };
    const projected = projectCornerTranscript(
      [
        card('same-1', 'Nothing ready to merge yet. No reviewed content.', 1),
        card('same-2', 'Nothing ready to merge yet. No reviewed content.', 2),
        card('changed-1', 'Nothing ready to merge yet. Worktree is dirty.', 3),
        card('changed-2', 'Nothing ready to merge yet. Worktree is dirty.', 4),
        human,
        card('same-after-transition', 'Nothing ready to merge yet. No reviewed content.', 6),
      ],
      { liveAgentPubkeys: new Set() },
    );

    expect(projected.map(({ id }) => id)).toEqual([
      'same-2',
      'changed-2',
      'human-transition',
      'same-after-transition',
    ]);
  });

  it('keeps the newest duplicate stable when an older transcript page is revealed', () => {
    const card = (id: string, timestamp: number): ChatDisplayMessage => ({
      id,
      text: 'Nothing ready to merge yet. No reviewed content.',
      isUser: false,
      timestamp,
      pubkey: AGENT,
      mergeNotReadyTransition: 'Nothing ready to merge yet. No reviewed content.',
    });
    const older = card('older-publication', 1);
    const visible = card('visible-publication', 2);

    expect(
      projectCornerTranscript([visible], { liveAgentPubkeys: new Set() }).map(({ id }) => id),
    ).toEqual(['visible-publication']);
    expect(
      projectCornerTranscript([older, visible], { liveAgentPubkeys: new Set() }).map(
        ({ id }) => id,
      ),
    ).toEqual(['visible-publication']);
  });
});
