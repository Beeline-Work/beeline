import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentSignInCardId } from './agent-command.js';
import {
  AGENT_SIGN_IN_NO_ANSWER_MESSAGE,
  AGENT_SIGN_IN_OFFLINE_MESSAGE,
  type AgentSignInEvent,
  startAgentSignIn,
} from './agent-sign-in.js';
import { DaemonService } from './daemon-service.js';
import { migrate } from './database.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import { POSTGRES_LIVE_CHANNEL, PostgresLiveListener, type LivePgClient } from './postgres-live.js';
import { PgliteDatabase } from './test-support.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const AGENT = 'a'.repeat(64);
const OWNER = 'b'.repeat(64);
const MEMBER = 'c'.repeat(64);
const OTHER_AGENT = 'd'.repeat(64);
const CODE = 'pasted-claude-code-7f3a#state-from-claude';
const LINK = 'https://claude.com/cai/oauth/authorize?code=true&state=s';

const SNAPSHOT = await (async () => {
  const database = new PgliteDatabase();
  try {
    await migrate(database);
    return await database.snapshot();
  } finally {
    await database.close();
  }
})();

class PgliteListenClient extends EventEmitter implements LivePgClient {
  private release?: () => Promise<void>;
  constructor(private readonly database: PgliteDatabase) {
    super();
  }
  async connect(): Promise<void> {}
  async query(): Promise<void> {
    this.release = await this.database.client.listen(POSTGRES_LIVE_CHANNEL, (payload) =>
      this.emit('notification', { channel: POSTGRES_LIVE_CHANNEL, payload }),
    );
  }
  async end(): Promise<void> {
    await this.release?.();
    this.release = undefined;
  }
}

/** Every row of every table, as text, contains `needle` nowhere. */
async function persistedAnywhere(database: PgliteDatabase, needle: string): Promise<string[]> {
  const tables = await database.query<{ name: string }>(
    `SELECT quote_ident(table_schema)||'.'||quote_ident(table_name) AS name
     FROM information_schema.tables
     WHERE table_schema='public' AND table_type='BASE TABLE'`,
  );
  const hits: string[] = [];
  for (const { name } of tables.rows) {
    const found = await database.query(
      `SELECT 1 FROM ${name} row WHERE row::text LIKE '%' || $1 || '%' LIMIT 1`,
      [needle],
    );
    if (found.rowCount) hits.push(name);
  }
  return hits;
}

describe('@agent login: Claude sign-in at the call site', () => {
  let database: PgliteDatabase;
  let live: LiveHub;
  let listener: PostgresLiveListener;
  let phone: PhoneService;
  let daemon: DaemonService;
  let helperFrames: AgentSignInEvent[];
  let logged: string[];
  let sent = 0;

  beforeEach(async () => {
    logged = [];
    for (const method of ['log', 'warn', 'error', 'info'] as const)
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((arg) => (arg instanceof Error ? arg.stack : String(arg))).join(' '));
      });
    database = PgliteDatabase.fromSnapshot(SNAPSHOT);
    await database.query(
      `INSERT INTO identities(id,kind,name,handle) VALUES
         ($1,'agent','Clara','clara'),($2,'human','Owner','owner'),
         ($3,'human','Member','member'),($4,'agent','Codie','codie')`,
      [AGENT, OWNER, MEMBER, OTHER_AGENT],
    );
    await database.query(`INSERT INTO workspaces(id,name) VALUES ($1,'Workspace')`, [WORKSPACE]);
    await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES ($1,$2,'General')`, [
      ROOM,
      WORKSPACE,
    ]);
    await database.query(
      `INSERT INTO agents(agent_id,owner_id,harness) VALUES ($1,$2,'claude'),($3,$2,'custom')`,
      [AGENT, OWNER, OTHER_AGENT],
    );
    for (const [identity, role] of [
      [AGENT, 'member'],
      [OWNER, 'owner'],
      [MEMBER, 'admin'],
      [OTHER_AGENT, 'member'],
    ] as const)
      for (const room of [null, ROOM])
        await database.query(
          `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES ($1,$2,$3,$4)`,
          [WORKSPACE, room, identity, role],
        );
    await database.query(
      `INSERT INTO agent_connections(agent_id,epoch,connection_id,instance_id)
       VALUES ($1,1,'connection','instance'),($2,1,'connection-2','instance')`,
      [AGENT, OTHER_AGENT],
    );
    live = new LiveHub();
    const client = new PgliteListenClient(database);
    listener = new PostgresLiveListener(database, live, () => client, 1);
    void listener.run();
    await vi.waitFor(() => expect(client.listenerCount('notification')).toBe(1));
    phone = new PhoneService(database, 'https://server.example', undefined, undefined, live);
    daemon = new DaemonService(database, live);
    // What a helper's live session receives (`daemon-live.ts` forwards only these).
    helperFrames = [];
    live.subscribeAll((event) => {
      if (event.type === 'agent-sign-in' && (event.step === 'start' || event.step === 'code'))
        helperFrames.push(event);
    });
  });

  afterEach(async () => {
    await listener.stop();
    await database.close();
    vi.restoreAllMocks();
  });

  /** A helper that answers each frame the way `answerAgentSignInFrame` does. */
  function helper(answer: (event: AgentSignInEvent) => Record<string, unknown> | undefined) {
    return live.subscribeAll((event) => {
      if (event.type !== 'agent-sign-in' || event.agentId !== AGENT) return;
      if (event.step !== 'start' && event.step !== 'code') return;
      const report = answer(event);
      if (report)
        void daemon.execute(
          'reportAgentSignIn',
          { agentId: AGENT, attemptId: event.attemptId, ...report } as never,
          AGENT,
        );
    });
  }

  async function send(author: string, text: string): Promise<string> {
    const messageId = String(++sent).padStart(64, '0');
    await phone.execute('sendRoomMessage', { roomId: ROOM, text, messageId }, author);
    return messageId;
  }

  async function card(messageId: string) {
    const row = (
      await database.query<{ card: Record<string, unknown>; text: string }>(
        `SELECT card,text FROM messages WHERE id=$1`,
        [agentSignInCardId(messageId, AGENT)],
      )
    ).rows[0];
    return row;
  }

  async function settled(messageId: string, status: string) {
    await vi.waitFor(async () => expect((await card(messageId))?.card.status).toBe(status), {
      timeout: 5_000,
    });
    return (await card(messageId))!;
  }

  async function systemLines() {
    return (
      await database.query<{ text: string }>(
        `SELECT text FROM messages WHERE presentation='system' ORDER BY created_at,id`,
      )
    ).rows.map((row) => row.text);
  }

  it('posts the machine’s claude.ai link in a card, takes the pasted code, and signs in', async () => {
    helper((event) => (event.step === 'start' ? { kind: 'paste-code', authorizeUrl: LINK } : { outcome: 'signed-in' }));

    const command = await send(OWNER, '@clara login');
    const pending = await settled(command, 'pending');
    expect(pending.text).toBe(
      '@clara started a Claude sign-in · its owner finishes it in this card',
    );
    expect(pending.card).toMatchObject({ agentId: AGENT, ownerId: OWNER, authorizeUrl: LINK });
    // The command is server control: the agent's model is never asked.
    expect(
      (await database.query(`SELECT 1 FROM agent_commands WHERE agent_id=$1`, [AGENT])).rowCount,
    ).toBe(0);

    const room = await phone.readRoom(ROOM, OWNER);
    const projected = room?.messages.find((message) => message.agentSignIn);
    expect(projected?.agentSignIn).toEqual({
      agentId: AGENT,
      ownerId: OWNER,
      harness: 'claude',
      status: 'pending',
      kind: 'paste-code',
      authorizeUrl: LINK,
    });
    // Anyone else in the Room sees whose sign-in it is, never the link.
    const others = await phone.readRoom(ROOM, MEMBER);
    expect(others?.messages.find((message) => message.agentSignIn)?.agentSignIn).toEqual({
      agentId: AGENT,
      ownerId: OWNER,
      harness: 'claude',
      status: 'pending',
      kind: 'paste-code',
    });

    await expect(
      phone.execute(
        'completeAgentSignIn',
        { roomId: ROOM, messageId: projected!.id, code: CODE },
        OWNER,
      ),
    ).resolves.toEqual({ signedIn: true });
    expect((await card(command))!.card.status).toBe('signed-in');
    expect(helperFrames.map((frame) => frame.step)).toEqual(['start', 'code']);
    expect(helperFrames[1]).toMatchObject({ code: CODE });
    // Nothing stored or logged carries the pasted code.
    expect(await persistedAnywhere(database, 'pasted-claude-code')).toEqual([]);
    expect(logged.filter((line) => line.includes('pasted-claude-code'))).toEqual([]);
  });

  it('accepts /login the same way', async () => {
    helper(() => ({ kind: 'paste-code', authorizeUrl: LINK }));
    const command = await send(OWNER, '@clara /login');
    await settled(command, 'pending');
  });

  it('refuses a non-owner, even a Workspace admin, with a system line and no card', async () => {
    helper(() => ({ kind: 'paste-code', authorizeUrl: LINK }));
    const command = await send(MEMBER, '@clara login');
    expect(await systemLines()).toContain(
      '@clara did not sign in to Claude · only its owner may sign it in',
    );
    expect(await card(command)).toBeUndefined();
    expect(helperFrames).toEqual([]);
  });

  it("refuses a non-owner's code on the owner's card", async () => {
    helper(() => ({ kind: 'paste-code', authorizeUrl: LINK }));
    const command = await send(OWNER, '@clara login');
    await settled(command, 'pending');
    await expect(
      phone.execute(
        'completeAgentSignIn',
        { roomId: ROOM, messageId: agentSignInCardId(command, AGENT), code: CODE },
        MEMBER,
      ),
    ).rejects.toThrow("Only the agent's owner can change this");
    expect(helperFrames.map((frame) => frame.step)).toEqual(['start']);
  });

  it('tells the owner when its harness cannot sign in from Beeline', async () => {
    await send(OWNER, '@codie login');
    expect(await systemLines()).toContain(
      '@codie did not sign in to Claude · sign-in from Beeline is not available for its harness',
    );
    expect(helperFrames).toEqual([]);
    expect(
      (await database.query(`SELECT 1 FROM agent_commands WHERE agent_id=$1`, [OTHER_AGENT]))
        .rowCount,
    ).toBe(0);
  });

  it('settles the card as offline instead of waiting when no helper is connected', async () => {
    await database.query(`UPDATE agent_connections SET released_at=now() WHERE agent_id=$1`, [AGENT]);
    const command = await send(OWNER, '@clara login');
    const failed = await settled(command, 'failed');
    expect(failed.card.errorMessage).toBe(AGENT_SIGN_IN_OFFLINE_MESSAGE);
    expect(helperFrames).toEqual([]);
  });

  it('stops waiting with a clear message when a connected helper never answers', async () => {
    await expect(startAgentSignIn(database, live, AGENT, { attemptId: randomUUID(), cardId: 'c'.repeat(64) }, { timeoutMs: 100 })).rejects.toThrow(
      AGENT_SIGN_IN_NO_ANSWER_MESSAGE,
    );
  });

  it('shows a bad or expired code on the card and lets the owner paste again', async () => {
    const rejected =
      'Claude did not accept that code. Paste the newest code from claude.ai, or send the agent `login` again.';
    let codes = 0;
    helper((event) =>
      event.step === 'start'
        ? { kind: 'paste-code', authorizeUrl: LINK }
        : ++codes === 1
          ? { outcome: 'failed', error: rejected }
          : { outcome: 'signed-in' },
    );
    const command = await send(OWNER, '@clara login');
    await settled(command, 'pending');
    const messageId = agentSignInCardId(command, AGENT);
    await expect(
      phone.execute('completeAgentSignIn', { roomId: ROOM, messageId, code: 'old' }, OWNER),
    ).rejects.toThrow(rejected);
    const failed = (await card(command))!;
    expect(failed.card).toMatchObject({ status: 'failed', errorMessage: rejected, authorizeUrl: LINK });
    await expect(
      phone.execute('completeAgentSignIn', { roomId: ROOM, messageId, code: CODE }, OWNER),
    ).resolves.toEqual({ signedIn: true });
    expect((await card(command))!.card).not.toHaveProperty('errorMessage');
  });

  it('settles a device-code card from the machine when the owner approves on the provider page', async () => {
    await database.query(`UPDATE agents SET harness='codex' WHERE agent_id=$1`, [AGENT]);
    const reports: Array<(outcome: Record<string, unknown>) => Promise<unknown>> = [];
    live.subscribeAll((event) => {
      if (event.type !== 'agent-sign-in' || event.step !== 'start' || event.agentId !== AGENT) return;
      void daemon.execute(
        'reportAgentSignIn',
        {
          agentId: AGENT,
          attemptId: event.attemptId,
          kind: 'device-code',
          authorizeUrl: 'https://auth.openai.com/codex/device',
          userCode: 'EBQ9-VJCLN',
          expiresAt: 1_800_000_000_000,
        },
        AGENT,
      );
      reports.push((outcome) =>
        daemon.execute(
          'reportAgentSignIn',
          { agentId: AGENT, attemptId: event.attemptId, cardId: event.cardId, ...outcome } as never,
          AGENT,
        ),
      );
    });
    const command = await send(OWNER, '@clara login');
    const pending = await settled(command, 'pending');
    expect(pending.text).toBe('@clara started a ChatGPT sign-in · its owner finishes it in this card');
    expect(pending.card).toMatchObject({ harness: 'codex', kind: 'device-code', userCode: 'EBQ9-VJCLN' });
    // Nothing to paste: the card finishes on the provider's page.
    await expect(
      phone.execute(
        'completeAgentSignIn',
        { roomId: ROOM, messageId: agentSignInCardId(command, AGENT), code: 'x' },
        OWNER,
      ),
    ).rejects.toThrow('finishes on the provider');
    // Another agent naming this card changes nothing.
    await daemon.execute(
      'reportAgentSignIn',
      {
        agentId: OTHER_AGENT,
        attemptId: String(pending.card.attemptId),
        cardId: agentSignInCardId(command, AGENT),
        outcome: 'signed-in',
      },
      OTHER_AGENT,
    );
    expect((await card(command))!.card.status).toBe('pending');
    await reports[0]!({ outcome: 'signed-in' });
    expect((await card(command))!.card.status).toBe('signed-in');
  });

  it('settles an expired device code as a clear failure', async () => {
    await database.query(`UPDATE agents SET harness='grok' WHERE agent_id=$1`, [AGENT]);
    live.subscribeAll((event) => {
      if (event.type !== 'agent-sign-in' || event.step !== 'start' || event.agentId !== AGENT) return;
      void (async () => {
        await daemon.execute(
          'reportAgentSignIn',
          {
            agentId: AGENT,
            attemptId: event.attemptId,
            kind: 'device-code',
            authorizeUrl: 'https://accounts.x.ai/oauth2/device?user_code=2RDF-2C74',
            userCode: '2RDF-2C74',
            expiresAt: 1_800_000_000_000,
          },
          AGENT,
        );
        await new Promise((resolve) => setTimeout(resolve, 200));
        await daemon.execute(
          'reportAgentSignIn',
          {
            agentId: AGENT,
            attemptId: event.attemptId,
            cardId: event.cardId,
            outcome: 'failed',
            error: 'The sign-in expired before it was approved. Send the agent `login` again.',
          },
          AGENT,
        );
      })();
    });
    const command = await send(OWNER, '@clara login');
    const failed = await settled(command, 'failed');
    expect(failed.card.errorMessage).toBe(
      'The sign-in expired before it was approved. Send the agent `login` again.',
    );
  });

  it('asks a key harness for a new key and relays it like a code', async () => {
    await database.query(`UPDATE agents SET harness='pi' WHERE agent_id=$1`, [AGENT]);
    helper((event) =>
      event.step === 'start' ? { kind: 'api-key', provider: 'openrouter' } : { outcome: 'signed-in' },
    );
    const command = await send(OWNER, '@clara login');
    const pending = await settled(command, 'pending');
    expect(pending.text).toBe('@clara asked for a new key · its owner finishes it in this card');
    expect(pending.card).toMatchObject({ harness: 'pi', kind: 'api-key', provider: 'openrouter' });
    await expect(
      phone.execute(
        'completeAgentSignIn',
        { roomId: ROOM, messageId: agentSignInCardId(command, AGENT), code: 'sk-or-pasted-secret' },
        OWNER,
      ),
    ).resolves.toEqual({ signedIn: true });
    expect(helperFrames.at(-1)).toMatchObject({ step: 'code', code: 'sk-or-pasted-secret' });
    expect(await persistedAnywhere(database, 'sk-or-pasted-secret')).toEqual([]);
  });

  it("never lets another agent's helper answer this agent's sign-in", async () => {
    let attemptId = '';
    live.subscribeAll((event) => {
      if (event.type === 'agent-sign-in' && event.step === 'start') {
        attemptId = event.attemptId;
        void daemon.execute(
          'reportAgentSignIn',
          { agentId: OTHER_AGENT, attemptId, kind: 'paste-code', authorizeUrl: 'https://evil.example/' },
          OTHER_AGENT,
        );
      }
    });
    await expect(startAgentSignIn(database, live, AGENT, { attemptId: randomUUID(), cardId: 'c'.repeat(64) }, { timeoutMs: 300 })).rejects.toThrow(
      AGENT_SIGN_IN_NO_ANSWER_MESSAGE,
    );
    await expect(
      daemon.execute(
        'reportAgentSignIn',
        { agentId: AGENT, attemptId, kind: 'paste-code', authorizeUrl: 'https://evil.example/' },
        OTHER_AGENT,
      ),
    ).rejects.toThrow('daemon token does not own requested agent');
  });
});
