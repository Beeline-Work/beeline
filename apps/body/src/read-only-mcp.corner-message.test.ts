import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callAgentTool } from './read-only-mcp.js';

/**
 * A corner turn session mounts the agent MCP with BEELINE_DAEMON_ROOM_ID set
 * to the PARENT Room (`monolith-corner-turn.ts`'s `beelineAgentMcpServer`
 * mount passes `roomId: this.options.parentRoomId`), while the active command
 * context names the CORNER. `get_room_message` must read the corner's own
 * transcript, so it has to target the active command's room, exactly like
 * every other turn-bound operation — never the parent env fallback.
 */
describe('corner-turn get_room_message room targeting', () => {
  let home: string;
  let calls: Array<{ name: string; input: Record<string, unknown> }>;
  let answer: (name: string) => Response;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'beeline-corner-message-'));
    const context = join(home, 'turn.json');
    // The active command lives in the corner; the session env still names the
    // parent Room, as a real corner session does.
    writeFileSync(
      context,
      JSON.stringify({
        roomId: 'corner-room',
        requestId: 'request-1',
        generationId: 'generation-1',
      }),
    );
    vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', context);
    vi.stubEnv('BEELINE_DAEMON_BASE_URL', 'http://daemon.test');
    vi.stubEnv('BEELINE_DAEMON_TOKEN', 'daemon-only');
    vi.stubEnv('BEELINE_DAEMON_AGENT_ID', 'agent-1');
    vi.stubEnv('BEELINE_DAEMON_ROOM_ID', 'parent-room');
    vi.stubEnv('BEELINE_DAEMON_CORNER_ID', 'corner-room');
    calls = [];
    answer = () => Response.json({});
    vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
      const name = String(url).split('/').at(-1)!;
      calls.push({ name, input: JSON.parse(String(init.body)) });
      return answer(name);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('reads a transcript message id from the corner Room, not the parent env Room', async () => {
    answer = () =>
      Response.json({
        messageId: 'corner-transcript-id',
        body: 'The corner message the turn is asked to act on',
        attachments: [],
      });
    const result = JSON.parse(
      await callAgentTool(
        'get_room_message',
        { messageId: 'corner-transcript-id' },
        'call-1',
      ),
    );
    expect(result.body).toBe('The corner message the turn is asked to act on');
    expect(calls).toEqual([
      {
        name: 'getRoomMessage',
        input: expect.objectContaining({
          roomId: 'corner-room',
          messageId: 'corner-transcript-id',
          requestId: 'request-1',
          generationId: 'generation-1',
        }),
      },
    ]);
    expect(calls[0]!.input.roomId).not.toBe('parent-room');
  });

  it('keeps the offset page on the corner read', async () => {
    await callAgentTool(
      'get_room_message',
      { messageId: 'corner-transcript-id', offset: 4000 },
      'call-2',
    );
    expect(calls[0]!.input).toMatchObject({
      roomId: 'corner-room',
      messageId: 'corner-transcript-id',
      offset: 4000,
    });
  });
});
