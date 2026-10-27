import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { FreeAgentContinuation } from './free-agent-continuation.js';

it('keeps a checkpoint across helper restarts, recognizes tagged continue, and clears it for a new request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'free-checkpoint-'));
  const path = join(root, 'checkpoint.json');
  try {
    const first = new FreeAgentContinuation(path);
    await first.begin('Smooth the handle.');
    await first.stopped({ stopReason: 'free-agent-time-limit', agentText: 'Saved handle.obj.', updates: [],
      toolCalls: [{ title: 'bash', status: 'in_progress', rawInput: { command: 'render handle.obj', token: 'private' }, content: 'mesh partial' }] });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, 'utf8')).not.toContain('private');
    const restarted = new FreeAgentContinuation(path);
    await restarted.begin('@bee continue');
    expect(restarted.context).toMatchObject({ request: 'Smooth the handle.', limits: 1, partial: 'Saved handle.obj.' });
    expect(restarted.context?.tools[0]).toContain('unfinished');
    expect(restarted.context?.tools[0]).toContain('render handle.obj');
    const note = await restarted.stopped({ stopReason: 'free-agent-time-limit', agentText: 'The mesh still needs export.', updates: [], toolCalls: [] });
    expect(note).toContain('Smooth the handle.');
    expect(note).toContain('First, I can check the output');
    expect(note).not.toContain('send continue');
    await restarted.begin('Make a new logo.');
    expect(restarted.context).toBeUndefined();
    await expect(readFile(path)).rejects.toThrow();
    await writeFile(path, 'incomplete');
    await new FreeAgentContinuation(path).begin('continue');
  } finally { await rm(root, { recursive: true, force: true }); }
});
