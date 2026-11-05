import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';

import { claimAgentCommand, createAgentCommand } from './agent-command.js';

import { DAEMON_OPERATION_NAMES, DaemonService } from './daemon-service.js';

import { feedbackConfigFromEnv, type FeedbackConfig, type FeedbackPullRequests } from './feedback.js';

import { FEEDBACK_TRIAGE_PULL_SQL } from './feedback-triage-workflow.js';

import { groupFeedback } from '../../../scripts/feedback-signals.mjs';

import { LiveHub } from './live.js';

import { hasSystemReportMention, taggedIdentityIdsSql } from './message-mentions.js';

import { PhoneService } from './phone-service.js';

import { PgliteDatabase, migratedDatabase, insertCornerFacts } from './test-support.js';

import { ensureSystemIdentity } from './system-line.js';


export const PERSON = 'a'.repeat(64);

export const OTHER = 'b'.repeat(64);

export const AGENT = 'c'.repeat(64);

export const TRIAGE = 'd'.repeat(64);

export const OUTSIDER = 'e'.repeat(64);

/** The one owner configured as a System sender; TRIAGE is this person's agent. */
export const CREATOR = '9'.repeat(64);

export const WORKSPACE = '11111111-1111-4111-8111-111111111111';

export const ROOM = '22222222-2222-4222-8222-222222222222';

export const CORNER = '33333333-3333-4333-8333-333333333333';

export const TRIAGE_CORNER = '44444444-4444-4444-8444-444444444444';

export const REPOSITORY = 'Beeline-Work/beeline';

export const CONFIG: FeedbackConfig = { repository: REPOSITORY, systemSenders: [CREATOR] };

export const FIX_URL = `https://github.com/${REPOSITORY}/pull/7`;

/** GitHub as the feedback loop reads it: pull request 7 merged, nothing else did. */
export let merged: Set<number>;

const pullRequests: FeedbackPullRequests = {
  merged: async (repository, number) => repository === REPOSITORY && merged.has(number),
};


export let database: PgliteDatabase;

let sequence = 0;


function hex(): string {
  sequence += 1;
  return sequence.toString(16).padStart(64, 'f');
}


beforeEach(async () => {
  merged = new Set([7]);
  database = await migratedDatabase();
  await database.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES
      ($1,'human','Priya Raman','priya'),($2,'human','Other Person','other'),
      ($3,'agent','Worker','worker'),($4,'agent','Sweeper','sweeper'),($5,'agent','Outsider','outsider'),
      ($6,'human','Creator','creator')`,
    [PERSON, OTHER, AGENT, TRIAGE, OUTSIDER, CREATOR],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
  await database.query(
    `INSERT INTO rooms(id,workspace_id,created_by,name)
     VALUES($1,$2,$3,'Moonbase Launch')`,
    [ROOM, WORKSPACE, PERSON],
  );
  await database.query(
    `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'Fix it')`,
    [CORNER, WORKSPACE, ROOM, PERSON],
  );
  // The Issues triage corner: an ordinary corner, with no setting.
  await database.query(
    `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'Issues triage')`,
    [TRIAGE_CORNER, WORKSPACE, ROOM, PERSON],
  );
  for (const corner of [CORNER, TRIAGE_CORNER])
    await insertCornerFacts(database, { cornerId: corner, ownerAgentId: TRIAGE });
  await database.query(
    `INSERT INTO agents(agent_id,owner_id) VALUES($1,$2),($3,$4),($5,$2)`,
    [AGENT, PERSON, TRIAGE, CREATOR, OUTSIDER],
  );
  for (const id of [PERSON, OTHER, AGENT, TRIAGE, OUTSIDER, CREATOR])
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,NULL,$2,'member'),($1,$3,$2,'member') `,
      [WORKSPACE, id, ROOM],
    );

});


afterEach(async () => {
  await database.close();
});


export async function message(text: string, authorId = PERSON, roomId = ROOM): Promise<string> {
  const id = hex();
  await database.query(
    `INSERT INTO messages(id,room_id,author_id,text,created_at)
     VALUES($1,$2,$3,$4,now()-interval '1 hour'+($5::int * interval '1 millisecond'))`,
    [id, roomId, authorId, text, sequence],
  );
  return id;
}


export async function openTurn(sourceMessageId: string, roomId = ROOM, agentId = AGENT) {
  const requestId = `request-${hex().slice(-8)}`;
  const generationId = `${requestId}-generation`;
  const command = await createAgentCommand(database, {
    roomId,
    agentId,
    sourceMessageId,
    reason: 'human_tag',
    turnRequestId: requestId,
  });
  await claimAgentCommand(database, roomId, agentId, command!.id, generationId);
  return { roomId, requestId, generationId };
}


export function daemon(config = CONFIG, reader: FeedbackPullRequests | null = pullRequests): DaemonService {
  return new DaemonService(
    database,
    new LiveHub(),
    undefined,
    undefined,
    false,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    { enabled: false },
    undefined,
    undefined,
    undefined,
    { config, ...(reader ? { pullRequests: reader } : {}) },
  );
}


export async function report(
  input: Record<string, unknown>,
  roomId = ROOM,
  agentId = AGENT,
): Promise<{ itemId: string; duplicate: boolean }> {
  const trigger = await message(`@worker please do the thing ${hex()}`, PERSON, roomId);
  const turn = await openTurn(trigger, roomId, agentId);
  return daemon().execute(
    'reportFeedback',
    { ...turn, category: 'bug', summary: 'x', ...input } as never,
    agentId,
  ) as Promise<{ itemId: string; duplicate: boolean }>;
}


/** One turn of the triage agent in the Issues triage corner. */
export async function triageTurn(roomId = TRIAGE_CORNER, agentId = TRIAGE) {
  const handle = agentId === TRIAGE ? 'sweeper' : 'outsider';
  return openTurn(await message(`@${handle} sweep`, PERSON, roomId), roomId, agentId);
}


export async function items() {
  return (
    await database.query<{
      id: string;
      status: string;
      source_kind: string;
      detail: string | null;
      room_id: string;
      trigger_message_id: string;
      request_id: string | null;
      prompt_section_ids: string[];
      message_ids: string[];
    }>(`SELECT * FROM feedback_items ORDER BY created_at,id`)
  ).rows;
}
export const rootFixture = {
get merged(){return merged;}, set merged(value: typeof merged){merged=value;},
get database(){return database;}, set database(value: typeof database){database=value;},
get sequence(){return sequence;}, set sequence(value: typeof sequence){sequence=value;},
};
export function fixtureScope3() {

  async function presence(agentId: string, releaseVersion: string) {
    await rootFixture.database.query(
      `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body)
       VALUES($1,$2,'presence','presence',$3::jsonb)
       ON CONFLICT(room_id,agent_id,turn_id,kind) DO UPDATE SET body=EXCLUDED.body,updated_at=now()`,
      [ROOM, agentId, JSON.stringify({ status: 'online', releaseVersion })],
    );
  }


  const PERSON_SESSION = '55555555-5555-4555-8555-555555555555';

  const OTHER_SESSION = '66666666-6666-4666-8666-666666666666';


  async function runningUpdate(
    identityId: string,
    familyId: string,
    deviceId: string,
    body: { platform: 'ios' | 'android' | 'macos' | 'windows' | 'linux'; releaseVersion?: string },
  ) {
    await new PhoneService(rootFixture.database, 'http://local.test').execute(
      'reportRunningUpdate',
      { deviceId, ...body },
      identityId,
      undefined,
      familyId,
    );
  }


  async function versions(id: string) {
    return (await rootFixture.database.query<{
      helper_version: string | null;
      app_version: string | null;
      app_platform: string | null;
      harness: string | null;
      harness_version: string | null;
    }>(
      `SELECT helper_version,app_version,app_platform,harness,harness_version FROM feedback_items WHERE id=$1`,
      [id],
    )).rows[0]!;
  }
return {
presence,
PERSON_SESSION,
OTHER_SESSION,
runningUpdate,
versions,
};
}
export function fixtureScope5() {

  async function reported() {
    const phone = new PhoneService(rootFixture.database, 'http://local.test');
    const agentItem = (await report({ summary: 'timeout' })).itemId;
    const tagged = await phone.execute(
      'sendRoomMessage',
      { roomId: ROOM, text: '@system the tools keep timing out' },
      PERSON,
    );
    const taggedItem = (await items()).find((item) => item.trigger_message_id === tagged.messageId)!.id;
    const actionItem = (
      await phone.execute('reportMessageIssue', { roomId: ROOM, messageId: await message('slow') }, OTHER)
    ).itemId;
    const repeatItem = (
      await phone.execute('reportMessageIssue', { roomId: ROOM, messageId: await message('slower') }, PERSON)
    ).itemId;
    return { agentItem, taggedItem, actionItem, repeatItem };
  }


  async function notify(input: Record<string, unknown>, agentId = TRIAGE, roomId = TRIAGE_CORNER) {
    const turn = await openTurn(
      await message(`@${agentId === TRIAGE ? 'sweeper' : 'worker'} notify`, CREATOR, roomId),
      roomId,
      agentId,
    );
    return daemon().execute(
      'notifyFeedbackFixed',
      { ...turn, notify: true, title: 'Slow tools', prUrl: FIX_URL, ...input } as never,
      agentId,
    );
  }


  async function fixedDms() {
    return (
      await rootFixture.database.query<{ text: string; participants: string[] }>(
        `SELECT message.text,room.direct_participants participants FROM messages message
         JOIN rooms room ON room.id=message.room_id
         WHERE message.author_id=$1 AND message.text LIKE 'Fixed:%'
         ORDER BY message.created_at,message.id`,
        [SYSTEM_IDENTITY_ID],
      )
    ).rows;
  }
return {
reported,
notify,
fixedDms,
};
}
export { afterEach, beforeEach, describe, expect, it } from 'vitest';
export { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
export { claimAgentCommand, createAgentCommand } from './agent-command.js';
export { DAEMON_OPERATION_NAMES, DaemonService } from './daemon-service.js';
export { feedbackConfigFromEnv } from './feedback.js';
export { FEEDBACK_TRIAGE_PULL_SQL } from './feedback-triage-workflow.js';
export { groupFeedback } from '../../../scripts/feedback-signals.mjs';
export { LiveHub } from './live.js';
export { hasSystemReportMention, taggedIdentityIdsSql } from './message-mentions.js';
export { PhoneService } from './phone-service.js';
export { PgliteDatabase, migratedDatabase, insertCornerFacts } from './test-support.js';
export { ensureSystemIdentity } from './system-line.js';
export type { FeedbackConfig, FeedbackPullRequests } from './feedback.js';
