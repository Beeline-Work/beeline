import { createHash } from 'node:crypto';
import { DEFAULT_WORKSPACE_ID } from '@beeline/api-contract/phone';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import type { SqlDatabase } from './database.js';
import { ensureSystemDirectMessageRoom } from './system-line.js';

export { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';

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

/**
 * App-store action remains in the release DM. Helpers update automatically
 * over their live server connection, so a behind helper is never manual work.
 */
export function composeReleaseNotice(input: {
  readonly version: string;
  readonly changelogUrl: string;
  readonly platforms: ReadonlySet<'android' | 'ios'>;
}): string {
  const sections = [
    `Beeline release ${input.version} is out! New functionalities are in the changelog (${input.changelogUrl}).`,
  ];
  if (input.platforms.has('android')) {
    sections.push('Android: open the Google Play Store, find Beeline, and tap Update.');
  }
  if (input.platforms.has('ios')) {
    sections.push(
      'iOS: open the App Store (or TestFlight if you installed the beta), find Beeline, and tap Update.',
    );
  }
  return sections.join('\n\n');
}

/**
 * Where a person's release notice lands: the `@system` DM in the Workspace
 * they joined first, never the retired shared Welcome Workspace while they
 * belong to any other (the retirement deletes it and every DM in it). A
 * person with no Workspace has no deck to read a DM on, so they get none.
 */
async function releaseNoticeWorkspaceId(
  database: SqlDatabase,
  personId: string,
): Promise<string | null> {
  const result = await database.query<{ workspace_id: string }>(
    `SELECT workspace_id FROM memberships
     WHERE identity_id=$1 AND room_id IS NULL AND removed_at IS NULL
     ORDER BY (workspace_id=$2::uuid),joined_at,workspace_id LIMIT 1`,
    [personId, DEFAULT_WORKSPACE_ID],
  );
  return result.rows[0]?.workspace_id ?? null;
}

/**
 * Posts one release notice to one person. Idempotent: the message id is
 * derived from (version, personId), so a re-run of the same release version
 * hits the `messages` primary key and inserts nothing twice — no separate
 * dedup table needed. Returns whether this call actually posted (false when
 * this person was already notified for this version, or belongs to no
 * Workspace).
 */
async function notifyPerson(
  database: SqlDatabase,
  personId: string,
  input: {
    readonly version: string;
    readonly changelogUrl: string;
    readonly platforms: ReadonlySet<'android' | 'ios'>;
  },
): Promise<boolean> {
  const workspaceId = await releaseNoticeWorkspaceId(database, personId);
  if (!workspaceId) return false;
  const roomId = await ensureSystemDirectMessageRoom(database, workspaceId, personId);
  const id = createHash('sha256')
    .update(`beeline-release-notice:v1:${input.version}:${personId}`)
    .digest('hex');
  const text = composeReleaseNotice(input);
  const inserted = await database.query(
    `INSERT INTO messages(id,room_id,author_id,text) VALUES ($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING`,
    [id, roomId, SYSTEM_IDENTITY_ID, text],
  );
  return Boolean(inserted.rowCount);
}

/**
 * Called once per successful release delivery. Posts one `@system` DM per
 * person (every non-hidden human identity), dedup'd on (version, identity).
 * Never touches a shared Room — the whole point of `@system` is that upgrade
 * chatter is DM-only.
 */
export async function notifyReleaseDelivered(
  database: SqlDatabase,
  input: ReleaseNotifyInput,
): Promise<ReleaseNotifyResult> {
  const version = required(input.version, 'version');
  const changelogUrl = required(input.changelogUrl, 'changelogUrl');
  required(input.sha, 'sha');
  const platformsByIdentity = new Map<string, Set<'android' | 'ios'>>();
  for (const row of (
    await database.query<{ identity_id: string; platform: 'android' | 'ios' }>(
      `SELECT DISTINCT identity_id,platform FROM push_devices`,
    )
  ).rows) {
    const platforms = platformsByIdentity.get(row.identity_id) ?? new Set<'android' | 'ios'>();
    platforms.add(row.platform);
    platformsByIdentity.set(row.identity_id, platforms);
  }

  const people = await database.query<{ id: string }>(
    `SELECT id FROM identities WHERE kind='human' AND hidden_from_roster=false`,
  );

  let notified = 0;
  let skipped = 0;
  for (const person of people.rows) {
    const posted = await notifyPerson(database, person.id, {
      version,
      changelogUrl,
      platforms: platformsByIdentity.get(person.id) ?? new Set(),
    });
    if (posted) notified += 1;
    else skipped += 1;
  }
  return { notified, skipped };
}

export interface ReleaseNotifierOptions {
  /** Absent = the notify endpoint refuses like any wrong secret. */
  readonly secret?: string;
}

/**
 * Thin wrapper so `index.ts` wires this exactly like `ReviewAccess`: a
 * shared secret gates the HTTP endpoint (`server.ts`), and everything else
 * is the pure function above.
 */
export class ReleaseNotifier {
  readonly secret: string | undefined;
  private readonly listeners = new Set<(release: HelperRelease) => void>();
  private pollTimer: NodeJS.Timeout | undefined;
  private lastSeenRelease: string | undefined;
  private lastRelease: HelperRelease | undefined;

  constructor(
    private readonly database: SqlDatabase,
    options: ReleaseNotifierOptions = {},
  ) {
    this.secret = options.secret;
  }

  async notifyReleaseDelivered(input: ReleaseNotifyInput): Promise<ReleaseNotifyResult> {
    // The helper wake must not wait behind a potentially long per-person DM
    // fanout; the pipeline's notify HTTP budget is shorter than that fanout.
    required(input.changelogUrl, 'changelogUrl');
    await recordHelperRelease(this.database, {
      version: required(input.version, 'version'),
      sha: required(input.sha, 'sha'),
    });
    await this.poll();
    return notifyReleaseDelivered(this.database, input);
  }

  /** One database read per server process, including servers other than the notify recipient. */
  subscribeHelperRelease(listener: (release: HelperRelease) => void): () => void {
    this.listeners.add(listener);
    if (this.lastRelease) {
      try {
        listener(this.lastRelease);
      } catch (error) {
        console.error('[release] helper socket send failed', error);
      }
    }
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => void this.poll().catch(console.error), 15_000);
      this.pollTimer.unref?.();
    }
    void this.poll().catch(console.error);
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size && this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = undefined;
      }
    };
  }

  private async poll(): Promise<void> {
    const release = await latestHelperRelease(this.database);
    if (!release || `${release.version}:${release.sha}` === this.lastSeenRelease) return;
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
