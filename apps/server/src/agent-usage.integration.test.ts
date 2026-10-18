import capturedEvent from '../../body/src/fixtures/claude-rate-limit-event.json';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readAgentDetailView, readWorkspaceMemberListView } from '@beeline/api-contract/phone';
import { usagePrompt } from '@beeline/api-contract/daemon';
import { parseAcpUsage } from '../../body/src/acp.js';
import { DaemonService } from './daemon-service.js';
import { PhoneService } from './phone-service.js';
import { LiveHub } from './live.js';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';

const agent = 'a'.repeat(64),
  owner = 'b'.repeat(64),
  other = 'c'.repeat(64);
const workspace = '11111111-1111-4111-8111-111111111111';
const db = new PgliteDatabase();
const daemon = new DaemonService(db, new LiveHub());
const phone = new PhoneService(db, 'https://server.example');
beforeAll(async () => {
  await migrate(db);
  await db.query(
    `INSERT INTO identities(id,kind,name) VALUES($1,'agent','Agent'),($2,'human','Owner'),($3,'human','Other')`,
    [agent, owner, other],
  );
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Usage')`, [workspace]);
  await db.query(`INSERT INTO agents(agent_id,owner_id,harness) VALUES($1,$2,'claude')`, [
    agent,
    owner,
  ]);
  await db.query(
    `INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'member'),($1,$3,'owner'),($1,$4,'member')`,
    [workspace, agent, owner, other],
  );
});
afterAll(async () => db.close());

describe('daemon → stored usage → owner profile and Members', () => {
  it('merges partial windows, exposes the same figures to the prompt, and hides plans from other viewers', async () => {
    const captured = parseAcpUsage({
      sessionUpdate: 'usage_update',
      _meta: { '_claude/rateLimit': capturedEvent.rate_limit_info },
    })!;
    await daemon.execute('postAgentUsage', { agentId: agent, usage: captured }, agent);
    expect(
      (await phone.readAgent(workspace, agent, owner))?.usage?.windows.map((w) => w.utilization),
    ).toEqual([0.06, 0.16]);
    const event = {
      sessionUpdate: 'usage_update',
      used: 612000,
      size: 1000000,
      _meta: {
        '_claude/rateLimit': {
          status: 'allowed',
          rateLimitType: 'five_hour',
          utilization: 0.42,
          resetsAt: 1792343400,
        },
      },
    };
    const usage = parseAcpUsage(event)!;
    await daemon.execute('postAgentUsage', { agentId: agent, usage }, agent);
    await daemon.execute(
      'postAgentUsage',
      {
        agentId: agent,
        usage: parseAcpUsage({
          sessionUpdate: 'usage_update',
          _meta: {
            '_claude/rateLimit': {
              status: 'allowed_warning',
              rateLimitType: 'seven_day',
              utilization: 0.83,
              resetsAt: 1792659600,
            },
          },
        })!,
      },
      agent,
    );
    const profile = readAgentDetailView(await phone.readAgent(workspace, agent, owner));
    expect(profile?.usage?.windows.map((w) => [w.rateLimitType, w.utilization])).toEqual([
      ['five_hour', 0.42],
      ['seven_day', 0.83],
    ]);
    expect(profile?.usage?.context).toEqual({ used: 612000, size: 1000000 });
    expect(profile?.usage?.updatedAt).toBeGreaterThan(Date.now() / 1000 - 60);
    expect((await phone.readAgent(workspace, agent, other))?.usage).toBeUndefined();
    const members = await phone.readWorkspaceMembers(workspace, owner);
    expect(readWorkspaceMemberListView(members)?.agents[0]?.usage).toEqual(profile?.usage);
    expect((await phone.readWorkspaceMembers(workspace, other))?.agents[0]?.usage).toBeUndefined();
    const prompt = usagePrompt(
      (await daemon.execute('getAgentUsage', { agentId: agent }, agent)) ?? undefined,
    );
    expect(prompt).toContain('5-hour 42%');
    expect(prompt).toContain('weekly 83%');
    expect(usagePrompt()).toBe('Usage: unknown (harness reports none).');
    await expect(
      daemon.execute(
        'postAgentUsage',
        {
          agentId: agent,
          usage: {
            updatedAt: 1,
            windows: [
              { rateLimitType: 'five_hour', status: 'allowed', utilization: NaN, updatedAt: 1 },
            ],
          },
        },
        agent,
      ),
    ).rejects.toThrow('invalid agent usage');
    expect((await phone.readAgent(workspace, agent, owner))?.usage?.windows).toHaveLength(2);
  });
});

it('keeps a provider stop without inventing utilization and rejects another agent write', async () => {
  const stopped = parseAcpUsage({
    sessionUpdate: 'usage_update',
    _meta: {
      '_claude/rateLimit': {
        rateLimitType: 'five_hour',
        status: 'rejected',
        resetsAt: 1792347600,
      },
    },
  })!;
  await daemon.execute('postAgentUsage', { agentId: agent, usage: stopped }, agent);
  const profile = await phone.readAgent(workspace, agent, owner);
  expect(profile?.usage?.windows.find((w) => w.rateLimitType === 'five_hour')).toMatchObject({
    status: 'rejected',
  });
  expect(
    profile?.usage?.windows.find((w) => w.rateLimitType === 'five_hour')?.utilization,
  ).toBeUndefined();
  expect(profile?.usage?.windows).toHaveLength(2);
  await daemon.execute(
    'postAgentUsage',
    {
      agentId: agent,
      usage: {
        updatedAt: 1,
        windows: [
          { rateLimitType: 'five_hour', status: 'allowed', utilization: 0.01, updatedAt: 1 },
        ],
      },
    },
    agent,
  );
  expect((await phone.readAgent(workspace, agent, owner))?.usage?.windows[0]?.status).toBe(
    'rejected',
  );
  await expect(
    daemon.execute('postAgentUsage', { agentId: agent, usage: stopped }, other),
  ).rejects.toThrow('does not own');
});

it('reports the owner-wide free allowance with its UTC reset and keeps it private', async () => {
  await db.query(
    `INSERT INTO free_agents(agent_id,workspace_id,owner_id,sealed_keys) VALUES($1,$2,$3,'fixture')`,
    [agent, workspace, owner],
  );
  await db.query(
    `INSERT INTO free_agent_usage(owner_id,day,tokens) VALUES($1,(now() AT TIME ZONE 'UTC')::date,123000)`,
    [owner],
  );
  const profile = await phone.readAgent(workspace, agent, owner);
  expect(profile?.usage?.free).toMatchObject({ used: 123000, limit: 1000000 });
  expect(new Date(profile!.usage!.free!.resetsAt * 1000).toISOString()).toMatch(/T00:00:00.000Z$/);
  expect((await phone.readWorkspaceMembers(workspace, owner))?.agents[0]?.usage?.free).toEqual(
    profile?.usage?.free,
  );
  expect((await phone.readAgent(workspace, agent, other))?.usage).toBeUndefined();
  expect(usagePrompt(profile?.usage)).toContain('Usage: 123K of 1M free tokens today, resets');
});
