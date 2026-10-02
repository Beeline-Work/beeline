/**
 * Host-shared registry of open Squire browser sessions and staged-order locks.
 *
 * One host runs one Trusty Squire broker (one Chrome profile) but one Beeline
 * daemon per agent, so a browser session opened by agent A is invisible to
 * agent B's relay even though it holds the shared browser. That is the
 * deadlock behind the daily-sweep feedback: a session left by another agent or
 * by a cancelled turn blocks `operate_start` and proxy changes, and no tool
 * listed or closed it.
 *
 * The registry is the one place every daemon can see every open session. It is
 * deliberately a plain directory of small JSON files under the shared Squire
 * host directory (already writable by the daemon and readable from the agent
 * sandbox, which `--ro-bind / /` makes the whole host readable), not a
 * database:
 *
 *   * one file per session means concurrent writers never rewrite each
 *     other's records, so no cross-process file lock is needed for the list;
 *   * every write is tmp-file + rename, so a reader never sees a partial
 *     record;
 *   * a record whose owning pid is gone is stale on read, which is what makes
 *     a crashed daemon's session visible instead of immortal.
 *
 * Staged orders take a lock in the same directory. The lock is a directory
 * created with `mkdir` (atomic on every POSIX filesystem) holding an owner
 * marker, the same ownership-safe pattern `grant-runner.ts` uses for
 * `secrets.json.lock`: acquisition is the mkdir, release is `rm` of the
 * directory, and a holder whose pid is gone (or whose TTL expired) can be
 * taken over. Two agents staging the same order therefore cannot both reach a
 * live card-release link.
 *
 * Every operation is synchronous on purpose: records are a few hundred bytes,
 * and the relay's turn-boundary liveness updates must land before the next
 * HTTP call is served, which a fire-and-forget async write cannot promise.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** A session whose turn ended is reaped after this long if nobody continues it. */
export const SQUIRE_SESSION_STALE_MS = 5 * 60_000;
/** A staged-order lock a holder never resolves expires so it cannot wedge forever. */
export const SQUIRE_ORDER_LOCK_TTL_MS = 30 * 60_000;
const SESSIONS_DIRNAME = 'sessions';
const ORDERS_DIRNAME = 'orders';
const ORDER_OWNER_FILENAME = 'owner.json';

export type SquireSessionRecord = {
  /** Squire's own browser session id (the handle `operate_finish` takes). */
  sessionId: string;
  /** The agent that opened it. */
  ownerAgentId: string;
  /** The human that paired that agent (`runtime.pairedBy`), when known. */
  ownerId: string | null;
  /** The Room/DM/corner whose turn opened it. */
  conversationId: string;
  relayId: string;
  pid: number;
  startedAt: number;
  /** True while a turn on the owning relay holds the session. */
  turnLive: boolean;
  /** True while a human card approval is outstanding for it. */
  approvalPending: boolean;
  updatedAt: number;
  /** The owning relay's loopback endpoint, so a same-owner agent can close it. */
  closeUrl: string;
  closeToken: string;
};

/** What `listSquireSessions` reports: the record plus the derived liveness. */
export type SquireSessionView = Omit<SquireSessionRecord, 'closeToken'> & {
  /** A record whose owning process is gone can never be closed from outside. */
  ownerAlive: boolean;
  /** The turn is live only if the owning process is still there to hold it. */
  turnLive: boolean;
  /** Stale = no live turn and no pending approval, i.e. safe to reap or close. */
  stale: boolean;
};

export type SquireOrderLockRecord = {
  /** Normalized order identity (merchant + amount + currency). */
  orderKey: string;
  /** Human-readable order summary for the refusal message. */
  label: string;
  holderAgentId: string;
  holderOwnerId: string | null;
  conversationId: string;
  relayId: string;
  pid: number;
  acquiredAt: number;
  /** True while the holder still has an unresolved card-release approval. */
  approvalPending: boolean;
};

export function squireRegistryDir(home: string): string {
  return join(home, '.trusty-squire', 'beeline-sessions');
}

function sessionsDir(dir: string): string {
  return join(dir, SESSIONS_DIRNAME);
}

function ordersDir(dir: string): string {
  return join(dir, ORDERS_DIRNAME);
}

/** A session id never becomes a path component: only its digest does. */
function sessionFile(dir: string, sessionId: string): string {
  return join(sessionsDir(dir), `${createHash('sha256').update(sessionId).digest('hex')}.json`);
}

function orderDir(dir: string, orderKey: string): string {
  return join(ordersDir(dir), createHash('sha256').update(orderKey).digest('hex'));
}

/** Is that pid still a live process? EPERM means alive but not ours. */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function normalizedText(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : '';
}

function wholeAmount(value: unknown): number | undefined {
  const amount = typeof value === 'string' ? Number(value) : value;
  return typeof amount === 'number' && Number.isSafeInteger(amount) && amount > 0 ? amount : undefined;
}

/**
 * The identity of an order a card release would pay for: merchant, amount and
 * currency. The item text is deliberately NOT part of the key — two agents
 * describing the same checkout line differently would slip past the lock, and
 * the thing being prevented is a double purchase of the same money at the same
 * merchant. The item is kept only for the refusal message.
 */
export function squireOrderIdentity(
  tool: string,
  args: Record<string, unknown>,
): { orderKey: string; label: string } | undefined {
  if (tool !== 'inject_card' && tool !== 'operate_drive') return undefined;
  const nested = args.facts && typeof args.facts === 'object' && !Array.isArray(args.facts)
    ? (args.facts as Record<string, unknown>)
    : undefined;
  const facts = nested ?? args;
  // A card release only ever happens through inject_card or an operate_drive
  // that carries a card_ref; anything else is browsing, not staging.
  if (tool === 'operate_drive' && !normalizedText(facts.card_ref)) return undefined;
  const merchant = normalizedText(facts.merchant);
  const amount = wholeAmount(facts.amount_cents);
  const currency = normalizedText(facts.currency).toUpperCase();
  if (!merchant || amount === undefined || !currency) return undefined;
  const item = normalizedText(facts.item);
  return {
    orderKey: `${merchant}|${amount}|${currency}`,
    label: [item || 'order', merchant, `${amount} ${currency}`].join(' · '),
  };
}

/**
 * The registry itself. Instances are cheap and stateless beyond the directory,
 * so a daemon may hold one per relay (or one shared) and they all agree.
 */
export class SquireSessionRegistry {
  constructor(readonly dir: string) {}

  private markUpdated(sessionId: string, patch: Partial<SquireSessionRecord>): void {
    const path = sessionFile(this.dir, sessionId);
    const existing = readJson<SquireSessionRecord>(path);
    if (!existing) return;
    writeJsonAtomic(path, { ...existing, ...patch, updatedAt: Date.now() });
  }

  registerSession(record: SquireSessionRecord): void {
    writeJsonAtomic(sessionFile(this.dir, record.sessionId), record);
  }

  setSessionLive(sessionId: string, turnLive: boolean, approvalPending: boolean): void {
    this.markUpdated(sessionId, { turnLive, approvalPending });
  }

  removeSession(sessionId: string): void {
    rmSync(sessionFile(this.dir, sessionId), { force: true });
  }

  /** A relay dropping its connection drops every session it was holding. */
  removeRelaySessions(relayId: string): void {
    for (const record of this.rawSessions()) {
      if (record.relayId === relayId) this.removeSession(record.sessionId);
    }
  }

  private rawSessions(): SquireSessionRecord[] {
    let entries: string[];
    try {
      entries = readdirSync(sessionsDir(this.dir));
    } catch {
      return [];
    }
    const records: SquireSessionRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const record = readJson<SquireSessionRecord>(join(sessionsDir(this.dir), entry));
      if (record && typeof record.sessionId === 'string' && record.sessionId) records.push(record);
    }
    return records;
  }

  /**
   * Every open session on the host, newest first, with liveness derived from
   * the owning process rather than trusted from the record: a crashed daemon's
   * record says `turnLive: true` forever, and reporting that would be a lie.
   */
  listSessions(): SquireSessionView[] {
    return this.rawSessions()
      .map((record) => {
        const { closeToken: _token, ...rest } = record;
        const ownerAlive = processAlive(record.pid);
        const turnLive = record.turnLive && ownerAlive;
        return { ...rest, ownerAlive, turnLive, stale: !turnLive && !record.approvalPending };
      })
      .sort((left, right) => right.startedAt - left.startedAt);
  }

  findSession(sessionId: string): SquireSessionRecord | undefined {
    return readJson<SquireSessionRecord>(sessionFile(this.dir, sessionId));
  }

  /**
   * Take the lock for one staged order. `mkdir` is the acquire fence; an
   * existing marker is either a live holder (refused, named in the result) or
   * a dead/expired one, which is taken over after its own directory is
   * removed. A relay always re-takes its own lock idempotently.
   */
  acquireOrderLock(
    record: SquireOrderLockRecord,
  ): { acquired: true } | { acquired: false; heldBy: SquireOrderLockRecord } {
    const dir = orderDir(this.dir, record.orderKey);
    const marker = join(dir, ORDER_OWNER_FILENAME);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        mkdirSync(ordersDir(this.dir), { recursive: true, mode: 0o700 });
        mkdirSync(dir, { mode: 0o700 });
        writeJsonAtomic(marker, record);
        return { acquired: true };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const held = readJson<SquireOrderLockRecord>(marker);
      if (!held) {
        // A crash between mkdir and the marker write leaves an empty lock
        // directory; only its absence of a marker is the evidence.
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
      if (held.relayId === record.relayId) return { acquired: true };
      const expired = Date.now() - held.acquiredAt > SQUIRE_ORDER_LOCK_TTL_MS;
      if (processAlive(held.pid) && !expired) return { acquired: false, heldBy: held };
      rmSync(dir, { recursive: true, force: true });
    }
    const held = readJson<SquireOrderLockRecord>(marker);
    return held ? { acquired: false, heldBy: held } : { acquired: true };
  }

  setOrderLockApprovalPending(orderKey: string, approvalPending: boolean): void {
    const marker = join(orderDir(this.dir, orderKey), ORDER_OWNER_FILENAME);
    const held = readJson<SquireOrderLockRecord>(marker);
    if (!held) return;
    writeJsonAtomic(marker, { ...held, approvalPending });
  }

  releaseOrderLock(orderKey: string, relayId: string): void {
    const dir = orderDir(this.dir, orderKey);
    const held = readJson<SquireOrderLockRecord>(join(dir, ORDER_OWNER_FILENAME));
    if (held && held.relayId !== relayId) return;
    rmSync(dir, { recursive: true, force: true });
  }

  removeRelayOrderLocks(relayId: string): void {
    for (const held of this.listOrderLocks()) {
      if (held.relayId === relayId) this.releaseOrderLock(held.orderKey, relayId);
    }
  }

  listOrderLocks(): SquireOrderLockRecord[] {
    let entries: string[];
    try {
      entries = readdirSync(ordersDir(this.dir));
    } catch {
      return [];
    }
    const locks: SquireOrderLockRecord[] = [];
    for (const entry of entries) {
      const held = readJson<SquireOrderLockRecord>(
        join(ordersDir(this.dir), entry, ORDER_OWNER_FILENAME),
      );
      if (held && typeof held.orderKey === 'string') locks.push(held);
    }
    return locks;
  }
}
