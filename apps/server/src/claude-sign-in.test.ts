import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_SIGN_IN_NO_ANSWER_MESSAGE,
  CLAUDE_SIGN_IN_OFFLINE_MESSAGE,
  type ClaudeSignInEvent,
  startClaudeSignIn,
} from './claude-sign-in.js';
import { DaemonService } from './daemon-service.js';
import { migrate } from './database.js';
import { LiveHub } from './live.js';
import { AGENT_OWNER_AUTHORITY_MESSAGE, PhoneService } from './phone-service.js';
import { POSTGRES_LIVE_CHANNEL, PostgresLiveListener, type LivePgClient } from './postgres-live.js';
import { PgliteDatabase } from './test-support.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const AGENT = 'a'.repeat(64);
const OWNER = 'b'.repeat(64);
const MEMBER = 'c'.repeat(64);
const OTHER_AGENT = 'd'.repeat(64);
const CODE = 'pasted-claude-code-7f3a#state-from-claude';

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

describe('Sign in to Claude relay', () => {
  let database: PgliteDatabase;
  let live: LiveHub;
  let listener: PostgresLiveListener;
  let phone: PhoneService;
  let daemon: DaemonService;
  let helperFrames: ClaudeSignInEvent[];
  let logged: string[];

  beforeEach(async () => {
    logged = [];
    for (const method of ['log', 'warn', 'error', 'info'] as const)
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((arg) => (arg instanceof Error ? arg.stack : String(arg))).join(' '));
      });
    database = PgliteDatabase.fromSnapshot(SNAPSHOT);
    await database.query(
      `INSERT INTO identities(id,kind,name) VALUES
         ($1,'agent','Agent'),($2,'human','Owner'),($3,'human','Member'),($4,'agent','Other')`,
      [AGENT, OWNER, MEMBER, OTHER_AGENT],
    );
    await database.query(`INSERT INTO workspaces(id,name) VALUES ($1,'Workspace')`, [WORKSPACE]);
    await database.query(
      `INSERT INTO agents(agent_id,owner_id,harness) VALUES ($1,$2,'claude'),($3,$2,'codex')`,
      [AGENT, OWNER, OTHER_AGENT],
    );
    await database.query(
      `INSERT INTO memberships(workspace_id,identity_id,role)
       VALUES ($1,$2,'member'),($1,$3,'owner'),($1,$4,'admin'),($1,$5,'member')`,
      [WORKSPACE, AGENT, OWNER, MEMBER, OTHER_AGENT],
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
      if (event.type === 'claude-sign-in' && (event.step === 'start' || event.step === 'code'))
        helperFrames.push(event);
    });
  });

  afterEach(async () => {
    await listener.stop();
    await database.close();
    vi.restoreAllMocks();
  });

  /** A helper that answers each frame the way `answerClaudeSignInFrame` does. */
  function helper(answer: (event: ClaudeSignInEvent) => Record<string, unknown> | undefined) {
    return live.subscribeAll((event) => {
      if (event.type !== 'claude-sign-in' || event.agentId !== AGENT) return;
      if (event.step !== 'start' && event.step !== 'code') return;
      const report = answer(event);
      if (report)
        void daemon.execute(
          'reportClaudeSignIn',
          { agentId: AGENT, attemptId: event.attemptId, ...report } as never,
          AGENT,
        );
    });
  }

  it('lets the owner start, paste the code, and hear the helper verdict', async () => {
    const link = 'https://claude.com/cai/oauth/authorize?code=true&state=s';
    helper((event) =>
      event.step === 'start' ? { authorizeUrl: link } : { outcome: 'signed-in' },
    );

    const started = await phone.execute(
      'startClaudeSignIn',
      { workspaceId: WORKSPACE, agentId: AGENT },
      OWNER,
    );
    expect(started).toEqual({ attemptId: expect.any(String), authorizeUrl: link });

    await expect(
      phone.execute(
        'completeClaudeSignIn',
        { workspaceId: WORKSPACE, agentId: AGENT, attemptId: started.attemptId, code: CODE },
        OWNER,
      ),
    ).resolves.toEqual({ signedIn: true });

    expect(helperFrames.map((frame) => frame.step)).toEqual(['start', 'code']);
    expect(helperFrames[1]).toMatchObject({ attemptId: started.attemptId, code: CODE });
    // The relay stored and logged nothing that carries the pasted code.
    expect(await persistedAnywhere(database, 'pasted-claude-code')).toEqual([]);
    expect(logged.filter((line) => line.includes('pasted-claude-code'))).toEqual([]);
  });

  it('shows the owner a Sign in to Claude verdict on the agent page, and nobody else', async () => {
    expect((await phone.readAgent(WORKSPACE, AGENT, OWNER))?.canSignInToClaude).toBe(true);
    expect((await phone.readAgent(WORKSPACE, AGENT, MEMBER))?.canSignInToClaude).toBe(false);
    expect((await phone.readAgent(WORKSPACE, OTHER_AGENT, OWNER))?.canSignInToClaude).toBe(false);
  });

  it('refuses a non-owner, even a Workspace admin, before the helper hears anything', async () => {
    helper(() => ({ authorizeUrl: 'https://claude.com/x' }));
    await expect(
      phone.execute('startClaudeSignIn', { workspaceId: WORKSPACE, agentId: AGENT }, MEMBER),
    ).rejects.toThrow(AGENT_OWNER_AUTHORITY_MESSAGE);
    await expect(
      phone.execute(
        'completeClaudeSignIn',
        {
          workspaceId: WORKSPACE,
          agentId: AGENT,
          attemptId: '00000000-0000-4000-8000-000000000000',
          code: CODE,
        },
        MEMBER,
      ),
    ).rejects.toThrow(AGENT_OWNER_AUTHORITY_MESSAGE);
    expect(helperFrames).toEqual([]);
  });

  it('refuses an agent that does not run Claude', async () => {
    await expect(
      phone.execute('startClaudeSignIn', { workspaceId: WORKSPACE, agentId: OTHER_AGENT }, OWNER),
    ).rejects.toThrow('only for agents that run Claude');
    expect(helperFrames).toEqual([]);
  });

  it('says the machine is offline instead of waiting when no helper is connected', async () => {
    await database.query(`UPDATE agent_connections SET released_at=now() WHERE agent_id=$1`, [AGENT]);
    const started = Date.now();
    await expect(
      phone.execute('startClaudeSignIn', { workspaceId: WORKSPACE, agentId: AGENT }, OWNER),
    ).rejects.toThrow(CLAUDE_SIGN_IN_OFFLINE_MESSAGE);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(helperFrames).toEqual([]);
  });

  it('stops waiting with a clear message when a connected helper never answers', async () => {
    await expect(startClaudeSignIn(database, live, AGENT, { timeoutMs: 100 })).rejects.toThrow(
      CLAUDE_SIGN_IN_NO_ANSWER_MESSAGE,
    );
    expect(helperFrames.map((frame) => frame.step)).toEqual(['start']);
  });

  it("surfaces the helper's bad or expired code verdict to the owner", async () => {
    const rejected =
      'Claude did not accept that code. Paste the newest code from claude.ai, or tap Sign in to Claude again.';
    helper((event) =>
      event.step === 'start'
        ? { authorizeUrl: 'https://claude.com/cai/oauth/authorize' }
        : { outcome: 'failed', error: rejected },
    );
    const { attemptId } = await phone.execute(
      'startClaudeSignIn',
      { workspaceId: WORKSPACE, agentId: AGENT },
      OWNER,
    );
    await expect(
      phone.execute(
        'completeClaudeSignIn',
        { workspaceId: WORKSPACE, agentId: AGENT, attemptId, code: 'expired-code' },
        OWNER,
      ),
    ).rejects.toThrow(rejected);
  });

  it("never lets another agent's helper answer this agent's sign-in", async () => {
    let attemptId = '';
    live.subscribeAll((event) => {
      if (event.type === 'claude-sign-in' && event.step === 'start') {
        attemptId = event.attemptId;
        void daemon.execute(
          'reportClaudeSignIn',
          { agentId: OTHER_AGENT, attemptId, authorizeUrl: 'https://evil.example/' },
          OTHER_AGENT,
        );
      }
    });
    await expect(startClaudeSignIn(database, live, AGENT, { timeoutMs: 300 })).rejects.toThrow(
      CLAUDE_SIGN_IN_NO_ANSWER_MESSAGE,
    );
    expect(attemptId).not.toBe('');
    await expect(
      daemon.execute(
        'reportClaudeSignIn',
        { agentId: AGENT, attemptId, authorizeUrl: 'https://evil.example/' },
        OTHER_AGENT,
      ),
    ).rejects.toThrow('daemon token does not own requested agent');
  });
});
