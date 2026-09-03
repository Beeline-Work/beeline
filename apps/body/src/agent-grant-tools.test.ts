import { describe, expect, it } from 'vitest';
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
