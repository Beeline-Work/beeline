import { describe, expect, it } from 'vitest';
import type { RoomViewMessage } from '@beeline/buzz-client';
import {
  conversationIdentityByPubkey,
  cornerSummaries,
  createRoomMessageProjector,
  displayRoomMessage,
  displayRoomMessages,
  foldSettledActivityRuns,
  mergeDisplayPages,
  roomViewTranscriptMessages,
  type ChatDisplayMessage,
} from './room-view-presentation';

describe('Room view presentation', () => {
  it('uses the child turn receipt time for a working corner instead of stale metadata', () => {
    const receiptAt = Math.floor(Date.now() / 1_000);
    const [corner] = cornerSummaries({
      corners: [
        {
          corner: {
            id: '80a5a6f1-fb5a-493b-93eb-f3db33f696e6',
            workspaceId: 'ec08be9d-9d9d-413e-b546-959d4abe39df',
            parentId: '7d111868-52eb-43ab-98ae-8a6c49b92da8',
            name: 'Receipt-driven corner',
            archived: false,
            createdAt: 1,
            updatedAt: 1,
          },
          lifecycle: { lifecycle: 'WORKING' },
          status: 'working',
          statusAt: receiptAt,
        },
      ],
    });

    expect(corner).toMatchObject({
      machineState: 'working',
      status: 'live',
      stateAt: receiptAt,
    });
  });

  it('presents a review corner as live while a fresh steering turn is working', () => {
    const receiptAt = Math.floor(Date.now() / 1_000);
    const [corner] = cornerSummaries({
      corners: [
        {
          corner: {
            id: '80a5a6f1-fb5a-493b-93eb-f3db33f696e6',
            workspaceId: 'ec08be9d-9d9d-413e-b546-959d4abe39df',
            parentId: '7d111868-52eb-43ab-98ae-8a6c49b92da8',
            name: 'Review steering corner',
            archived: false,
            createdAt: 1,
            updatedAt: 1,
          },
          lifecycle: { lifecycle: 'REVIEW' },
          status: 'working',
          statusAt: receiptAt,
          reason: 'review',
        },
      ],
    });

    expect(corner).toMatchObject({
      machineState: 'working',
      status: 'live',
      stateAt: receiptAt,
    });
  });

  it('keeps an indexed system row visible as a system notice', () => {
    const message: RoomViewMessage = {
      id: 'system-notice',
      text: 'A scheduled run is paused.',
      createdAt: 12,
      author: {
        pubkey: 'b'.repeat(64),
        kind: 'agent',
        name: 'Pi agent',
      },
      presentation: 'system',
    };

    expect(displayRoomMessage(message, 'a'.repeat(64))).toMatchObject({
      id: 'system-notice',
      text: 'A scheduled run is paused.',
      authorIdentity: message.author,
      isSystemNotice: true,
      isAgentAuthor: true,
    });
  });

  it('re-resolves a stale roster label from each current server message projection', () => {
    const agentPubkey = 'b'.repeat(64);
    const viewerPubkey = 'a'.repeat(64);
    const staleMember = {
      identity: { pubkey: agentPubkey, kind: 'agent' as const, name: 'Arlo', handle: 'arlo' },
      role: 'member' as const,
    };
    const indexedMessage = (name: string, handle: string): RoomViewMessage => ({
      id: 'identity-message',
      text: `Hello from ${name}`,
      createdAt: 12,
      author: { pubkey: agentPubkey, kind: 'agent', name, handle },
      presentation: 'message',
    });
    const projector = createRoomMessageProjector();

    const cached = projector.project([indexedMessage('Arlo', 'arlo')], viewerPubkey);
    expect(conversationIdentityByPubkey([staleMember], cached).get(agentPubkey)?.name).toBe('Arlo');

    const fresh = projector.project([indexedMessage('Codex', 'codex')], viewerPubkey);
    expect(fresh[0]).not.toBe(cached[0]);
    expect(conversationIdentityByPubkey([staleMember], fresh).get(agentPubkey)).toMatchObject({
      name: 'Codex',
      handle: 'codex',
    });
  });

  it('keeps a GitHub card out of speaker attribution', () => {
    const message: RoomViewMessage = {
      id: 'github-card',
      text: '',
      createdAt: 12,
      author: {
        pubkey: 'd'.repeat(64),
        kind: 'human',
        name: 'PERSON DDDDDDDD',
      },
      presentation: 'card',
      githubEvent: {
        type: 'pull-request',
        action: 'opened',
        actor: 'lena',
        title: 'Ship the card',
        url: 'https://github.com/acme/widget/pull/7',
      },
    };

    expect(displayRoomMessage(message, 'a'.repeat(64))).toEqual(
      expect.objectContaining({
        id: 'github-card',
        githubEvent: message.githubEvent,
      }),
    );
    expect(displayRoomMessage(message, 'a'.repeat(64))).not.toHaveProperty('pubkey');
    expect(displayRoomMessage(message, 'a'.repeat(64))).not.toHaveProperty('isAgentAuthor');
  });

  it('retains the indexed agent on a landed-corner summary card', () => {
    const message: RoomViewMessage = {
      id: 'landed-card',
      text: '',
      createdAt: 12,
      author: { pubkey: 'd'.repeat(64), kind: 'agent', name: 'Beebee' },
      presentation: 'card',
      daemonFact: {
        type: 'corner-complete',
        cornerId: '80a5a6f1-fb5a-493b-93eb-f3db33f696e6',
        objective: 'Fix the corner lifecycle',
        outcome: 'landed',
        pullRequest: { number: 42, url: 'https://github.com/acme/widget/pull/42' },
      },
    };

    expect(displayRoomMessage(message, 'a'.repeat(64))).toMatchObject({
      daemonFact: message.daemonFact,
      authorIdentity: message.author,
      pubkey: message.author.pubkey,
    });
  });

  it('orders response, paged history, signed outbox, and live-overlay partitions by time', () => {
    const message = (id: string, timestamp: number): ChatDisplayMessage => ({
      id,
      text: id,
      isUser: id === 'stale-outbox',
      timestamp,
    });

    expect(
      mergeDisplayPages(
        [message('older-page', 10)],
        [message('server-tail', 40)],
        [message('stale-outbox', 20)],
        [message('live-overlay', 30)],
      ).map((item) => item.id),
    ).toEqual(['older-page', 'stale-outbox', 'live-overlay', 'server-tail']);
  });

  it('feeds additive corner toolRows to the collapsed activity renderer without expanding messages', () => {
    const agent = 'b'.repeat(64);
    const toolRow: RoomViewMessage = {
      id: 'corner-tool-row',
      text: '',
      createdAt: 2,
      author: { pubkey: agent, kind: 'agent', name: 'Bee' },
      presentation: 'activity',
      activity: [{ kind: 'tool', title: 'Bash', operation: 'execute', command: 'npm test' }],
    };
    const transcript = roomViewTranscriptMessages({
      messages: [
        {
          id: 'corner-message',
          text: 'Done.',
          createdAt: 3,
          author: { pubkey: agent, kind: 'agent', name: 'Bee' },
          presentation: 'message',
        },
      ],
      toolRows: [toolRow],
    });

    expect(transcript.map((message) => message.id)).toEqual(['corner-tool-row', 'corner-message']);
    expect(displayRoomMessages(transcript, 'a'.repeat(64))[0]).toMatchObject({
      isAgentActivity: true,
      activity: [{ kind: 'tool', toolKind: 'execute', command: 'npm test' }],
    });
  });

  it('interleaves durable corner narration lines with tool rows by creation time', () => {
    const agent = 'b'.repeat(64);
    const author = { pubkey: agent, kind: 'agent' as const, name: 'Bee' };
    const narration = (id: string, createdAt: number): RoomViewMessage => ({
      id,
      text: `Step ${id}: updating only the ledger.`,
      createdAt,
      author,
      presentation: 'message',
    });
    const toolRow = (id: string, createdAt: number): RoomViewMessage => ({
      id,
      text: '',
      createdAt,
      author,
      presentation: 'activity',
      activity: [{ kind: 'tool', title: 'Bash', operation: 'execute', command: `npm test ${id}` }],
    });
    const transcript = roomViewTranscriptMessages({
      messages: [narration('narration-1', 1), narration('narration-2', 3), narration('final', 5)],
      toolRows: [toolRow('tool-1', 2), toolRow('tool-2', 4)],
    });

    // Narration segments land between the collapsed tool-call groups in
    // creation order, never before or after the whole activity block.
    expect(transcript.map((message) => message.id)).toEqual([
      'narration-1',
      'tool-1',
      'narration-2',
      'tool-2',
      'final',
    ]);
    // Narration rows render as ordinary agent lines, not activity rows.
    const displayed = displayRoomMessages(transcript, 'a'.repeat(64));
    const narrationRow = displayed.find((row) => row.id === 'narration-1');
    expect(narrationRow).toMatchObject({
      text: 'Step narration-1: updating only the ledger.',
    });
    expect(narrationRow).not.toHaveProperty('isAgentActivity');
  });

  it('folds a settled run of per-call tool rows from one agent into one group (C55)', () => {
    const agent = 'b'.repeat(64);
    const other = 'c'.repeat(64);
    const human = 'a'.repeat(64);
    const toolRow = (
      id: string,
      createdAt: number,
      status: 'completed' | 'failed',
      pubkey = agent,
    ): RoomViewMessage => ({
      id,
      text: '',
      createdAt,
      author: { pubkey, kind: 'agent', name: 'Bee' },
      presentation: 'activity',
      activity: [{ kind: 'tool', title: 'Bash', operation: 'execute', command: id, status }],
    });
    const six = [
      toolRow('t1', 1, 'completed'),
      toolRow('t2', 2, 'completed'),
      toolRow('t3', 3, 'failed'),
      toolRow('t4', 4, 'failed'),
      toolRow('t5', 5, 'failed'),
      toolRow('t6', 6, 'failed'),
    ];
    const display = (rows: RoomViewMessage[]) => displayRoomMessages(rows, human);

    const one = foldSettledActivityRuns(display(six));
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ id: 't1', timestamp: 1, isAgentActivity: true, pubkey: agent });
    expect(one[0].activity?.map((item) => item.command)).toEqual(['t1', 't2', 't3', 't4', 't5', 't6']);
    expect(one[0].activity?.filter((item) => item.status === 'failed')).toHaveLength(4);

    const steer: RoomViewMessage = {
      id: 'steer',
      text: 'try again',
      createdAt: 3.5,
      author: { pubkey: human, kind: 'human', name: 'Ann' },
      presentation: 'message',
    };
    const split = foldSettledActivityRuns(
      display([...six.slice(0, 3), steer, ...six.slice(3)]),
    );
    expect(split.map((row) => [row.id, row.activity?.length ?? 0])).toEqual([
      ['t1', 3],
      ['steer', 0],
      ['t4', 3],
    ]);

    const otherAgent = foldSettledActivityRuns(
      display([...six.slice(0, 2), toolRow('x1', 2.5, 'completed', other), ...six.slice(2)]),
    );
    expect(otherAgent.map((row) => [row.id, row.activity?.length ?? 0])).toEqual([
      ['t1', 2],
      ['x1', 1],
      ['t3', 4],
    ]);

    const draft = {
      id: 'live-turn:req',
      text: 'Drafting…',
      isUser: false,
      timestamp: 3.5,
      pubkey: agent,
      isAgentAuthor: true,
      isAgentActivity: true,
      isAgentLiveTurn: true,
      isAgentDraft: true,
      agentMessageDraft: 'Drafting…',
    };
    const displayed = display(six);
    const withDraft = foldSettledActivityRuns([...displayed.slice(0, 3), draft, ...displayed.slice(3)]);
    expect(withDraft.map((row) => [row.id, row.activity?.length ?? 0])).toEqual([
      ['t1', 6],
      ['live-turn:req', 0],
    ]);
    expect(withDraft[1]).toBe(draft);
  });
});
