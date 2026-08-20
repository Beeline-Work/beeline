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
import { appendPersonaSessionInstructions } from './persona-instructions.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Workspace persona session instructions', () => {
  it('threads the saved persona through ACP without writing it into the tracked repository', async () => {
    const temporaryDirectory = await mkdtemp(resolve(tmpdir(), 'beeline-persona-'));
    temporaryDirectories.push(temporaryDirectory);
    const repository = resolve(temporaryDirectory, 'repository');
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
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } });
  } else if (message.method === 'session/new') {
    writeFileSync(process.env.PERSONA_CAPTURE, JSON.stringify(message.params));
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
      agentEnv: { PERSONA_CAPTURE: capture },
    });
    await client.start();
    try {
      await client.sessionNew({
        cwd: repository,
        systemPrompt: appendPersonaSessionInstructions('Base session boundary.', savedProfile!),
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
  });
});
