import { afterEach, describe, expect, it, vi } from 'vitest';
import { signEvent, type NostrEvent } from '@beeline/nostr';
import { newIdentity } from './identity.js';
import { KIND_PUT_USER } from './buzz.js';
import { resolveChannelRole } from './provisioning.js';

const KIND_CHANNEL_ADMINS = 39001;
const KIND_CHANNEL_MEMBERS = 39002;
const channelId = '11111111-1111-4111-8111-111111111111';
const owner = newIdentity('owner');
const member = newIdentity('member');

function signed(kind: number, tags: string[][]): NostrEvent {
  return signEvent(
    {
      pubkey: owner.publicKey,
      created_at: 1_700_000_000,
      kind,
      tags,
      content: '',
    },
    owner.secretKey,
  );
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('resolveChannelRole', () => {
  it('uses current projections when same-second role history conflicts', async () => {
    const history = [
      signed(KIND_PUT_USER, [
        ['h', channelId],
        ['p', member.publicKey],
        ['role', 'member'],
      ]),
      signed(KIND_PUT_USER, [
        ['h', channelId],
        ['p', member.publicKey],
        ['role', 'admin'],
      ]),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const filter = (JSON.parse(String(init?.body)) as Record<string, unknown>[])[0]!;
        const kind = (filter.kinds as number[])[0];
        if (kind === KIND_CHANNEL_ADMINS) {
          return jsonResponse([
            signed(KIND_CHANNEL_ADMINS, [
              ['d', channelId],
              ['p', owner.publicKey, 'owner'],
              ['p', member.publicKey, 'admin'],
            ]),
          ]);
        }
        if (kind === KIND_CHANNEL_MEMBERS) {
          return jsonResponse([
            signed(KIND_CHANNEL_MEMBERS, [
              ['d', channelId],
              ['p', owner.publicKey, '', 'owner'],
              ['p', member.publicKey, '', 'admin'],
            ]),
          ]);
        }
        if (kind === KIND_PUT_USER) return jsonResponse(history);
        return jsonResponse([]);
      }),
    );

    await expect(resolveChannelRole(channelId, member.publicKey, owner.publicKey)).resolves.toBe(
      'admin',
    );
  });

  it('fails closed on conflicting same-second history without projections', async () => {
    const history = [
      signed(KIND_PUT_USER, [
        ['h', channelId],
        ['p', member.publicKey],
        ['role', 'member'],
      ]),
      signed(KIND_PUT_USER, [
        ['h', channelId],
        ['p', member.publicKey],
        ['role', 'admin'],
      ]),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const filter = (JSON.parse(String(init?.body)) as Record<string, unknown>[])[0]!;
        return jsonResponse((filter.kinds as number[])[0] === KIND_PUT_USER ? history : []);
      }),
    );

    await expect(resolveChannelRole(channelId, member.publicKey, owner.publicKey)).resolves.toBe(
      null,
    );
  });
});
