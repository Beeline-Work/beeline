#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { getPublicKey } from '@beeline/nostr';
import { requestQueryEvents } from '../src/http.js';

type StoredIdentity = { secretKeyHex: string; publicKey: string };
type Runtime = {
  relayBaseUrl: string;
  relayHost?: string;
  agent: StoredIdentity;
  body: StoredIdentity;
};
type RawEvent = {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: unknown;
  content: unknown;
};

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function stableAlias(prefix: string, value: string, aliases: Map<string, string>): string {
  const existing = aliases.get(value);
  if (existing) return existing;
  const alias = `$${prefix}${aliases.size + 1}`;
  aliases.set(value, alias);
  return alias;
}

const SAFE_PROTOCOL_VALUES = new Set([
  'agent-activity',
  'body-control',
  'root',
  'reply',
  'mention',
  'owner',
  'admin',
  'member',
  'open',
  'private',
  'stream',
  'working',
  'waiting',
  'completed',
  'failed',
  'active',
  'archived',
]);

async function main(): Promise<void> {
  const runtimePath = option('runtime');
  const roomId = option('room');
  const output = option('output');
  const summaryOnly = process.argv.includes('--summary');
  if (!runtimePath || !roomId || (!output && !summaryOnly)) {
    throw new Error(
      'usage: capture-relay-history --runtime <runtime.json> --room <id> (--output <fixture.json> | --summary)',
    );
  }
  const runtime = JSON.parse(await readFile(resolve(runtimePath), 'utf8')) as Runtime;
  const stored = runtime.agent;
  const secretKey = Uint8Array.from(Buffer.from(stored.secretKeyHex, 'hex'));
  if (secretKey.length !== 32 || getPublicKey(secretKey) !== stored.publicKey) {
    throw new Error('runtime agent identity is invalid');
  }
  const relayBaseUrl = runtime.relayBaseUrl.replace(/\/$/, '');
  const events = (await requestQueryEvents(
    {
      baseUrl: relayBaseUrl,
      host: runtime.relayHost ?? new URL(relayBaseUrl).host,
      identity: { secretKey, publicKey: stored.publicKey },
    },
    // Kind:9 is the production transcript stream and is Room-scoped by #h.
    // Keeping the filter explicit avoids restricted p-gated protocol kinds
    // while preserving the exact message/tag/burst shapes this gate targets.
    [{ kinds: [9], '#h': [roomId], limit: Number(option('limit') ?? 5_000) }],
    stored.publicKey,
  )) as RawEvent[];
  const sorted = [...events].sort(
    (a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id),
  );
  const kindCounts = Object.fromEntries(
    [...new Set(sorted.map((event) => event.kind))]
      .sort((a, b) => a - b)
      .map((kind) => [String(kind), sorted.filter((event) => event.kind === kind).length]),
  );
  if (summaryOnly) {
    process.stdout.write(`${roomId}\t${sorted.length}\t${JSON.stringify(kindCounts)}\n`);
    return;
  }

  const actors = new Map<string, string>();
  const eventIds = new Map(sorted.map((event, index) => [event.id, `$event${index + 1}`]));
  const channels = new Map<string, string>([[roomId, '$room']]);
  const externalEvents = new Map<string, string>();
  const people = new Map<string, string>();
  const values = new Map<string, string>();
  for (const event of sorted) stableAlias('actor', event.pubkey, actors);
  const agentPubkeys = new Set<string>([runtime.agent.publicKey]);
  for (const event of sorted) {
    if (
      Array.isArray(event.tags) &&
      event.tags.some(
        (tag) =>
          Array.isArray(tag) &&
          tag[0] === 't' &&
          (tag[1] === 'agent-activity' || tag[1] === 'body-control'),
      )
    ) {
      agentPubkeys.add(event.pubkey);
    }
    if (Array.isArray(event.tags)) {
      for (const tag of event.tags) {
        if (Array.isArray(tag) && tag[0] === 'agent' && typeof tag[1] === 'string') {
          agentPubkeys.add(tag[1]);
        }
      }
    }
  }

  const sanitized = sorted.map((event, index) => {
    const tags = Array.isArray(event.tags)
      ? event.tags.map((candidate) => {
          if (!Array.isArray(candidate)) return ['$malformed-tag'];
          return candidate.map((raw, position) => {
            if (position === 0) return typeof raw === 'string' ? raw : '$malformed-name';
            if (typeof raw !== 'string') return `$${typeof raw}`;
            const name = typeof candidate[0] === 'string' ? candidate[0] : '';
            if (name === 'h' || name === 'd' || name === 'parent' || name === 'subchannel') {
              return stableAlias('channel', raw, channels);
            }
            if (name === 'e') {
              return eventIds.get(raw) ?? stableAlias('externalEvent', raw, externalEvents);
            }
            if (name === 'p') {
              return actors.get(raw) ?? stableAlias('person', raw, people);
            }
            if (SAFE_PROTOCOL_VALUES.has(raw) || /^\d{1,10}$/.test(raw)) return raw;
            return stableAlias('value', raw, values);
          });
        })
      : [['$malformed-tags']];
    const content = typeof event.content === 'string' ? event.content : '';
    return {
      alias: eventIds.get(event.id),
      actor: actors.get(event.pubkey),
      created_at: index + 1,
      kind: event.kind,
      tags,
      content: event.kind === 9 ? `Captured production message ${index + 1}` : '',
      shape: {
        contentBytes: Buffer.byteLength(content),
        contentWasJson: (() => {
          try {
            JSON.parse(content);
            return true;
          } catch {
            return false;
          }
        })(),
        tagCount: Array.isArray(event.tags) ? event.tags.length : 0,
      },
    };
  });
  const shapeHash = createHash('sha256')
    .update(
      JSON.stringify(
        sanitized.map(({ kind, tags, shape }) => ({
          kind,
          tagArities: tags.map((tag) => tag.length),
          tagNames: tags.map((tag) => tag[0]),
          shape,
        })),
      ),
    )
    .digest('hex');
  const fixture = {
    schemaVersion: 1,
    capture: {
      source: 'production-read-only-query',
      relay: new URL(relayBaseUrl).host,
      capturedAt: new Date().toISOString().slice(0, 10),
      eventCount: sanitized.length,
      shapeHash,
      sanitization:
        'All stable ids, pubkeys, free-form tag values, timestamps, and content were replaced before commit.',
    },
    roomId: '$room',
    workspaceId: '$workspace',
    actors: [...actors.entries()].map(([pubkey, alias]) => ({
      alias,
      kind: agentPubkeys.has(pubkey) ? 'agent' : 'human',
    })),
    events: sanitized,
    expected: {
      minimumTranscriptItems: 1,
      maximumReplayMs: Number(option('budget-ms') ?? 20_000),
    },
  };
  await mkdir(dirname(resolve(output!)), { recursive: true });
  await writeFile(resolve(output!), `${JSON.stringify(fixture, null, 2)}\n`);
  process.stdout.write(`captured ${sanitized.length} sanitized events to ${resolve(output!)}\n`);
}

await main();
