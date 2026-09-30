import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { PhoneService } from './phone-service.js';

const WORKSPACE = '10000000-0000-4000-8000-000000000004';
const OWNER = 'a'.repeat(64);
const ADMIN = 'b'.repeat(64);
const MEMBER = 'c'.repeat(64);
const AGENT = 'd'.repeat(64);

let database: PgliteDatabase;
let phone: PhoneService;

beforeEach(async () => {
  database = new PgliteDatabase();
  await migrate(database);
  await database.query(
    `INSERT INTO identities(id,kind,name) VALUES
       ($1,'human','Owner'),($2,'human','Admin'),($3,'human','Member'),($4,'agent','Impy')`,
    [OWNER, ADMIN, MEMBER, AGENT],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [WORKSPACE]);
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,NULL,$2,'owner'),($1,NULL,$3,'admin'),($1,NULL,$4,'member'),($1,NULL,$5,'member')`,
    [WORKSPACE, OWNER, ADMIN, MEMBER, AGENT],
  );
  // The agent's own connected owner is MEMBER, not OWNER/ADMIN — custom tags
  // are a Workspace-manager authority, distinct from that agent-owner axis.
  await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [AGENT, MEMBER]);
  phone = new PhoneService(database, 'http://local.test');
});

describe('setAgentCustomTags', () => {
  it('lets a Workspace admin set tags on an agent it does not own', async () => {
    const result = await phone.execute(
      'setAgentCustomTags',
      { workspaceId: WORKSPACE, agentId: AGENT, tags: ['night-shift', 'trusted'] },
      ADMIN,
    );
    expect(result).toEqual({ tags: ['night-shift', 'trusted'] });
    const row = await database.query<{ custom_tags: string[] }>(
      `SELECT custom_tags FROM agents WHERE agent_id=$1`,
      [AGENT],
    );
    expect(row.rows[0]?.custom_tags).toEqual(['night-shift', 'trusted']);
  });

  it('lets the Workspace owner set tags', async () => {
    await expect(
      phone.execute(
        'setAgentCustomTags',
        { workspaceId: WORKSPACE, agentId: AGENT, tags: ['heavy-rotation'] },
        OWNER,
      ),
    ).resolves.toEqual({ tags: ['heavy-rotation'] });
  });

  it('refuses a plain Workspace member, including the agent’s own connected owner', async () => {
    await expect(
      phone.execute(
        'setAgentCustomTags',
        { workspaceId: WORKSPACE, agentId: AGENT, tags: ['night-shift'] },
        MEMBER,
      ),
    ).rejects.toThrow('workspace manager required');
  });

  it('rejects a malformed tag', async () => {
    await expect(
      phone.execute(
        'setAgentCustomTags',
        { workspaceId: WORKSPACE, agentId: AGENT, tags: ['Not Valid'] },
        ADMIN,
      ),
    ).rejects.toThrow('lowercase');
  });

  it('rejects more than the per-agent tag cap', async () => {
    const tags = Array.from({ length: 17 }, (_, index) => `tag-${index}`);
    await expect(
      phone.execute('setAgentCustomTags', { workspaceId: WORKSPACE, agentId: AGENT, tags }, ADMIN),
    ).rejects.toThrow('at most 16 tags');
  });

  it('rejects an unknown agent', async () => {
    await expect(
      phone.execute(
        'setAgentCustomTags',
        { workspaceId: WORKSPACE, agentId: 'f'.repeat(64), tags: [] },
        ADMIN,
      ),
    ).rejects.toThrow('agent not found in workspace');
  });

  it('clears custom tags with an empty array', async () => {
    await phone.execute(
      'setAgentCustomTags',
      { workspaceId: WORKSPACE, agentId: AGENT, tags: ['night-shift'] },
      ADMIN,
    );
    const result = await phone.execute(
      'setAgentCustomTags',
      { workspaceId: WORKSPACE, agentId: AGENT, tags: [] },
      ADMIN,
    );
    expect(result).toEqual({ tags: [] });
  });
});

describe('setWorkspaceWeightTierRules', () => {
  it('lets an admin set a custom family-pattern map', async () => {
    const rules = [{ pattern: 'astra*', tier: 'god' as const }, { pattern: '*mini*', tier: 'light' as const }];
    const result = await phone.execute(
      'setWorkspaceWeightTierRules',
      { workspaceId: WORKSPACE, rules },
      ADMIN,
    );
    expect(result).toEqual({ rules });
    const row = await database.query<{ weight_tier_rules: unknown }>(
      `SELECT weight_tier_rules FROM workspaces WHERE id=$1`,
      [WORKSPACE],
    );
    expect(row.rows[0]?.weight_tier_rules).toEqual(rules);
  });

  it('refuses a plain member', async () => {
    await expect(
      phone.execute(
        'setWorkspaceWeightTierRules',
        { workspaceId: WORKSPACE, rules: [{ pattern: 'astra*', tier: 'god' }] },
        MEMBER,
      ),
    ).rejects.toThrow('workspace manager required');
  });

  it('rejects a rule with an invalid tier', async () => {
    await expect(
      phone.execute(
        'setWorkspaceWeightTierRules',
        { workspaceId: WORKSPACE, rules: [{ pattern: 'astra*', tier: 'bogus' as never }] },
        ADMIN,
      ),
    ).rejects.toThrow('invalid weight tier rule');
  });

  it('resets to the shipped defaults with null', async () => {
    await phone.execute(
      'setWorkspaceWeightTierRules',
      { workspaceId: WORKSPACE, rules: [{ pattern: 'astra*', tier: 'god' }] },
      ADMIN,
    );
    const reset = await phone.execute(
      'setWorkspaceWeightTierRules',
      { workspaceId: WORKSPACE, rules: null },
      ADMIN,
    );
    expect(reset.rules.length).toBeGreaterThan(1);
    const row = await database.query<{ weight_tier_rules: unknown }>(
      `SELECT weight_tier_rules FROM workspaces WHERE id=$1`,
      [WORKSPACE],
    );
    expect(row.rows[0]?.weight_tier_rules).toBeNull();
  });
});
