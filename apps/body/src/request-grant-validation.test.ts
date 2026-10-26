import { afterEach, describe, expect, it, vi } from 'vitest';
import { callAgentTool } from './read-only-mcp.js';

const valid = { action: 'request', kind: 'host', target: 'example.com', reason: 'Inspect service', purpose: 'Diagnose the service' };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('GRANT-VALIDATION-1: advertised request_grant refusals', () => {
  it('names all missing request fields together', async () => {
    const error = await callAgentTool('request_grant', {}, 'empty').catch(error => error as Error);
    for (const field of Object.keys(valid)) expect((error as Error).message).toContain(`${field}: expected`);
  });

  it.each([{ action: 'list' }, valid])('preserves valid dispatch for $action', async args => {
    vi.stubEnv('BEELINE_DAEMON_ROOM_ID', 'room-1');
    vi.stubEnv('BEELINE_DAEMON_BASE_URL', 'http://localhost:1234');
    vi.stubEnv('BEELINE_DAEMON_TOKEN', 'test-token');
    const fetch = vi.fn(async () => Response.json({ grants: [] }));
    vi.stubGlobal('fetch', fetch);
    await callAgentTool('request_grant', args, 'valid');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('does not echo unknown field names or request values', async () => {
    await expect(callAgentTool('request_grant', { ...valid, 'private-marker': 'private-value' }, 'unknown'))
      .rejects.toThrow('input: expected only advertised fields');
    const error = await callAgentTool('request_grant', { ...valid, 'private-marker': 'private-value' }, 'unknown').catch(error => error as Error);
    expect((error as Error).message).not.toMatch(/private-marker|private-value/);
  });

  it.each(['action', 'kind', 'target', 'reason', 'purpose'])('names missing %s and its expected value', async field => {
    const args: Record<string, unknown> = { ...valid };
    delete args[field];
    await expect(callAgentTool('request_grant', args, `missing-${field}`)).rejects.toThrow(new RegExp(`${field}: expected`));
  });

  it.each([
    ['action', 'private-marker', 'request, list'],
    ['kind', 'private-marker', 'host'],
    ['target', 123, 'string'],
    ['target', '', 'at least 1'],
    ['target', 'private-marker'.repeat(100), 'at most 512'],
    ['reason', false, 'string'],
    ['reason', '', 'at least 1'],
    ['purpose', '', 'at least 1'],
    ['purpose', 'private-marker'.repeat(100), 'at most 240'],
    ['ttl', 1, 'at least 60'],
    ['touches', {}, 'string'],
    ['capabilities', [], 'string'],
  ])('explains invalid %s without echoing values', async (field, value, expected) => {
    const error = await callAgentTool('request_grant', { ...valid, [field]: value }, `invalid-${field}`).catch(error => error as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(`${field}: expected`);
    expect((error as Error).message).toContain(expected);
    expect((error as Error).message).not.toContain('private-marker');
  });
});
