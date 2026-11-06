import { m9_createHash, m9_describe, m9_expect, m9_it, m9_requestGrant, m9_runGrantedCommand, mergedDescribe9, m10_describe, m10_expect, m10_it, m10_MESSAGE_REACTION_EMOJIS, m10_agentToolsFor, m10_reactToMessage, mergedDescribe10, m11_describe, m11_expect, m11_it, m11_createSchedule, m11_deleteSchedule, m11_listSchedules, m11_updateSchedule, mergedDescribe11, m14_describe, m14_expect, m14_it, m14_vi, m14_agentToolsFor, m14_connectorOfferDepsFromEnv, m14_offerConnector, m14_workbenchStatus, m14_pendingGrantToolCall, m14_resumePrompt, mergedDescribe14, m24_describe, m24_expect, m24_it, m24_callAgentTool, m24_assembleTurnPrompt, mergedDescribe24, m25_describe, m25_expect, m25_it, m25_callAgentTool, mergedDescribe25, m26_expect, m26_it, m26_vi, m26_callAgentTool, mergedDescribe26, fixtureScope8, fixtureScope12, fixtureScope16, fixtureScope18, fixtureScope20, fixtureScope21, fixtureScope23, fixtureScope24, type m10_AgentScheduleDeps } from './test-support-read-only-mcp.test-support.js';

mergedDescribe9("agent-grant-tools.test.ts", () => {
const scope8 = fixtureScope8();
m9_describe('request_grant carries the script an interpreter will run', () => {
const scope12 = fixtureScope12(scope8);


  m9_it('sends the file contents and its hash with the ask, and tells the agent so', async () => {
    const body = 'import os\nos.remove("/tmp/x")\n';
    const root = scope12.checkout(body);
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    const reply = await m9_requestGrant(
      { kind: 'command', target: 'python3 fix.py', purpose: 'clean up', reason: 'clean up' },
      {
        ...scope8.deps(
          { grantId: 'g-1', status: 'pending', auto: false, escalations: ['unseen-script'] },
          ops,
        ),
        scriptRoots: [root],
      },
    );
    m9_expect(ops[0]!.input.script).toEqual({
      path: 'fix.py',
      sha256: m9_createHash('sha256').update(body).digest('hex'),
      bytes: Buffer.byteLength(body),
      contents: body,
    });
    m9_expect(reply).toContain(
      'A human always answers this one because it runs a script whose contents nobody has read',
    );
    m9_expect(reply).toContain('the approval is bound to those bytes');
  });


  m9_it.each(['#!/bin/sh\n', ''])('binds a direct script with prefix %j to its bytes', async (prefix) => {
    const body = `${prefix}printf approved\n`;
    const root = scope12.checkout(body, 'approved');
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    await m9_requestGrant(
      { kind: 'command', target: './approved', purpose: 'run approved script', reason: 'run approved script' },
      { ...scope8.deps({ grantId: 'g', status: 'pending', auto: false }, ops), scriptRoots: [root] },
    );
    m9_expect(ops[0]!.input.script).toMatchObject({ path: './approved', contents: body,
      sha256: m9_createHash('sha256').update(body).digest('hex') });
  });


  m9_it('keeps native executable grants outside script roots unchanged', async () => {
    const root = scope12.checkout('unused');
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    await m9_requestGrant(
      { kind: 'command', target: '/bin/true', purpose: 'check execution', reason: 'check execution' },
      { ...scope8.deps({ grantId: 'g', status: 'approved', auto: true }, ops), scriptRoots: [root] },
    );
    m9_expect(ops[0]!.input.script).toBeUndefined();
  });


  m9_it('refuses a script too long to read honestly instead of truncating it', async () => {
    const root = scope12.checkout(`${Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n')}\n`);
    await m9_expect(
      m9_requestGrant(
        { kind: 'command', target: 'python3 fix.py', purpose: 'x', reason: 'x' },
        { ...scope8.deps({ grantId: 'g' }), scriptRoots: [root] },
      ),
    ).rejects.toThrow('will not be truncated');
  });


  m9_it('refuses a script outside the checkout and the scratch directory', async () => {
    const root = scope12.checkout('print(1)\n');
    await m9_expect(
      m9_requestGrant(
        { kind: 'command', target: 'python3 /etc/hosts', purpose: 'x', reason: 'x' },
        { ...scope8.deps({ grantId: 'g' }), scriptRoots: [root] },
      ),
    ).rejects.toThrow('cannot be shown on the approval card');
  });


  m9_it('asks without a body when the interpreter line names no file', async () => {
    const root = scope12.checkout('print(1)\n');
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    await m9_requestGrant(
      { kind: 'command', target: 'python3 -V', purpose: 'x', reason: 'x' },
      { ...scope8.deps({ grantId: 'g', status: 'pending', auto: false }, ops), scriptRoots: [root] },
    );
    m9_expect(ops[0]!.input.script).toBeUndefined();
  });
});
m9_describe('run_granted_command reports the Room boundary', () => {
  m9_it('names the corner when the read-only filesystem refused a write', async () => {
    const reply = await m9_runGrantedCommand(
      { argv: ['cp', 'a', 'b'] },
      {
        roomId: 'room-1',
        run: async () => ({
          grantId: 'g-1',
          exitCode: 1,
          timedOut: false,
          output: "cp: cannot create 'b': Read-only file system",
          writeRefused: true,
        }),
      },
    );
    m9_expect(reply).toContain('read-only outside your scratch directory');
    m9_expect(reply).toContain('open_corner');
    m9_expect(reply).toContain('request_grant(kind:command, target, reason, purpose)');
    m9_expect(reply).toContain('run_granted_command');
  });


  m9_it('distinguishes a sandbox startup failure from the command exit status', async () => {
    const reply = await m9_runGrantedCommand(
      { argv: ['git', 'status'] },
      {
        roomId: 'room-1',
        run: async () => ({
          grantId: 'g-2',
          exitCode: 1,
          timedOut: false,
          output: 'bwrap: No permissions to create a new namespace',
          sandboxFailure: true,
        }),
      },
    );
    m9_expect(reply).toContain('sandbox failed before command start');
    m9_expect(reply).not.toContain('exit 1');
    m9_expect(reply).toContain('request_grant(kind:command, target, reason, purpose)');
    m9_expect(reply).toContain('run_granted_command');
  });
});
});
mergedDescribe10("agent-reaction-tools.test.ts", () => {m10_describe('beeline-agent reaction tool', () => {
  m10_it('declares the supported emoji and is available on every agent conversation surface', () => {
    for (const tools of [
      m10_agentToolsFor(true, false),
      m10_agentToolsFor(true, true),
      m10_agentToolsFor(true, false, true),
    ]) {
      const tool = tools.find((entry) => entry.name === 'react_to_message');
      m10_expect(tool?.inputSchema).toMatchObject({
        required: ['messageId', 'emoji'],
        properties: { emoji: { enum: [...m10_MESSAGE_REACTION_EMOJIS] } },
      });
    }
    m10_expect(m10_agentToolsFor(false, false).map((tool) => tool.name)).not.toContain('react_to_message');
  });


  m10_it('reacts as the authenticated agent in the current Room', async () => {
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const deps: m10_AgentScheduleDeps = {
      roomId: 'room-1',
      execute: async (name, input) => {
        calls.push({ name, input });
        return { id: 'write-1', createdAt: 1 };
      },
    };

    await m10_expect(m10_reactToMessage({ messageId: 'message-1', emoji: '🎉' }, deps)).resolves.toBe(
      'Reacted 🎉 to message message-1.',
    );
    m10_expect(calls).toEqual([
      {
        name: 'reactToRoomMessage',
        input: { roomId: 'room-1', messageId: 'message-1', emoji: '🎉' },
      },
    ]);
  });


  m10_it('refuses unsupported emoji before calling the daemon', async () => {
    const calls: string[] = [];
    const deps: m10_AgentScheduleDeps = {
      roomId: 'room-1',
      execute: async (name) => {
        calls.push(name);
        return {};
      },
    };

    await m10_expect(m10_reactToMessage({ messageId: 'message-1', emoji: '🔥' }, deps)).rejects.toThrow(
      /emoji must be one of/,
    );
    m10_expect(calls).toEqual([]);
  });
});
});
mergedDescribe11("agent-schedule-tools.test.ts", () => {
const scope16 = fixtureScope16();
m11_describe('beeline-agent schedule tools', () => {
  m11_it('carries the workflow target through create/update and names it in list_schedules', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    await m11_createSchedule(
      { prompt: 'Scan', workflowName: 'daily', cadence: { kind: 'interval', everyMinutes: 1 } },
      scope16.deps(ops),
    );
    await m11_updateSchedule({ scheduleId: 'sched-1', workflowName: 'daily' }, scope16.deps(ops));
    m11_expect(ops.map((op) => op.input.workflowName)).toEqual(['daily', 'daily']);
    const activeRunId = 'b'.repeat(64);
    const listed = await m11_listSchedules({
      roomId: 'room-1',
      execute: async () => ({
        schedules: [
          {
            scheduleId: 'sched-1',
            agentId: 'agent-1',
            prompt: 'Scan',
            cadence: { kind: 'interval', everyMinutes: 1 },
            workflowName: 'daily',
            activeRunIds: [activeRunId],
          },
        ],
      }),
    });
    m11_expect(listed).toContain('Workflow daily');
    m11_expect(listed).toContain(`Active run IDs: ${activeRunId}`);
  });


  m11_it('create_schedule calls createAgentSchedule and reports the 1-minute floor', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    const result = await m11_createSchedule(
      {
        prompt: "message 'hello @bananaman614305'",
        cadence: { kind: 'interval', everyMinutes: 0.5 },
      },
      scope16.deps(ops),
    );
    m11_expect(ops).toEqual([
      {
        name: 'createAgentSchedule',
        input: {
          roomId: 'room-1',
          prompt: "message 'hello @bananaman614305'",
          cadence: { kind: 'interval', everyMinutes: 1 },
        },
      },
    ]);
    m11_expect(result).toContain('sched-1');
    m11_expect(result).toContain('The minimum cadence is 1 minute');
    m11_expect(result).toContain('every 1 minute');
  });


  m11_it('passes a short title on create and title-only updates', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    await m11_createSchedule({ title: 'Morning card', prompt: 'Summarize.',
      cadence: { kind: 'interval', everyMinutes: 60 } }, scope16.deps(ops));
    await m11_updateSchedule({ scheduleId: 'sched-1', title: 'Owner card' }, scope16.deps(ops));
    m11_expect(ops[0]?.input.title).toBe('Morning card');
    m11_expect(ops[1]).toEqual({ name: 'updateAgentSchedule',
      input: { roomId: 'room-1', scheduleId: 'sched-1', title: 'Owner card' } });
  });


  m11_it('create_schedule accepts cron cadences without a floor note', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    const result = await m11_createSchedule(
      { prompt: 'Ping.', cadence: { kind: 'cron', expression: '*/5 * * * *' } },
      scope16.deps(ops),
    );
    m11_expect(ops[0]?.input.cadence).toEqual({ kind: 'cron', expression: '*/5 * * * *' });
    m11_expect(result).not.toContain('minimum');
    m11_expect(result).toContain('cron');
  });


  m11_it('create_schedule rejects invalid arguments', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    await m11_expect(
      m11_createSchedule({ prompt: ' ', cadence: { kind: 'interval', everyMinutes: 5 } }, scope16.deps(ops)),
    ).rejects.toThrow('prompt must be a non-empty string');
    await m11_expect(
      m11_createSchedule({ prompt: 'p', cadence: { kind: 'interval', everyMinutes: 0 } }, scope16.deps(ops)),
    ).rejects.toThrow('everyMinutes');
    await m11_expect(
      m11_createSchedule({ prompt: 'p', cadence: { kind: 'cron', expression: '* * * *' } }, scope16.deps(ops)),
    ).rejects.toThrow('five fields');
    m11_expect(ops).toEqual([]);
  });


  m11_it('list_schedules formats the daemon list', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    const result = await m11_listSchedules(scope16.deps(ops));
    m11_expect(ops).toEqual([{ name: 'listAgentSchedules', input: { roomId: 'room-1' } }]);
    m11_expect(result).toContain('sched-1 (@rival)');
    m11_expect(result).toContain('every 1 minute(s)');
    m11_expect(result).toContain('(2/5 runs)');
    m11_expect(result).toContain('message hello');
    m11_expect(
      await m11_listSchedules({
        roomId: 'room-1',
        execute: async () => ({ schedules: [] }),
      }),
    ).toBe('No schedules in this Room.');
  });


  m11_it('list_schedules names a schedule\'s still-active workflow runs', async () => {
    const activeRunId = 'b'.repeat(64);
    const result = await m11_listSchedules({
      roomId: 'room-1',
      execute: async () => ({
        schedules: [
          {
            scheduleId: 'sched-1',
            agentId: 'agent-1',
            agentHandle: 'rival',
            prompt: 'hello',
            cadence: { kind: 'interval', everyMinutes: 1 },
            runCount: 2,
            activeRunIds: [activeRunId],
          },
        ],
      }),
    });
    m11_expect(result).toContain(`Active run IDs: ${activeRunId}`);
  });


  m11_it('delete_schedule calls deleteAgentSchedule scoped to this Room', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    const result = await m11_deleteSchedule({ scheduleId: 'sched-1' }, scope16.deps(ops));
    m11_expect(ops).toEqual([
      { name: 'deleteAgentSchedule', input: { roomId: 'room-1', scheduleId: 'sched-1' } },
    ]);
    m11_expect(result).toBe('Schedule sched-1 deleted.');
  });


  m11_it('update_schedule sends only the fields given, scoped to this Room', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    const result = await m11_updateSchedule(
      {
        scheduleId: 'sched-1',
        prompt: ' Summarize. ',
        cadence: { kind: 'interval', everyMinutes: 60 },
      },
      scope16.deps(ops),
    );
    m11_expect(ops).toEqual([
      {
        name: 'updateAgentSchedule',
        input: {
          roomId: 'room-1',
          scheduleId: 'sched-1',
          prompt: 'Summarize.',
          cadence: { kind: 'interval', everyMinutes: 60 },
        },
      },
    ]);
    m11_expect(result).toBe('Schedule sched-1 updated. Next run 2027-01-15T08:00:00.000Z.');
    await m11_expect(m11_updateSchedule({ scheduleId: 'sched-1' }, scope16.deps(ops))).rejects.toThrow(
      'give a prompt, cadence, title, or workflowName to change',
    );
    m11_expect(ops).toHaveLength(1);
  });
});
});
mergedDescribe14("connector-offer-tools.test.ts", () => {
const scope18 = fixtureScope18();
m14_describe('beeline-agent connectors_status + offer_connector (R5)', () => {
  m14_it('pauses a connect call on its committed sign-in or approval card, including MCP text content', () => {
    for (const status of ['needs_sign_in', 'needs_approval']) {
      const text = JSON.stringify({ status, app: 'Link' });
      m14_expect(m14_pendingGrantToolCall({ title: 'beeline-agent.connect', content: text })).toBe(true);
      m14_expect(m14_pendingGrantToolCall({ title: 'beeline-agent.connect', content: { content: [{ type: 'text', text }] } })).toBe(true);
    }
    m14_expect(m14_pendingGrantToolCall({ title: 'beeline-agent.connect', content: '{"status":"ready"}' })).toBe(false);
  });

  m14_it('uses this machine broker report when no Squire route is granted', async () => {
    m14_vi.stubEnv('BEELINE_DAEMON_ROOM_ID', 'room-1');
    m14_vi.stubEnv('BEELINE_SQUIRE_RELAY_URL', '');
    m14_vi.stubEnv('BEELINE_SQUIRE_RELAY_TOKEN', '');
    try {
      const runtime = m14_connectorOfferDepsFromEnv();
      m14_expect(runtime.squireReach).toBeUndefined();
      const text = await m14_workbenchStatus(scope18.deps({
        machine: { name: 'squire', squire: { status: 'connected', reportedAt: 1 } },
        catalog: [{
          connectorType: 'trusty-squire', name: 'Trusty Squire', purpose: 'A vault.',
        }] }, [], { squireReach: runtime.squireReach }));
      m14_expect(text).toContain('Trusty Squire): connected on squire');
    } finally { m14_vi.unstubAllEnvs(); }
  });

  m14_it('mounts discovery in every turn while connector offers stay in Rooms and DMs', () => {
    for (const directMessage of [false, true]) {
      const names = m14_agentToolsFor(true, directMessage).map((tool) => tool.name);
      m14_expect(names).not.toContain('connectors_status');
      m14_expect(names).not.toContain('workbench_status');
      m14_expect(names).toContain('connect');
      m14_expect(names).not.toContain('offer_connector');
    }
    const corner = m14_agentToolsFor(true, false, true).map((tool) => tool.name);
    m14_expect(corner).toContain('connect');
    m14_expect(corner).not.toContain('offer_connector');
    m14_expect(m14_agentToolsFor(false, false).map((tool) => tool.name)).not.toContain('offer_connector');
  });


  m14_it('advertises silent readiness and separate connection permission', () => {
    const tool = m14_agentToolsFor(true, false).find(entry => entry.name === 'connect')!;
    m14_expect(tool.description).toContain('status silently reads readiness');
    m14_expect(tool.description).toContain('Setup never grants use authority');
    m14_expect(tool.description).toContain('Never show secrets/sign-in links');
  });


  m14_it('connect exposes service and machine flags while legacy offer calls stay hidden', () => {
    const names = m14_agentToolsFor(true, false).map(tool => tool.name);
    m14_expect(names).not.toContain('offer_connector');
    m14_expect(names).not.toContain('connect_app');
    const tool = m14_agentToolsFor(true, false).find(entry => entry.name === 'connect')!;
    m14_expect(tool.inputSchema.required).toEqual(['mode']);
    m14_expect(tool.inputSchema.properties).toHaveProperty('switchGoogleAccount');
    m14_expect(tool.inputSchema.properties).toHaveProperty('reconnect');
    m14_expect(tool.inputSchema.properties).toHaveProperty('noApi');
  });


  m14_it('workbench_status renders the catalog, the paired state, and connections by name only', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    const text = await m14_workbenchStatus(
      scope18.deps(
        {
          addressee: { identityId: 'zeke-id', name: 'Zeke', handle: 'zeke' },
          owner: { identityId: 'moon-id', name: 'Moonscanner', handle: 'moonscanner' },
          machine: { machineId: 'machine-1', name: 'otter-laptop' },
          catalog: [
            {
              connectorType: 'trusty-squire',
              name: 'Trusty Squire',
              purpose: 'A credential vault.',
              available: true,
              offerable: true,
            },
            {
              connectorType: 'google-gmail',
              name: 'Gmail',
              purpose: 'Mail.',
              available: true,
              offerable: true,
              paired: { status: 'connected', helperName: 'otter-laptop', onThisMachine: true },
            },
            {
              connectorType: 'wallet',
              name: 'Wallet',
              purpose: 'A wallet.',
              available: true,
              offerable: false,
            },
            {
              connectorType: 'tailscale',
              name: 'Tailscale',
              purpose: 'Network.',
              available: true,
              offerable: true,
            },
          ],
          connections: [
            { connectorType: 'trusty-squire', service: '1inch', label: '1inch API key', state: 'active' },
          ],
        },
        ops,
      ),
    );
    m14_expect(ops).toEqual([{ name: 'readAgentWorkbench', input: { roomId: 'room-1' } }]);
    m14_expect(text).toContain('Connectors for @moonscanner');
    m14_expect(text).not.toContain('Connectors for @zeke');
    m14_expect(text).toContain('on otter-laptop');
    m14_expect(text).toContain(
      '- trusty-squire (Trusty Squire): not added. A credential vault.',
    );
    m14_expect(text).toContain('- google-gmail (Gmail): connected on otter-laptop (your machine). Mail.');
    m14_expect(text).toContain('- wallet (Wallet): not added — call connect.');
    m14_expect(text).toContain(
      '- tailscale (Tailscale): not added — call connect. Network.',
    );
    m14_expect(text).toContain('- 1inch API key (1inch) via trusty-squire');
    // Names only: nothing in the view carries a value, and the text prints nothing but names.
    m14_expect(text).not.toMatch(/secret|password|token=/i);
  });


  m14_it('shows the provider failure reason for an app', async () => {
    const status = await m14_workbenchStatus(scope18.deps({
      owner: { name: 'Owner' }, catalog: [], connections: [],
      apps: [{ appId: 'app-instagram', appKey: 'instagram', name: 'Instagram',
        transport: 'composio', status: 'error',
        errorMessage: 'Instagram needs a Business or Creator account' }],
    }));
    m14_expect(status).toContain('Instagram (app:instagram, id app-instagram) via composio: error — Instagram needs a Business or Creator account');
  });


  m14_it('checks local Trusty Squire reachability and names an unreachable cause', async () => {
    const view = {
      owner: { name: 'Owner' }, machine: { name: 'Owner laptop' },
      catalog: [{ connectorType: 'trusty-squire', name: 'Trusty Squire',
        purpose: 'A credential vault.', available: true, offerable: true,
        paired: { status: 'error', helperName: 'Owner laptop', onThisMachine: true,
          errorMessage: 'Earlier install failed' } }],
      connections: [],
    };
    const reachable = await m14_workbenchStatus(scope18.deps(view, [], {
      squireReach: async () => ({ reachable: true }),
    }));
    m14_expect(reachable).toContain('Trusty Squire): connected on Owner laptop');
    const unreachable = await m14_workbenchStatus(scope18.deps(view, [], {
      squireReach: async () => ({ reachable: false, cause: 'MCP did not respond' }),
    }));
    m14_expect(unreachable).toContain('Trusty Squire): error on Owner laptop');
    m14_expect(unreachable).toContain('MCP did not respond');
  });


  m14_it('installs Tailscale when it is enabled on this machine and the CLI is missing', async () => {
    const ensured: boolean[] = [];
    const text = await m14_workbenchStatus(
      scope18.deps(
        {
          addressee: { identityId: 'zeke-id', name: 'Zeke', handle: 'zeke' },
          owner: { identityId: 'moon-id', name: 'Moonscanner', handle: 'moonscanner' },
          machine: { machineId: 'machine-1', name: 'chode' },
          catalog: [
            {
              connectorType: 'tailscale',
              name: 'Tailscale',
              purpose: 'Network.',
              available: true,
              offerable: true,
              paired: { status: 'connected', helperName: 'chode', onThisMachine: true },
            },
          ],
          connections: [],
        },
        [],
        {
          tailscaleReach: async (enabled) => {
            ensured.push(enabled);
            return "I can't reach Tailscale on this machine because the CLI is not installed; to fix it, the connector will install it and send the owner a login link.";
          },
        },
      ),
    );
    m14_expect(ensured).toEqual([true]);
    m14_expect(text).toContain('Connectors for @moonscanner');
    m14_expect(text).toContain(
      "I can't reach Tailscale on this machine because the CLI is not installed; to fix it, the connector will install it and send the owner a login link.",
    );
  });


  m14_it('offer_connector posts one offer and tells the agent its turn is paused on the card', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    const reply = await m14_offerConnector(
      { connectorType: 'trusty-squire', reason: '  provision the 1inch API key\n into its vault ' },
      scope18.deps({ offerId: 'o-1', status: 'pending', messageId: 'm-1', joined: false }, ops),
    );
    m14_expect(ops).toEqual([
      {
        name: 'offerConnector',
        input: {
          roomId: 'room-1',
          connectorType: 'trusty-squire',
          reason: 'provision the 1inch API key into its vault',
        },
      },
    ]);
    m14_expect(reply).toMatch(/^pending, card posted: add trusty-squire \[offer o-1\]/);
    m14_expect(reply).toContain('your turn is paused on this offer');
    m14_expect(reply).toContain('Do not ask them to open Settings or the Connectors page');
    // The room turn recognises that reply as a pause, exactly like a grant card.
    m14_expect(m14_pendingGrantToolCall({ title: 'beeline-agent.offer_connector', content: reply })).toBe(true);
    const joined = await m14_offerConnector(
      { connectorType: 'trusty-squire', reason: 'provision the 1inch API key into its vault' },
      scope18.deps({ offerId: 'o-1', status: 'pending', messageId: 'm-1', joined: true }),
    );
    m14_expect(joined).toMatch(/^already offered, card still open: add trusty-squire \[offer o-1\]/);
    m14_expect(m14_pendingGrantToolCall({ title: 'offer_connector', content: joined })).toBe(true);
  });


  m14_it('offer_connector with intent switch asks to replace the bound Squire account and pauses the turn', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    const reply = await m14_offerConnector(
      { connectorType: 'trusty-squire', reason: 'sign up with your work account', intent: 'switch' },
      scope18.deps({ offerId: 'o-2', status: 'pending', messageId: 'm-2', joined: false }, ops),
    );
    m14_expect(ops).toEqual([
      {
        name: 'offerConnector',
        input: {
          roomId: 'room-1',
          connectorType: 'trusty-squire',
          reason: 'sign up with your work account',
          intent: 'switch',
        },
      },
    ]);
    m14_expect(reply).toMatch(/^pending, card posted: switch trusty-squire account \[offer o-2\]/);
    m14_expect(m14_pendingGrantToolCall({ title: 'offer_connector', content: reply })).toBe(true);
    const joined = await m14_offerConnector(
      { connectorType: 'trusty-squire', reason: 'sign up with your work account', intent: 'switch' },
      scope18.deps({ offerId: 'o-2', status: 'pending', messageId: 'm-2', joined: true }),
    );
    m14_expect(m14_pendingGrantToolCall({ title: 'offer_connector', content: joined })).toBe(true);
    await m14_expect(
      m14_offerConnector({ connectorType: 'trusty-squire', reason: 'x', intent: 'add' }, scope18.deps({ offerId: 'never' })),
    ).rejects.toThrow('intent must be "switch" when given');
  });


  m14_it('refuses a non-offerable kind and an empty reason before the server is called', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    const answer = scope18.deps({ offerId: 'never' }, ops);
    await m14_expect(m14_offerConnector({ connectorType: 'google-gmail', reason: 'hold funds' }, answer)).rejects.toThrow(
      'connectorType must be one of',
    );
    await m14_expect(m14_offerConnector({ connectorType: 'trusty-squire', reason: '  ' }, answer)).rejects.toThrow(
      'reason must be a non-empty string',
    );
    await m14_expect(
      m14_offerConnector({ connectorType: 'trusty-squire', reason: 'x'.repeat(201) }, answer),
    ).rejects.toThrow('reason is too long');
    m14_expect(ops).toEqual([]);
  });


  m14_it('a connector-offer decision resumes the turn with the offer answer, not a grant verdict', () => {
    const prompt = m14_resumePrompt({
      body: '@zeke added Trusty Squire',
      systemEvent: {
        subject: { kind: 'person', id: 'zeke-id', name: '@zeke' },
        verb: 'added',
        kind: 'connector-offer-decided',
        object: { text: 'Trusty Squire' },
      },
    });
    m14_expect(prompt).toContain('This is the answer to your connector offer: @zeke added Trusty Squire.');
    m14_expect(prompt).toContain('Adding Trusty Squire now.');
    m14_expect(prompt).not.toContain('grant');
    const grant = m14_resumePrompt({
      body: '@owner approved once command npm test',
      systemEvent: {
        subject: { kind: 'person', id: 'owner-id', name: '@owner' },
        verb: 'approved once',
        kind: 'grant-decided',
        object: { text: 'command npm test' },
      },
    });
    m14_expect(grant).toContain('This is the answer to your grant request');
  });


  m14_it('a Squire approval decision resumes the turn with what was approved or denied', () => {
    const approved = m14_resumePrompt({
      body: 'Trusty Squire approved Purchase approval · MUJI order · at MUJI',
      systemEvent: {
        subject: { kind: 'person', id: 'trusty-squire', name: 'Trusty Squire' },
        verb: 'approved',
        kind: 'squire-approval-decided',
        object: { text: 'Purchase approval' },
        consequence: 'MUJI order · at MUJI',
      },
    });
    m14_expect(approved).toContain(
      "This is Trusty Squire's answer to the approval you were waiting on: Trusty Squire approved Purchase approval · MUJI order · at MUJI.",
    );
    m14_expect(approved).toContain('continue exactly where you left off with Trusty Squire');
    m14_expect(approved).not.toContain('grant request');
    const denied = m14_resumePrompt({
      body: 'Trusty Squire denied Purchase approval',
      systemEvent: {
        subject: { kind: 'person', id: 'trusty-squire', name: 'Trusty Squire' },
        verb: 'denied',
        kind: 'squire-approval-decided',
        object: { text: 'Purchase approval' },
      },
    });
    m14_expect(denied).toContain('If it was denied, stop that Trusty Squire action');
  });
});
});
mergedDescribe24("place-capabilities.test.ts", () => {
const scope20 = fixtureScope20();
m24_describe.each(scope20.PLACES.flatMap(place => [false, true].map(repositoryOnboarding => ({ ...place, repositoryOnboarding }))))('$name onboarding=$repositoryOnboarding', ({ corner, surface, commandReason, repositoryOnboarding }) => {
const scope21 = fixtureScope21(scope20, { corner, surface, commandReason, repositoryOnboarding });

  m24_it('discovery offers only Beeline apps that answer there, and every app that answers is offered', async () => {
    scope20.useEnvironment(corner);
    const offered = await scope20.discovered(corner);
    m24_expect(offered.length).toBeGreaterThan(0);
    for (const app of offered) {
      const answer = JSON.parse(await m24_callAgentTool('app_tool', { app }, 'discover')) as { tools: unknown[] };
      m24_expect(answer.tools.length, app).toBeGreaterThan(0);
    }
    for (const app of scope20.ALL_APPS.filter(app => !offered.includes(app)))
      await m24_expect(m24_callAgentTool('app_tool', { app }, 'discover'), app).rejects.toThrow('Beeline apps here');
  });


  m24_it('states the discovered apps in one short block of the turn prompt', async () => {
    scope20.useEnvironment(corner);
    const offered = await scope20.discovered(corner);
    const prompt = m24_assembleTurnPrompt({ surface, onboarding: repositoryOnboarding, task: { body: 'Check the deploy.', commandReason } });
    const block = prompt.text.split('\n\n').find(paragraph => paragraph.startsWith('Works here ('));
    m24_expect(block).toBeDefined();
    m24_expect(Buffer.byteLength(block!)).toBeLessThanOrEqual(260);
    const [works, cornerOnly = ''] = block!.split('Corner only:');
    m24_expect(scope20.appsIn(works!)).toEqual(offered);
    m24_expect(scope20.appsIn(cornerOnly)).toEqual([]);
    m24_expect(block!.includes('schedule run')).toBe(commandReason === 'schedule');
  });
});
});
mergedDescribe25("read-only-mcp.corner-message.test.ts", () => {m25_describe('corner-turn get_room_message room targeting', () => {
const scope23 = fixtureScope23();


  m25_it('reads a transcript message id from the corner Room, not the parent env Room', async () => {
    scope23.answer = () =>
      Response.json({
        messageId: 'corner-transcript-id',
        body: 'The corner message the turn is asked to act on',
        attachments: [],
      });
    const result = JSON.parse(
      await m25_callAgentTool(
        'read', { facet: "message", ...{ messageId: 'corner-transcript-id' } },
        'call-1',
      ),
    );
    m25_expect(result.body).toBe('The corner message the turn is asked to act on');
    m25_expect(scope23.calls).toEqual([
      {
        name: 'getRoomMessage',
        input: m25_expect.objectContaining({
          roomId: 'corner-room',
          messageId: 'corner-transcript-id',
          requestId: 'request-1',
          generationId: 'generation-1',
        }),
      },
    ]);
    m25_expect(scope23.calls[0]!.input.roomId).not.toBe('parent-room');
  });


  m25_it('keeps the offset page on the corner read', async () => {
    await m25_callAgentTool(
      'read', { facet: "message", ...{ messageId: 'corner-transcript-id', cursor: { offset: 4000 } } },
      'call-2',
    );
    m25_expect(scope23.calls[0]!.input).toMatchObject({
      roomId: 'corner-room',
      messageId: 'corner-transcript-id',
      offset: 4000,
    });
  });
});
});
mergedDescribe26("read-only-mcp.onboarding.test.ts", () => {
const scope24 = fixtureScope24();


m26_it('discovers cards and Room invitations without an external connection and binds writes to the active turn',async()=>{
  const discovered=JSON.parse(await m26_callAgentTool('app_tool',{app:'beeline:onboarding'},'discover'));
  m26_expect(discovered.tools.map((t:{name:string})=>t.name)).toEqual(m26_expect.arrayContaining(['welcome','video_preview','invite','repository','starters']));
  scope24.calls.length = 0;
  await m26_callAgentTool('app_tool',{app:'beeline:onboarding',tool:'welcome',args:{}});
  m26_expect(scope24.calls.find(call => call.name === 'postStarterWelcome')!.input).toMatchObject({roomId:'room-1',requestId:'request-1',taskId:'command-1',generationId:scope24.context.generationId});
  for (const tool of ['repository','starters']) await m26_callAgentTool('app_tool',{app:'beeline:onboarding',tool,args:{}});
  m26_expect(scope24.calls.filter(call=>call.name === 'postRepositoryOnboarding').map(call=>call.name)).toEqual(['postRepositoryOnboarding','postRepositoryOnboarding']);
  m26_expect(scope24.calls.filter(call=>call.name === 'postRepositoryOnboarding').map(call=>call.input.kind)).toEqual(['repository','starters']);
  m26_expect(scope24.calls.find(call=>call.name === 'postRepositoryOnboarding')!.input).toMatchObject({roomId:'room-1',requestId:'request-1',generationId:scope24.context.generationId});
  await m26_callAgentTool('app_tool',{app:'beeline:onboarding',tool:'invite',args:{}});
  m26_expect(scope24.calls.filter(call=>call.name === 'postRoomInvite')).toEqual([{
    name:'postRoomInvite', input:{roomId:'room-1',requestId:'request-1',taskId:'command-1',generationId:scope24.context.generationId},
  }]);
});



m26_it('hides the new tools when server eligibility is absent', async () => {
  m26_vi.stubGlobal('fetch', async () => Response.json({resolution:'none'}));
  await m26_expect(m26_callAgentTool('app_tool',{app:'beeline:onboarding'},'discover')).rejects.toThrow('unavailable');
  const discovered = JSON.parse(await m26_callAgentTool('connect',{mode:'discover'},'discover'));
  m26_expect(discovered.capabilities).not.toContain('beeline:onboarding');
});
});
