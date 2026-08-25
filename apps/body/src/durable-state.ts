import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { NostrEvent } from '@beeline/nostr';
import {
  guardReadModelBoot,
  selectAgentHistory,
  type WorkspaceSnapshot,
} from '@beeline/buzz-client';
import type { ModelTurnSpend, SessionReprimeRecord } from './model-spend.js';
import type { ConcludeEpisode } from './conclude-watch.js';

export interface EventCursor {
  createdAt: number;
  eventId: string;
}

interface InboxItem {
  event: NostrEvent;
  state: 'pending' | 'delivered';
  attempts: number;
  lastError?: string;
  /** A completed response is persisted before publication so retries reuse its relay id. */
  reply?: NostrEvent;
}

interface DurableBodyData {
  version: 2;
  inboxes: Record<string, { cursor: EventCursor; items: Record<string, InboxItem> }>;
  /** Relay-verified normalized read models. Presentation prose is never persisted. */
  readModels: Record<string, WorkspaceSnapshot>;
  /** Bounded local audit trail for `beeline spend`; never published to the Room. */
  modelTurns?: ModelTurnSpend[];
  sessionReprimes?: SessionReprimeRecord[];
  /** Per-Room GitHub repository-event feed cursors (auth-service event ids). */
  githubEventCursors?: Record<string, number>;
  /** Quiet-episode conclude-watch state per corner, so a restart mid-episode
   *  neither resets the spent nudge budget nor re-marks a resolved episode. */
  concludeEpisodes?: Record<string, ConcludeEpisode>;
  /** Versioned P1 trust-spine reservations. Keys are immutable signed ids. */
  factory?: {
    version: 1;
    inboundDelegationClaims: string[];
    outboundDelegations: Record<string, NostrEvent>;
    permissionActionClaims: string[];
  };
}

function emptyData(): DurableBodyData {
  return {
    version: 2,
    inboxes: {},
    readModels: {},
    modelTurns: [],
    sessionReprimes: [],
    concludeEpisodes: {},
  };
}

const MAX_MODEL_TURNS = 20_000;
const MAX_FACTORY_CLAIMS = 20_000;

function compareEvents(a: NostrEvent, b: NostrEvent): number {
  return a.created_at - b.created_at || a.id.localeCompare(b.id);
}

/** Atomic JSON state for relay inboxes and ACP context rehydration. */
export class DurableBodyState {
  private readonly path: string;
  private data: DurableBodyData = emptyData();
  private loaded = false;
  private saveTail: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as DurableBodyData;
      if (parsed.version !== 2 || !parsed.inboxes || !parsed.readModels) {
        throw new Error(`unsupported durable body state at ${this.path}`);
      }
      for (const [channelId, candidate] of Object.entries(parsed.readModels)) {
        const guarded = guardReadModelBoot(candidate);
        if (guarded.status === 'integrity-halt') {
          throw new Error(
            `read-model integrity halt for ${channelId} at ${this.path}: ${guarded.diagnostic}`,
          );
        }
      }
      this.data = parsed;
      this.data.modelTurns ??= [];
      this.data.sessionReprimes ??= [];
      this.data.githubEventCursors ??= {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.loaded = true;
  }

  async enqueue(channelId: string, events: NostrEvent[]): Promise<number> {
    await this.load();
    const inbox = this.inbox(channelId);
    let added = 0;
    for (const event of events) {
      if (inbox.items[event.id]) continue;
      inbox.items[event.id] = { event, state: 'pending', attempts: 0 };
      added++;
    }
    if (added) await this.save();
    return added;
  }

  async pending(channelId: string): Promise<NostrEvent[]> {
    await this.load();
    return Object.values(this.inbox(channelId).items)
      .filter((item) => item.state === 'pending')
      .map((item) => item.event)
      .sort(compareEvents);
  }

  async delivered(channelId: string, eventId: string): Promise<void> {
    await this.load();
    const inbox = this.inbox(channelId);
    const item = inbox.items[eventId];
    if (!item) return;
    item.state = 'delivered';
    delete item.lastError;
    const cursor = { createdAt: item.event.created_at, eventId: item.event.id };
    if (
      cursor.createdAt > inbox.cursor.createdAt ||
      (cursor.createdAt === inbox.cursor.createdAt && cursor.eventId > inbox.cursor.eventId)
    ) {
      inbox.cursor = cursor;
    }
    await this.save();
  }

  async reply(channelId: string, eventId: string): Promise<NostrEvent | undefined> {
    await this.load();
    return this.inbox(channelId).items[eventId]?.reply;
  }

  async reserveReply(channelId: string, eventId: string, reply: NostrEvent): Promise<NostrEvent> {
    await this.load();
    const item = this.inbox(channelId).items[eventId];
    // Direct Body library callers can publish a one-off reply without first
    // entering the polling inbox. The polling path always has an item and is
    // therefore durably idempotent; keep this diagnostic/library path usable.
    if (!item) return reply;
    if (item.reply) return item.reply;
    item.reply = reply;
    await this.save();
    return reply;
  }

  /** Returns the item's total attempt count after recording this failure. */
  async failed(channelId: string, eventId: string, error: unknown): Promise<number> {
    await this.load();
    const item = this.inbox(channelId).items[eventId];
    if (!item) return 0;
    item.attempts++;
    item.lastError = String(error).slice(0, 1_000);
    await this.save();
    return item.attempts;
  }

  async cursor(channelId: string): Promise<EventCursor> {
    await this.load();
    return { ...this.inbox(channelId).cursor };
  }

  async replaceReadModel(channelId: string, snapshot: WorkspaceSnapshot): Promise<void> {
    await this.load();
    const guarded = guardReadModelBoot(snapshot);
    if (guarded.status === 'integrity-halt') {
      throw new Error(
        `refusing corrupt read-model snapshot for ${channelId}: ${guarded.diagnostic}`,
      );
    }
    this.data.readModels[channelId] = guarded.snapshot;
    await this.save();
  }

  async readModel(channelId: string): Promise<WorkspaceSnapshot | undefined> {
    await this.load();
    return this.data.readModels[channelId];
  }

  /** Latest durable agent response for lifecycle surfaces that outlive a process. */
  async latestAgentMessage(channelId: string): Promise<string | undefined> {
    const snapshot = await this.readModel(channelId);
    return snapshot
      ? [...selectAgentHistory(snapshot, channelId)]
          .reverse()
          .find((entry) => entry.type === 'agent-message' && entry.body.trim())
          ?.body.trim()
      : undefined;
  }

  /** Persist one inspectable model invocation, including the human event that authorized it. */
  async recordModelTurn(turn: ModelTurnSpend): Promise<void> {
    await this.load();
    const turns = this.data.modelTurns ?? [];
    turns.push(turn);
    this.data.modelTurns = turns.slice(-MAX_MODEL_TURNS);
    await this.save();
  }

  async modelTurns(): Promise<ModelTurnSpend[]> {
    await this.load();
    return [...(this.data.modelTurns ?? [])];
  }

  /** Atomic durable inbox linearization for concurrent WS/HTTP delegation delivery. */
  async claimDelegationInbound(eventId: string): Promise<'claimed' | 'duplicate'> {
    await this.load();
    const factory = this.factory();
    if (factory.inboundDelegationClaims.includes(eventId)) return 'duplicate';
    factory.inboundDelegationClaims.push(eventId);
    factory.inboundDelegationClaims = factory.inboundDelegationClaims.slice(-MAX_FACTORY_CLAIMS);
    await this.save();
    return 'claimed';
  }

  /** Reserve the exact signed event before relay publication. */
  async reserveDelegationOutbound(event: NostrEvent): Promise<'claimed' | 'duplicate'> {
    await this.load();
    const factory = this.factory();
    if (factory.outboundDelegations[event.id]) return 'duplicate';
    factory.outboundDelegations[event.id] = event;
    const ids = Object.keys(factory.outboundDelegations);
    for (const stale of ids.slice(0, Math.max(0, ids.length - MAX_FACTORY_CLAIMS))) {
      delete factory.outboundDelegations[stale];
    }
    await this.save();
    return 'claimed';
  }

  async claimPermissionAction(key: string): Promise<'claimed' | 'duplicate'> {
    await this.load();
    const factory = this.factory();
    if (factory.permissionActionClaims.includes(key)) return 'duplicate';
    factory.permissionActionClaims.push(key);
    factory.permissionActionClaims = factory.permissionActionClaims.slice(-MAX_FACTORY_CLAIMS);
    await this.save();
    return 'claimed';
  }

  async recordSessionReprime(record: SessionReprimeRecord): Promise<void> {
    await this.load();
    const records = this.data.sessionReprimes ?? [];
    records.push(record);
    this.data.sessionReprimes = records.slice(-MAX_MODEL_TURNS);
    await this.save();
  }

  async sessionReprimes(): Promise<SessionReprimeRecord[]> {
    await this.load();
    return [...(this.data.sessionReprimes ?? [])];
  }

  /** The GitHub repository-event feed cursor for a Room; `undefined` = never bootstrapped. */
  async githubEventCursor(channelId: string): Promise<number | undefined> {
    await this.load();
    return this.data.githubEventCursors?.[channelId];
  }

  async saveGitHubEventCursor(channelId: string, id: number): Promise<void> {
    await this.load();
    this.data.githubEventCursors ??= {};
    this.data.githubEventCursors[channelId] = id;
    await this.save();
  }

  /** The quiet-episode conclude-watch state for a corner; `undefined` = no quiet episode. */
  async concludeEpisode(channelId: string): Promise<ConcludeEpisode | undefined> {
    await this.load();
    return this.data.concludeEpisodes?.[channelId];
  }

  async saveConcludeEpisode(
    channelId: string,
    episode: ConcludeEpisode | undefined,
  ): Promise<void> {
    await this.load();
    if (episode === undefined) {
      delete this.data.concludeEpisodes?.[channelId];
    } else {
      this.data.concludeEpisodes ??= {};
      this.data.concludeEpisodes[channelId] = episode;
    }
    await this.save();
  }

  private inbox(channelId: string): DurableBodyData['inboxes'][string] {
    return (this.data.inboxes[channelId] ??= {
      cursor: { createdAt: 0, eventId: '' },
      items: {},
    });
  }

  private factory(): NonNullable<DurableBodyData['factory']> {
    return (this.data.factory ??= {
      version: 1,
      inboundDelegationClaims: [],
      outboundDelegations: {},
      permissionActionClaims: [],
    });
  }

  private save(): Promise<void> {
    this.saveTail = this.saveTail.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = resolve(dirname(this.path), `body-state-${process.pid}.tmp`);
      await writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.path);
    });
    return this.saveTail;
  }
}
