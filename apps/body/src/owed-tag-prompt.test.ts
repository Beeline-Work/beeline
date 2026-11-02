import { afterEach, describe, expect, it, vi } from 'vitest';
import { assembleTurnPrompt } from './prompt-assembly.js';
import { callTool } from './session-join/beeline-api.js';
import { toolOwedContext } from './read-only-mcp.js';
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
  it('C7 helper MCP results carry the current owed list', async () => {
    vi.stubEnv('BEELINE_DAEMON_BASE_URL', 'http://localhost');
    vi.stubEnv('BEELINE_DAEMON_TOKEN', 'local-test');
    vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', '');
    const owedMentions = [{ roomId: 'room', messageId: 'message', memberId: 'member', replyRule: 'answer in this Room with replyTo message' }];
    vi.stubGlobal('fetch', async (url: URL) => {
      expect(url.pathname).toBe('/v1/daemon/operations/getOwedMentions');
      return Response.json({ owedMentions });
    });
    expect(await toolOwedContext()).toEqual({ type: 'text', text: JSON.stringify({ owedMentions }) });
  });
});
