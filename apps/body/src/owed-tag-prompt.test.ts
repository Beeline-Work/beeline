import { afterEach, describe, expect, it, vi } from 'vitest';
import { assembleTurnPrompt } from './prompt-assembly.js';
import { callTool } from './session-join/beeline-api.js';
import { callAgentTool, withToolOwedContext } from './read-only-mcp.js';
import { renderMention } from './session-join/bridge.js';

describe('owed tag delivery', () => {
  const routing = { roomId: 'room-id', messageId: 'message-id', memberId: 'member-id', roomName: 'Design', fromName: 'Ruby' };
  it.each(['claude-code', 'codex'] as const)('C3 %s helper injection prefixes header, IDs and rule before long text', agent => {
    const text = renderMention({ id: routing.messageId, room_id: routing.roomId, memberId: routing.memberId,
      room_name: routing.roomName, author_name: routing.fromName, text: 'x'.repeat(30000) },
    { key: 'joined', agent, cwd: '/', name: 'Helper', server: '', clientId: '', refreshToken: '', cursor: '0', deliveredWakes: [], joinedAt: '' },
    { node: '/node', bundle: '/bundle' });
    expect(text.startsWith('[Beeline · Room Design · message message-id · from Ruby]')).toBe(true);
    for (const value of [routing.roomId, routing.messageId, routing.memberId, 'answer in this Room with replyTo message-id']) expect(text.slice(0,400)).toContain(value);
  });
  it('C2 managed helper prompt routing survives a truncated long instruction', () => {
    const result = assembleTurnPrompt({ surface: 'room', routing, sessionPrefix: 'x'.repeat(10000), task: { body: 'long task' } });
    for (const value of [routing.roomId, routing.messageId, routing.memberId, 'answer in this Room with replyTo message-id']) expect(result.text.slice(0,400)).toContain(value);
  });
});

describe('helper owed context', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  it('C7 joined-session tools retain owed tags from connector results', async () => {
    const owedMentions = [{ roomId: 'room', messageId: 'message', memberId: 'member' }];
    vi.stubGlobal('fetch', async () => Response.json({ result: { content: [{ text: JSON.stringify({ data: { ok: true }, owedMentions }) }] } }));
    expect(await callTool({ server: 'http://localhost' }, 'fixture', 'list_rooms', {})).toEqual({ ok: true, owedMentions });
    vi.stubGlobal('fetch', async () => Response.json({ result: { isError: true, content: [{ text: 'Refused' }, { text: JSON.stringify({ owedMentions }) }] } }));
    await expect(callTool({ server: 'http://localhost' }, 'fixture', 'post', {})).rejects.toThrow('owedMentions');
  });
  it('C7 helper MCP results carry owed tags from the existing operation without another request', async () => {
    vi.stubEnv('BEELINE_DAEMON_BASE_URL', 'http://localhost');
    vi.stubEnv('BEELINE_DAEMON_TOKEN', 'local-test');
    vi.stubEnv('BEELINE_DAEMON_ROOM_ID', 'room');
    vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', '');
    const owedMentions = [{ roomId: 'room', messageId: 'message', memberId: 'member', replyRule: 'answer in this Room with replyTo message' }];
    const fetch = vi.fn(async (url: URL, init: RequestInit) => {
      expect(url.pathname).toBe('/v1/daemon/operations/listRooms');
      expect(init.headers).toMatchObject({ 'x-beeline-tool-result': '1' });
      return Response.json({ _beelineToolResult: { rooms: [] }, _beelineOwedMentions: owedMentions });
    });
    vi.stubGlobal('fetch', fetch);
    const result = await withToolOwedContext(() => callAgentTool('read', { facet: 'addresses' }, 'owed'));
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify({ rooms: [] }) },
      { type: 'text', text: JSON.stringify({ owedMentions }) },
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    // An older server, or one whose owed read failed, must keep the tool result.
    fetch.mockImplementation(async () => Response.json({ rooms: [] }));
    expect((await withToolOwedContext(() => callAgentTool('read', { facet: 'addresses' }, 'fallback'))).content)
      .toEqual([{ type: 'text', text: JSON.stringify({ rooms: [] }) }]);
    expect(fetch).toHaveBeenCalledTimes(2);
    vi.stubEnv('BEELINE_DAEMON_AGENT_ID', 'member');
    fetch.mockImplementation(async () => Response.json({ _beelineToolResult: null, _beelineOwedMentions: owedMentions }));
    const usage = await withToolOwedContext(() => callAgentTool('read', { facet: 'usage' }, 'nullable'));
    expect(JSON.parse(usage.content[0]!.text)).toEqual({ summary: 'Usage: unknown (harness reports none).' });
    expect(JSON.parse(usage.content[1]!.text)).toEqual({ owedMentions });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
