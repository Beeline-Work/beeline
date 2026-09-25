import { describe, expect, it, vi } from 'vitest';
import { ComposioClient } from './connector-composio.js';
import type { ComposioScope } from '@beeline/api-contract/composio';

const scope: ComposioScope = {
  ownerId: 'person-a',
  toolkits: ['github'],
  tools: { github: ['GITHUB_GET_AN_ISSUE'] },
};

describe('Composio helper client', () => {
  it('creates an owner-scoped session and executes only an allowed tool after account status is active', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ session_id: 'trs_1' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({
        items: [{ slug: 'github', connected_account: { status: 'ACTIVE', user_id: 'person-a' } }],
      }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { id: 42 }, log_id: 'log_1' }) });
    const client = new ComposioClient('secret-key', request);
    const sessionId = await client.createSession(scope);
    expect(sessionId).toBe('trs_1');
    const body = JSON.parse(request.mock.calls[0]![1].body);
    expect(body.user_id).toBe('person-a');
    expect(body.toolkits).toEqual({ enabled: ['github'] });
    expect(body.tools).toEqual({ github: { enabled: ['GITHUB_GET_AN_ISSUE'] } });
    expect(await client.execute(sessionId, scope, 'github', 'GITHUB_GET_AN_ISSUE', { issue_number: 42 }))
      .toEqual({ data: { id: 42 }, logId: 'log_1' });
    expect(request.mock.calls[2]![1].body).toContain('GITHUB_GET_AN_ISSUE');
  });

  it('refuses an unscoped toolkit or tool before any request', async () => {
    const request = vi.fn();
    const client = new ComposioClient('secret-key', request);
    await expect(client.link('trs_1', 'slack', scope)).rejects.toThrow('out of scope');
    await expect(client.execute('trs_1', scope, 'github', 'GITHUB_DELETE_REPO', {}))
      .rejects.toThrow('out of scope');
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses malformed policy before opening a session', async () => {
    const request = vi.fn();
    const client = new ComposioClient('secret-key', request);
    await expect(client.createSession({
      ownerId: 'person-a', toolkits: ['github'], tools: { github: [] },
    })).rejects.toThrow('invalid Composio tool scope');
    await expect(client.createSession({
      ownerId: 'person-a', toolkits: ['github'], tools: { github: ['SLACK_SEND_MESSAGE'] },
    })).rejects.toThrow('invalid Composio tool scope');
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses a disconnected account and a non-Composio link URL', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ items: [{ slug: 'github' }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ redirect_url: 'https://evil.test/link' }) });
    const client = new ComposioClient('secret-key', request);
    await expect(client.execute('trs_1', scope, 'github', 'GITHUB_GET_AN_ISSUE', {}))
      .rejects.toThrow('not connected');
    await expect(client.link('trs_1', 'github', scope)).rejects.toThrow('invalid Composio sign-in URL');
  });

  it('does not treat another user’s connected account as this owner’s link', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      items: [{ slug: 'github', connected_account: { status: 'ACTIVE', user_id: 'person-b' } }],
    }) });
    const client = new ComposioClient('secret-key', request);
    expect(await client.connected('trs_1', 'github', scope)).toBe(false);
  });
});
