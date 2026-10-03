import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { agentToolsFor, callAgentTool } from './read-only-mcp.js';

const snapshot = {
  id: 'sibling',
  name: 'Ship widget',
  workflowState: 'review',
  pullRequestNumber: 42,
  pullRequestUrl: 'https://github.com/owner/widgets/pull/42',
  headSha: 'a'.repeat(40),
  checks: 'passing',
  mergeCommitSha: null,
};
let calls: { name: string; input: unknown }[];
beforeEach(() => {
  vi.stubEnv('BEELINE_DAEMON_BASE_URL', 'http://daemon.test');
  vi.stubEnv('BEELINE_DAEMON_TOKEN', 'test-token');
  vi.stubEnv('BEELINE_DAEMON_ROOM_ID', 'parent');
  vi.stubEnv('BEELINE_DAEMON_CORNER_ID', 'watcher');
  vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', '');
  calls = [];
  vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
    const input = JSON.parse(String(init.body));
    calls.push({ name: String(url).split('/').at(-1)!, input });
    return Response.json({ kinds: input.kinds, snapshot });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('calls watchCorner in the current corner and returns readable state and kinds', async () => {
  const text = await callAgentTool(
    'watch_corner',
    { cornerId: 'sibling', kinds: ['merged', 'check-passed'] },
    'watch-1',
  );
  expect(calls).toEqual([
    {
      name: 'watchCorner',
      input: { roomId: 'watcher', cornerId: 'sibling', kinds: ['merged', 'check-passed'] },
    },
  ]);
  expect(text).toContain('Watching for merged, check-passed');
  for (const value of [
    'Ship widget',
    'review',
    '42',
    snapshot.pullRequestUrl,
    snapshot.headSha,
    'passing',
  ])
    expect(text).toContain(value);
});

it('reports removal and uses the parent Room when outside a corner', async () => {
  vi.stubEnv('BEELINE_DAEMON_CORNER_ID', '');
  expect(
    await callAgentTool('watch_corner', { cornerId: 'sibling', kinds: [] }, 'watch-2'),
  ).toContain('Watch removed');
  expect(calls[0]!.input).toEqual({ roomId: 'parent', cornerId: 'sibling', kinds: [] });
});

it('describes replacement and removal on both Room and corner surfaces', () => {
  for (const corner of [false, true]) {
    const tool = agentToolsFor(true, false, corner).find((t) => t.name === 'watch_corner')!;
    expect(tool.description).toContain('Replaces any earlier watch');
    expect(tool.description).toContain('empty list removes');
    expect(tool.inputSchema.required).toEqual(['cornerId', 'kinds']);
  }
});
