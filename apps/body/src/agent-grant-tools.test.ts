import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REQUESTABLE_AGENT_GRANT_KINDS } from '@beeline/api-contract/agent-grants';
import {
  agentToolsFor,
  listGrants,
  requestGrant,
  runGrantedCommand,
  storeSecret,
  type AgentGrantDeps,
  type GrantRunDeps,
} from './read-only-mcp.js';

function deps(
  answer: Record<string, unknown>,
  ops: Array<{ name: string; input: Record<string, unknown> }> = [],
  secrets: Record<string, string> = { FLY_TOKEN: 'fly-secret-value-123' },
): AgentGrantDeps {
  return {
    roomId: 'room-1',
    execute: async (name, input) => {
      ops.push({ name, input: input as Record<string, unknown> });
      return answer;
    },
    resolveSecret: async (name) => secrets[name],
  };
}

describe('beeline-agent request_grant', () => {
  it.each([
    { kind: 'budget', target: '$10', reason: 'more tokens' },
    { kind: 'repository', target: 'acme/widgets', reason: 'edit the repository' },
  ])('rejects retired $kind prompts before calling the server', async (ask) => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    await expect(requestGrant(ask, deps({}, ops))).rejects.toThrow('kind must be one of');
    expect(ops).toEqual([]);
  });

  it('is mounted in Rooms, corners, and direct messages next to run_granted_command', () => {
    for (const directMessage of [false, true]) {
      const names = agentToolsFor(true, directMessage).map((tool) => tool.name);
      expect(names).toContain('request_grant');
      expect(names).toContain('run_granted_command');
    }
    expect(agentToolsFor(false, false).map((tool) => tool.name)).not.toContain('request_grant');
  });

  it('suppresses command execution when the daemon has no usable runner boundary', () => {
    const names = agentToolsFor(true, false, false, false, false).map((tool) => tool.name);
    expect(names).toContain('request_grant');
    expect(names).not.toContain('run_granted_command');
  });

  it('offers every grant kind the contract defines, and names each one where the agent reads it', () => {
    const tool = agentToolsFor(true, false).find((entry) => entry.name === 'request_grant');
    const kinds = (tool?.inputSchema as { properties: { kind: { enum: string[] } } }).properties
      .kind.enum;
    expect([...kinds].sort()).toEqual([...REQUESTABLE_AGENT_GRANT_KINDS].sort());
    // The description is the interface the model reads to pick a kind: a kind
    // the schema offers but the prose never names is one nobody asks for.
    for (const kind of kinds) expect(tool?.description).toContain(kind);
  });

  it('asks for a host MCP route by name and reports it pending, never a yolo approval', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    const reply = await requestGrant(
      { kind: 'mcp', target: ' squire ', reason: 'vault the provider key' },
      deps(
        {
          grantId: 'g-9',
          status: 'pending',
          auto: false,
          messageId: 'm-9',
          approval: { destination: 'trusty-squire-dm', authority: 'resource-owner' },
        },
        ops,
      ),
    );
    expect(ops).toEqual([
      {
        name: 'requestAgentGrant',
        input: {
          roomId: 'room-1',
          kind: 'mcp',
          target: 'squire',
          reason: 'vault the provider key',
        },
      },
    ]);
    expect(reply).toMatch(/^pending, card posted: use squire \[grant g-9\]/);
    expect(reply).toContain('paused');
    expect(reply).toContain(
      "The resource owner must answer ALWAYS, ONCE, or NO in the resource owner's private Trusty Squire DM",
    );
    expect(reply).toContain('approval wake starts the fresh session with that route mounted');
    expect(reply).toContain('without restarting or scheduling another turn');
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
      deps(
        {
          grantId: 'g-1',
          status: 'pending',
          auto: false,
          messageId: 'm-1',
          approval: { destination: 'system-dm', authority: 'resource-owner' },
        },
        ops,
      ),
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
    expect(reply).toMatch(
      /^pending, card posted: run fly deploy -a beeline-preview --with FLY_TOKEN \[grant g-1\]/,
    );
    expect(reply).toContain('paused');
    expect(reply).toContain('ALWAYS, ONCE, or NO');
    expect(reply).toContain(
      "The resource owner must answer ALWAYS, ONCE, or NO in the resource owner's private @system DM",
    );
    expect(reply).not.toContain('in this Room');
  });

  it('returns approval and, for a command, points at run_granted_command', async () => {
    const command = await requestGrant(
      { kind: 'command', target: 'npm test', reason: 'run the suite' },
      deps({ grantId: 'g-2', status: 'approved', auto: true }),
    );
    expect(command).toBe(
      'approved: run npm test [grant g-2]. Run it now with run_granted_command and the argv.',
    );
    const host = await requestGrant(
      { kind: 'host', target: ' api.fly.io ', reason: 'reach the Fly API' },
      deps({ grantId: 'g-3', status: 'approved', auto: true }),
    );
    expect(host).toBe(
      "approved: reach api.fly.io [grant g-3]; applies at the agent's next session.",
    );
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
    await expect(
      requestGrant({ kind: 'host', target: 'api.fly.io', reason: ' ' }, answer),
    ).rejects.toThrow('reason must be a non-empty string');
    await expect(
      requestGrant({ kind: 'host', target: 'api.fly.io', reason: 'x', ttl: 5 }, answer),
    ).rejects.toThrow('ttl must be');
    expect(ops).toEqual([]);
  });

  it('rejects at ask time a command grant whose named secret cannot resolve, before the server is called', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    const ask = deps({ grantId: 'never' }, ops, {});
    await expect(
      requestGrant(
        {
          kind: 'command',
          target: 'fly deploy -a preview --with DOOMED_SECRET --with ANOTHER_MISSING',
          reason: 'publish',
        },
        ask,
      ),
    ).rejects.toThrow('DOOMED_SECRET, ANOTHER_MISSING');
    // Nothing was sent to the server: an unresolvable ask never becomes a card.
    expect(ops).toEqual([]);
  });

  it('lets a command ask through when every named secret resolves now', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    const reply = await requestGrant(
      {
        kind: 'command',
        target: 'fly deploy -a preview --with FLY_TOKEN',
        reason: 'publish',
      },
      deps({ grantId: 'g-7', status: 'approved', auto: true }, ops),
    );
    expect(ops[0]!.name).toBe('requestAgentGrant');
    expect(ops[0]!.input).toEqual({
      roomId: 'room-1',
      kind: 'command',
      target: 'fly deploy -a preview --with FLY_TOKEN',
      reason: 'publish',
    });
    expect(reply).toContain('approved: run fly deploy -a preview');
  });

  it('mounts list_grants and store_secret next to request_grant on every agent surface', () => {
    for (const directMessage of [false, true]) {
      const names = agentToolsFor(true, directMessage).map((tool) => tool.name);
      expect(names).toContain('list_grants');
      expect(names).toContain('store_secret');
      expect(names).toContain('request_grant');
    }
    expect(agentToolsFor(false, false).map((tool) => tool.name)).not.toContain('store_secret');
    expect(agentToolsFor(false, false).map((tool) => tool.name)).not.toContain('list_grants');
  });
});

describe('beeline-agent list_grants and store_secret', () => {
  it('list_grants shows each pending and live grant and flags a command grant whose secret is missing', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    const reply = await listGrants(
      deps(
        {
          grants: [
            {
              grantId: 'g-1',
              workspaceId: 'w',
              roomId: 'room-1',
              kind: 'command',
              target: 'fly deploy -a preview --with FLY_TOKEN',
              reason: 'publish the preview',
              status: 'pending',
              auto: false,
              requestedBy: 'c'.repeat(64),
              createdAt: 1,
            },
            {
              grantId: 'g-2',
              workspaceId: 'w',
              roomId: 'room-1',
              kind: 'command',
              target: 'fly deploy -a preview --with GHOST_SECRET',
              reason: 'publish the preview',
              status: 'pending',
              auto: false,
              requestedBy: 'c'.repeat(64),
              createdAt: 2,
            },
            {
              grantId: 'g-3',
              workspaceId: 'w',
              roomId: 'room-1',
              kind: 'host',
              target: 'api.fly.io',
              reason: 'reach the API',
              status: 'approved',
              auto: true,
              requestedBy: 'c'.repeat(64),
              createdAt: 3,
            },
          ],
        },
        ops,
        // Only FLY_TOKEN resolves; GHOST_SECRET does not.
        { FLY_TOKEN: 'fly-secret-value-123' },
      ),
    );
    expect(ops[0]!.name).toBe('listAgentGrantRequests');
    expect(reply).toContain('pending command fly deploy -a preview --with FLY_TOKEN');
    expect(reply).toContain('secrets present');
    expect(reply).toContain('GHOST_SECRET NOT resolvable');
    expect(reply).toContain('approved host api.fly.io');
    expect(reply).not.toContain('fly-secret-value-123');
  });

  it('list_grants says none when the server has nothing', async () => {
    const reply = await listGrants(deps({ grants: [] }));
    expect(reply).toContain('no grants right now');
  });

  it('store_secret writes through its dependency and never echoes the value', async () => {
    const writes: Array<[string, string]> = [];
    const reply = await storeSecret(
      { name: 'DEPLOY_TOKEN', value: 'super-secret-9' },
      {
        roomId: 'room-1',
        execute: async () => ({}),
        storeSecret: async (name, value) => {
          writes.push([name, value]);
        },
      },
    );
    expect(writes).toEqual([['DEPLOY_TOKEN', 'super-secret-9']]);
    expect(reply).toContain('stored secret DEPLOY_TOKEN');
    expect(reply).not.toContain('super-secret-9');
  });

  it('store_secret refuses a name the --with rule would never accept', async () => {
    const writes: Array<[string, string]> = [];
    await expect(
      storeSecret(
        { name: 'lower_case', value: 'x' },
        {
          roomId: 'room-1',
          execute: async () => ({}),
          storeSecret: async (name, value) => {
            writes.push([name, value]);
          },
        },
      ),
    ).rejects.toThrow('UPPER_CASE');
    expect(writes).toEqual([]);
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
    const reply = await runGrantedCommand(
      { argv: ['fly', 'deploy', '-a', 'beeline-preview'] },
      run,
    );
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
      {
        ...deps(
          { grantId: 'g-1', status: 'pending', auto: false, escalations: ['unseen-script'] },
          ops,
        ),
        scriptRoots: [root],
      },
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

  it('distinguishes a sandbox startup failure from the command exit status', async () => {
    const reply = await runGrantedCommand(
      { argv: ['git', 'status'] },
      {
        roomId: 'room-1',
        run: async () => ({
          grantId: 'g-2',
          exitCode: 1,
          timedOut: false,
          output: 'bwrap: No permissions to create a new namespace',
          sandboxFailure: true,
        }),
      },
    );
    expect(reply).toContain('sandbox failed before command start');
    expect(reply).not.toContain('exit 1');
  });
});
