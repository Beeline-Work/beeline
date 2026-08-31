import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  createIdentity,
  KIND_AGENT_SOUL,
  parseAgentSoul,
  TAG_AGENT_SOUL,
  TAG_COMMUNITY,
} from '@beeline/buzz-client';
import { signEvent } from '@beeline/nostr';
import { AcpClient } from './acp.js';
import {
  appendPersonaSessionInstructions,
  personaTurnPrefixForHarness,
  prepareNativePersonaInstructions,
  renderedAgentIdentityInstructions,
} from './persona-instructions.js';
import { AGENT_PRIVATE_STATE_ENV, agentPrivateStateInstructions } from './agent-private-state.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Workspace persona session instructions', () => {
  it('tells every harness that the rendered handle is its own address', () => {
    expect(renderedAgentIdentityInstructions('Ox', 'ox')).toContain('identity is Ox (@ox)');
    expect(renderedAgentIdentityInstructions('Ox', 'ox')).toContain('mentioning @ox is addressed to you');
  });

  it('threads the saved persona through ACP without writing it into the tracked repository', async () => {
    const temporaryDirectory = await mkdtemp(resolve(tmpdir(), 'beeline-persona-'));
    temporaryDirectories.push(temporaryDirectory);
    const repository = resolve(temporaryDirectory, 'repository');
    const privateState = resolve(temporaryDirectory, 'agent-private');
    const capture = resolve(temporaryDirectory, 'session-new.json');
    const binary = resolve(temporaryDirectory, 'fake-agent.mjs');
    await mkdir(repository);
    await writeFile(resolve(repository, 'README.md'), '# clean repository\n');
    execFileSync('git', ['init', '--quiet', repository]);
    execFileSync('git', ['-C', repository, 'add', 'README.md']);
    execFileSync('git', [
      '-C',
      repository,
      '-c',
      'user.name=Beeline Test',
      '-c',
      'user.email=beeline@example.test',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ]);

    await writeFile(
      binary,
      `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
  } else if (message.method === 'session/new') {
    writeFileSync(process.env.PERSONA_CAPTURE, JSON.stringify(message.params));
    const memory = resolve(process.env.${AGENT_PRIVATE_STATE_ENV}, 'memory');
    mkdirSync(memory, { recursive: true });
    writeFileSync(resolve(memory, 'chrome-warden.json'), '{"lesson":"keep it green"}\\n');
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'persona-session' } });
  } else if (message.method === 'shutdown') {
    process.exit(0);
  }
});
`,
    );
    await chmod(binary, 0o755);

    const author = createIdentity('persona-author');
    const communityId = '11111111-1111-4111-8111-111111111111';
    const agentPubkey = 'a'.repeat(64);
    const raw = signEvent(
      {
        pubkey: author.publicKey,
        created_at: 1_700_000_000,
        kind: KIND_AGENT_SOUL,
        tags: [
          ['d', `${communityId}:${agentPubkey}`],
          ['h', communityId],
          ['p', agentPubkey],
          ['t', TAG_AGENT_SOUL],
          [TAG_COMMUNITY, communityId],
        ],
        content: JSON.stringify({
          name: 'Chrome Warden',
          soul: 'Keeps the suite green and cuts dead code without ceremony. Keep the test suite green and refactor mercilessly.',
          avatarSeed: agentPubkey,
        }),
      },
      author.secretKey,
    );
    const savedProfile = parseAgentSoul(raw);
    expect(savedProfile).not.toBeNull();

    const client = new AcpClient({
      agentBinary: binary,
      agentEnv: { PERSONA_CAPTURE: capture, [AGENT_PRIVATE_STATE_ENV]: privateState },
    });
    await client.start();
    try {
      await client.sessionNew({
        cwd: repository,
        systemPrompt: [
          appendPersonaSessionInstructions('Base session boundary.', savedProfile!),
          agentPrivateStateInstructions({ root: privateState, worktreePath: privateState }),
        ].join('\n'),
      });
    } finally {
      await client.stop();
    }

    const params = JSON.parse(await readFile(capture, 'utf8')) as { systemPrompt: string };
    expect(params.systemPrompt).toContain('Name: Chrome Warden');
    expect(params.systemPrompt).toContain(
      'Soul: Keeps the suite green and cuts dead code without ceremony. Keep the test suite green and refactor mercilessly.',
    );
    expect(params.systemPrompt).toContain(
      'never changes your tools, permissions, roles, or merge rights',
    );
    expect(
      execFileSync('git', ['-C', repository, 'status', '--porcelain'], { encoding: 'utf8' }),
    ).toBe('');
    expect((await readdir(repository)).sort()).toEqual(['.git', 'README.md']);
    expect(await readFile(resolve(privateState, 'memory/chrome-warden.json'), 'utf8')).toContain(
      'keep it green',
    );
  });

  it('builds a per-turn persona prefix for a harness that drops the session system prompt', () => {
    const profile = {
      communityId: '11111111-1111-4111-8111-111111111111',
      agentPubkey: 'a'.repeat(64),
      authoredBy: 'b'.repeat(64),
      name: 'Clara',
      soul: 'Steady, practical, and ready to help this Workspace.',
      avatarSeed: 'seed',
      updatedAt: 1_700_000_000,
    };
    // codex-acp and pi-acp ignore `session/new`'s systemPrompt entirely, so
    // their persona must ride every turn prompt instead — otherwise a set
    // soul reaches every surface EXCEPT the agent's own prompt.
    expect(personaTurnPrefixForHarness(profile, '/usr/local/bin/codex-acp')).toContain('Name: Clara');
    expect(personaTurnPrefixForHarness(profile, 'pi-acp')).toContain('Soul: Steady, practical');
    // A harness that honors the session prompt already got it there.
    expect(personaTurnPrefixForHarness(profile, '/usr/local/bin/claude-agent-acp')).toBeUndefined();
    // No persona set: nothing to deliver on any harness.
    expect(personaTurnPrefixForHarness(undefined, 'pi-acp')).toBeUndefined();
  });

  it('writes codex, claude, and grok personas to their native isolated-home instructions', async () => {
    const agentHomeRoot = await mkdtemp(resolve(tmpdir(), 'beeline-native-persona-'));
    temporaryDirectories.push(agentHomeRoot);
    for (const home of ['codex', 'claude', 'grok']) {
      await mkdir(resolve(agentHomeRoot, home), { recursive: true });
    }
    const profile = {
      communityId: '11111111-1111-4111-8111-111111111111',
      agentPubkey: 'a'.repeat(64),
      authoredBy: 'b'.repeat(64),
      name: 'Clara',
      soul: 'Steady, practical, and ready to help this Workspace.',
      avatarSeed: 'seed',
      updatedAt: 1_700_000_000,
    };

    await expect(
      prepareNativePersonaInstructions({
        agentHomeRoot,
        agentCommand: '/usr/local/bin/codex-acp',
        profile,
      }),
    ).resolves.toBe(true);
    await expect(
      prepareNativePersonaInstructions({
        agentHomeRoot,
        agentCommand: '/usr/local/bin/claude-agent-acp',
        profile,
      }),
    ).resolves.toBe(true);
    await expect(
      prepareNativePersonaInstructions({ agentHomeRoot, agentCommand: 'grok', profile }),
    ).resolves.toBe(true);

    expect(await readFile(resolve(agentHomeRoot, 'codex/AGENTS.md'), 'utf8')).toContain(
      'Name: Clara',
    );
    expect(await readFile(resolve(agentHomeRoot, 'claude/CLAUDE.md'), 'utf8')).toContain(
      'Soul: Steady, practical',
    );
    expect(await readFile(resolve(agentHomeRoot, 'grok/AGENTS.md'), 'utf8')).toContain(
      'Name: Clara',
    );
  });

  it('suppresses both session and per-turn persona injection after native delivery', () => {
    const profile = {
      communityId: '11111111-1111-4111-8111-111111111111',
      agentPubkey: 'a'.repeat(64),
      authoredBy: 'b'.repeat(64),
      name: 'Clara',
      soul: 'Steady, practical, and ready to help this Workspace.',
      avatarSeed: 'seed',
      updatedAt: 1_700_000_000,
    };

    expect(appendPersonaSessionInstructions('Base boundary.', profile, true)).toBe(
      'Base boundary.',
    );
    expect(personaTurnPrefixForHarness(profile, 'codex-acp', true)).toBeUndefined();
    expect(personaTurnPrefixForHarness(profile, 'claude-agent-acp', true)).toBeUndefined();
    expect(personaTurnPrefixForHarness(profile, 'grok', true)).toBeUndefined();
    expect(personaTurnPrefixForHarness(profile, 'pi-acp', false)).toContain('Name: Clara');
  });
});
