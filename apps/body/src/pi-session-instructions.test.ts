import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PiSessionInstructions } from './pi-session-instructions.js';

describe('Pi instruction delivery', () => {
  let root: string;
  let file: string;
  let env: Record<string, string>;
  let delivery: PiSessionInstructions;
  const rules = 'Keep the approved task and safety rules.';
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'beeline-pi-instructions-'));
    const dir = join(root, 'sessions', 'project');
    await mkdir(dir, { recursive: true });
    file = join(dir, 'time_session.jsonl');
    await writeFile(file, '{"type":"session","id":"session"}\n');
    env = { PI_CODING_AGENT_DIR: root };
    delivery = new PiSessionInstructions();
    delivery.remember('session', rules);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('sends rules on the first turn and keeps only the new task on a warm turn', async () => {
    expect(await delivery.prepare('session', `${rules}\n\nFirst task.`, env)).toBe(`${rules}\n\nFirst task.`);
    expect(await delivery.prepare('session', `${rules}\n\nSecond task.`, env)).toBe('Second task.');
  });
  it('resends for a new session', async () => {
    await delivery.prepare('session', 'First task.', env);
    delivery.remember('repaired', rules);
    expect(await delivery.prepare('repaired', 'Continue.', env)).toBe(`${rules}\n\nContinue.`);
  });
  it('resends after a failed delivery even if a repaired adapter reuses the session id', async () => {
    await delivery.prepare('session', 'First task.', env);
    delivery.failed('session');
    expect(await delivery.prepare('session', 'Retry.', env)).toBe(`${rules}\n\nRetry.`);
  });
  it('resends changed instructions', async () => {
    await delivery.prepare('session', 'First task.', env);
    delivery.remember('session', 'Updated safety rules.');
    expect(await delivery.prepare('session', 'Continue.', env)).toBe('Updated safety rules.\n\nContinue.');
  });
  it('resends after every compaction, then returns to warm delivery', async () => {
    await delivery.prepare('session', 'First task.', env);
    await writeFile(file, '{"type":"compaction","id":"compact-1"}\n');
    expect(await delivery.prepare('session', 'Continue.', env)).toBe(`${rules}\n\nContinue.`);
    expect(await delivery.prepare('session', `${rules}\n\nNext.`, env)).toBe('Next.');
    await writeFile(file, '{"type":"compaction","id":"compact-2"}\n');
    expect(await delivery.prepare('session', 'Continue.', env)).toBe(`${rules}\n\nContinue.`);
  });
  it('retains rules when the journal is unavailable or cannot be parsed', async () => {
    await delivery.prepare('session', 'First task.', env);
    await writeFile(file, '{partial');
    expect(await delivery.prepare('session', 'Continue.', env)).toBe(`${rules}\n\nContinue.`);
    await rm(file);
    expect(await delivery.prepare('session', 'Again.', env)).toBe(`${rules}\n\nAgain.`);
  });
  it('does not alter prompts for another harness or strip a merely similar prefix', async () => {
    expect(await delivery.prepare('other', rules, env)).toBe(rules);
    await delivery.prepare('session', 'First.', env);
    expect(await delivery.prepare('session', `${rules}Extra text.`, env)).toBe(`${rules}Extra text.`);
  });
});
