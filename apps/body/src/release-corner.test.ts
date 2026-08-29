/**
 * The release conversation, end to end through a Room turn.
 *
 * The daemon's whole contribution is here: it reads what is genuinely
 * unreleased out of git and hands it to the Room turn as ground truth, it
 * remembers that it offered to cut a release, and it turns a person's plain
 * "yes" into a corner whose brief is the repository's own release process.
 * Everything about HOW a release is cut stays in the corner's prompt, which is
 * why nothing here asserts a version scheme or a changelog format.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpClient } from './acp.js';
import {
  Body,
  RELEASE_PROPOSAL_TTL_MS,
  type BoundRepo,
  type RoomReplyOutcome,
  type SubchannelInfo,
} from './body.js';
import type { NostrEvent } from '@beeline/nostr';

const cleanup: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return (result.stdout ?? '').trim();
}

/** A Room whose repository has a tagged release and unreleased work after it. */
function room(options: { unreleased?: string[] } = {}): {
  body: Body;
  boundRepo: BoundRepo;
  prompts: string[];
  opened: Array<{ intent?: string; prompt: string; instructions: string }>;
  published: NostrEvent[];
  reply: (content: string, at?: number) => Promise<RoomReplyOutcome>;
} {
  const root = mkdtempSync(join(tmpdir(), 'beeline-release-corner-'));
  cleanup.push(root);
  const repoPath = join(root, 'repo');
  spawnSync('git', ['init', '-q', '-b', 'main', repoPath], { encoding: 'utf8' });
  git(repoPath, ['config', 'user.name', 'Operator']);
  git(repoPath, ['config', 'user.email', 'operator@example.com']);
  writeFileSync(join(repoPath, 'README.md'), '# widgets\n');
  git(repoPath, ['add', '.']);
  git(repoPath, ['commit', '-qm', 'seed']);
  git(repoPath, ['tag', '-a', 'v1.1.0', '-m', 'v1.1.0']);
  for (const subject of options.unreleased ?? [
    'add the widget picker',
    'fix an empty-input crash',
  ]) {
    writeFileSync(join(repoPath, subject.replace(/\W+/g, '-')), `${subject}\n`);
    git(repoPath, ['add', '.']);
    git(repoPath, ['commit', '-qm', subject]);
  }

  const body = new Body(
    {
      agentBinary: '/nonexistent',
      mcpBinary: '/nonexistent',
      agentEnv: {},
      workspaceRoot: root,
      relayBaseUrl: 'http://relay.test',
      relayHost: 'relay.test',
      relayScheme: 'http',
      relayWsUrl: 'ws://relay.test',
      autoApprovePermissions: true,
    },
    undefined,
    undefined,
    undefined,
    { statePath: join(root, 'state.json') },
  );
  body.registerSession({
    channelId: 'room-channel',
    sessionId: 'readonly-session',
    client: new AcpClient({ agentBinary: '/nonexistent', agentEnv: {} }),
    mode: 'readonly',
  });

  const prompts: string[] = [];
  Reflect.set(body, 'promptAgent', async (_session: unknown, prompt: string) => {
    prompts.push(prompt);
    return {
      agentText: 'Here is what is unreleased. Shall I open a corner? Say yes.',
      updates: [],
    };
  });

  const opened: Array<{ intent?: string; prompt: string; instructions: string }> = [];
  const info = { subchannelId: 'corner-channel' } as unknown as SubchannelInfo;
  Reflect.set(body, 'openSubchannel', async (_room: string, _repo: BoundRepo, intent?: string) => {
    opened.push({ intent, prompt: '', instructions: '' });
    return info;
  });
  Reflect.set(
    body,
    'startAgentTask',
    (_info: SubchannelInfo, prompt: string, instructions: string) => {
      const last = opened.at(-1);
      if (last) {
        last.prompt = prompt;
        last.instructions = instructions;
      }
    },
  );

  const published: NostrEvent[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/query')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      published.push(JSON.parse(String(init?.body)) as NostrEvent);
      return new Response(JSON.stringify({ accepted: true }), { status: 200 });
    }),
  );

  const boundRepo: BoundRepo = {
    repo: 'widgets',
    localPath: repoPath,
    remoteName: 'origin',
    targetBranch: 'refs/heads/main',
    repositoryKey: 'release-corner',
  };
  let sequence = 0;
  const reply = (content: string, at?: number): Promise<RoomReplyOutcome> =>
    Reflect.get(body, 'replyInRoom').call(body, 'room-channel', boundRepo, {
      eventId: `event-${++sequence}`,
      authorPubkey: 'human-pubkey',
      content,
      createdAt: at ?? 1_700_000_000 + sequence,
    }) as Promise<RoomReplyOutcome>;

  return { body, boundRepo, prompts, opened, published, reply };
}

describe('a Room asked about a release', () => {
  it('answers from git, not from memory, and offers a corner', async () => {
    const { prompts, reply } = room();

    await reply("what's unreleased?");

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('2 commits on main since v1.1.0');
    expect(prompts[0]).toContain('- add the widget picker');
    expect(prompts[0]).toContain('- fix an empty-input crash');
    expect(prompts[0]).toContain('offer, in one sentence, to open a corner');
    expect(prompts[0]).toContain('Do not attempt the release yourself in this Room');
    // Still an ordinary read-only Room turn: the actual question is in there.
    expect(prompts[0]).toContain("what's unreleased?");
  });

  it('never turns target-branch prose into product state', async () => {
    const { prompts, reply } = room();

    await expect(reply('make release the target branch')).resolves.toEqual({
      openedCorner: false,
      producedReply: true,
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('make release the target branch');
  });

  it('never escalates a release ask into the write-permission ceremony', async () => {
    const { body, prompts, reply } = room();
    const permission = vi.spyOn(body as never, 'handleRoomPermissionRequest' as never);

    // "make" is a mutation verb, so without the release path this exact
    // message would have opened a permission ceremony instead of answering.
    await reply('make a release');

    expect(permission).not.toHaveBeenCalled();
    expect(prompts[0]).toContain('this turn is about cutting a release, and it is read-only');
  });
});

describe('confirming the proposal', () => {
  it('opens a corner briefed with the repository’s own release process', async () => {
    const { opened, reply } = room();

    await reply("what's unreleased?");
    await expect(reply('yes')).resolves.toEqual({ openedCorner: true, producedReply: true });

    expect(opened).toHaveLength(1);
    // Named after the release, never after the imperative that opened it.
    expect(opened[0]!.intent).toBe('release from main');
    expect(opened[0]!.prompt).toBe('cut a release from main');
    expect(opened[0]!.instructions).toContain(
      "Run this repository's own release process for main.",
    );
    expect(opened[0]!.instructions).toContain('do not invent one');
    expect(opened[0]!.instructions).toContain('ANNOTATED tag');
    expect(opened[0]!.instructions).toContain('Do NOT push anything');
    // The host-read change list travels with it.
    expect(opened[0]!.instructions).toContain('- add the widget picker');
  });

  it('carries a version the person named into the corner', async () => {
    const { opened, reply } = room();

    await reply('cut release v1.2.0');
    await expect(reply('go ahead')).resolves.toEqual({ openedCorner: true, producedReply: true });

    expect(opened[0]!.intent).toBe('release 1.2.0');
    expect(opened[0]!.instructions).toContain('Use the version the person asked for: 1.2.0.');
  });

  it('is a one-shot: a second "yes" is just another Room message', async () => {
    const { opened, prompts, reply } = room();

    await reply("what's unreleased?");
    await reply('yes');
    await reply('yes');

    expect(opened).toHaveLength(1);
    // The second confirmation ran as an ordinary turn instead.
    expect(prompts).toHaveLength(2);
  });

  it('means nothing when no release was ever proposed', async () => {
    const { opened, prompts, reply } = room();

    await expect(reply('yes')).resolves.toEqual({ openedCorner: false, producedReply: true });

    expect(opened).toHaveLength(0);
    expect(prompts).toHaveLength(1);
  });

  it('does not open a corner for a "yes" that arrives with new instructions', async () => {
    const { opened, reply } = room();

    await reply("what's unreleased?");
    await expect(reply('yes, but bump the minor not the patch')).resolves.toEqual({
      openedCorner: false,
      producedReply: true,
    });

    expect(opened).toHaveLength(0);
  });

  it('expires, so an unrelated "yes" much later cannot cut a release', async () => {
    const { opened, reply } = room();
    await reply("what's unreleased?");

    const later = Date.now() + RELEASE_PROPOSAL_TTL_MS + 1;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    await expect(reply('yes')).resolves.toEqual({ openedCorner: false, producedReply: true });

    expect(opened).toHaveLength(0);
  });

  it('offers nothing at all when there is nothing unreleased', async () => {
    const { opened, prompts, reply } = room({ unreleased: [] });

    await reply("what's unreleased?");
    expect(prompts[0]).toContain('There is nothing unreleased.');
    expect(prompts[0]).toContain('Do not offer a corner');

    // Nothing was proposed, so agreement has nothing to agree to.
    await expect(reply('yes')).resolves.toEqual({ openedCorner: false, producedReply: true });
    expect(opened).toHaveLength(0);
  });
});
