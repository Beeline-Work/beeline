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
    'watch',
    { address: 'sibling' },
    'watch-1',
  );
  expect(calls).toEqual([
    {
      name: 'watchCorner',
      input: { roomId: 'watcher', cornerId: 'sibling', kinds: ['opened', 'merged'] },
    },
  ]);
  expect(text).toContain('Watching for opened, merged');
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

it('offers lifecycle watches in a DM without chatter or schedule events', () => {
  const tool = agentToolsFor(true, true).find(t => t.name === 'watch')!;
  expect(tool.description).toContain('Chatter, messages and schedules never wake a watcher');
  expect(tool.inputSchema.required).toEqual(['address']);
});

it('reports an already merged corner with its merge commit, and a closed one', async () => {
  const merged = { ...snapshot, workflowState: 'done', mergeCommitSha: 'f'.repeat(40) };
  vi.stubGlobal('fetch', async () =>
    Response.json({ kinds: [], state: 'merged', woken: true, snapshot: merged }),
  );
  const text = await callAgentTool(
    'watch',
    { address: 'sibling' },
    'watch-3',
  );
  expect(text).toContain('Corner already merged; one merged wake queued now');
  expect(text).toContain('f'.repeat(40));
  vi.stubGlobal('fetch', async () => Response.json({ kinds: [], state: 'closed', snapshot }));
  expect(
    await callAgentTool('watch', { address: 'sibling' }, 'watch-4'),
  ).toContain('Corner closed without merging');
});

it('limits the advertised address to corners, including when called from a Room or DM', () => {
  for (const dm of [false, true]) {
    const tool = agentToolsFor(true, dm).find(t => t.name === 'watch')!;
    expect(tool.description).toContain('Top-level Rooms and DMs have no watchable lifecycle');
    expect(tool.inputSchema.properties.address.description).toContain('Corner address only');
  }
});
