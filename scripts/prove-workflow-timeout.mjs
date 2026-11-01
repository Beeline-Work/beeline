/** Built-service workflow refusal and recovery proof. --base-member asserts the original Sentry captures. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
const envelopes = [];
const collector = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  envelopes.push(Buffer.concat(chunks).toString());
  response.end('{}');
});
await new Promise(resolve => collector.listen(0, '127.0.0.1', resolve));
process.env.SENTRY_DSN = `http://public@127.0.0.1:${collector.address().port}/1`;
// Set the collector DSN before loading modules that initialize Sentry.
const { migrate } = await import('../apps/server/dist/database.js');
const { PgliteDatabase, describedWorkflow } = await import('../apps/server/src/test-support.js');
const { TokenAuth } = await import('../apps/server/dist/auth.js');
const { PhoneService } = await import('../apps/server/dist/phone-service.js');
const { DaemonService } = await import('../apps/server/dist/daemon-service.js');
const { LiveHub } = await import('../apps/server/dist/live.js');
const { createAgentCommand } = await import('../apps/server/dist/agent-command.js');
const { createBeelineServer } = await import('../apps/server/dist/server.js');
const { flushServerErrors } = await import('../apps/server/dist/sentry.js');
const HUMAN = createHash('sha256').update('github:proof-owner').digest('hex');
const WRITER = 'b'.repeat(64);
const REVIEWER = 'c'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
async function main() {
  const log = [];
  const database = new PgliteDatabase();
  await migrate(database);
  await database.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES
       ($1,'human','Proof Owner','proofowner'),
       ($2,'agent','Wren','wren'),
       ($3,'agent','Revi','revi')`,
    [HUMAN, WRITER, REVIEWER],
  );
  await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$3),($2,$3)`, [
    WRITER,
    REVIEWER,
    HUMAN,
  ]);
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workflow Proof Workspace')`, [
    WORKSPACE,
  ]);
  await database.query(
    `INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Team')`,
    [ROOM, WORKSPACE, HUMAN],
  );
  for (const who of [HUMAN, WRITER, REVIEWER])
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
         ($1,NULL,$2,$3),($1,$4,$2,$3)`,
      [WORKSPACE, who, who === HUMAN ? 'owner' : 'member', ROOM],
    );
  const auth = new TokenAuth(database, async () => ({
    subject: 'proof-owner',
    login: 'proofowner',
    name: 'Proof Owner',
  }));
  const phone = new PhoneService(database, 'http://placeholder');
  const live = new LiveHub();
  const daemon = new DaemonService(
    database,
    live,
    undefined,
    undefined,
    false,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    {
      enabled: true,
      live: true,
    },
  );
  const server = createBeelineServer({
    database,
    auth,
    phone,
    daemon,
    live,
    mediaMaximumBytes: 1024 * 1024,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const daemonTokenFor = async (agentId) => {
    const exchange = await auth.createDaemonExchange(agentId);
    return (await auth.exchangeDaemonToken(exchange.exchangeToken)).daemonToken;
  };
  const writerToken = await daemonTokenFor(WRITER);
  const reviewerToken = await daemonTokenFor(REVIEWER);
  const call = async (label, name, payload, token) => {
    const response = await fetch(`${origin}/v1/daemon/operations/${name}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    if (!response.ok) {
      log.push({
        label,
        request: { operation: name, ...payload },
        response: { httpStatus: response.status, ...(text ? JSON.parse(text) : {}) },
      });
      throw new Error(`${label} (${name}) -> HTTP ${response.status} ${text}`);
    }
    const parsed = text ? JSON.parse(text) : {};
    log.push({ label, request: { operation: name, ...payload }, response: parsed });
    return parsed;
  };
  /** Claim the given command and post a `working` receipt, exactly as a real daemon does. */
  const claim = async (agentId, token, command, roomId = ROOM) => {
    const generationId = `gen-${command.id.slice(0, 8)}`;
    await call(
      `${agentId} claims its turn`,
      'claimAgentCommand',
      {
        roomId,
        commandId: command.id,
        generationId,
      },
      token,
    );
    await call(
      `${agentId} starts working`,
      'postAgentTurnReceipt',
      {
        roomId,
        agentId,
        requestId: command.turnRequestId,
        generationId,
        status: 'working',
      },
      token,
    );
    return { requestId: command.turnRequestId, generationId };
  };
  // Seed the very first turn the way a human's addressed message would: this
  // is scaffolding (an ordinary Room command), not something under test.
  const kickoff = 'kickoff-message';
  await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)`, [
    kickoff,
    ROOM,
    HUMAN,
    'wren, please start and recover our signup workflow',
  ]);
  const initialRow = await createAgentCommand(database, {
    roomId: ROOM,
    agentId: WRITER,
    sourceMessageId: kickoff,
    reason: 'human_tag',
  });
  if (!initialRow) throw new Error('failed to seed the initial writer command');
  const initial = {
    id: initialRow.id,
    roomId: initialRow.room_id,
    agentId: initialRow.agent_id,
    sourceMessageId: initialRow.source_message_id ?? initialRow.id,
    turnRequestId: initialRow.turn_request_id,
    reason: initialRow.reason,
  };
  // The human request authorizes the maker to save, start and recover the run.
  const turn1 = await claim(WRITER, writerToken, initial);
  const contract = describedWorkflow({
    version: 1,
    name: 'signup-recovery',
    description: 'Recover signup without a provider key',
    roles: ['maker', 'owner'],
    start: 'signup_stills',
    handoffs: {
      signup_stills: {
        role: 'maker',
        requires: ['vault_reference'],
        timeoutSeconds: 60,
        on: { ready: 'done', timeout: 'recover' },
      },
      recover: {
        kind: 'gate',
        role: 'owner',
        requires: ['decision'],
        timeoutSeconds: 600,
        default: 'abandon',
        on: { retry: 'signup_stills', abandon: 'failed' },
      },
      done: { kind: 'terminal', status: 'done' },
      failed: { kind: 'terminal', status: 'failed' },
    },
  });
  const payload = { roomId: ROOM, agentId: WRITER, ...turn1 };
  await call('save signup contract', 'saveWorkflow', { ...payload, contract }, writerToken);
  const run = await call(
    'start signup',
    'startWorkflow',
    {
      ...payload,
      name: 'signup-recovery',
      roleBindings: { maker: WRITER, owner: REVIEWER },
    },
    writerToken,
  );
  const runId = run.runId;
  // SENTRY-WORKFLOW-MEMBER: the real authenticated command path, with isolated data.
  const baseMember = process.argv.includes('--base-member');
  const outsider = 'f'.repeat(64);
  await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Outsider')`, [outsider]);
  for (const targetAgentId of [HUMAN, outsider]) {
    const response = await fetch(`${origin}/v1/daemon/operations/assignWorkflowRole`, {
      method: 'POST',
      headers: { authorization: `Bearer ${writerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, runId, role: 'maker', targetAgentId }),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: `${targetAgentId} is not a current agent member of this Room` });
  }
  // Keep the already-classified role mismatch on the same command boundary.
  const mismatch = await fetch(`${origin}/v1/daemon/operations/assignWorkflowRole`, {
    method: 'POST',
    headers: { authorization: `Bearer ${writerToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, runId, role: 'owner', targetAgentId: REVIEWER }),
  });
  assert.equal(mismatch.status, 503);
  assert.deepEqual(await mismatch.json(), { error: 'this run is currently at the maker role, not owner' });
  // An unexpected failure in this same operation must still reach Sentry.
  const execute = daemon.execute.bind(daemon);
  daemon.execute = async (operation, input, ...rest) => {
    if (operation === 'assignWorkflowRole') throw new Error('Workflow membership proof control fault');
    return execute(operation, input, ...rest);
  };
  const control = await fetch(`${origin}/v1/daemon/operations/assignWorkflowRole`, {
    method: 'POST',
    headers: { authorization: `Bearer ${writerToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, runId, role: 'maker', targetAgentId: REVIEWER }),
  });
  assert.equal(control.status, 503);
  daemon.execute = execute;
  await flushServerErrors();
  const events = envelopes.flatMap(envelope => envelope.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))).filter(item => item.exception);
  const controls = events.filter(event => event.exception.values.some(value => value.value === 'Workflow membership proof control fault'));
  assert.equal(controls.length, 1, 'unexpected command fault still reaches Sentry');
  assert.equal(events.length - controls.length, baseMember ? 2 : 0);
  console.log(`Reproduction SENTRY-WORKFLOW-MEMBER: human/nonmember HTTP 503; refusal captures=${events.length - controls.length}; unexpected captures=${controls.length}; role mismatch HTTP 503`);
  const refusal = async (label, operation, args, token, pattern) => {
    await assert.rejects(call(label, operation, args, token), pattern);
  };
  await refusal(
    'success still needs key',
    'handoff',
    {
      ...payload,
      runId,
      outcome: 'ready',
      contents: { reason: 'No provider key' },
    },
    writerToken,
    /vault_reference is required/,
  );
  const timed = await call(
    'wf-1 declared timeout without key',
    'handoff',
    {
      ...payload,
      runId,
      outcome: 'timeout',
      contents: { reason: 'No provider key exists' },
    },
    writerToken,
  );
  assert.equal(timed.state, 'recover');
  console.log(
    'Reproduction wf-1 PASS: HTTP advance accepts timeout reason without vault_reference; success still requires key.',
  );
  const rebound = await call(
    'wf-2 rebind maker from owner gate',
    'assignWorkflowRole',
    {
      ...payload,
      runId,
      role: 'maker',
      targetAgentId: REVIEWER,
    },
    writerToken,
  );
  assert.equal(rebound.state, 'recover');
  const gateHead = (
    await database.query(
      `SELECT id FROM messages WHERE card->>'runId'=$1 AND card_type='workflow-handoff'
     ORDER BY (card->>'seq')::int DESC LIMIT 1`,
      [runId],
    )
  ).rows[0].id;
  const reviewerCommand = await createAgentCommand(database, {
    roomId: ROOM,
    agentId: REVIEWER,
    sourceMessageId: gateHead,
    reason: 'test',
  });
  assert.ok(reviewerCommand);
  const reviewerTurn = await claim(REVIEWER, reviewerToken, {
    id: reviewerCommand.id,
    roomId: ROOM,
    agentId: REVIEWER,
    sourceMessageId: gateHead,
    turnRequestId: reviewerCommand.turn_request_id,
    reason: reviewerCommand.reason,
  });
  await refusal(
    'rebound agent cannot answer gate',
    'handoff',
    {
      roomId: ROOM,
      ...reviewerTurn,
      runId,
      outcome: 'retry',
      contents: { decision: 'retry' },
    },
    reviewerToken,
    /gate/,
  );
  const adminToken = (await auth.exchangeGitHubOidc('proof')).accessToken;
  const gate = (
    await database.query(`SELECT id,options FROM room_choices WHERE room_id=$1 AND status='open'`, [
      ROOM,
    ])
  ).rows[0];
  const response = await fetch(`${origin}/v1/phone/operations/answerChoice`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      choiceId: gate.id,
      optionId: gate.options.find((option) => option.label === 'retry').optionId,
    }),
  });
  assert.ok(response.ok, await response.text());
  const read = await call(
    'read recovered signup',
    'getWorkflowRun',
    { roomId: ROOM, runId },
    reviewerToken,
  );
  assert.equal(read.state, 'signup_stills');
  assert.equal(read.boundAgentId, REVIEWER);
  console.log(
    'Reproduction wf-2 PASS: maker rebound at owner gate; agent answer refused; human retry dispatches recovered maker.',
  );
  await new Promise((resolve) => server.close(() => resolve()));
  await database.close();
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => { collector.closeAllConnections(); collector.close(); process.exit(process.exitCode ?? 0); });
