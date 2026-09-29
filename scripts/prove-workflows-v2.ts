import { PgliteDatabase } from '../apps/server/src/test-support.js';
import { migrate } from '../apps/server/src/database.js';
import { createAgentCommand } from '../apps/server/src/agent-command.js';
import { PhoneService } from '../apps/server/src/phone-service.js';
import {
  checkWorkflow,
  listWorkflows,
  publishWorkflow,
  putWorkflowDefinition,
  readWorkflowRun,
  settleWorkflowPublicationChoice,
  startWorkflowRun,
} from '../apps/server/src/workflow-service.js';
import { answerRoomChoice } from '../apps/server/src/room-choice.js';

const human = 'a'.repeat(64);
const worker = 'b'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const firstRoom = '22222222-2222-4222-8222-222222222222';
const secondRoom = '33333333-3333-4333-8333-333333333333';
const firstMessage = 'c'.repeat(64);
const secondMessage = 'd'.repeat(64);

const definition = {
  version: 1,
  name: 'review-release',
  purpose: 'Review a release and record the result.',
  roles: ['worker'],
  trigger: { kind: 'manual' },
  start: 'review',
  success: ['done'],
  states: {
    review: {
      kind: 'step',
      step: {
        role: 'worker',
        skill: 'review-release',
        output: { result: { type: 'string', enum: ['ready', 'blocked'] } },
        timeoutSeconds: 60,
        retries: 0,
      },
      guard: { field: 'result' },
      on: { ready: 'done', blocked: 'stopped', failure: 'stopped', timeout: 'stopped' },
    },
    done: { kind: 'terminal' },
    stopped: { kind: 'terminal' },
  },
};

async function main() {
  const db = new PgliteDatabase();
  try {
    await migrate(db);
    await db.query(
      `INSERT INTO identities(id,kind,name) VALUES($1,'human','Human'),($2,'agent','Worker')`,
      [human, worker],
    );
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Proof')`, [workspace]);
    await db.query(
      `INSERT INTO rooms(id,workspace_id,created_by,name)
    VALUES($1,$3,$4,'First'),($2,$3,$4,'Second')`,
      [firstRoom, secondRoom, workspace, human],
    );
    for (const room of [firstRoom, secondRoom]) {
      await db.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,$2,$3,'owner'),($1,$2,$4,'member')`,
        [workspace, room, human, worker],
      );
    }
    await db.query(
      `INSERT INTO workspace_skills(id,workspace_id,slug,description,
    current_version,revision,source_room_id,repository,target_commit)
    VALUES($1,$2,'review-release','Review a release',1,1,$3,'acme/repo',$4)`,
      ['44444444-4444-4444-8444-444444444444', workspace, firstRoom, 'e'.repeat(40)],
    );
    await db.query(
      `INSERT INTO messages(id,room_id,author_id,text)
    VALUES($1,$3,$5,'Define workflow'),($2,$4,$5,'Run workflow')`,
      [firstMessage, secondMessage, firstRoom, secondRoom, human],
    );
    const firstCommand = await createAgentCommand(db, {
      roomId: firstRoom,
      agentId: worker,
      sourceMessageId: firstMessage,
      reason: 'human_mention',
    });
    const secondCommand = await createAgentCommand(db, {
      roomId: secondRoom,
      agentId: worker,
      sourceMessageId: secondMessage,
      reason: 'human_mention',
    });
    if (!firstCommand || !secondCommand) throw new Error('proof commands were not created');

    const checked = await checkWorkflow(db, firstRoom, definition);
    if (
      !checked.ok ||
      checked.bounds.agentTurns !== 1 ||
      !checked.nonSuccessRoutes.some((route) => route.terminal === 'stopped')
    )
      throw new Error('checker did not report the expected bound and non-success route');
    const typo = structuredClone(definition);
    typo.states.review.on.ready = 'missing';
    const rejected = await checkWorkflow(db, firstRoom, typo);
    if (!rejected.errors.some((error) => error.rule === 'structure'))
      throw new Error('checker accepted an invalid route');
    console.log(
      `Y: checker returned a ${checked.bounds.durationMs} ms / ${checked.bounds.agentTurns} turn bound, a stopped route, and named errors for invalid input`,
    );

    await db.transaction((tx) =>
      putWorkflowDefinition(tx, firstRoom, worker, definition, undefined, firstCommand),
    );
    const pending = await db.transaction((tx) =>
      publishWorkflow(tx, firstRoom, definition.name, firstCommand),
    );
    if ((await listWorkflows(db, secondRoom)).some((workflow) => workflow.name === definition.name))
      throw new Error('workflow appeared before approval');
    await db.transaction(async (tx) => {
      await answerRoomChoice(tx, { choiceId: pending.choiceId, optionId: 'A', viewerId: human });
      await settleWorkflowPublicationChoice(tx, pending.choiceId, 'A', human);
    });
    const visible = (await listWorkflows(db, secondRoom)).find(
      (item) => item.name === definition.name,
    );
    if (visible?.layer !== 'workspace' || visible.version !== 1)
      throw new Error('approved workflow is not visible in the second Room');
    const run = await db.transaction((tx) =>
      startWorkflowRun(tx, secondRoom, definition.name, { worker }, secondCommand),
    );
    if (run.status !== 'running' || run.layer !== 'workspace')
      throw new Error('published workflow did not start in the second Room');
    console.log(
      'Y: a human approved Room A’s draft; Room B lists version 1 and started a run without another gate',
    );

    const phone = new PhoneService(db, 'http://test');
    await phone.execute(
      'overrideWorkflowRun',
      { roomId: secondRoom, runId: run.runId, action: 'kill', reason: 'Proof complete' },
      human,
    );
    const ended = await readWorkflowRun(db, secondRoom, run.runId);
    if (
      ended.run.status !== 'failed' ||
      !ended.log.some(
        (event) =>
          event.event === 'override_kill' &&
          (event.payload as { viewerId?: string }).viewerId === human,
      )
    )
      throw new Error('human override was not recorded');
    console.log(
      'Y: the human killed the run through the phone API and the run log records the actor',
    );
  } finally {
    await db.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
