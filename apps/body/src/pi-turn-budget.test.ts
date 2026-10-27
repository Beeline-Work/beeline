import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installPiTurnBudget } from './pi-turn-budget.js';

type Event = { toolName: string; toolCallId: string; input: { command: string; timeout?: number }; isError?: boolean; content?: { type: string; text: string }[] };
type Handler = (event: Event) => { block?: boolean; reason?: string; content?: { type: string; text: string }[]; isError?: boolean } | undefined;

describe('free Pi shell turn budget', () => {
  let root: string;
  let context: string;
  let handlers: Map<string, Handler>;
  const call = (timeout?: number): Event => ({ toolName: 'bash', toolCallId: 'render', input: { command: 'sleep 10', timeout } });
  async function load() {
    await installPiTurnBudget(root);
    const source = await readFile(resolve(root, 'extensions/beeline-turn-budget.js'), 'utf8');
    const extension = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    handlers = new Map();
    extension.default({ on: (name: string, handler: Handler) => handlers.set(name, handler) });
  }
  beforeEach(async () => {
    root = await mkdtemp(resolve(tmpdir(), 'beeline-turn-budget-'));
    context = resolve(root, 'turn.json');
    vi.stubEnv('BEELINE_FREE_AGENT_ID', 'test');
    vi.stubEnv('BEELINE_FREE_AGENT_MODEL_TOKEN', '');
    vi.stubEnv('BEELINE_FREE_AGENT_MAX_TURN_SECONDS', '900');
    vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', context);
    await writeFile(context, JSON.stringify({ startedAt: Date.now() - 800000 }));
    await load();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });
  it.each([undefined, 900, 0])('bounds timeout %s against intake, leaving a minute for delivery', (timeout) => {
    const event = call(timeout);
    expect(handlers.get('tool_call')!(event)).toBeUndefined();
    expect(event.input.timeout).toBeGreaterThan(35);
    expect(event.input.timeout).toBeLessThanOrEqual(40);
  });
  it('preserves shorter requested limits and successful results', () => {
    const event = call(2);
    handlers.get('tool_call')!(event);
    expect(event.input.timeout).toBe(2);
    expect(handlers.get('tool_result')!({ ...event, isError: false, content: [{ type: 'text', text: 'done' }] })).toBeUndefined();
  });
  it('rereads intake for warm turns and refuses commands during delivery time', async () => {
    await writeFile(context, JSON.stringify({ startedAt: Date.now() - 850000 }));
    expect(handlers.get('tool_call')!(call())).toMatchObject({ block: true, reason: expect.stringContaining('Deliver any finished files') });
    await writeFile(context, JSON.stringify({ startedAt: Date.now() }));
    const event = call();
    expect(handlers.get('tool_call')!(event)).toBeUndefined();
    expect(event.input.timeout).toBe(300);
    await writeFile(context, '{}');
    expect(handlers.get('tool_call')!(call())).toMatchObject({ block: true });
  });
  it('does not constrain paid agents or non-shell tools', async () => {
    const event = { ...call(), toolName: 'read' };
    expect(handlers.get('tool_call')!(event)).toBeUndefined();
    expect(event.input.timeout).toBeUndefined();
    vi.stubEnv('BEELINE_FREE_AGENT_ID', '');
    await load();
    expect(handlers.size).toBe(0);
  });
  it('Reproduction avatar-timeout: real Pi shell stops before cutoff and gives a delivery instruction', async () => {
    // The production extension and actual Pi shell executor, with one second of command budget.
    const { createBashTool } = await import('@earendil-works/pi-coding-agent');
    await writeFile(context, JSON.stringify({ startedAt: Date.now() - 838500 }));
    const event = call(900);
    event.input.command = 'printf partial; printf partial > partial.txt; sleep 10; printf finished > finished.txt';
    handlers.get('tool_call')!(event);
    expect(event.input.timeout).toBe(1);
    const start = Date.now();
    let error = '';
    try { await createBashTool(root).execute(event.toolCallId, event.input); }
    catch (failure) { error = String(failure); }
    expect(error).toMatch(/timed out/i);
    expect(error).toContain('partial');
    expect(Date.now() - start).toBeLessThan(5000);
    expect(await readFile(resolve(root, 'partial.txt'), 'utf8')).toBe('partial');
    await expect(readFile(resolve(root, 'finished.txt'), 'utf8')).rejects.toThrow();
    const result = handlers.get('tool_result')!({ ...event, isError: true, content: [{ type: 'text', text: error }] });
    expect(result).toMatchObject({ isError: true, content: expect.arrayContaining([{ type: 'text', text: expect.stringContaining('Deliver any finished files now') }]) });
    console.info('Reproduction avatar-timeout: long shell stopped; partial.txt survived; agent receives delivery instruction with a minute remaining.');
  });
});
