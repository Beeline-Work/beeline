import { appendFileSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chosenName, heldBy, permissionMode, postToClaude, registryAncestor, scanClaude, socketFor } from './claude.js';
import { rolloutThread, scanCodex, turnEvent, turnRunning } from './codex.js';

const scratch = () => mkdtempSync(join(process.env.HOME ?? '/var/tmp', 'sj-'));

describe('Claude Code sessions', () => {
  it('lists live sessions from the registry and finds a session’s inbox', () => {
    const config = scratch();
    mkdirSync(join(config, 'sessions'));
    writeFileSync(join(config, 'sessions', '4242.json'), JSON.stringify({ pid: 4242, sessionId: 'after-clear', cwd: '/repo', name: 'api', nameSource: 'user', messagingSocketPath: '/run/4242.sock' }));
    writeFileSync(join(config, 'sessions', '4343.json'), JSON.stringify({ pid: 4343, sessionId: 'gone' }));
    writeFileSync(join(config, 'sessions', '4242.abc.key'), '{}');
    writeFileSync(join(config, 'sessions', '4444.json'), '{half');
    const sessions = scanClaude({ CLAUDE_CONFIG_DIR: config }, pid => pid === 4242);
    expect(sessions.map(s => s.sessionId)).toEqual(['after-clear']);
    expect(chosenName(sessions[0]!)).toBe('api');
    expect(chosenName({ pid: 1, name: 'repo-07', nameSource: 'derived' })).toBeUndefined();
    expect(socketFor(sessions, 'after-clear')).toEqual({ path: '/run/4242.sock' });
    expect(socketFor(sessions, undefined, 4242)).toEqual({ path: '/run/4242.sock' });
    expect(socketFor(sessions, 'other')).toBeUndefined();
    // The nearest ancestor with an entry is ours; a headless one between has none.
    expect(registryAncestor([800, 700, 600], pid => pid === 700 || pid === 600)).toBe(700);
  });

  it('posts a user frame into the inbox socket, which starts a turn in an idle session', async () => {
    const path = join(scratch(), 'inbox.sock');
    const received: string[] = [];
    const server = createServer(connection => connection.on('data', chunk => received.push(String(chunk))));
    await new Promise<void>(resolve => server.listen(path, resolve));
    await postToClaude({ path, token: 'peer-token' }, 'Beeline: @ana tagged you');
    await new Promise(resolve => setTimeout(resolve, 50));
    server.close();
    const frames = received.join('').trim().split('\n').map(line => JSON.parse(line));
    expect(frames).toEqual([{ type: 'auth', token: 'peer-token' }, { type: 'user', message: { role: 'user', content: 'Beeline: @ana tagged you' } }]);
    await expect(postToClaude({ path: join(scratch(), 'missing.sock') }, 'x')).rejects.toThrow();
  });

  it('knows Claude Code holds messages for a session that skips prompts unless inbound is accepted', () => {
    const transcript = join(scratch(), 'session.jsonl');
    writeFileSync(transcript, ['{"type":"user","permissionMode":"bypassPermissions"}', '{"type":"assistant"}', '{"type":"permission-mode","permissionMode":"auto"}', '{"type":"x"}'].join('\n') + '\n');
    expect(permissionMode(transcript)).toBe('auto');
    expect(permissionMode(join(scratch(), 'missing.jsonl'))).toBeUndefined();
    expect(heldBy('bypassPermissions', undefined)).toBe(true);
    expect(heldBy('bypassPermissions', 'accept')).toBe(false);
    expect(heldBy('auto', undefined)).toBe(false);
  });
});

describe('Codex threads', () => {
  const event = (kind: string) => JSON.stringify({ timestamp: 't', type: 'event_msg', payload: { type: kind, turn_id: '1' } }) + '\n';

  it('tells a running turn from one that is over, reading only what was appended', () => {
    const path = join(scratch(), 'rollout.jsonl');
    expect(turnRunning(path)).toBeUndefined();
    appendFileSync(path, '{"type":"session_meta","payload":{}}\n');
    expect(turnRunning(path)).toBe(false);
    appendFileSync(path, event('task_started'));
    expect(turnRunning(path)).toBe(true);
    // A message that quotes a turn event is not one.
    appendFileSync(path, JSON.stringify({ type: 'response_item', payload: { text: '"type":"event_msg" task_complete' } }) + '\n');
    expect(turnRunning(path)).toBe(true);
    appendFileSync(path, event('turn_aborted'));
    expect(turnRunning(path)).toBe(false);
    // A line still being written counts once it is whole.
    appendFileSync(path, event('task_started'));
    const end = event('task_complete');
    appendFileSync(path, end.slice(0, 20));
    expect(turnRunning(path)).toBe(true);
    appendFileSync(path, end.slice(20));
    expect(turnRunning(path)).toBe(false);
    // Rewritten shorter: read again.
    writeFileSync(path, event('turn_started'));
    expect(turnRunning(path)).toBe(true);
    expect(turnEvent('{"type":"event_msg","payload":{"type":"token_count"}}')).toBeUndefined();
  });

  it('finds each live thread from the rollout its process keeps open', () => {
    const proc = scratch();
    const rollout = join(scratch(), 'rollout-2026-10-30T21-49-16-01a18fa5-951a-7730-989a-50a80b6939c1.jsonl');
    writeFileSync(rollout, '');
    mkdirSync(join(proc, '700', 'fd'), { recursive: true });
    symlinkSync('/dev/null', join(proc, '700', 'fd', '0'));
    symlinkSync(rollout, join(proc, '700', 'fd', '9'));
    symlinkSync('/work/api', join(proc, '700', 'cwd'));
    mkdirSync(join(proc, '701', 'fd'), { recursive: true });
    mkdirSync(join(proc, 'self'));
    expect(scanCodex(proc)).toEqual([{ pid: 700, threadId: '01a18fa5-951a-7730-989a-50a80b6939c1', cwd: '/work/api', rollout }]);
    expect(rolloutThread('/x/notes.jsonl')).toBeUndefined();
  });
});
