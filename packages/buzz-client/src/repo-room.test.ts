import { afterEach, describe, expect, it, vi } from 'vitest';
import { signEvent, type NostrEvent } from '@beeline/nostr';
import { createIdentity } from './identity.js';
import {
  KIND_CHANNEL_ADMINS,
  KIND_CHANNEL_MEMBERS,
  KIND_CREATE_GROUP,
  KIND_PUT_USER,
  TAG_COMMUNITY,
} from './kinds.js';
import { tagValue } from './parse.js';
import { repositoryRoomId, resolveRepositoryRoom } from './repo-room.js';
import type { ChannelOpsContext } from './channel.js';
import type { RepositoryBinding } from './types.js';

const binding: RepositoryBinding = {
  key: 'a'.repeat(64),
  name: 'project',
  remote: 'git://example.com/team/project',
  localOnly: false,
};
const communityId = '11111111-1111-4111-8111-111111111111';
const agent = createIdentity('agent');
const human = createIdentity('human');
const mergeWorker = createIdentity('merge-worker');
const http = { baseUrl: 'http://relay.test', host: 'relay.test' };

function ctx(): ChannelOpsContext {
  return { http: { ...http, identity: agent }, identity: agent };
}

function signed(identity: typeof agent, kind: number, tags: string[][]): NostrEvent {
  return signEvent(
    {
      pubkey: identity.publicKey,
      created_at: Math.floor(Date.now() / 1000),
      kind,
      tags,
      content: '',
    },
    identity.secretKey,
  );
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function filterFrom(init?: RequestInit): Record<string, unknown> {
  return (JSON.parse(String(init?.body)) as Record<string, unknown>[])[0] ?? {};
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('repository Room identity', () => {
  it('converges matching repo clones within one Workspace', () => {
    const workspace = '11111111-1111-4111-8111-111111111111';
    expect(repositoryRoomId(workspace, binding)).toBe(repositoryRoomId(workspace, { ...binding }));
    expect(repositoryRoomId(workspace, binding)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('does not converge the same repo across Workspaces', () => {
    expect(repositoryRoomId('11111111-1111-4111-8111-111111111111', binding)).not.toBe(
      repositoryRoomId('22222222-2222-4222-8222-222222222222', binding),
    );
  });

  it('uses current role projections when member and admin mutations share a timestamp', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const channelId = repositoryRoomId(communityId, binding);
    const published: NostrEvent[] = [];
    const roles = new Map<string, 'owner' | 'admin' | 'member'>();
    let roomCreated = false;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/events')) {
          const event = JSON.parse(String(init?.body)) as NostrEvent;
          published.push(event);
          if (event.kind === KIND_CREATE_GROUP && tagValue(event, 'h') === channelId) {
            roomCreated = true;
            roles.set(agent.publicKey, 'owner');
          }
          if (event.kind === KIND_PUT_USER && tagValue(event, 'h') === channelId) {
            roles.set(
              tagValue(event, 'p')!,
              tagValue(event, 'role') as 'owner' | 'admin' | 'member',
            );
          }
          return jsonResponse({ accepted: true });
        }

        const filter = filterFrom(init);
        const kind = (filter.kinds as number[])[0];
        const requestedId =
          (filter['#d'] as string[] | undefined)?.[0] ??
          (filter['#h'] as string[] | undefined)?.[0];
        if (kind === KIND_CREATE_GROUP) return jsonResponse([]);
        if (kind === KIND_CHANNEL_MEMBERS && requestedId === communityId) {
          return jsonResponse([
            signed(human, KIND_CHANNEL_MEMBERS, [
              ['d', communityId],
              ['p', human.publicKey],
              ['p', agent.publicKey],
            ]),
          ]);
        }
        if (kind === KIND_CHANNEL_MEMBERS && requestedId === channelId && roomCreated) {
          return jsonResponse([
            signed(human, KIND_CHANNEL_MEMBERS, [
              ['d', channelId],
              ...[...roles].map(([pubkey, role]) => ['p', pubkey, '', role]),
            ]),
          ]);
        }
        if (kind === KIND_CHANNEL_ADMINS && requestedId === channelId && roomCreated) {
          return jsonResponse([
            signed(human, KIND_CHANNEL_ADMINS, [
              ['d', channelId],
              ...[...roles]
                .filter(([, role]) => role === 'owner' || role === 'admin')
                .map(([pubkey, role]) => ['p', pubkey, role]),
            ]),
          ]);
        }
        if (kind === KIND_PUT_USER) {
          return jsonResponse(published.filter((event) => event.kind === KIND_PUT_USER));
        }
        return jsonResponse([]);
      }),
    );

    await expect(
      resolveRepositoryRoom(ctx(), communityId, binding, human.publicKey, mergeWorker.publicKey),
    ).resolves.toEqual({
      channelId,
      created: true,
      joined: true,
      mergeWorkerProvisioned: true,
    });

    const create = published.find(
      (event) => event.kind === KIND_CREATE_GROUP && tagValue(event, 'h') === channelId,
    );
    expect(create?.tags).toContainEqual([TAG_COMMUNITY, communityId]);

    const humanMutations = published.filter(
      (event) => event.kind === KIND_PUT_USER && tagValue(event, 'p') === human.publicKey,
    );
    expect(humanMutations.map((event) => tagValue(event, 'role'))).toEqual(['member', 'admin']);
    expect(new Set(humanMutations.map((event) => event.created_at))).toEqual(
      new Set([1_700_000_000]),
    );
  });

  it('does not re-assert an existing human admin from a member client', async () => {
    const channelId = repositoryRoomId(communityId, binding);
    const roomCreate = signed(human, KIND_CREATE_GROUP, [
      ['h', channelId],
      ['repo-key', binding.key],
      [TAG_COMMUNITY, communityId],
    ]);
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/events')) {
          published.push(JSON.parse(String(init?.body)) as NostrEvent);
          return jsonResponse({ accepted: true });
        }
        const filter = filterFrom(init);
        const kind = (filter.kinds as number[])[0];
        if (kind === KIND_CREATE_GROUP) return jsonResponse([roomCreate]);
        if (kind === KIND_CHANNEL_ADMINS) {
          return jsonResponse([
            signed(human, KIND_CHANNEL_ADMINS, [
              ['d', channelId],
              ['p', human.publicKey, 'admin'],
            ]),
          ]);
        }
        if (kind === KIND_CHANNEL_MEMBERS) {
          return jsonResponse([
            signed(human, KIND_CHANNEL_MEMBERS, [
              ['d', channelId],
              ['p', human.publicKey, '', 'admin'],
              ['p', agent.publicKey],
            ]),
          ]);
        }
        return jsonResponse([]);
      }),
    );

    await expect(
      resolveRepositoryRoom(ctx(), communityId, binding, human.publicKey),
    ).resolves.toEqual({
      channelId,
      created: false,
      joined: true,
      mergeWorkerProvisioned: false,
    });
    expect(published).toEqual([]);
  });

  it('fails fast when an existing admin is missing and the caller cannot grant it', async () => {
    const channelId = repositoryRoomId(communityId, binding);
    const roomCreate = signed(human, KIND_CREATE_GROUP, [
      ['h', channelId],
      ['repo-key', binding.key],
      [TAG_COMMUNITY, communityId],
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const filter = filterFrom(init);
        const kind = (filter.kinds as number[])[0];
        if (kind === KIND_CREATE_GROUP) return jsonResponse([roomCreate]);
        if (kind === KIND_CHANNEL_ADMINS) return jsonResponse([]);
        if (kind === KIND_CHANNEL_MEMBERS) {
          return jsonResponse([
            signed(human, KIND_CHANNEL_MEMBERS, [
              ['d', channelId],
              ['p', human.publicKey],
              ['p', agent.publicKey],
            ]),
          ]);
        }
        return jsonResponse([]);
      }),
    );

    await expect(
      resolveRepositoryRoom(ctx(), communityId, binding, human.publicKey),
    ).rejects.toThrow('current client is member and cannot grant it');
  });
});
