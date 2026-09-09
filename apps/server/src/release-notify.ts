import { createHash } from 'node:crypto';
import { DEFAULT_WORKSPACE_ID } from '@beeline/api-contract/phone';
import {
  SYSTEM_IDENTITY_HANDLE,
  SYSTEM_IDENTITY_ID,
  SYSTEM_IDENTITY_NAME,
} from '@beeline/api-contract/system-identity';
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

function required(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} is required`);
  return trimmed;
}

/**
 * The captain's template, verbatim in shape. The helper section names ONLY
 * when this person owns a daemon reporting a version other than the release
 * being announced (an owned daemon that has never reported a version is left
 * alone — nothing is asserted about a daemon nobody has ever observed). The
 * app section names ONLY the platform(s) this person's registered devices
 * actually use.
 *
 * The helper command is `npx usebeeline update`, never any `npx beeline ...`
 * spelling: `beeline` is also an UNRELATED package on npm (a router
 * library), so `npx beeline ...` would fetch a stranger's code — keeping our
 * published package name in the instruction is the safe form. #949 made the
 * npx path delegate to the installed bundle when one exists, so this works
 * on an installed host exactly like the on-PATH `beeline` wrapper, and it
 * still reaches hosts that only hold the npm package.
 */
export function composeReleaseNotice(input: {
  readonly version: string;
  readonly changelogUrl: string;
  readonly behind: boolean;
  readonly platforms: ReadonlySet<'android' | 'ios'>;
}): string {
  const sections = [
    `Beeline release ${input.version} is out! New functionalities are in the changelog (${input.changelogUrl}).`,
  ];
  if (input.behind) {
    sections.push(
      'In order to keep your agents current, go to the host machine for your agents, and run "npx usebeeline update"',
    );
  }
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

async function repairSystemIdentity(database: SqlDatabase): Promise<void> {
  await database.query(
    `INSERT INTO identities(id,kind,name,handle,hidden_from_roster)
     VALUES ($1,'human',$2,$3,true) ON CONFLICT(id) DO UPDATE
     SET name=EXCLUDED.name,handle=EXCLUDED.handle,hidden_from_roster=true,updated_at=now()`,
    [SYSTEM_IDENTITY_ID, SYSTEM_IDENTITY_NAME, SYSTEM_IDENTITY_HANDLE],
  );
}

/**
 * Posts one release notice to one person. Idempotent: the message id is
 * derived from (version, personId), so a re-run of the same release version
 * hits the `messages` primary key and inserts nothing twice — no separate
 * dedup table needed. Returns whether this call actually posted (false when
 * this person was already notified for this version).
 */
async function notifyPerson(
  database: SqlDatabase,
  personId: string,
  input: {
    readonly version: string;
    readonly changelogUrl: string;
    readonly behind: boolean;
    readonly platforms: ReadonlySet<'android' | 'ios'>;
  },
): Promise<boolean> {
  const roomId = await ensureSystemDirectMessageRoom(database, DEFAULT_WORKSPACE_ID, personId);
  await database.query(`UPDATE rooms SET visibility='invite-only' WHERE id=$1`, [roomId]);
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
  await repairSystemIdentity(database);
  const behindOwners = new Set(
    (
      await database.query<{ owner_id: string }>(
        `SELECT DISTINCT a.owner_id
         FROM agents a
         JOIN LATERAL (
           SELECT body FROM live_outputs
           WHERE agent_id=a.agent_id AND kind='presence'
           ORDER BY updated_at DESC LIMIT 1
         ) lo ON true
         WHERE (lo.body->>'releaseVersion') IS NOT NULL
           AND (lo.body->>'releaseVersion') <> $1`,
        [version],
      )
    ).rows.map((row) => row.owner_id),
  );

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
      behind: behindOwners.has(person.id),
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

  constructor(
    private readonly database: SqlDatabase,
    options: ReleaseNotifierOptions = {},
  ) {
    this.secret = options.secret;
  }

  notifyReleaseDelivered(input: ReleaseNotifyInput): Promise<ReleaseNotifyResult> {
    return notifyReleaseDelivered(this.database, input);
  }
}
