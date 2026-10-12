import type { SqlDatabase } from './database.js';
import type { LiveHub } from './live.js';

export interface ReleaseNotifyInput {
  readonly version: string;
  readonly sha: string;
  readonly changelogUrl: string;
}

export interface ReleaseNotifyResult {
  readonly notified: number;
  readonly skipped: number;
}

export interface HelperRelease {
  readonly version: string;
  readonly sha: string;
}

/** The release endpoint writes this only after publishing the helper bundle. */
async function recordHelperRelease(database: SqlDatabase, release: HelperRelease): Promise<void> {
  await database.query(
    `INSERT INTO helper_release_notifications(singleton,version,sha) VALUES(true,$1,$2)
     ON CONFLICT(singleton) DO UPDATE SET version=EXCLUDED.version,sha=EXCLUDED.sha,announced_at=now()`,
    [release.version, release.sha],
  );
}

async function latestHelperRelease(database: SqlDatabase): Promise<HelperRelease | undefined> {
  return (await database.query<HelperRelease>(
    `SELECT version,sha FROM helper_release_notifications WHERE singleton=true`,
  )).rows[0];
}

function required(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} is required`);
  return trimmed;
}

export interface ReleaseNotifierOptions {
  /** Absent = the notify endpoint refuses like any wrong secret. */
  readonly secret?: string;
  readonly live?: LiveHub;
}

/**
 * Thin wrapper so `index.ts` wires this exactly like `ReviewAccess`: a
 * shared secret gates the HTTP endpoint (`server.ts`).
 */
export class ReleaseNotifier {
  readonly secret: string | undefined;
  private readonly listeners = new Set<(release: HelperRelease) => void>();
  private readInFlight?: Promise<void>;
  private initialized = false;
  private lastSeenRelease: string | undefined;
  private lastRelease: HelperRelease | undefined;

  constructor(
    private readonly database: SqlDatabase,
    options: ReleaseNotifierOptions = {},
  ) {
    this.secret = options.secret;
    options.live?.subscribeAll((event) => {
      if (event.type === 'helper-release') this.accept(event);
    });
    options.live?.subscribeResync(() => this.readOnce(true));
  }

  async notifyReleaseDelivered(input: ReleaseNotifyInput): Promise<ReleaseNotifyResult> {
    // Release delivery wakes helpers only; it produces no user-facing messages.
    required(input.changelogUrl, 'changelogUrl');
    await recordHelperRelease(this.database, {
      version: required(input.version, 'version'),
      sha: required(input.sha, 'sha'),
    });
    this.accept({ version: input.version.trim(), sha: input.sha.trim() });
    return { notified: 0, skipped: 0 };
  }

  /** One initial read per process; commit notifications and reconnects carry later changes. */
  subscribeHelperRelease(listener: (release: HelperRelease) => void): () => void {
    this.listeners.add(listener);
    if (this.lastRelease) {
      try {
        listener(this.lastRelease);
      } catch (error) {
        console.error('[release] helper socket send failed', error);
      }
    }
    this.readOnce(false);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private readOnce(force: boolean): void {
    if (this.readInFlight || (!force && this.initialized)) return;
    this.readInFlight = this.reconcile().then(() => {
      this.initialized = true;
    }).catch((error) => console.error('[release] reconcile failed', error)).finally(() => {
      this.readInFlight = undefined;
    });
  }

  private async reconcile(): Promise<void> {
    const seenBeforeRead = this.lastSeenRelease;
    const release = await latestHelperRelease(this.database);
    // A commit may reach LISTEN while this covering read is in flight.
    if (release && this.lastSeenRelease === seenBeforeRead) this.accept(release);
  }

  private accept(release: HelperRelease): void {
    if (`${release.version}:${release.sha}` === this.lastSeenRelease) return;
    this.lastSeenRelease = `${release.version}:${release.sha}`;
    this.lastRelease = release;
    for (const listener of this.listeners) {
      try {
        listener(release);
      } catch (error) {
        console.error('[release] helper socket send failed', error);
      }
    }
  }
}
