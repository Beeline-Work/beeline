import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  agentToolsFor,
  requestGrant,
  runGrantedCommand,
  type AgentGrantDeps,
  type GrantRunDeps,
} from './read-only-mcp.js';

function deps(
  answer: Record<string, unknown>,
  ops: Array<{ name: string; input: Record<string, unknown> }> = [],
): AgentGrantDeps {
  return {
    roomId: 'room-1',
    execute: async (name, input) => {
      ops.push({ name, input: input as Record<string, unknown> });
      return answer;
    },
  };
}

describe('beeline-agent request_grant', () => {
  it('is mounted in Rooms, corners, and direct messages next to run_granted_command', () => {
    for (const directMessage of [false, true]) {
      const names = agentToolsFor(true, directMessage).map((tool) => tool.name);
      expect(names).toContain('request_grant');
      expect(names).toContain('run_granted_command');
    }
    expect(agentToolsFor(false, false).map((tool) => tool.name)).not.toContain('request_grant');
  });

  it('returns "pending, card posted" and tells the agent its turn is paused', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    const reply = await requestGrant(
      {
        kind: 'command',
        target: 'fly deploy -a beeline-preview --with FLY_TOKEN',
        reason: 'publish the preview build',
        ttl: 3600,
      },
      deps({ grantId: 'g-1', status: 'pending', auto: false, messageId: 'm-1' }, ops),
    );
    expect(ops).toEqual([
      {
        name: 'requestAgentGrant',
        input: {
          roomId: 'room-1',
          kind: 'command',
          target: 'fly deploy -a beeline-preview --with FLY_TOKEN',
          reason: 'publish the preview build',
          ttlSeconds: 3600,
        },
      },
    ]);
    expect(reply).toMatch(/^pending, card posted: run fly deploy -a beeline-preview --with FLY_TOKEN \[grant g-1\]/);
    expect(reply).toContain('paused');
    expect(reply).toContain('ALWAYS, ONCE, or NO');
  });

  it('returns "approved (yolo)" and, for a command, points at run_granted_command', async () => {
    const command = await requestGrant(
      { kind: 'command', target: 'npm test', reason: 'run the suite' },
      deps({ grantId: 'g-2', status: 'approved', auto: true }),
    );
    expect(command).toBe(
      'approved (yolo): run npm test [grant g-2]. Run it now with run_granted_command and the argv.',
    );
    const host = await requestGrant(
      { kind: 'host', target: ' api.fly.io ', reason: 'reach the Fly API' },
      deps({ grantId: 'g-3', status: 'approved', auto: true }),
    );
    expect(host).toBe("approved (yolo): reach api.fly.io [grant g-3]; applies at the agent's next session.");
  });

  it('refuses shell metacharacters and malformed asks before the server is called', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    const answer = deps({ grantId: 'never' }, ops);
    await expect(
      requestGrant({ kind: 'command', target: 'fly deploy; rm -rf /', reason: 'x' }, answer),
    ).rejects.toThrow('shell metacharacters');
    await expect(
      requestGrant({ kind: 'command', target: 'echo $FLY_TOKEN', reason: 'x' }, answer),
    ).rejects.toThrow('shell metacharacters');
    await expect(requestGrant({ kind: 'wifi', target: 'x', reason: 'x' }, answer)).rejects.toThrow(
      'kind must be one of',
    );
    await expect(requestGrant({ kind: 'host', target: '  ', reason: 'x' }, answer)).rejects.toThrow(
      'target must be a non-empty string',
    );
    await expect(requestGrant({ kind: 'host', target: 'api.fly.io', reason: ' ' }, answer)).rejects.toThrow(
      'reason must be a non-empty string',
    );
    await expect(
      requestGrant({ kind: 'host', target: 'api.fly.io', reason: 'x', ttl: 5 }, answer),
    ).rejects.toThrow('ttl must be');
    expect(ops).toEqual([]);
  });
});

describe('beeline-agent run_granted_command', () => {
  it('posts the argv to the daemon runner and returns the verdict with the capped output', async () => {
    const runs: unknown[] = [];
    const run: GrantRunDeps = {
      roomId: 'room-1',
      run: async (input) => {
        runs.push(input);
        return { grantId: 'g-1', exitCode: 0, timedOut: false, output: 'deployed\n' };
      },
    };
    const reply = await runGrantedCommand({ argv: ['fly', 'deploy', '-a', 'beeline-preview'] }, run);
    expect(runs).toEqual([{ roomId: 'room-1', argv: ['fly', 'deploy', '-a', 'beeline-preview'] }]);
    expect(reply).toBe('ran under grant g-1: exit 0\ndeployed\n');
  });

  it('surfaces the runner refusal and validates argv locally', async () => {
    const refusing: GrantRunDeps = {
      roomId: 'room-1',
      run: async () => {
        throw new Error('no approved command grant matches: rm -rf /');
      },
    };
    await expect(runGrantedCommand({ argv: ['rm', '-rf', '/'] }, refusing)).rejects.toThrow(
      'no approved command grant matches',
    );
    await expect(runGrantedCommand({ argv: [] }, refusing)).rejects.toThrow('argv must be');
    await expect(runGrantedCommand({ argv: 'npm test' }, refusing)).rejects.toThrow('argv must be');
    const timedOut = await runGrantedCommand(
      { argv: ['sleep'] },
      {
        roomId: 'room-1',
        run: async () => ({ grantId: 'g', exitCode: null, timedOut: true, output: '' }),
      },
    );
    expect(timedOut).toBe('ran under grant g: timed out after 10 minutes\n(no output)');
  });
});

/**
 * C94: `python3 fix.py` tells the person deciding nothing about what will run,
 * so the ask carries the script and the approval is bound to those bytes.
 */
describe('request_grant carries the script an interpreter will run', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  const checkout = (contents: string, name = 'fix.py') => {
    const root = mkdtempSync(join(tmpdir(), 'beeline-grant-script-'));
    roots.push(root);
    writeFileSync(join(root, name), contents);
    return root;
  };

  it('sends the file contents and its hash with the ask, and tells the agent so', async () => {
    const body = 'import os\nos.remove("/tmp/x")\n';
    const root = checkout(body);
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    const reply = await requestGrant(
      { kind: 'command', target: 'python3 fix.py', reason: 'clean up' },
      { ...deps({ grantId: 'g-1', status: 'pending', auto: false, escalations: ['unseen-script'] }, ops), scriptRoots: [root] },
    );
    expect(ops[0]!.input.script).toEqual({
      path: 'fix.py',
      sha256: createHash('sha256').update(body).digest('hex'),
      bytes: Buffer.byteLength(body),
      contents: body,
    });
    expect(reply).toContain(
      'A human always answers this one because it runs a script whose contents nobody has read',
    );
    expect(reply).toContain('the approval is bound to those bytes');
  });

  it('refuses a script too long to read honestly instead of truncating it', async () => {
    const root = checkout(`${Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n')}\n`);
    await expect(
      requestGrant(
        { kind: 'command', target: 'python3 fix.py', reason: 'x' },
        { ...deps({ grantId: 'g' }), scriptRoots: [root] },
      ),
    ).rejects.toThrow('will not be truncated');
  });

  it('refuses a script outside the checkout and the scratch directory', async () => {
    const root = checkout('print(1)\n');
    await expect(
      requestGrant(
        { kind: 'command', target: 'python3 /etc/hosts', reason: 'x' },
        { ...deps({ grantId: 'g' }), scriptRoots: [root] },
      ),
    ).rejects.toThrow('cannot be shown on the approval card');
  });

  it('asks without a body when the interpreter line names no file', async () => {
    const root = checkout('print(1)\n');
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    await requestGrant(
      { kind: 'command', target: 'python3 -V', reason: 'x' },
      { ...deps({ grantId: 'g', status: 'pending', auto: false }, ops), scriptRoots: [root] },
    );
    expect(ops[0]!.input.script).toBeUndefined();
  });
});

describe('run_granted_command reports the Room boundary', () => {
  it('names the corner when the read-only filesystem refused a write', async () => {
    const reply = await runGrantedCommand(
      { argv: ['cp', 'a', 'b'] },
      {
        roomId: 'room-1',
        run: async () => ({
          grantId: 'g-1',
          exitCode: 1,
          timedOut: false,
          output: "cp: cannot create 'b': Read-only file system",
          writeRefused: true,
        }),
      },
    );
    expect(reply).toContain('read-only outside your scratch directory');
    expect(reply).toContain('open_corner');
  });
});
