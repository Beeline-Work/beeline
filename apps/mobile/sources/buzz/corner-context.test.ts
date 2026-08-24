import { describe, expect, it } from 'vitest';
import type { ChatDisplayMessage } from '@/sync/transport/buzz-event-projection';
import { ROOM_CONTEXT_LIMIT, cornerObjectiveLine, selectRoomContext } from './corner-context';

function message(partial: Partial<ChatDisplayMessage> & { id: string }): ChatDisplayMessage {
  return {
    text: 'hello',
    isUser: false,
    timestamp: 1_000,
    ...partial,
  } as ChatDisplayMessage;
}

describe('selectRoomContext', () => {
  it('keeps only what a person or an agent actually said', () => {
    const entries = selectRoomContext([
      message({ id: 'a', text: 'we should colour the code blocks', timestamp: 1 }),
      message({ id: 'b', text: 'card', timestamp: 2, corner: { subchannelId: 'c', status: 'live' } }),
      message({
        id: 'c',
        text: '',
        timestamp: 3,
        agentTurn: { requestId: 'r', agentPubkey: 'p', status: 'working' },
      }),
      message({ id: 'd', text: 'ran a tool', timestamp: 4, isAgentActivity: true }),
      message({ id: 'e', text: 'merged', timestamp: 5, isMergeSummary: true }),
      message({ id: 'f', text: 'agent is offline', timestamp: 6, isSystemNotice: true }),
      message({ id: 'g', text: 'on it', timestamp: 7, isAgentAuthor: true, pubkey: 'agent1' }),
    ]);

    expect(entries.map((entry) => entry.id)).toEqual(['a', 'g']);
    expect(entries[1]).toMatchObject({ isAgent: true, pubkey: 'agent1' });
  });

  it('takes the window nearest the corner, oldest first', () => {
    const messages = Array.from({ length: 25 }, (_, index) =>
      message({ id: `m${index}`, text: `line ${index}`, timestamp: index }),
    );
    const entries = selectRoomContext(messages);
    expect(entries).toHaveLength(ROOM_CONTEXT_LIMIT);
    expect(entries[0].text).toBe('line 15');
    expect(entries.at(-1)!.text).toBe('line 24');
  });

  it('never quotes a pasted tool dump as conversation', () => {
    const entries = selectRoomContext([
      message({ id: 'a', text: 'push failed', timestamp: 1 }),
      message({
        id: 'b',
        timestamp: 2,
        text: '! [rejected]        main -> main (fetch first)\nhint: Updates were rejected',
      }),
    ]);
    expect(entries.map((entry) => entry.id)).toEqual(['a']);
  });

  it('is empty for an empty window', () => {
    expect(selectRoomContext([])).toEqual([]);
    expect(selectRoomContext([message({ id: 'a' })], 0)).toEqual([]);
  });
});

describe('cornerObjectiveLine', () => {
  it('pins the opening task ahead of later plan objectives, then falls back to the corner name', () => {
    expect(
      cornerObjectiveLine({
        planObjective: 'plan says',
        task: 'task says',
        cornerName: 'name-says',
      }),
    ).toBe('task says');
    expect(cornerObjectiveLine({ planObjective: 'plan says', cornerName: 'name-says' })).toBe('plan says');
    expect(cornerObjectiveLine({ task: 'task says', cornerName: 'name-says' })).toBe('task says');
    expect(cornerObjectiveLine({ cornerName: 'add-color-to-code-blocks' })).toBe(
      'add color to code blocks',
    );
  });

  it('says nothing rather than naming a generated corner id', () => {
    expect(cornerObjectiveLine({ cornerName: 'corner-1a2b3c4d' })).toBeUndefined();
    expect(cornerObjectiveLine({})).toBeUndefined();
    expect(cornerObjectiveLine({ task: '   ' })).toBeUndefined();
  });

  it('never renders raw tool plumbing as an objective', () => {
    expect(cornerObjectiveLine({ task: 'hint: Updates were rejected' })).toBeUndefined();
    expect(cornerObjectiveLine({ planObjective: 'diff --git a/x b/x' })).toBeUndefined();
  });

  it('collapses a multi-line task to one line without discarding long objective text', () => {
    const line = cornerObjectiveLine({ task: `add color\n\nto **code** blocks` });
    expect(line).toBe('add color to code blocks');
    const long = cornerObjectiveLine({ task: 'x'.repeat(400) });
    expect(long).toBe('x'.repeat(400));
  });
});
