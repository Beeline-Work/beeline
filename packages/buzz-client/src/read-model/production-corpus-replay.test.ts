import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { signEvent, type NostrEvent, type UnsignedEvent } from '@beeline/nostr';
import { describe, expect, it } from 'vitest';
import { createIdentity } from '../identity.js';
import { parseRelayEvents } from './parser.js';
import { createWorkspaceSnapshot, reduceWorkspaceEvents } from './reducer.js';
import { selectTranscript } from './selectors.js';
import type { IdentityRecord, ParseAuthority, Pubkey } from './types.js';
import manifest from './fixtures/captures/manifest.json';

type CapturedEvent = {
  alias: string;
  actor: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  shape: { contentBytes: number; contentWasJson: boolean; tagCount: number };
};
type CapturedCorpus = {
  schemaVersion: 1;
  capture: { eventCount: number; shapeHash: string };
  actors: { alias: string; kind: 'human' | 'agent' }[];
  events: CapturedEvent[];
  expected: { minimumTranscriptItems: number; maximumReplayMs: number };
};

const fixturesRoot = fileURLToPath(new URL('./fixtures/captures/', import.meta.url));

function opaqueHex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function materialize(corpus: CapturedCorpus): {
  events: NostrEvent[];
  authority: ParseAuthority;
  identities: IdentityRecord[];
  roomId: string;
} {
  const roomId = 'captured-charles-scale-room';
  const workspaceId = 'captured-production-workspace';
  const actors = Object.fromEntries(
    corpus.actors.map(({ alias }) => [alias, createIdentity(`production-corpus-${alias}`)]),
  );
  const signedIds = new Map<string, string>();
  const substitute = (value: string): string => {
    if (value === '$room') return roomId;
    if (value === '$workspace') return workspaceId;
    if (actors[value]) return actors[value].publicKey;
    if (signedIds.has(value)) return signedIds.get(value)!;
    if (value.startsWith('$event') || value.startsWith('$externalEvent')) return opaqueHex(value);
    if (value.startsWith('$channel')) return `captured-${value.slice(1)}`;
    if (value.startsWith('$person')) return opaqueHex(value);
    return value;
  };
  const events = corpus.events.map((fixture) => {
    const actor = actors[fixture.actor];
    if (!actor) throw new Error(`capture references unknown actor ${fixture.actor}`);
    const event = signEvent(
      {
        pubkey: actor.publicKey,
        created_at: fixture.created_at,
        kind: fixture.kind,
        tags: fixture.tags.map((tag) => tag.map(substitute)),
        content: fixture.content,
      } satisfies UnsignedEvent,
      actor.secretKey,
    );
    signedIds.set(fixture.alias, event.id);
    return event;
  });
  const identities: IdentityRecord[] = corpus.actors.map(({ alias, kind }, index) => ({
    kind,
    pubkey: actors[alias]!.publicKey as Pubkey,
    displayName: `Captured actor ${index + 1}`,
    revision: 'capture-v1',
  }));
  const pubkeys = identities.map((identity) => identity.pubkey);
  return {
    events,
    identities,
    roomId,
    authority: {
      workspaceId,
      expectedChannelId: roomId,
      identities: Object.fromEntries(identities.map((identity) => [identity.pubkey, identity])),
      channelCreators: { [roomId]: pubkeys[0]! },
      channelAdmins: { [roomId]: pubkeys },
      trustedProjectionPubkeys: pubkeys,
    },
  };
}

describe('PRODUCTION-CORPUS REPLAY gate', () => {
  it.each(manifest.fixtures)('decodes, reduces, and selects %s within its budget', async (name) => {
    const corpus = JSON.parse(await readFile(`${fixturesRoot}${name}`, 'utf8')) as CapturedCorpus;
    expect(corpus.schemaVersion).toBe(1);
    expect(corpus.events).toHaveLength(corpus.capture.eventCount);
    const shapeHash = createHash('sha256')
      .update(
        JSON.stringify(
          corpus.events.map(({ kind, tags, shape }) => ({
            kind,
            tagArities: tags.map((tag) => tag.length),
            tagNames: tags.map((tag) => tag[0]),
            shape,
          })),
        ),
      )
      .digest('hex');
    expect(shapeHash).toBe(corpus.capture.shapeHash);
    const { events, authority, identities, roomId } = materialize(corpus);

    const startedAt = performance.now();
    const decoded = parseRelayEvents(events, authority);
    const snapshot = reduceWorkspaceEvents(
      createWorkspaceSnapshot({ workspaceId: authority.workspaceId, identities }),
      decoded,
    );
    const transcript = selectTranscript(snapshot, roomId);
    const elapsedMs = performance.now() - startedAt;

    expect(decoded).toHaveLength(events.length);
    expect(transcript.length).toBeGreaterThanOrEqual(corpus.expected.minimumTranscriptItems);
    expect(elapsedMs).toBeLessThan(corpus.expected.maximumReplayMs);
  });
});
