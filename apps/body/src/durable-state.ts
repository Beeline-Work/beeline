import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { NostrEvent } from '@beeline/nostr';
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

export interface ConversationEntry {
  role: 'user' | 'agent' | 'control';
  text: string;
  eventId?: string;
  at: string;
}

interface DurableBodyData {
  version: 1;
  inboxes: Record<string, { cursor: EventCursor; items: Record<string, InboxItem> }>;
  conversations: Record<string, ConversationEntry[]>;
  /** Bounded local audit trail for `beeline spend`; never published to the Room. */
  modelTurns?: ModelTurnSpend[];
  sessionReprimes?: SessionReprimeRecord[];
  /** Per-Room GitHub repository-event feed cursors (auth-service event ids). */
  githubEventCursors?: Record<string, number>;
  /** Quiet-episode conclude-watch state per corner, so a restart mid-episode
   *  neither resets the spent nudge budget nor re-marks a resolved episode. */
  concludeEpisodes?: Record<string, ConcludeEpisode>;
}

function emptyData(): DurableBodyData {
  return {
    version: 1,
    inboxes: {},
    conversations: {},
    modelTurns: [],
    sessionReprimes: [],
    concludeEpisodes: {},
  };
}

const MAX_MODEL_TURNS = 20_000;

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
      if (parsed.version !== 1 || !parsed.inboxes || !parsed.conversations) {
        throw new Error(`unsupported durable body state at ${this.path}`);
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

  async appendConversation(channelId: string, entry: ConversationEntry): Promise<void> {
    await this.load();
    const entries = this.data.conversations[channelId] ?? [];
    if (entry.eventId && entries.some((existing) => existing.eventId === entry.eventId)) return;
    entries.push(entry);
    this.data.conversations[channelId] = entries.slice(-200);
    await this.save();
  }

  async conversation(channelId: string): Promise<ConversationEntry[]> {
    await this.load();
    return [...(this.data.conversations[channelId] ?? [])];
  }

  /** Latest durable agent response for lifecycle surfaces that outlive a process. */
  async latestAgentMessage(channelId: string): Promise<string | undefined> {
    const entries = await this.conversation(channelId);
    return [...entries]
      .reverse()
      .find((entry) => entry.role === 'agent' && entry.text.trim())
      ?.text.trim();
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

  async saveConcludeEpisode(channelId: string, episode: ConcludeEpisode | undefined): Promise<void> {
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
