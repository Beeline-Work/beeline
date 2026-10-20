import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { beelineManagedSkills } from './beeline-skill.js';
import { callAgentTool } from './read-only-mcp.js';

// R1: exercise the public read facet with the server's missing-procedure response.
describe('read procedure built-in skills (R1)', () => {
  beforeEach(() => {
    vi.stubEnv('BEELINE_DAEMON_AGENT_ID', 'agent');
    vi.stubEnv('BEELINE_DAEMON_ROOM_ID', 'room');
    vi.stubEnv('BEELINE_DAEMON_BASE_URL', 'http://daemon.test');
    vi.stubEnv('BEELINE_DAEMON_TOKEN', 'test-token');
    vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', '');
    vi.stubEnv('BEELINE_LIB_DIR', '');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'workspace skill not found' }, { status: 404 })));
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  for (const skill of beelineManagedSkills('source', { isReviewer: true })) {
    it(`returns shipped text for ${skill.name}`, async () => {
      const result = JSON.parse(await callAgentTool('read', { facet: 'procedure', slug: skill.name }));
      expect(result).toEqual({ slug: skill.name, markdown: skill.content, source: 'built-in' });
      expect(fetch).toHaveBeenCalledWith(new URL('http://daemon.test/v1/daemon/operations/loadWorkspaceSkill'),
        expect.objectContaining({ body: JSON.stringify({ agentId: 'agent', roomId: 'room', slug: skill.name }) }));
    });
  }

  it('keeps a workspace procedure ahead of a built-in with the same slug', async () => {
    const procedure = { slug: 'beeline-memory', markdown: 'Workspace guidance', version: 2 };
    vi.stubGlobal('fetch', async () => Response.json(procedure));
    expect(JSON.parse(await callAgentTool('read', { facet: 'procedure', slug: procedure.slug }))).toEqual(procedure);
  });

  it('preserves not found for an unknown slug', async () => {
    await expect(callAgentTool('read', { facet: 'procedure', slug: 'unknown-procedure' })).rejects.toThrow('404');
  });

  it.each([403, 500])('preserves server failures (%s) for built-in names', async (status) => {
    vi.stubGlobal('fetch', async () => Response.json({ error: 'refused' }, { status }));
    await expect(callAgentTool('read', { facet: 'procedure', slug: 'beeline-memory' })).rejects.toThrow(`${status}: refused`);
  });
});
