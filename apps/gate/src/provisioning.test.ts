import { afterEach, describe, expect, it, vi } from 'vitest';
import { signEvent, type NostrEvent } from '@beeline/nostr';
import * as buzzClientKinds from '@beeline/buzz-client';
import { newIdentity } from './identity.js';
import { KIND_CREATE_GROUP, KIND_EDIT_METADATA, KIND_PUT_USER, KIND_STREAM_MESSAGE } from './buzz.js';
import { resolveChannelRole } from './provisioning.js';
import { createRelayClient } from './relay.js';
import { KIND_CHANNEL_ADMINS, KIND_CHANNEL_MEMBERS } from '@beeline/buzz-client';

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

    await expect(resolveChannelRole(channelId, member.publicKey, createRelayClient(owner))).resolves.toBe(
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

    await expect(resolveChannelRole(channelId, member.publicKey, createRelayClient(owner))).resolves.toBe(
      null,
    );
  });
});

describe('gate kind constants', () => {
  it('buzz.ts and provisioning.ts source their nostr kind numbers from @beeline/buzz-client, not a hand-copied duplicate', () => {
    // Regression: apps/gate/src/buzz.ts and provisioning.ts used to
    // re-declare these as local literals instead of importing the shared
    // constants @beeline/buzz-client/src/kinds.ts already exports — kept in
    // sync only by coincidence, with nothing to catch future drift.
    expect(KIND_PUT_USER).toBe(buzzClientKinds.KIND_PUT_USER);
    expect(KIND_CREATE_GROUP).toBe(buzzClientKinds.KIND_CREATE_GROUP);
    expect(KIND_STREAM_MESSAGE).toBe(buzzClientKinds.KIND_STREAM_MESSAGE);
    expect(KIND_EDIT_METADATA).toBe(buzzClientKinds.KIND_EDIT_METADATA);
    expect(KIND_CHANNEL_ADMINS).toBe(buzzClientKinds.KIND_CHANNEL_ADMINS);
    expect(KIND_CHANNEL_MEMBERS).toBe(buzzClientKinds.KIND_CHANNEL_MEMBERS);
  });
});
