import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentToolsFor, callAgentTool } from './read-only-mcp.js';
import { CAPABILITY_ROUTES } from './minimal-tool-surface.js';
import { assembleTurnPrompt, type PromptSurface } from './prompt-assembly.js';

/** Each place an agent turn runs in, with the MCP environment and prompt facts it gets. */
const PLACES: ReadonlyArray<{ name: string; corner: boolean; surface: PromptSurface; commandReason: string }> = [
  { name: 'Room', corner: false, surface: 'room', commandReason: 'human_tag' },
  { name: 'DM', corner: false, surface: 'dm', commandReason: 'direct_message' },
  { name: 'code corner', corner: true, surface: 'code-corner', commandReason: 'order' },
  { name: 'repo-less corner', corner: true, surface: 'repo-less-corner', commandReason: 'order' },
  { name: 'schedule run in a Room', corner: false, surface: 'room', commandReason: 'schedule' },
  { name: 'schedule run in a corner', corner: true, surface: 'code-corner', commandReason: 'schedule' },
];
const ALL_APPS = Object.keys(CAPABILITY_ROUTES).map(capability => `beeline:${capability}`);
const appsIn = (text: string) => [...new Set(text.match(/beeline:[a-z_]+/g) ?? [])].sort();

function useEnvironment(corner: boolean) {
  const context = join(mkdtempSync(join(tmpdir(), 'place-capabilities-')), 'context.json');
  writeFileSync(context, JSON.stringify({ roomId: corner ? 'corner' : 'room', requestId: 'request', generationId: 'generation' }));
  for (const [key, value] of Object.entries({
    BEELINE_DAEMON_ROOM_ID: corner ? 'corner' : 'room',
    BEELINE_DAEMON_CORNER_ID: corner ? 'corner' : '',
    BEELINE_DAEMON_AGENT_ID: 'self',
    BEELINE_DAEMON_BASE_URL: 'http://localhost',
    BEELINE_DAEMON_TOKEN: 'test',
    BEELINE_TURN_CONTEXT_FILE: context,
  })) vi.stubEnv(key, value);
}

/** What discovery offers: app_tool's own list and connect's capabilities. */
async function discovered(corner: boolean): Promise<string[]> {
  const appTool = agentToolsFor(true, false, corner).find(tool => tool.name === 'app_tool')!;
  const connect = JSON.parse(await callAgentTool('connect', { mode: 'discover' }, 'discover')) as { capabilities: string[] };
  return [...new Set([...appsIn(appTool.description), ...connect.capabilities])].sort();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe.each(PLACES.flatMap(place => [false, true].map(repositoryOnboarding => ({ ...place, repositoryOnboarding }))))('$name onboarding=$repositoryOnboarding', ({ corner, surface, commandReason, repositoryOnboarding }) => {
  beforeEach(() => {
    vi.stubGlobal('fetch', async () => Response.json({ repositoryOnboarding }));
  });
  it('discovery offers only Beeline apps that answer there, and every app that answers is offered', async () => {
    useEnvironment(corner);
    const offered = await discovered(corner);
    expect(offered.length).toBeGreaterThan(0);
    for (const app of offered) {
      const answer = JSON.parse(await callAgentTool('app_tool', { app }, 'discover')) as { tools: unknown[] };
      expect(answer.tools.length, app).toBeGreaterThan(0);
    }
    for (const app of ALL_APPS.filter(app => !offered.includes(app)))
      await expect(callAgentTool('app_tool', { app }, 'discover'), app).rejects.toThrow('Beeline apps here');
    expect(offered.includes('beeline:corner_app')).toBe(corner);
  });

  it('states the discovered apps in one short block of the turn prompt', async () => {
    useEnvironment(corner);
    const offered = await discovered(corner);
    const prompt = assembleTurnPrompt({ surface, onboarding: repositoryOnboarding, task: { body: 'Check the deploy.', commandReason } });
    const block = prompt.text.split('\n\n').find(paragraph => paragraph.startsWith('Works here ('));
    expect(block).toBeDefined();
    expect(Buffer.byteLength(block!)).toBeLessThanOrEqual(260);
    const [works, cornerOnly = ''] = block!.split('Corner only:');
    expect(appsIn(works!)).toEqual(offered);
    expect(appsIn(cornerOnly)).toEqual(corner ? [] : ['beeline:corner_app']);
    expect(block!.includes('schedule run')).toBe(commandReason === 'schedule');
  });
});
