import { describe, it, expect } from 'vitest';
import { cornerCallText } from './read-only-mcp.js';
describe('corner text', () => {
  it('flattens an untidy call instead of refusing it', () => {
    // A grok-shaped call: the brief arrives with its line breaks intact.
    expect(
      cornerCallText({
        name: 'widget-ledger',
        objective: 'Ship the corner name parameter.\nMake grok able to open a corner.',
      }),
    ).toEqual({
      name: 'widget-ledger',
      objective: 'Ship the corner name parameter. Make grok able to open a corner.',
    });
  });

  it('refuses only what is genuinely too long, in a sentence naming the count', () => {
    expect(() =>
      cornerCallText({
        name: 'far too many words here',
        objective: 'Ship the widget',
      }),
    ).toThrow('the name must not contain whitespace; use hyphens between words');
    expect(() =>
      cornerCallText({
        name: 'widget-ledger',
        objective: Array.from({ length: 61 }, (_, index) => `word${index}`).join(' '),
      }),
    ).toThrow('the objective is 61 words; the limit is 24');
    expect(() => cornerCallText({ objective: 'Ship the widget' })).toThrow(
      'the name is required; give a title of at most 3 words',
    );
  });
});

import { Check } from 'typebox/value';
import { agentToolsFor, callAgentTool } from './read-only-mcp.js';
import { CAPABILITY_TOOLS, toolValidationSchema } from './minimal-tool-surface.js';

const schema = (name: string) => toolValidationSchema(name)!;

describe('canonical tool contracts', () => {
  it('requires explicit ownership and a complete brief with optional opening approval', () => {
    const input = {room:'11111111-1111-4111-8111-111111111111',implementer:'worker',brief:{spec:'Build the widget',approval:{sourceMessageId:'human-message'}}};
    expect(Check(schema('open_corner'),input)).toBe(true);
    expect(Check(schema('open_corner'),{...input,implementer:undefined})).toBe(false);
    expect(Check(schema('open_corner'),{...input,brief:{spec:'Build the widget'}})).toBe(true);
    expect(Check(schema('open_corner'),{...input,brief:{...input.brief,spec:''}})).toBe(false);
    const revision = {address:'child',action:'brief',brief:input.brief,expectedRevision:2,change:'Approved correction'};
    expect(Check(schema('revise_corner'),revision)).toBe(true);
    expect(Check(schema('revise_corner'),{...revision,brief:{spec:'Build the widget'}})).toBe(true);
    expect(Check(schema('revise_corner'),{address:revision.address,action:revision.action,brief:revision.brief,change:revision.change})).toBe(false);
    expect(Check(schema('revise_corner'),{address:'child',action:'metadata',name:'widget',brief:input.brief})).toBe(false);
    expect(Check(schema('revise_corner'),{address:'child',action:'install_brief',name:'widget',brief:input.brief})).toBe(true);
  });

  it('keeps sourced memory mutations and procedure upsert distinct', () => {
    const procedure = {kind:'procedure',action:'save',slug:'widget',description:'Build widgets',markdown:'Steps'};
    expect(Check(schema('remember'),procedure)).toBe(true);
    expect(Check(schema('remember'),{...procedure,action:'update'})).toBe(false);
    expect(Check(schema('remember'),{kind:'fact',action:'save',body:'Unattributed fact'})).toBe(false);
    expect(Check(schema('remember'),{kind:'fact',action:'delete',item_id:'item'})).toBe(false);
  });

  it('keeps memory query character limits inside the advertised schema and tool path', async () => {
    const searchSchema = schema('search');
    const memoryQuery = (query: string) => ({ scope: 'memory', query, limit: 1 });
    expect(searchSchema.properties.query.description).toMatch(/1–500 characters/);
    const withinCap = memoryQuery('🙂'.repeat(500));
    const overCap = memoryQuery('🙂'.repeat(501));

    expect(Buffer.byteLength(withinCap.query, 'utf8')).toBe(2_000);
    expect(Check(searchSchema, withinCap)).toBe(true);
    expect(Check(searchSchema, overCap)).toBe(false);
    await expect(callAgentTool('search', overCap, 'memory-search-over-cap'))
      .rejects.toThrow(/query: at most 500 characters/);
  });

  it('separates assignment completion, feedback, discovery and execution', () => {
    expect(Check(schema('report'),{status:'blocked',text:'blocked: input required'})).toBe(true);
    expect(Check(schema('report'),{category:'bug',summary:'Broken tool'})).toBe(false);
    expect(Check(schema('report_feedback'),{category:'bug',summary:'Broken tool'})).toBe(true);
    expect(Check(schema('app_tool'),{app:'beeline:workflow'})).toBe(true);
    expect(Check(schema('app_tool'),{app:'beeline:workflow',args:{}})).toBe(false);
    expect(Check(schema('app_tool'),{app:'beeline:workflow',tool:'read',args:{runId:'run'}})).toBe(true);
    for (const tools of Object.values(CAPABILITY_TOOLS)) for (const tool of Object.values(tools)) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.properties).toBeDefined();
    }
  });
});

import { describe as m7_describe, expect as m7_expect, it as m7_it } from 'vitest';

import { agentToolsFor as m7_agentToolsFor, askChoice as m7_askChoice, openPoll as m7_openPoll, type AgentGrantDeps as m7_AgentGrantDeps } from "./read-only-mcp.js";
import { describe as mergedDescribe7 } from 'vitest';
mergedDescribe7("agent-choice-tools.test.ts", () => {


function deps(
  answer: Record<string, unknown>,
  ops: Array<{ name: string; input: Record<string, unknown> }> = [],
): m7_AgentGrantDeps {
  return {
    roomId: 'room-1',
    execute: async (name, input) => {
      ops.push({ name, input: input as Record<string, unknown> });
      return answer;
    },
  };
}


const options = [
  { label: 'Kraken paper', consequence: 'Works with plugin auth' },
  { label: 'Keep waiting', consequence: 'Blocked on CDP JWT', costly: true },
];


m7_describe('the one app front door', () => {
  m7_it('mounts connect wherever an app can be used, and no retired connector tools anywhere', () => {
    const room = m7_agentToolsFor(true, false).map((tool) => tool.name);
    const dm = m7_agentToolsFor(true, true).map((tool) => tool.name);
    const corner = m7_agentToolsFor(true, false, true).map((tool) => tool.name);
    m7_expect(room).toContain('connect');
    m7_expect(dm).toContain('connect');
    m7_expect(corner).toContain('connect');
    for (const names of [room, dm, corner])
      for (const retired of [
        'connect_app',
        'offer_connector',
        'connect_mcp_server',
        'search_mcp_registry',
        'composio_tools',
        'composio_execute',
      ])
        m7_expect(names).not.toContain(retired);
  });
});


m7_describe('beeline-agent ask_choice and open_poll', () => {
  m7_it('keeps standalone preference cards out of the minimal surface', () => {
    for (const tools of [m7_agentToolsFor(true, false), m7_agentToolsFor(true, true), m7_agentToolsFor(true, false, true)]) {
      const names = tools.map(tool => tool.name);
      m7_expect(names).not.toContain('ask_choice');
      m7_expect(names).not.toContain('open_poll');
      const schema = tools.find(tool => tool.name === 'report')!.inputSchema;
      m7_expect(schema.required ?? []).not.toContain('ask');
      m7_expect(schema.properties?.ask).toMatchObject({ maxLength: 140, description: m7_expect.stringContaining('one sentence on one line') });
    }
  });

  m7_it('posts a choice with no agent-authored ask', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    await m7_askChoice({ prompt: 'Ship the OTA tonight?', options }, deps({ choiceId: 'c-1' }, ops));
    m7_expect(ops[0]?.input.prompt).toBe('Ship the OTA tonight?');
    m7_expect(ops[0]?.input).not.toHaveProperty('ask');
  });

  m7_it('posts ask_choice without pausing the turn', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    const reply = await m7_askChoice(
      {
        ask: 'Which approach should we use?',
        prompt: 'How do you want to push the desk past this?',
        constraint: 'CDP AgentKit needs JWT signing',
        options,
        ttl: 900,
      },
      deps({ choiceId: 'c-1', messageId: 'm-1', mode: 'question', electorateCount: 1 }, ops),
    );
    m7_expect(ops).toEqual([
      {
        name: 'askRoomChoice',
        input: {
          roomId: 'room-1',
          ask: 'Which approach should we use?',
        prompt: 'How do you want to push the desk past this?',
          constraint: 'CDP AgentKit needs JWT signing',
          options,
          ttlSeconds: 900,
        },
      },
    ]);
    m7_expect(reply).toContain('posted [c-1]');
    m7_expect(reply).toContain('not paused');
    m7_expect(reply).not.toContain('paused on this grant');
  });

  m7_it('posts open_poll as a fact, never a mandate', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    const reply = await m7_openPoll(
      { prompt: 'Which paper API?', options, ttl: 3600 },
      deps(
        {
          choiceId: 'c-2',
          messageId: 'm-2',
          mode: 'poll',
          electorateCount: 4,
          closesAt: 1_800_000_000,
        },
        ops,
      ),
    );
    m7_expect(ops[0]).toEqual({
      name: 'openRoomPoll',
      input: {
        roomId: 'room-1',
        prompt: 'Which paper API?',
        options,
        ttlSeconds: 3600,
      },
    });
    m7_expect(reply).toContain('electorate 4');
    m7_expect(reply).toContain('preference fact');
    m7_expect(reply).toContain('tie or no votes');
  });
});
});

import { describe as m8_describe, expect as m8_expect, it as m8_it } from 'vitest';

import {
  agentToolsFor as m8_agentToolsFor,
  emitEvent as m8_emitEvent,
  listEventSubscriptions as m8_listEventSubscriptions,
  subscribeEvents as m8_subscribeEvents,
  setWakeDelivery as m8_setWakeDelivery,
  type AgentScheduleDeps as m8_AgentScheduleDeps,
} from "./read-only-mcp.js";
import { describe as mergedDescribe8 } from 'vitest';
mergedDescribe8("agent-event-tools.test.ts", () => {


type Call = { name: string; input: Record<string, unknown> };


function deps(
  calls: Call[],
  answers: Record<string, Record<string, unknown> | Error> = {},
): m8_AgentScheduleDeps {
  return {
    roomId: 'room-1',
    execute: async (name, input) => {
      calls.push({ name, input: input as Record<string, unknown> });
      const answer = answers[name];
      if (answer instanceof Error) throw answer;
      return answer ?? { id: 'w', createdAt: 1 };
    },
  };
}


m8_describe('beeline-agent event tools', () => {
  m8_it('sets its own whole inbox setting without transmitting an agent identity', async () => {
    const calls: Call[] = [];
    const result = await m8_setWakeDelivery({ delivery: 'batch:5', agentId: 'someone-else' },
      deps(calls, { setWakeDelivery: { delivery: 'batch:5' } }));
    m8_expect(calls).toEqual([{ name: 'setWakeDelivery', input: { roomId: 'room-1', delivery: 'batch:5' } }]);
    m8_expect(result).toContain('batch:5');
    await m8_expect(m8_setWakeDelivery({ delivery: 'batch:0' }, deps(calls))).rejects.toThrow('positive whole minutes');
    m8_expect(calls).toHaveLength(1);
  });
  m8_it('an agent subscribes itself, and the reply names the whole resulting list', async () => {
    const calls: Call[] = [];
    const result = await m8_subscribeEvents(
      { kinds: ['joined'] },
      deps(calls, { setEventSubscriptions: { kinds: ['joined'] } }),
    );
    m8_expect(calls).toEqual([
      { name: 'setEventSubscriptions', input: { roomId: 'room-1', kinds: ['joined'] } },
    ]);
    m8_expect(result).toContain('joined');
    m8_expect(result).toContain('You now react to');
  });

  m8_it('refuses a kind that is not a server event kind, without calling the daemon', async () => {
    const calls: Call[] = [];
    await m8_expect(m8_subscribeEvents({ kinds: ['agent:handoff'] }, deps(calls))).rejects.toThrow(
      /not an event kind you can subscribe to: agent:handoff/,
    );
    await m8_expect(m8_subscribeEvents({ kinds: ['everything'] }, deps(calls))).rejects.toThrow(
      /not an event kind/,
    );
    m8_expect(calls).toEqual([]);
  });

  m8_it('refuses a per-item kind: it already wakes its own owner, with no subscription involved', async () => {
    const calls: Call[] = [];
    await m8_expect(m8_subscribeEvents({ kinds: ['grant-decided'] }, deps(calls))).rejects.toThrow(
      /grant-decided wakes its own item's owner automatically/,
    );
    await m8_expect(
      m8_subscribeEvents({ kinds: ['joined', 'choice-answered'] }, deps(calls)),
    ).rejects.toThrow(/choice-answered wakes its own item's owner automatically/);
    m8_expect(calls).toEqual([]);
  });

  m8_it('an empty subscription list is a legal answer and says the agent reacts to nothing', async () => {
    const calls: Call[] = [];
    const result = await m8_subscribeEvents(
      { kinds: [] },
      deps(calls, { setEventSubscriptions: { kinds: [] } }),
    );
    m8_expect(calls[0]?.input).toEqual({ roomId: 'room-1', kinds: [] });
    m8_expect(result).toContain('react to no events');
  });

  m8_it('lists what the agent currently reacts to', async () => {
    const calls: Call[] = [];
    const result = await m8_listEventSubscriptions(
      deps(calls, { listEventSubscriptions: { kinds: ['joined', 'merged'] } }),
    );
    m8_expect(calls).toEqual([{ name: 'listEventSubscriptions', input: { roomId: 'room-1' } }]);
    m8_expect(result).toContain('joined, merged');
  });

  m8_it('emit_event forwards kind, sentence and mentions, and never a cause', async () => {
    const calls: Call[] = [];
    const result = await m8_emitEvent(
      { kind: 'agent:handoff', consequence: 'the branch is ready', mentionAgentIds: ['agent-b'] },
      deps(calls),
    );
    m8_expect(calls).toEqual([
      {
        name: 'postRoomEvent',
        input: {
          roomId: 'room-1',
          kind: 'agent:handoff',
          consequence: 'the branch is ready',
          mentionAgentIds: ['agent-b'],
        },
      },
    ]);
    m8_expect(Object.keys(calls[0]?.input ?? {})).not.toContain('causeId');
    m8_expect(result).toContain('agent:handoff');
  });

  m8_it('refuses a server kind, a malformed kind, an empty sentence and too many mentions', async () => {
    const calls: Call[] = [];
    await m8_expect(m8_emitEvent({ kind: 'joined', consequence: 'hello' }, deps(calls))).rejects.toThrow(
      /a fact the server states/,
    );
    await m8_expect(
      m8_emitEvent({ kind: 'agent:Handoff', consequence: 'hello' }, deps(calls)),
    ).rejects.toThrow(/agent:<slug>/);
    await m8_expect(m8_emitEvent({ kind: 'agent:x', consequence: '   ' }, deps(calls))).rejects.toThrow(
      /one sentence/,
    );
    await m8_expect(
      m8_emitEvent(
        { kind: 'agent:x', consequence: 'ok', mentionAgentIds: ['a', 'b', 'c', 'd'] },
        deps(calls),
      ),
    ).rejects.toThrow(/at most 3 agents/);
    m8_expect(calls).toEqual([]);
  });

  m8_it('accepts the advertised maximum lengths and refuses the next character', async () => {
    const calls: Call[] = [];
    await m8_emitEvent({ kind: `agent:${'x'.repeat(40)}`, consequence: 'x'.repeat(200) }, deps(calls));
    await m8_expect(m8_emitEvent({ kind: `agent:${'x'.repeat(41)}`, consequence: 'ok' }, deps(calls)))
      .rejects.toThrow(/slug at most 40 characters/);
    await m8_expect(m8_emitEvent({ kind: 'agent:x', consequence: 'x'.repeat(201) }, deps(calls)))
      .rejects.toThrow(/at most 200 characters/);
    m8_expect(calls).toHaveLength(1);
  });

  m8_it("surfaces the server's refusal verbatim, so the emitting model reads why nothing was posted", async () => {
    const calls: Call[] = [];
    await m8_expect(
      m8_emitEvent(
        { kind: 'agent:ping', consequence: 'again' },
        deps(calls, {
          postRoomEvent: new Error(
            'daemon operation postRoomEvent failed (400: this event would sit 5 events deep and the limit is 4; nothing was posted.)',
          ),
        }),
      ),
    ).rejects.toThrow(/5 events deep/);
  });

  m8_it('exposes only self-wake management on the minimal surface', () => {
    for (const dm of [false, true]) {
      const names = m8_agentToolsFor(true, dm).map(tool => tool.name);
      m8_expect(names).toContain('wake');
      for (const retired of ['subscribe_events', 'list_event_subscriptions', 'emit_event', 'set_wake_delivery', 'get_wake_delivery']) m8_expect(names).not.toContain(retired);
    }
  });
});
});

import { createHash as m9_createHash } from 'node:crypto';

import { mkdtempSync as m9_mkdtempSync, rmSync as m9_rmSync, writeFileSync as m9_writeFileSync } from 'node:fs';

import { tmpdir as m9_tmpdir } from 'node:os';

import { join as m9_join } from 'node:path';

import { afterEach as m9_afterEach, describe as m9_describe, expect as m9_expect, it as m9_it } from 'vitest';

import { REQUESTABLE_AGENT_GRANT_KINDS as m9_REQUESTABLE_AGENT_GRANT_KINDS } from '@beeline/api-contract/agent-grants';

import {
  agentToolsFor as m9_agentToolsFor,
  listGrants as m9_listGrants,
  requestGrant as m9_requestGrant,
  requestSharedAssetIsolation as m9_requestSharedAssetIsolation,
  runGrantedCommand as m9_runGrantedCommand,
  storeSecret as m9_storeSecret,
  type AgentGrantDeps as m9_AgentGrantDeps,
  type GrantRunDeps as m9_GrantRunDeps,
} from "./read-only-mcp.js";

import { resolveGrantCommand as m9_resolveGrantCommand } from "./grant-script.js";

import { approvedDeviceGrant as m9_approvedDeviceGrant } from "./monolith-room-turn.js";
import { describe as mergedDescribe9 } from 'vitest';
mergedDescribe9("agent-grant-tools.test.ts", () => {


function deps(
  answer: Record<string, unknown>,
  ops: Array<{ name: string; input: Record<string, unknown> }> = [],
  secrets: Record<string, string> = { FLY_TOKEN: 'fly-secret-value-123' },
): m9_AgentGrantDeps {
  return {
    roomId: 'room-1',
    execute: async (name, input) => {
      ops.push({ name, input: input as Record<string, unknown> });
      return answer;
    },
    resolveSecret: async (name) => secrets[name],
  };
}


m9_describe('beeline-agent request_grant', () => {
  m9_it('expands literal env split strings without modifying execution argv', () => {
    const argv = ['env', '-S', 'bash approved.sh', 'argument'];
    m9_expect(m9_resolveGrantCommand(argv, '/tmp', {}).argv).toEqual(['bash', 'approved.sh', 'argument']);
    m9_expect(argv).toEqual(['env', '-S', 'bash approved.sh', 'argument']);
    m9_expect(m9_resolveGrantCommand(['env', '-u', 'PATH', '-S', '/bin/echo approved'], '/tmp', {}).argv)
      .toEqual(['/bin/echo', 'approved']);
    for (const value of ['bash\\_changed.sh', 'bash ${SCRIPT}', 'bash "changed.sh"', 'bash #changed.sh']) {
      m9_expect(() => m9_resolveGrantCommand(['env', '-S', value], '/tmp', {})).toThrow('unsupported split string');
    }
  });

  m9_it('applies env options before assignments, keeps only the final chdir, and stops options at operands', () => {
    m9_expect(m9_resolveGrantCommand(['env', '-viuFOO', '-C', '/elsewhere', '-C.', 'FOO=restored', '/bin/echo'], '/tmp', { FOO: 'old', OTHER: 'removed' }))
      .toEqual({ argv: ['/bin/echo'], cwd: '/tmp', env: { FOO: 'restored' } });
    m9_expect(m9_resolveGrantCommand(['env', '--', '-', 'FOO=x', '-v'], '/tmp', { OTHER: 'removed' }))
      .toEqual({ argv: ['-v'], cwd: '/tmp', env: { FOO: 'x' } });
    m9_expect(m9_resolveGrantCommand(['env', '--deb', '--split-string=', '/bin/echo'], '/tmp', {}).argv).toEqual(['/bin/echo']);
    m9_expect(m9_resolveGrantCommand(['timeout', '5', 'env', '-C', 'nested', 'env', 'PATH=bin', 'chosen'], '/tmp', {}))
      .toEqual({ argv: ['chosen'], cwd: '/tmp/nested', env: { PATH: 'bin' } });
    for (const argv of [['env', '--not-an-option', '/bin/echo'], ['env', '-u'], ['env', '--debug=yes'], ['env', '--i']]) {
      m9_expect(() => m9_resolveGrantCommand(argv, '/tmp', {})).toThrow(/env/);
    }
  });

  m9_it.each(['--debug', '-i -u FOO -C /tmp', '-v', '-iv', '-0', '--null', '--help', '--version', '--', '--list-signal-handling', '--block-signal=PIPE', '--default-signal', '--ignore-signal=PIPE', '-', '-S', '--split-string', '--split-string=/bin/echo', '-S/bin/echo', '-i', '-u PATH', '--unset=PATH', '-C /tmp', '--chdir=/tmp'])('requests a native env %s command without a script binding', async (option) => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    await m9_requestGrant({ kind: 'command', target: `env ${option} /bin/echo approved`,
      purpose: 'Print approved', reason: 'Native command regression' }, {
      ...deps({ grantId: 'native', status: 'pending', auto: false }, ops),
      scriptRoots: [m9_tmpdir()],
    });
    m9_expect(ops).toHaveLength(1);
    m9_expect(ops[0]!.name).toBe('requestAgentGrant');
    m9_expect(ops[0]!.input.script).toBeUndefined();
  });

  m9_it.each([undefined, '', '   ', 'x'.repeat(241)])('rejects invalid purpose %s before requesting approval', async (purpose) => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    await m9_expect(m9_requestGrant({ kind: 'command', target: 'git status', reason: 'inspect', purpose }, deps({}, ops))).rejects.toThrow('purpose is required');
    m9_expect(ops).toEqual([]);
  });

  m9_it('requires purpose in the validation contract but permits listing without it', () => {
    const schema = m9_agentToolsFor(true, false).find(tool => tool.name === 'request_grant')!.inputSchema;
    m9_expect(schema.properties.purpose).toMatchObject({ minLength: 1, maxLength: 240 });
    m9_expect(toolValidationSchema('request_grant')!.anyOf).toEqual(m9_expect.arrayContaining([m9_expect.objectContaining({ required: ['action', 'kind', 'target', 'reason', 'purpose'] })]));
  });

  m9_it('asks for one coarse shared asset category with a reason and a Room card', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    const answer = await m9_requestSharedAssetIsolation({
      category: 'package-cache', purpose: 'Shared npm tarball is corrupt', reason: 'Shared npm tarball is corrupt',
    }, deps({ grantId: 'g-7', status: 'pending', auto: false }, ops));
    m9_expect(ops).toEqual([{ name: 'requestAgentGrant', input: {
      roomId: 'room-1', kind: 'shared_asset', target: 'package-cache',
      purpose: 'Shared npm tarball is corrupt', reason: 'Shared npm tarball is corrupt',
    } }]);
    m9_expect(answer).toContain('pending, card posted: isolate package-cache');
    await m9_expect(m9_requestSharedAssetIsolation({ category: 'cache/file', purpose: 'broken', reason: 'broken' },
      deps({}, ops))).rejects.toThrow('category must be one of');
    m9_expect(ops).toHaveLength(1);
  });
  m9_it.each([
    { kind: 'budget', target: '$10', purpose: 'more tokens', reason: 'more tokens' },
    { kind: 'repository', target: 'acme/widgets', purpose: 'edit the repository', reason: 'edit the repository' },
  ])('rejects retired $kind prompts before calling the server', async (ask) => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    await m9_expect(m9_requestGrant(ask, deps({}, ops))).rejects.toThrow('kind must be one of');
    m9_expect(ops).toEqual([]);
  });

  m9_it('is mounted in Rooms, corners, and direct messages next to run_granted_command', () => {
    for (const directMessage of [false, true]) {
      const names = m9_agentToolsFor(true, directMessage).map((tool) => tool.name);
      m9_expect(names).toContain('request_grant');
      m9_expect(names).toContain('run_granted_command');
    }
    m9_expect(m9_agentToolsFor(false, false).map((tool) => tool.name)).not.toContain('request_grant');
  });

  m9_it('suppresses command execution when the daemon has no usable runner boundary', () => {
    const names = m9_agentToolsFor(true, false, false, false, false).map((tool) => tool.name);
    m9_expect(names).toContain('request_grant');
    m9_expect(names).not.toContain('run_granted_command');
  });

  m9_it('offers every grant kind the contract defines, and names each one where the agent reads it', () => {
    const tool = m9_agentToolsFor(true, false).find((entry) => entry.name === 'request_grant');
    const kinds = (tool?.inputSchema as { properties: { kind: { enum: string[] } } }).properties
      .kind.enum;
    m9_expect([...kinds].sort()).toEqual([...m9_REQUESTABLE_AGENT_GRANT_KINDS].sort());
    // The description is the interface the model reads to pick a kind: a kind
    // the schema offers but the prose never names is one nobody asks for.
    m9_expect(tool?.inputSchema.properties).toHaveProperty('kind');
  });

  m9_it('asks for a host MCP route by name and reports it pending, never a yolo approval', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    const reply = await m9_requestGrant(
      { kind: 'mcp', target: ' squire ', purpose: 'vault the provider key', reason: 'vault the provider key' },
      deps(
        {
          grantId: 'g-9',
          status: 'pending',
          auto: false,
          messageId: 'm-9',
          approval: { destination: 'trusty-squire-dm', authority: 'resource-owner' },
        },
        ops,
      ),
    );
    m9_expect(ops).toEqual([
      {
        name: 'requestAgentGrant',
        input: {
          roomId: 'room-1',
          kind: 'mcp',
          target: 'squire',
          purpose: 'vault the provider key', reason: 'vault the provider key',
        },
      },
    ]);
    m9_expect(reply).toMatch(/^pending, card posted: use squire \[grant g-9\]/);
    m9_expect(reply).toContain('paused');
    m9_expect(reply).toContain(
      "The resource owner must answer ALWAYS, ONCE, or NO in the resource owner's private Trusty Squire DM",
    );
    m9_expect(reply).toContain('approval wake starts the fresh session with that route mounted');
    m9_expect(reply).toContain('without restarting or scheduling another turn');
  });

  m9_it('returns "pending, card posted" and tells the agent its turn is paused', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    const reply = await m9_requestGrant(
      {
        kind: 'command',
        target: 'fly deploy -a beeline-preview --with FLY_TOKEN',
        purpose: 'publish the preview build', reason: 'publish the preview build',
        ttl: 3600,
      },
      deps(
        {
          grantId: 'g-1',
          status: 'pending',
          auto: false,
          messageId: 'm-1',
          approval: { destination: 'system-dm', authority: 'resource-owner' },
        },
        ops,
      ),
    );
    m9_expect(ops).toEqual([
      {
        name: 'requestAgentGrant',
        input: {
          roomId: 'room-1',
          kind: 'command',
          target: 'fly deploy -a beeline-preview --with FLY_TOKEN',
          purpose: 'publish the preview build', reason: 'publish the preview build',
          ttlSeconds: 3600,
        },
      },
    ]);
    m9_expect(reply).toMatch(
      /^pending, card posted: run fly deploy -a beeline-preview --with FLY_TOKEN \[grant g-1\]/,
    );
    m9_expect(reply).toContain('paused');
    m9_expect(reply).toContain('ALWAYS, ONCE, or NO');
    m9_expect(reply).toContain(
      "The resource owner must answer ALWAYS, ONCE, or NO in the resource owner's private @system DM",
    );
    m9_expect(reply).not.toContain('in this Room');
  });

  m9_it('returns approval and, for a command, points at run_granted_command', async () => {
    const command = await m9_requestGrant(
      { kind: 'command', target: 'npm test', purpose: 'run the suite', reason: 'run the suite' },
      deps({ grantId: 'g-2', status: 'approved', auto: true }),
    );
    m9_expect(command).toBe(
      'approved: run npm test [grant g-2]. Run it now with run_granted_command and the argv.',
    );
    const host = await m9_requestGrant(
      { kind: 'host', target: ' api.fly.io ', purpose: 'reach the Fly API', reason: 'reach the Fly API' },
      deps({ grantId: 'g-3', status: 'approved', auto: true }),
    );
    m9_expect(host).toBe(
      "approved: reach api.fly.io [grant g-3]; applies at the agent's next session.",
    );
  });

  m9_it('tells an instantly approved /dev/ device grant that this same turn continues with it', async () => {
    const device = await m9_requestGrant(
      { kind: 'device', target: '/dev/kvm', purpose: 'run the Android emulator', reason: 'run the Android emulator' },
      deps({ grantId: 'g-4', status: 'approved', auto: true }),
    );
    m9_expect(device).toBe(
      'approved: use /dev/kvm [grant g-4]. A running session cannot add a device, so end your turn now with one short line; this same turn continues straight away in a session that has /dev/kvm. Do not ask anyone to restart.',
    );
    m9_expect(device).not.toContain('next session');
    // The turn loop recognises exactly this reply and continues the turn.
    m9_expect(m9_approvedDeviceGrant([{ title: 'mcp__beeline-agent__request_grant', content: device }])).toBe(
      '/dev/kvm',
    );
    const outside = await m9_requestGrant(
      { kind: 'device', target: 'kvm', purpose: 'run the Android emulator', reason: 'run the Android emulator' },
      deps({ grantId: 'g-5', status: 'approved', auto: true }),
    );
    m9_expect(outside).toBe(
      'approved: use kvm [grant g-5], but only device nodes under /dev/ are added to your session, so nothing was added.',
    );
  });

  m9_it('refuses shell metacharacters and malformed asks before the server is called', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    const answer = deps({ grantId: 'never' }, ops);
    await m9_expect(
      m9_requestGrant({ kind: 'command', target: 'fly deploy; rm -rf /', purpose: 'x', reason: 'x' }, answer),
    ).rejects.toThrow('shell metacharacters');
    await m9_expect(
      m9_requestGrant({ kind: 'command', target: 'echo $FLY_TOKEN', purpose: 'x', reason: 'x' }, answer),
    ).rejects.toThrow('shell metacharacters');
    await m9_expect(m9_requestGrant({ kind: 'wifi', target: 'x', purpose: 'x', reason: 'x' }, answer)).rejects.toThrow(
      'kind must be one of',
    );
    await m9_expect(m9_requestGrant({ kind: 'host', target: '  ', purpose: 'x', reason: 'x' }, answer)).rejects.toThrow(
      'target must be a non-empty string',
    );
    await m9_expect(
      m9_requestGrant({ kind: 'host', target: 'api.fly.io', purpose: 'Inspect the checkout', reason: ' ' }, answer),
    ).rejects.toThrow('reason must be a non-empty string');
    await m9_expect(
      m9_requestGrant({ kind: 'host', target: 'api.fly.io', purpose: 'x', reason: 'x', ttl: 5 }, answer),
    ).rejects.toThrow('ttl must be');
    m9_expect(ops).toEqual([]);
  });

  m9_it('rejects at ask time a command grant whose named secret cannot resolve, before the server is called', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    const ask = deps({ grantId: 'never' }, ops, {});
    await m9_expect(
      m9_requestGrant(
        {
          kind: 'command',
          target: 'fly deploy -a preview --with DOOMED_SECRET --with ANOTHER_MISSING',
          purpose: 'publish', reason: 'publish',
        },
        ask,
      ),
    ).rejects.toThrow('DOOMED_SECRET, ANOTHER_MISSING');
    // Nothing was sent to the server: an unresolvable ask never becomes a card.
    m9_expect(ops).toEqual([]);
  });

  m9_it('lets a command ask through when every named secret resolves now', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    const reply = await m9_requestGrant(
      {
        kind: 'command',
        target: 'fly deploy -a preview --with FLY_TOKEN',
        purpose: 'publish', reason: 'publish',
      },
      deps({ grantId: 'g-7', status: 'approved', auto: true }, ops),
    );
    m9_expect(ops[0]!.name).toBe('requestAgentGrant');
    m9_expect(ops[0]!.input).toEqual({
      roomId: 'room-1',
      kind: 'command',
      target: 'fly deploy -a preview --with FLY_TOKEN',
      purpose: 'publish', reason: 'publish',
    });
    m9_expect(reply).toContain('approved: run fly deploy -a preview');
  });

  m9_it('keeps grant listing under request_grant and local secret initialization out of ordinary turns', () => {
    for (const directMessage of [false, true]) {
      const names = m9_agentToolsFor(true, directMessage).map((tool) => tool.name);
      m9_expect(names).not.toContain('list_grants');
      m9_expect(names).not.toContain('store_secret');
      m9_expect(names).toContain('request_grant');
    }
    m9_expect(m9_agentToolsFor(false, false).map((tool) => tool.name)).not.toContain('store_secret');
    m9_expect(m9_agentToolsFor(false, false).map((tool) => tool.name)).not.toContain('list_grants');
  });
});


m9_describe('beeline-agent list_grants and store_secret', () => {
  m9_it('list_grants shows each pending and live grant and flags a command grant whose secret is missing', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    const reply = await m9_listGrants(
      deps(
        {
          grants: [
            {
              grantId: 'g-1',
              workspaceId: 'w',
              roomId: 'room-1',
              kind: 'command',
              target: 'fly deploy -a preview --with FLY_TOKEN',
              purpose: 'publish the preview', reason: 'publish the preview',
              status: 'pending',
              auto: false,
              requestedBy: 'c'.repeat(64),
              createdAt: 1,
            },
            {
              grantId: 'g-2',
              workspaceId: 'w',
              roomId: 'room-1',
              kind: 'command',
              target: 'fly deploy -a preview --with GHOST_SECRET',
              purpose: 'publish the preview', reason: 'publish the preview',
              status: 'pending',
              auto: false,
              requestedBy: 'c'.repeat(64),
              createdAt: 2,
            },
            {
              grantId: 'g-3',
              workspaceId: 'w',
              roomId: 'room-1',
              kind: 'host',
              target: 'api.fly.io',
              purpose: 'reach the API', reason: 'reach the API',
              status: 'approved',
              auto: true,
              requestedBy: 'c'.repeat(64),
              createdAt: 3,
            },
          ],
        },
        ops,
        // Only FLY_TOKEN resolves; GHOST_SECRET does not.
        { FLY_TOKEN: 'fly-secret-value-123' },
      ),
    );
    m9_expect(ops[0]!.name).toBe('listAgentGrantRequests');
    m9_expect(reply).toContain('pending command fly deploy -a preview --with FLY_TOKEN');
    m9_expect(reply).toContain('secrets present');
    m9_expect(reply).toContain('GHOST_SECRET NOT resolvable');
    m9_expect(reply).toContain('approved host api.fly.io');
    m9_expect(reply).not.toContain('fly-secret-value-123');
  });

  m9_it('list_grants says none when the server has nothing', async () => {
    const reply = await m9_listGrants(deps({ grants: [] }));
    m9_expect(reply).toContain('no grants right now');
  });

  m9_it('store_secret writes through its dependency and never echoes the value', async () => {
    const writes: Array<[string, string]> = [];
    const reply = await m9_storeSecret(
      { name: 'DEPLOY_TOKEN', value: 'super-secret-9' },
      {
        roomId: 'room-1',
        execute: async () => ({}),
        storeSecret: async (name, value) => {
          writes.push([name, value]);
        },
      },
    );
    m9_expect(writes).toEqual([['DEPLOY_TOKEN', 'super-secret-9']]);
    m9_expect(reply).toContain('stored secret DEPLOY_TOKEN');
    m9_expect(reply).not.toContain('super-secret-9');
  });

  m9_it('store_secret refuses a name the --with rule would never accept', async () => {
    const writes: Array<[string, string]> = [];
    await m9_expect(
      m9_storeSecret(
        { name: 'lower_case', value: 'x' },
        {
          roomId: 'room-1',
          execute: async () => ({}),
          storeSecret: async (name, value) => {
            writes.push([name, value]);
          },
        },
      ),
    ).rejects.toThrow('UPPER_CASE');
    m9_expect(writes).toEqual([]);
  });
});


m9_describe('beeline-agent run_granted_command', () => {
  m9_it('posts the argv to the daemon runner and returns the verdict with the capped output', async () => {
    const runs: unknown[] = [];
    const run: m9_GrantRunDeps = {
      roomId: 'room-1',
      run: async (input) => {
        runs.push(input);
        return { grantId: 'g-1', exitCode: 0, timedOut: false, output: 'deployed\n' };
      },
    };
    const reply = await m9_runGrantedCommand(
      { argv: ['fly', 'deploy', '-a', 'beeline-preview'] },
      run,
    );
    m9_expect(runs).toEqual([{ roomId: 'room-1', argv: ['fly', 'deploy', '-a', 'beeline-preview'] }]);
    m9_expect(reply).toBe('ran under grant g-1: exit 0\ndeployed\n');
  });

  m9_it('surfaces the runner refusal and validates argv locally', async () => {
    const refusing: m9_GrantRunDeps = {
      roomId: 'room-1',
      run: async () => {
        throw new Error('no approved command grant matches: rm -rf /');
      },
    };
    await m9_expect(m9_runGrantedCommand({ argv: ['rm', '-rf', '/'] }, refusing)).rejects.toThrow(
      'no approved command grant matches',
    );
    await m9_expect(m9_runGrantedCommand({ argv: [] }, refusing)).rejects.toThrow('argv must be');
    await m9_expect(m9_runGrantedCommand({ argv: 'npm test' }, refusing)).rejects.toThrow('argv must be');
    const timedOut = await m9_runGrantedCommand(
      { argv: ['sleep'] },
      {
        roomId: 'room-1',
        run: async () => ({ grantId: 'g', exitCode: null, timedOut: true, output: '' }),
      },
    );
    m9_expect(timedOut).toBe('ran under grant g: timed out after 10 minutes\n(no output)');
  });
});


/**
 * C94: `python3 fix.py` tells the person deciding nothing about what will run,
 * so the ask carries the script and the approval is bound to those bytes.
 */
m9_describe('request_grant carries the script an interpreter will run', () => {
  const roots: string[] = [];
  m9_afterEach(() => {
    for (const root of roots.splice(0)) m9_rmSync(root, { recursive: true, force: true });
  });

  const checkout = (contents: string, name = 'fix.py') => {
    const root = m9_mkdtempSync(m9_join(m9_tmpdir(), 'beeline-grant-script-'));
    roots.push(root);
    m9_writeFileSync(m9_join(root, name), contents);
    return root;
  };

  m9_it.each(['-v', '-iv --', '--chdir=CHECKOUT', '-i -u FOO -C CHECKOUT', '--block-signal=PIPE', '--ignore-signal', '--default-signal='])('binds env %s scripts to the executed bytes', async (option) => {
    const contents = '#!/bin/sh\nprintf approved\n';
    const root = checkout(contents, 'script.sh');
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    await m9_requestGrant({ kind: 'command', target: `env ${option.replaceAll('CHECKOUT', root)} ./script.sh`,
      purpose: 'Run reviewed script', reason: 'Wrapper hash regression' }, {
      ...deps({ grantId: 'script', status: 'pending', auto: false }, ops), scriptRoots: [root],
    });
    m9_expect(ops[0]!.input.script).toEqual({ path: './script.sh', contents, bytes: Buffer.byteLength(contents),
      sha256: m9_createHash('sha256').update(contents).digest('hex') });
  });

  m9_it('sends the file contents and its hash with the ask, and tells the agent so', async () => {
    const body = 'import os\nos.remove("/tmp/x")\n';
    const root = checkout(body);
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    const reply = await m9_requestGrant(
      { kind: 'command', target: 'python3 fix.py', purpose: 'clean up', reason: 'clean up' },
      {
        ...deps(
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
    const root = checkout(body, 'approved');
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    await m9_requestGrant(
      { kind: 'command', target: './approved', purpose: 'run approved script', reason: 'run approved script' },
      { ...deps({ grantId: 'g', status: 'pending', auto: false }, ops), scriptRoots: [root] },
    );
    m9_expect(ops[0]!.input.script).toMatchObject({ path: './approved', contents: body,
      sha256: m9_createHash('sha256').update(body).digest('hex') });
  });

  m9_it('keeps native executable grants outside script roots unchanged', async () => {
    const root = checkout('unused');
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    await m9_requestGrant(
      { kind: 'command', target: '/bin/true', purpose: 'check execution', reason: 'check execution' },
      { ...deps({ grantId: 'g', status: 'approved', auto: true }, ops), scriptRoots: [root] },
    );
    m9_expect(ops[0]!.input.script).toBeUndefined();
  });

  m9_it('refuses a script too long to read honestly instead of truncating it', async () => {
    const root = checkout(`${Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n')}\n`);
    await m9_expect(
      m9_requestGrant(
        { kind: 'command', target: 'python3 fix.py', purpose: 'x', reason: 'x' },
        { ...deps({ grantId: 'g' }), scriptRoots: [root] },
      ),
    ).rejects.toThrow('will not be truncated');
  });

  m9_it('refuses a script outside the checkout and the scratch directory', async () => {
    const root = checkout('print(1)\n');
    await m9_expect(
      m9_requestGrant(
        { kind: 'command', target: 'python3 /etc/hosts', purpose: 'x', reason: 'x' },
        { ...deps({ grantId: 'g' }), scriptRoots: [root] },
      ),
    ).rejects.toThrow('cannot be shown on the approval card');
  });

  m9_it('asks without a body when the interpreter line names no file', async () => {
    const root = checkout('print(1)\n');
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    await m9_requestGrant(
      { kind: 'command', target: 'python3 -V', purpose: 'x', reason: 'x' },
      { ...deps({ grantId: 'g', status: 'pending', auto: false }, ops), scriptRoots: [root] },
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

import { describe as m10_describe, expect as m10_expect, it as m10_it } from 'vitest';

import { MESSAGE_REACTION_EMOJIS as m10_MESSAGE_REACTION_EMOJIS } from '@beeline/api-contract/phone';

import { agentToolsFor as m10_agentToolsFor, reactToMessage as m10_reactToMessage, type AgentScheduleDeps as m10_AgentScheduleDeps } from "./read-only-mcp.js";
import { describe as mergedDescribe10 } from 'vitest';
mergedDescribe10("agent-reaction-tools.test.ts", () => {


m10_describe('beeline-agent reaction tool', () => {
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

import { describe as m11_describe, expect as m11_expect, it as m11_it } from 'vitest';

import {
  createSchedule as m11_createSchedule,
  deleteSchedule as m11_deleteSchedule,
  listSchedules as m11_listSchedules,
  updateSchedule as m11_updateSchedule,
  type AgentScheduleDeps as m11_AgentScheduleDeps,
} from "./read-only-mcp.js";
import { describe as mergedDescribe11 } from 'vitest';
mergedDescribe11("agent-schedule-tools.test.ts", () => {


function deps(ops: Array<{ name: string; input: Record<string, unknown> }>): m11_AgentScheduleDeps {
  return {
    roomId: 'room-1',
    execute: async (name, input) => {
      ops.push({ name, input: input as Record<string, unknown> });
      if (name === 'createAgentSchedule') {
        return { scheduleId: 'sched-1', nextRunAt: 1_800_000_000 };
      }
      if (name === 'listAgentSchedules') {
        return {
          schedules: [
            {
              scheduleId: 'sched-1',
              agentId: 'agent-2',
              agentHandle: 'rival',
              prompt: 'message hello',
              cadence: { kind: 'interval', everyMinutes: 1 },
              maxRuns: 5,
              runCount: 2,
              nextRunAt: 1_800_000_000,
            },
          ],
        };
      }
      if (name === 'updateAgentSchedule') {
        return { scheduleId: 'sched-1', nextRunAt: 1_800_000_000 };
      }
      return { id: 'w', createdAt: 1 };
    },
  };
}


m11_describe('beeline-agent schedule tools', () => {
  m11_it('carries the workflow target through create/update and names it in list_schedules', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    await m11_createSchedule(
      { prompt: 'Scan', workflowName: 'daily', cadence: { kind: 'interval', everyMinutes: 1 } },
      deps(ops),
    );
    await m11_updateSchedule({ scheduleId: 'sched-1', workflowName: 'daily' }, deps(ops));
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
      deps(ops),
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
      cadence: { kind: 'interval', everyMinutes: 60 } }, deps(ops));
    await m11_updateSchedule({ scheduleId: 'sched-1', title: 'Owner card' }, deps(ops));
    m11_expect(ops[0]?.input.title).toBe('Morning card');
    m11_expect(ops[1]).toEqual({ name: 'updateAgentSchedule',
      input: { roomId: 'room-1', scheduleId: 'sched-1', title: 'Owner card' } });
  });

  m11_it('create_schedule accepts cron cadences without a floor note', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    const result = await m11_createSchedule(
      { prompt: 'Ping.', cadence: { kind: 'cron', expression: '*/5 * * * *' } },
      deps(ops),
    );
    m11_expect(ops[0]?.input.cadence).toEqual({ kind: 'cron', expression: '*/5 * * * *' });
    m11_expect(result).not.toContain('minimum');
    m11_expect(result).toContain('cron');
  });

  m11_it('create_schedule rejects invalid arguments', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    await m11_expect(
      m11_createSchedule({ prompt: ' ', cadence: { kind: 'interval', everyMinutes: 5 } }, deps(ops)),
    ).rejects.toThrow('prompt must be a non-empty string');
    await m11_expect(
      m11_createSchedule({ prompt: 'p', cadence: { kind: 'interval', everyMinutes: 0 } }, deps(ops)),
    ).rejects.toThrow('everyMinutes');
    await m11_expect(
      m11_createSchedule({ prompt: 'p', cadence: { kind: 'cron', expression: '* * * *' } }, deps(ops)),
    ).rejects.toThrow('five fields');
    m11_expect(ops).toEqual([]);
  });

  m11_it('list_schedules formats the daemon list', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    const result = await m11_listSchedules(deps(ops));
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
    const result = await m11_deleteSchedule({ scheduleId: 'sched-1' }, deps(ops));
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
      deps(ops),
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
    await m11_expect(m11_updateSchedule({ scheduleId: 'sched-1' }, deps(ops))).rejects.toThrow(
      'give a prompt, cadence, title, or workflowName to change',
    );
    m11_expect(ops).toHaveLength(1);
  });
});
});

import { describe as m14_describe, expect as m14_expect, it as m14_it, vi as m14_vi } from 'vitest';

import {
  agentToolsFor as m14_agentToolsFor,
  connectorOfferDepsFromEnv as m14_connectorOfferDepsFromEnv,
  offerConnector as m14_offerConnector,
  workbenchStatus as m14_workbenchStatus,
  type ConnectorOfferDeps as m14_ConnectorOfferDeps,
} from "./read-only-mcp.js";

import { pendingGrantToolCall as m14_pendingGrantToolCall, resumePrompt as m14_resumePrompt } from "./monolith-room-turn.js";
import { describe as mergedDescribe14 } from 'vitest';
mergedDescribe14("connector-offer-tools.test.ts", () => {


function deps(
  answer: Record<string, unknown>,
  ops: Array<{ name: string; input: Record<string, unknown> }> = [],
  extra: Partial<m14_ConnectorOfferDeps> = {},
): m14_ConnectorOfferDeps {
  return {
    roomId: 'room-1',
    execute: async (name, input) => {
      ops.push({ name, input: input as Record<string, unknown> });
      return answer;
    },
    ...extra,
  };
}


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
      const text = await m14_workbenchStatus(deps({
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
      deps(
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
    const status = await m14_workbenchStatus(deps({
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
    const reachable = await m14_workbenchStatus(deps(view, [], {
      squireReach: async () => ({ reachable: true }),
    }));
    m14_expect(reachable).toContain('Trusty Squire): connected on Owner laptop');
    const unreachable = await m14_workbenchStatus(deps(view, [], {
      squireReach: async () => ({ reachable: false, cause: 'MCP did not respond' }),
    }));
    m14_expect(unreachable).toContain('Trusty Squire): error on Owner laptop');
    m14_expect(unreachable).toContain('MCP did not respond');
  });

  m14_it('installs Tailscale when it is enabled on this machine and the CLI is missing', async () => {
    const ensured: boolean[] = [];
    const text = await m14_workbenchStatus(
      deps(
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
      deps({ offerId: 'o-1', status: 'pending', messageId: 'm-1', joined: false }, ops),
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
      deps({ offerId: 'o-1', status: 'pending', messageId: 'm-1', joined: true }),
    );
    m14_expect(joined).toMatch(/^already offered, card still open: add trusty-squire \[offer o-1\]/);
    m14_expect(m14_pendingGrantToolCall({ title: 'offer_connector', content: joined })).toBe(true);
  });

  m14_it('offer_connector with intent switch asks to replace the bound Squire account and pauses the turn', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    const reply = await m14_offerConnector(
      { connectorType: 'trusty-squire', reason: 'sign up with your work account', intent: 'switch' },
      deps({ offerId: 'o-2', status: 'pending', messageId: 'm-2', joined: false }, ops),
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
      deps({ offerId: 'o-2', status: 'pending', messageId: 'm-2', joined: true }),
    );
    m14_expect(m14_pendingGrantToolCall({ title: 'offer_connector', content: joined })).toBe(true);
    await m14_expect(
      m14_offerConnector({ connectorType: 'trusty-squire', reason: 'x', intent: 'add' }, deps({ offerId: 'never' })),
    ).rejects.toThrow('intent must be "switch" when given');
  });

  m14_it('refuses a non-offerable kind and an empty reason before the server is called', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    const answer = deps({ offerId: 'never' }, ops);
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

import { mkdtempSync as m24_mkdtempSync, writeFileSync as m24_writeFileSync } from 'node:fs';

import { join as m24_join } from 'node:path';

import { tmpdir as m24_tmpdir } from 'node:os';

import { afterEach as m24_afterEach, beforeEach as m24_beforeEach, describe as m24_describe, expect as m24_expect, it as m24_it, vi as m24_vi } from 'vitest';

import { agentToolsFor as m24_agentToolsFor, callAgentTool as m24_callAgentTool } from "./read-only-mcp.js";

import { CAPABILITY_ROUTES as m24_CAPABILITY_ROUTES } from "./minimal-tool-surface.js";

import { assembleTurnPrompt as m24_assembleTurnPrompt, type PromptSurface as m24_PromptSurface } from "./prompt-assembly.js";
import { describe as mergedDescribe24 } from 'vitest';
mergedDescribe24("place-capabilities.test.ts", () => {


/** Each place an agent turn runs in, with the MCP environment and prompt facts it gets. */
const PLACES: ReadonlyArray<{ name: string; corner: boolean; surface: m24_PromptSurface; commandReason: string }> = [
  { name: 'Room', corner: false, surface: 'room', commandReason: 'human_tag' },
  { name: 'DM', corner: false, surface: 'dm', commandReason: 'direct_message' },
  { name: 'code corner', corner: true, surface: 'code-corner', commandReason: 'order' },
  { name: 'repo-less corner', corner: true, surface: 'repo-less-corner', commandReason: 'order' },
  { name: 'schedule run in a Room', corner: false, surface: 'room', commandReason: 'schedule' },
  { name: 'schedule run in a corner', corner: true, surface: 'code-corner', commandReason: 'schedule' },
];

const ALL_APPS = Object.keys(m24_CAPABILITY_ROUTES).map(capability => `beeline:${capability}`);

const appsIn = (text: string) => [...new Set(text.match(/beeline:[a-z_]+/g) ?? [])].sort();


function useEnvironment(corner: boolean) {
  const context = m24_join(m24_mkdtempSync(m24_join(m24_tmpdir(), 'place-capabilities-')), 'context.json');
  m24_writeFileSync(context, JSON.stringify({ roomId: corner ? 'corner' : 'room', requestId: 'request', generationId: 'generation' }));
  for (const [key, value] of Object.entries({
    BEELINE_DAEMON_ROOM_ID: corner ? 'corner' : 'room',
    BEELINE_DAEMON_CORNER_ID: corner ? 'corner' : '',
    BEELINE_DAEMON_AGENT_ID: 'self',
    BEELINE_DAEMON_BASE_URL: 'http://localhost',
    BEELINE_DAEMON_TOKEN: 'test',
    BEELINE_TURN_CONTEXT_FILE: context,
  })) m24_vi.stubEnv(key, value);
}


/** What discovery offers: app_tool's own list and connect's capabilities. */
async function discovered(corner: boolean): Promise<string[]> {
  const appTool = m24_agentToolsFor(true, false, corner).find(tool => tool.name === 'app_tool')!;
  const connect = JSON.parse(await m24_callAgentTool('connect', { mode: 'discover' }, 'discover')) as { capabilities: string[] };
  return [...new Set([...appsIn(appTool.description), ...connect.capabilities])].sort();
}


m24_afterEach(() => {
  m24_vi.unstubAllGlobals();
  m24_vi.unstubAllEnvs();
});


m24_describe.each(PLACES.flatMap(place => [false, true].map(repositoryOnboarding => ({ ...place, repositoryOnboarding }))))('$name onboarding=$repositoryOnboarding', ({ corner, surface, commandReason, repositoryOnboarding }) => {
  m24_beforeEach(() => {
    m24_vi.stubGlobal('fetch', async () => Response.json({ repositoryOnboarding }));
  });
  m24_it('discovery offers only Beeline apps that answer there, and every app that answers is offered', async () => {
    useEnvironment(corner);
    const offered = await discovered(corner);
    m24_expect(offered.length).toBeGreaterThan(0);
    for (const app of offered) {
      const answer = JSON.parse(await m24_callAgentTool('app_tool', { app }, 'discover')) as { tools: unknown[] };
      m24_expect(answer.tools.length, app).toBeGreaterThan(0);
    }
    for (const app of ALL_APPS.filter(app => !offered.includes(app)))
      await m24_expect(m24_callAgentTool('app_tool', { app }, 'discover'), app).rejects.toThrow('Beeline apps here');
  });

  m24_it('states the discovered apps in one short block of the turn prompt', async () => {
    useEnvironment(corner);
    const offered = await discovered(corner);
    const prompt = m24_assembleTurnPrompt({ surface, onboarding: repositoryOnboarding, task: { body: 'Check the deploy.', commandReason } });
    const block = prompt.text.split('\n\n').find(paragraph => paragraph.startsWith('Works here ('));
    m24_expect(block).toBeDefined();
    m24_expect(Buffer.byteLength(block!)).toBeLessThanOrEqual(260);
    const [works, cornerOnly = ''] = block!.split('Corner only:');
    m24_expect(appsIn(works!)).toEqual(offered);
    m24_expect(appsIn(cornerOnly)).toEqual([]);
    m24_expect(block!.includes('schedule run')).toBe(commandReason === 'schedule');
  });
});
});

import { mkdtempSync as m25_mkdtempSync, rmSync as m25_rmSync, writeFileSync as m25_writeFileSync } from 'node:fs';

import { tmpdir as m25_tmpdir } from 'node:os';

import { join as m25_join } from 'node:path';

import { afterEach as m25_afterEach, beforeEach as m25_beforeEach, describe as m25_describe, expect as m25_expect, it as m25_it, vi as m25_vi } from 'vitest';

import { callAgentTool as m25_callAgentTool } from "./read-only-mcp.js";
import { describe as mergedDescribe25 } from 'vitest';
mergedDescribe25("read-only-mcp.corner-message.test.ts", () => {


/**
 * A corner turn session mounts the agent MCP with BEELINE_DAEMON_ROOM_ID set
 * to the PARENT Room (`monolith-corner-turn.ts`'s `beelineAgentMcpServer`
 * mount passes `roomId: this.options.parentRoomId`), while the active command
 * context names the CORNER. `get_room_message` must read the corner's own
 * transcript, so it has to target the active command's room, exactly like
 * every other turn-bound operation — never the parent env fallback.
 */
m25_describe('corner-turn get_room_message room targeting', () => {
  let home: string;
  let calls: Array<{ name: string; input: Record<string, unknown> }>;
  let answer: (name: string) => Response;

  m25_beforeEach(() => {
    home = m25_mkdtempSync(m25_join(m25_tmpdir(), 'beeline-corner-message-'));
    const context = m25_join(home, 'turn.json');
    // The active command lives in the corner; the session env still names the
    // parent Room, as a real corner session does.
    m25_writeFileSync(
      context,
      JSON.stringify({
        roomId: 'corner-room',
        requestId: 'request-1',
        generationId: 'generation-1',
      }),
    );
    m25_vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', context);
    m25_vi.stubEnv('BEELINE_DAEMON_BASE_URL', 'http://daemon.test');
    m25_vi.stubEnv('BEELINE_DAEMON_TOKEN', 'daemon-only');
    m25_vi.stubEnv('BEELINE_DAEMON_AGENT_ID', 'agent-1');
    m25_vi.stubEnv('BEELINE_DAEMON_ROOM_ID', 'parent-room');
    m25_vi.stubEnv('BEELINE_DAEMON_CORNER_ID', 'corner-room');
    calls = [];
    answer = () => Response.json({});
    m25_vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
      const name = String(url).split('/').at(-1)!;
      calls.push({ name, input: JSON.parse(String(init.body)) });
      return answer(name);
    });
  });

  m25_afterEach(() => {
    m25_vi.unstubAllGlobals();
    m25_vi.unstubAllEnvs();
    m25_rmSync(home, { recursive: true, force: true });
  });

  m25_it('reads a transcript message id from the corner Room, not the parent env Room', async () => {
    answer = () =>
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
    m25_expect(calls).toEqual([
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
    m25_expect(calls[0]!.input.roomId).not.toBe('parent-room');
  });

  m25_it('keeps the offset page on the corner read', async () => {
    await m25_callAgentTool(
      'read', { facet: "message", ...{ messageId: 'corner-transcript-id', cursor: { offset: 4000 } } },
      'call-2',
    );
    m25_expect(calls[0]!.input).toMatchObject({
      roomId: 'corner-room',
      messageId: 'corner-transcript-id',
      offset: 4000,
    });
  });
});
});

import { afterEach as m26_afterEach, beforeEach as m26_beforeEach, expect as m26_expect, it as m26_it, vi as m26_vi } from 'vitest';

import { mkdtempSync as m26_mkdtempSync } from 'node:fs';

import { tmpdir as m26_tmpdir } from 'node:os';

import { join as m26_join } from 'node:path';

import type { AgentCommand as m26_AgentCommand } from '@beeline/api-contract/daemon';

import { callAgentTool as m26_callAgentTool } from "./read-only-mcp.js";

import { CommandExecutionContext as m26_CommandExecutionContext } from "./server-command-intake.js";
import { describe as mergedDescribe26 } from 'vitest';
mergedDescribe26("read-only-mcp.onboarding.test.ts", () => {

const calls: Array<{ name: string; input: Record<string, unknown> }> = [];

let context: m26_CommandExecutionContext;

m26_beforeEach(async () => {
  calls.length=0;
  context=new m26_CommandExecutionContext(m26_mkdtempSync(m26_join(m26_tmpdir(),'onboarding-tools-')));
  await context.enter({roomId:'room-1',turnRequestId:'request-1',rootCommandId:'command-1'} as m26_AgentCommand);
  for (const [key,value] of Object.entries({BEELINE_DAEMON_AGENT_ID:'agent-1',BEELINE_DAEMON_ROOM_ID:'room-1',BEELINE_DAEMON_BASE_URL:'http://localhost:1234',BEELINE_DAEMON_TOKEN:'test-token',BEELINE_TURN_CONTEXT_FILE:context.path})) m26_vi.stubEnv(key,value);
  m26_vi.stubGlobal('fetch', async (url:URL,init:RequestInit) => {
    calls.push({name:new URL(url).pathname.split('/').pop()!,input:JSON.parse(String(init.body))});
    return Response.json({state:'no_repo_linked',repositoryOnboarding:true});
  });
});

m26_afterEach(() => {m26_vi.unstubAllEnvs();m26_vi.unstubAllGlobals();});

m26_it('discovers cards and Room invitations without an external connection and binds writes to the active turn',async()=>{
  const discovered=JSON.parse(await m26_callAgentTool('app_tool',{app:'beeline:onboarding'},'discover'));
  m26_expect(discovered.tools.map((t:{name:string})=>t.name)).toEqual(m26_expect.arrayContaining(['welcome','video_preview','invite','repository','starters']));
  calls.length = 0;
  await m26_callAgentTool('app_tool',{app:'beeline:onboarding',tool:'welcome',args:{}});
  m26_expect(calls.find(call => call.name === 'postStarterWelcome')!.input).toMatchObject({roomId:'room-1',requestId:'request-1',taskId:'command-1',generationId:context.generationId});
  for (const tool of ['repository','starters']) await m26_callAgentTool('app_tool',{app:'beeline:onboarding',tool,args:{}});
  m26_expect(calls.filter(call=>call.name === 'postRepositoryOnboarding').map(call=>call.name)).toEqual(['postRepositoryOnboarding','postRepositoryOnboarding']);
  m26_expect(calls.filter(call=>call.name === 'postRepositoryOnboarding').map(call=>call.input.kind)).toEqual(['repository','starters']);
  m26_expect(calls.find(call=>call.name === 'postRepositoryOnboarding')!.input).toMatchObject({roomId:'room-1',requestId:'request-1',generationId:context.generationId});
  await m26_callAgentTool('app_tool',{app:'beeline:onboarding',tool:'invite',args:{}});
  m26_expect(calls.filter(call=>call.name === 'postRoomInvite')).toEqual([{
    name:'postRoomInvite', input:{roomId:'room-1',requestId:'request-1',taskId:'command-1',generationId:context.generationId},
  }]);
});


m26_it('hides the new tools when server eligibility is absent', async () => {
  m26_vi.stubGlobal('fetch', async () => Response.json({resolution:'none'}));
  await m26_expect(m26_callAgentTool('app_tool',{app:'beeline:onboarding'},'discover')).rejects.toThrow('unavailable');
  const discovered = JSON.parse(await m26_callAgentTool('connect',{mode:'discover'},'discover'));
  m26_expect(discovered.capabilities).not.toContain('beeline:onboarding');
});


m26_it.each(['GitHub', 'link my repository', 'connect my repo', 'GitHub repository'])('R-REPO-CARD: routes %s to the repository card before connector search', async service => {
  const result = JSON.parse(await m26_callAgentTool('connect', {mode:'ensure', service, reason:`Connect ${service}`, continuation:`Connect my ${service} account.`}, 'repo-connect'));
  m26_expect(result).toMatchObject({status:'ready', app:'beeline:onboarding'});
  await m26_callAgentTool('app_tool', {app:result.app, tool:'repository', args:{}}, 'repo-card');
  m26_expect(calls.some(call => call.name === 'postRepositoryOnboarding')).toBe(true);
  m26_expect(calls.some(call => ['connect','find_connectors'].includes(call.name))).toBe(false);
});

m26_it('advertises repository onboarding without an exact-name query', async () => {
  const result = JSON.parse(await m26_callAgentTool('connect', {mode:'discover'}, 'discover'));
  m26_expect(result.capabilities).toContain('beeline:onboarding');
});


m26_it('reports unavailable repo cards without attempting an external connector', async () => {
  m26_vi.stubGlobal('fetch', async (url: URL) => {
    calls.push({name:new URL(url).pathname.split('/').pop()!,input:{}});
    return Response.json({repositoryOnboarding:false});
  });
  const result = JSON.parse(await m26_callAgentTool('connect', {mode:'ensure',service:'link my repository',reason:'Connect the repository',continuation:'Show the repository card.'}, 'connect'));
  m26_expect(result).toMatchObject({status:'unavailable',app:'beeline:onboarding'});
  m26_expect(result.next).toContain('active Room');
  m26_expect(calls.map(call => call.name)).toEqual(['getRoomRepositoryState']);
});


m26_it('keeps ordinary GitHub repository reads on the connector route', async () => {
  await m26_callAgentTool('connect', {mode:'ensure', service:'GitHub', reason:'List repositories', continuation:'Read the account repositories.'}, 'github');
  m26_expect(calls.map(call => call.name)).toEqual(['connect']);
});


m26_it('binds the visual clip preview and visibility to the active Room turn', async () => {
  const args={videoObjectId:'11111111-1111-4111-8111-111111111111',frameObjectId:'22222222-2222-4222-8222-222222222222',title:'Clip preview',description:'A short clip',visibility:'unlisted'};
  await m26_callAgentTool('app_tool',{app:'beeline:onboarding',tool:'video_preview',args});
  m26_expect(calls.find(call=>call.name==='postStarterVideoPreview')!.input).toMatchObject({...args,roomId:'room-1',requestId:'request-1',taskId:'command-1',generationId:context.generationId});
});
});

import { afterEach as m27_afterEach, beforeEach as m27_beforeEach, expect as m27_expect, it as m27_it, vi as m27_vi } from 'vitest';

import { agentToolsFor as m27_agentToolsFor, callAgentTool as m27_callAgentTool } from "./read-only-mcp.js";
import { describe as mergedDescribe27 } from 'vitest';
mergedDescribe27("read-only-mcp.order.test.ts", () => {


m27_beforeEach(() => {
  m27_vi.stubEnv('BEELINE_DAEMON_BASE_URL', 'http://daemon.test');
  m27_vi.stubEnv('BEELINE_DAEMON_TOKEN', 'test-token');
  m27_vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', '');
});

m27_afterEach(() => {
  m27_vi.unstubAllGlobals();
  m27_vi.unstubAllEnvs();
});


// The always-on prompt owns "end the turn after ordering"; the tool text only describes the order.
m27_it('returns the delivery receipt without restating the end-the-turn rule', async () => {
  const fetch = m27_vi.fn(async (_url: URL, _init: RequestInit) => Response.json({ commandIds: ['order-1'] }));
  m27_vi.stubGlobal('fetch', fetch);
  const result = await m27_callAgentTool('order', { address: '11111111-1111-4111-8111-111111111111', text: 'Compute 17 + 25' }, 'call-1');
  m27_expect(fetch).toHaveBeenCalledTimes(1);
  m27_expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual({ address: '11111111-1111-4111-8111-111111111111', text: 'Compute 17 + 25' });
  m27_expect(JSON.parse(result as string)).toEqual({ commandIds: ['order-1'] });
  m27_expect(m27_agentToolsFor(true, true).find(t => t.name === 'order')!.description).not.toMatch(/end this turn|never poll/i);
});


m27_it('preserves an order refusal without claiming delivery or telling the commander to wait', async () => {
  m27_vi.stubGlobal('fetch', async () => Response.json({ error: 'forbidden' }, { status: 403 }));
  await m27_expect(m27_callAgentTool('order', { address: '11111111-1111-4111-8111-111111111111', text: 'Compute 17 + 25' }, 'call-2'))
    .rejects.toThrow('403');
});


m27_it('forwards the one named agent and never describes a Room broadcast', async () => {
  const fetch = m27_vi.fn(async (_url: URL, _init: RequestInit) => Response.json({ commandIds: ['order-2'] }));
  m27_vi.stubGlobal('fetch', fetch);
  await m27_callAgentTool('order', { address: '11111111-1111-4111-8111-111111111111', agent: '@candy', text: 'Check the build' }, 'call-3');
  m27_expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual({ address: '11111111-1111-4111-8111-111111111111', agent: '@candy', text: 'Check the build' });
  const tool = m27_agentToolsFor(true, true).find(t => t.name === 'order')!;
  m27_expect(tool.description).not.toMatch(/broadcast/i);
  m27_expect(tool.description).toContain('one agent');
  m27_expect(Object.keys((tool.inputSchema as { properties: object }).properties)).toContain('agent');
});
});

import { afterEach as m28_afterEach, beforeEach as m28_beforeEach, describe as m28_describe, expect as m28_expect, it as m28_it, vi as m28_vi } from 'vitest';

import { beelineManagedSkills as m28_beelineManagedSkills } from "./beeline-skill.js";

import { callAgentTool as m28_callAgentTool } from "./read-only-mcp.js";
import { describe as mergedDescribe28 } from 'vitest';
mergedDescribe28("read-only-mcp.procedure.test.ts", () => {


// R1: exercise the public read facet with the server's missing-procedure response.
m28_describe('read procedure built-in skills (R1)', () => {
  m28_beforeEach(() => {
    m28_vi.stubEnv('BEELINE_DAEMON_AGENT_ID', 'agent');
    m28_vi.stubEnv('BEELINE_DAEMON_ROOM_ID', 'room');
    m28_vi.stubEnv('BEELINE_DAEMON_BASE_URL', 'http://daemon.test');
    m28_vi.stubEnv('BEELINE_DAEMON_TOKEN', 'test-token');
    m28_vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', '');
    m28_vi.stubEnv('BEELINE_LIB_DIR', '');
    m28_vi.stubGlobal('fetch', m28_vi.fn(async () => Response.json({ error: 'workspace skill not found' }, { status: 404 })));
  });
  m28_afterEach(() => { m28_vi.unstubAllEnvs(); m28_vi.unstubAllGlobals(); });

  for (const skill of m28_beelineManagedSkills('source', { isReviewer: true })) {
    m28_it(`returns shipped text for ${skill.name}`, async () => {
      const result = JSON.parse(await m28_callAgentTool('read', { facet: 'procedure', slug: skill.name }));
      m28_expect(result).toEqual({ slug: skill.name, markdown: skill.content, source: 'built-in' });
      m28_expect(fetch).toHaveBeenCalledWith(new URL('http://daemon.test/v1/daemon/operations/loadWorkspaceSkill'),
        m28_expect.objectContaining({ body: JSON.stringify({ agentId: 'agent', roomId: 'room', slug: skill.name }) }));
    });
  }

  m28_it('keeps a workspace procedure ahead of a built-in with the same slug', async () => {
    const procedure = { slug: 'beeline-memory', markdown: 'Workspace guidance', version: 2 };
    m28_vi.stubGlobal('fetch', async () => Response.json(procedure));
    m28_expect(JSON.parse(await m28_callAgentTool('read', { facet: 'procedure', slug: procedure.slug }))).toEqual(procedure);
  });

  m28_it('preserves not found for an unknown slug', async () => {
    await m28_expect(m28_callAgentTool('read', { facet: 'procedure', slug: 'unknown-procedure' })).rejects.toThrow('404');
  });

  m28_it.each([403, 500])('preserves server failures (%s) for built-in names', async (status) => {
    m28_vi.stubGlobal('fetch', async () => Response.json({ error: 'refused' }, { status }));
    await m28_expect(m28_callAgentTool('read', { facet: 'procedure', slug: 'beeline-memory' })).rejects.toThrow(`${status}: refused`);
  });
});
});

import { afterEach as m29_afterEach, beforeEach as m29_beforeEach, describe as m29_describe, expect as m29_expect, it as m29_it, vi as m29_vi } from 'vitest';

import {
  callAgentTool as m29_callAgentTool,
  daemonOperationIsSafeToRepeat as m29_daemonOperationIsSafeToRepeat,
  isDaemonNetworkFailure as m29_isDaemonNetworkFailure,
} from "./read-only-mcp.js";
import { describe as mergedDescribe29 } from 'vitest';
mergedDescribe29("read-only-mcp.retry.test.ts", () => {


m29_beforeEach(() => {
  for (const [key, value] of Object.entries({
    BEELINE_DAEMON_ROOM_ID: 'room-1',
    BEELINE_DAEMON_BASE_URL: 'http://localhost:1234',
    BEELINE_DAEMON_TOKEN: 'test-token',
  }))
    m29_vi.stubEnv(key, value);
});


m29_afterEach(() => {
  m29_vi.unstubAllGlobals();
  m29_vi.unstubAllEnvs();
});


const bareFetchFailed = () => new TypeError('fetch failed');


m29_describe('daemon network-failure classification', () => {
  m29_it('recognises a bare fetch failed and a coded cause, never a server response', () => {
    m29_expect(m29_isDaemonNetworkFailure(bareFetchFailed())).toBe(true);
    m29_expect(
      m29_isDaemonNetworkFailure(
        new TypeError('fetch failed', {
          cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
        }),
      ),
    ).toBe(true);
    m29_expect(m29_isDaemonNetworkFailure(new Error('corner not found'))).toBe(false);
  });
});


m29_describe('daemonOperationIsSafeToRepeat', () => {
  m29_it('repeats reads', () => {
    m29_expect(m29_daemonOperationIsSafeToRepeat('getPrChecksStatus', {})).toBe(true);
    m29_expect(m29_daemonOperationIsSafeToRepeat('listAgentSubscriptions', {})).toBe(true);
  });

  m29_it('never repeats an ordinary write', () => {
    m29_expect(m29_daemonOperationIsSafeToRepeat('postAgentAttachment', {})).toBe(false);
    m29_expect(m29_daemonOperationIsSafeToRepeat('postRoomMessage', {})).toBe(false);
    m29_expect(m29_daemonOperationIsSafeToRepeat('walletPay', {})).toBe(false);
    m29_expect(m29_daemonOperationIsSafeToRepeat('archiveCorner', {})).toBe(false);
  });

  m29_it('repeats any operation that carries its own idempotency key', () => {
    m29_expect(m29_daemonOperationIsSafeToRepeat('createCorner', { idempotencyKey: 'one' })).toBe(true);
  });
});


m29_describe('daemon tool-call network retry', () => {
  m29_it.each([false,true])('sends one read attempt even for a transient network failure (coded=%s)',async coded=>{
    const fetched=m29_vi.fn(async()=>{throw coded?new TypeError('fetch failed',{cause:{code:'ECONNREFUSED'}}):bareFetchFailed();});
    m29_vi.stubGlobal('fetch',fetched);
    await m29_expect(m29_callAgentTool('read',{facet:'addresses'},'call-1')).rejects.toThrow('await a new action or recovery boundary');
    m29_expect(fetched).toHaveBeenCalledTimes(1);
  });

  m29_it('never retries a response the server actually sent', async () => {
    let calls = 0;
    m29_vi.stubGlobal('fetch', async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: 'boom' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    });
    await m29_expect(m29_callAgentTool('read', { facet:'addresses' }, 'call-1')).rejects.toThrow(
      'daemon operation listRooms failed (500: boom)',
    );
    m29_expect(calls).toBe(1);
  });

  m29_it('sends a non-idempotent write once and says it may not have run', async () => {
    m29_vi.stubEnv('BEELINE_DAEMON_CORNER_ID', 'corner-1');
    let calls = 0;
    m29_vi.stubGlobal('fetch', async () => {
      calls += 1;
      throw bareFetchFailed();
    });
    await m29_expect(m29_callAgentTool('close_corner', { address:'corner-1' }, 'call-1')).rejects.toThrow(
      'daemon operation archiveCorner failed before the server answered; await a new action or recovery boundary; the write outcome is unknown',
    );
    m29_expect(calls).toBe(1);
  });
});
});

import { mkdtempSync as m30_mkdtempSync, rmSync as m30_rmSync, writeFileSync as m30_writeFileSync } from 'node:fs';

import { tmpdir as m30_tmpdir } from 'node:os';

import { join as m30_join } from 'node:path';

import { afterEach as m30_afterEach, beforeEach as m30_beforeEach, describe as m30_describe, expect as m30_expect, it as m30_it, vi as m30_vi } from 'vitest';

import { callAgentTool as m30_callAgentTool } from "./read-only-mcp.js";
import { describe as mergedDescribe30 } from 'vitest';
mergedDescribe30("read-only-mcp.usage.test.ts", () => {


m30_describe('read facet usage', () => {
  let home: string;
  let calls: Array<{ name: string; input: Record<string, unknown> }>;
  let usage: unknown;

  m30_beforeEach(() => {
    home = m30_mkdtempSync(m30_join(m30_tmpdir(), 'beeline-usage-'));
    const context = m30_join(home, 'turn.json');
    m30_writeFileSync(context, JSON.stringify({ roomId: 'room-1', requestId: 'r', generationId: 'g' }));
    m30_vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', context);
    m30_vi.stubEnv('BEELINE_DAEMON_BASE_URL', 'http://daemon.test');
    m30_vi.stubEnv('BEELINE_DAEMON_TOKEN', 'daemon-only');
    m30_vi.stubEnv('BEELINE_DAEMON_AGENT_ID', 'agent-self');
    m30_vi.stubEnv('BEELINE_DAEMON_ROOM_ID', 'room-1');
    calls = [];
    m30_vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
      const name = String(url).split('/').at(-1)!;
      calls.push({ name, input: JSON.parse(String(init.body)) });
      return Response.json(usage);
    });
  });
  m30_afterEach(() => {
    m30_vi.unstubAllGlobals();
    m30_vi.unstubAllEnvs();
    m30_rmSync(home, { recursive: true, force: true });
  });

  const read = async (args: Record<string, unknown> = {}) =>
    JSON.parse(await m30_callAgentTool('read', { facet: 'usage', ...args }, 'call-1'));
  const now = Date.now() / 1000;

  m30_it('reads only the calling agent, even when another address is named', async () => {
    usage = null;
    m30_expect(await read({ address: 'someone-elses-room' })).toEqual({
      summary: 'Usage: unknown (harness reports none).',
    });
    m30_expect(calls).toEqual([{ name: 'getAgentUsage', input: { agentId: 'agent-self' } }]);
  });

  m30_it('returns every Claude window, context and staleness with a summary', async () => {
    usage = {
      updatedAt: now - 1900,
      windows: [
        { rateLimitType: 'five_hour', status: 'allowed', utilization: 0.42, resetsAt: now + 600, updatedAt: now - 1900 },
        { rateLimitType: 'seven_day', status: 'allowed_warning', utilization: 0.83, resetsAt: now + 86_400 * 3, updatedAt: now - 1900 },
      ],
      context: { used: 612_000, size: 1_000_000 },
    };
    const result = await read();
    m30_expect(result.old).toBe(true);
    m30_expect(result.usage.windows).toHaveLength(2);
    m30_expect(result.summary).toMatch(/^Usage: 5-hour 42% .*weekly 83% .*context 612K of 1M tokens/);
  });

  m30_it('gives free agents tokens and paused state, never money', async () => {
    usage = { updatedAt: now, windows: [], free: { used: 840_000, limit: 1_000_000, resetsAt: now + 3600, paused: true } };
    const text = await m30_callAgentTool('read', { facet: 'usage' }, 'call-2');
    m30_expect(JSON.parse(text).usage.free.paused).toBe(true);
    m30_expect(text).not.toContain('$');
  });

  m30_it('reports OpenRouter key spend as shared', async () => {
    usage = { updatedAt: now, windows: [], spend: { today: 4.12, week: 18.4, limit: 20, remaining: 15.88 } };
    m30_expect((await read()).summary).toContain('$15.88 of $20 key limit left');
    m30_expect((await read()).summary).toContain('shared OpenRouter key');
  });
});
});

import { afterEach as m31_afterEach, beforeEach as m31_beforeEach, expect as m31_expect, it as m31_it, vi as m31_vi } from 'vitest';

import { agentToolsFor as m31_agentToolsFor, callAgentTool as m31_callAgentTool } from "./read-only-mcp.js";
import { describe as mergedDescribe31 } from 'vitest';
mergedDescribe31("read-only-mcp.watch-corner.test.ts", () => {


const snapshot = {
  id: 'sibling',
  name: 'Ship widget',
  workflowState: 'review',
  pullRequestNumber: 42,
  pullRequestUrl: 'https://github.com/owner/widgets/pull/42',
  headSha: 'a'.repeat(40),
  checks: 'passing',
  mergeCommitSha: null,
};

let calls: { name: string; input: unknown }[];

m31_beforeEach(() => {
  m31_vi.stubEnv('BEELINE_DAEMON_BASE_URL', 'http://daemon.test');
  m31_vi.stubEnv('BEELINE_DAEMON_TOKEN', 'test-token');
  m31_vi.stubEnv('BEELINE_DAEMON_ROOM_ID', 'parent');
  m31_vi.stubEnv('BEELINE_DAEMON_CORNER_ID', 'watcher');
  m31_vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', '');
  calls = [];
  m31_vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
    const input = JSON.parse(String(init.body));
    calls.push({ name: String(url).split('/').at(-1)!, input });
    return Response.json({ kinds: input.kinds, snapshot });
  });
});

m31_afterEach(() => {
  m31_vi.unstubAllGlobals();
  m31_vi.unstubAllEnvs();
});


m31_it('calls watchCorner in the current corner and returns readable state and kinds', async () => {
  const text = await m31_callAgentTool(
    'wake', { action:"create",trigger:"lifecycle", ...{ address: 'sibling' } },
    'watch-1',
  );
  m31_expect(calls).toEqual([
    {
      name: 'watchCorner',
      input: { roomId: 'watcher', cornerId: 'sibling', kinds: ['opened', 'merged'] },
    },
  ]);
  m31_expect(text).toContain('Watching for opened, merged');
  for (const value of [
    'Ship widget',
    'review',
    '42',
    snapshot.pullRequestUrl,
    snapshot.headSha,
    'passing',
  ])
    m31_expect(text).toContain(value);
});


m31_it('rejects schedule run limits on create and update before calling the daemon', async () => {
  for (const dm of [false, true]) {
    const tool = m31_agentToolsFor(true, dm).find(t => t.name === 'wake')!;
    m31_expect(tool.inputSchema.properties).not.toHaveProperty('maxRuns');
  }
  for (const action of ['create', 'update']) {
    await m31_expect(m31_callAgentTool('wake', {
      action, trigger: 'schedule', title: 'Daily scan', scheduleId: 'sched-1',
      prompt: 'Scan.', cadence: { kind: 'interval', everyMinutes: 60 }, maxRuns: 14,
    }, `limited-${action}`)).rejects.toThrow(/invalid arguments/);
  }
  m31_expect(calls).toEqual([]);
});


m31_it('routes pause and resume for a schedule or subscription through the own-wake action', async () => {
  m31_vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
    calls.push({ name: String(url).split('/').at(-1)!, input: JSON.parse(String(init.body)) });
    return Response.json({ id: 'write-receipt', createdAt: 1 });
  });
  await m31_callAgentTool('wake', { action: 'pause', scheduleId: 'saved-schedule' }, 'pause-1');
  await m31_callAgentTool('wake', { action: 'resume', subscriptionId: 'saved-subscription' }, 'resume-1');
  m31_expect(calls).toEqual([
    { name: 'setAgentWakePaused', input: { roomId: 'watcher', scheduleId: 'saved-schedule', paused: true } },
    { name: 'setAgentWakePaused', input: { roomId: 'watcher', subscriptionId: 'saved-subscription', paused: false } },
  ]);
});

m31_it('offers lifecycle watches in a DM without chatter or schedule events', () => {
  const tool = m31_agentToolsFor(true, true).find(t => t.name === 'wake')!;
  m31_expect(tool.description).toMatch(/lifecycle/i);
  m31_expect(tool.inputSchema.required).toEqual(['action']);
});


m31_it('reports an already merged corner with its merge commit, and a closed one', async () => {
  const merged = { ...snapshot, workflowState: 'done', mergeCommitSha: 'f'.repeat(40) };
  m31_vi.stubGlobal('fetch', async () =>
    Response.json({ kinds: [], state: 'merged', woken: true, snapshot: merged }),
  );
  const text = await m31_callAgentTool(
    'wake', { action:"create",trigger:"lifecycle", ...{ address: 'sibling' } },
    'watch-3',
  );
  m31_expect(text).toContain('Corner already merged; one merged wake queued now');
  m31_expect(text).toContain('f'.repeat(40));
  m31_vi.stubGlobal('fetch', async () => Response.json({ kinds: [], state: 'closed', snapshot }));
  m31_expect(
    await m31_callAgentTool('wake', { action:"create",trigger:"lifecycle", ...{ address: 'sibling' } }, 'watch-4'),
  ).toContain('Corner closed without merging');
});


m31_it('limits the advertised address to corners, including when called from a Room or DM', () => {
  for (const dm of [false, true]) {
    const tool = m31_agentToolsFor(true, dm).find(t => t.name === 'wake')!;
    m31_expect(tool.description).toContain('requires address and watches opened/merged');
    m31_expect(tool.inputSchema.properties).not.toHaveProperty('agent');
  }
});
});

import { afterEach as m32_afterEach, beforeEach as m32_beforeEach, describe as m32_describe, expect as m32_expect, it as m32_it, vi as m32_vi } from 'vitest';

import { mkdtempSync as m32_mkdtempSync } from 'node:fs';

import { tmpdir as m32_tmpdir } from 'node:os';

import { join as m32_join } from 'node:path';

import type { AgentCommand as m32_AgentCommand } from '@beeline/api-contract/daemon';

import { agentToolsFor as m32_agentToolsFor, callAgentTool as m32_callAgentTool } from "./read-only-mcp.js";

import { CommandExecutionContext as m32_CommandExecutionContext } from "./server-command-intake.js";
import { describe as mergedDescribe32 } from 'vitest';
mergedDescribe32("read-only-mcp.workflow.test.ts", () => {


m32_describe('workflow run tools', () => {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  let context: m32_CommandExecutionContext;
  m32_beforeEach(async () => {
    calls.length = 0;
    context = new m32_CommandExecutionContext(m32_mkdtempSync(m32_join(m32_tmpdir(), 'workflow-tools-')));
    await context.enter({ roomId: 'room-1', turnRequestId: 'request-1', rootCommandId: 'command-1' } as m32_AgentCommand);
    for (const [key, value] of Object.entries({
      BEELINE_DAEMON_AGENT_ID: 'agent-1', BEELINE_DAEMON_ROOM_ID: 'room-1',
      BEELINE_DAEMON_BASE_URL: 'http://localhost:1234', BEELINE_DAEMON_TOKEN: 'test-token',
      BEELINE_TURN_CONTEXT_FILE: context.path,
    })) m32_vi.stubEnv(key, value);
    m32_vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
      calls.push({ name: new URL(url).pathname.split('/').pop()!, input: JSON.parse(String(init.body)) });
      return Response.json({ runId: 'run-1', state: 'draft' });
    });
  });
  m32_afterEach(() => { m32_vi.unstubAllEnvs(); m32_vi.unstubAllGlobals(); });

  m32_it('keeps workflows discoverable without mounting their schemas on ordinary turns', async () => {
    m32_expect(m32_agentToolsFor(true, false).map(tool => tool.name)).toContain('app_tool');
    m32_expect(m32_agentToolsFor(true, false).map(tool => tool.name)).not.toContain('get_workflow_run');
    const discovered = JSON.parse(await m32_callAgentTool('app_tool', { app: 'beeline:workflow' }, 'discover'));
    m32_expect(discovered.tools.map((tool: { name: string }) => tool.name)).toEqual(['save', 'describe', 'start', 'read', 'advance', 'cancel', 'archive', 'rebind']);
    m32_expect(calls).toEqual([]);
  });

  m32_it('reads a returned run id without requiring a write turn', async () => {
    m32_expect(JSON.parse(await m32_callAgentTool('app_tool', { app: 'beeline:workflow', tool: 'read', args: { runId: 'run-1' } }, 'read'))).toMatchObject({ runId: 'run-1' });
    m32_expect(calls).toEqual([{ name: 'getWorkflowRun', input: { roomId: 'room-1', agentId: 'agent-1', runId: 'run-1' } }]);
  });

  m32_it('binds cancellation to the active turn and forwards its reason', async () => {
    await m32_callAgentTool('app_tool', { app:'beeline:workflow', tool:'cancel', args:{ runId: 'run-1', reason: 'Request withdrawn' } });
    m32_expect(calls).toEqual([{ name: 'cancelWorkflowRun', input: {
      roomId: 'room-1', agentId: 'agent-1', runId: 'run-1', reason: 'Request withdrawn',
      requestId: 'request-1', generationId: context.generationId, taskId: 'command-1',
    } }]);
  });
});


/**
 * Inside a corner, BEELINE_DAEMON_ROOM_ID still names the PARENT Room while
 * BEELINE_DAEMON_CORNER_ID names the corner itself (`monolith-corner-turn.ts`
 * mounts the agent MCP that way). A run started in the corner stores its
 * `workflow-handoff` card under the corner's own room_id, so every workflow
 * run tool must target the corner id the same way `agentScheduleRoomId()`
 * already does for scheduling — never fall back to the parent env var, or
 * the server answers 503 "workflow run is unavailable in this Room".
 */
m32_describe('workflow run tools inside a corner', () => {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  let context: m32_CommandExecutionContext;
  m32_beforeEach(async () => {
    calls.length = 0;
    context = new m32_CommandExecutionContext(m32_mkdtempSync(m32_join(m32_tmpdir(), 'workflow-tools-corner-')));
    await context.enter({ roomId: 'corner-1', turnRequestId: 'request-1', rootCommandId: 'command-1' } as m32_AgentCommand);
    for (const [key, value] of Object.entries({
      BEELINE_DAEMON_AGENT_ID: 'agent-1', BEELINE_DAEMON_ROOM_ID: 'parent-room',
      BEELINE_DAEMON_CORNER_ID: 'corner-1',
      BEELINE_DAEMON_BASE_URL: 'http://localhost:1234', BEELINE_DAEMON_TOKEN: 'test-token',
      BEELINE_TURN_CONTEXT_FILE: context.path,
    })) m32_vi.stubEnv(key, value);
    m32_vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
      calls.push({ name: new URL(url).pathname.split('/').pop()!, input: JSON.parse(String(init.body)) });
      return Response.json({ runId: 'run-1', state: 'draft' });
    });
  });
  m32_afterEach(() => { m32_vi.unstubAllEnvs(); m32_vi.unstubAllGlobals(); });

  m32_it('reads the run stored in the corner, not the parent Room', async () => {
    await m32_callAgentTool('app_tool', { app: 'beeline:workflow', tool: 'read', args: { runId: 'run-1' } }, 'read');
    m32_expect(calls).toEqual([{ name: 'getWorkflowRun', input: { roomId: 'corner-1', agentId: 'agent-1', runId: 'run-1' } }]);
  });

  m32_it('advances a run with handoff scoped to the corner', async () => {
    await m32_callAgentTool('app_tool', { app:'beeline:workflow', tool:'advance', args:{ runId: 'run-1', outcome: 'done', contents: { note: 'ready' } } });
    m32_expect(calls).toEqual([{ name: 'handoff', input: {
      roomId: 'corner-1', agentId: 'agent-1', runId: 'run-1', outcome: 'done', contents: { note: 'ready' },
      requestId: 'request-1', generationId: context.generationId, taskId: 'command-1',
    } }]);
  });

  m32_it('starts, cancels and reassigns a workflow role scoped to the corner', async () => {
    await m32_callAgentTool('app_tool', { app:'beeline:workflow', tool:'start', args:{ name: 'triage', roleBindings: { reviewer: 'agent-1' } } });
    await m32_callAgentTool('app_tool', { app:'beeline:workflow', tool:'cancel', args:{ runId: 'run-1', reason: 'no longer needed' } });
    await m32_callAgentTool('app_tool', { app:'beeline:workflow', tool:'rebind', args:{ runId: 'run-1', role: 'reviewer', agent: 'agent-2' } });
    m32_expect(calls.map((call) => call.input.roomId)).toEqual(['corner-1', 'corner-1', 'corner-1']);
  });
});
});

import { afterEach as m33_afterEach, describe as m33_describe, expect as m33_expect, it as m33_it, vi as m33_vi } from 'vitest';

import { callAgentTool as m33_callAgentTool } from "./read-only-mcp.js";
import { describe as mergedDescribe33 } from 'vitest';
mergedDescribe33("request-grant-validation.test.ts", () => {


const valid = { action: 'request', kind: 'host', target: 'example.com', reason: 'Inspect service', purpose: 'Diagnose the service' };


m33_afterEach(() => {
  m33_vi.unstubAllGlobals();
  m33_vi.unstubAllEnvs();
});


m33_describe('GRANT-VALIDATION-1: advertised request_grant refusals', () => {
  m33_it('names all missing request fields together', async () => {
    const error = await m33_callAgentTool('request_grant', {}, 'empty').catch(error => error as Error);
    for (const field of Object.keys(valid)) m33_expect((error as Error).message).toContain(`${field}: expected`);
  });

  m33_it.each([{ action: 'list' }, valid])('preserves valid dispatch for $action', async args => {
    m33_vi.stubEnv('BEELINE_DAEMON_ROOM_ID', 'room-1');
    m33_vi.stubEnv('BEELINE_DAEMON_BASE_URL', 'http://localhost:1234');
    m33_vi.stubEnv('BEELINE_DAEMON_TOKEN', 'test-token');
    const fetch = m33_vi.fn(async () => Response.json({ grants: [] }));
    m33_vi.stubGlobal('fetch', fetch);
    await m33_callAgentTool('request_grant', args, 'valid');
    m33_expect(fetch).toHaveBeenCalledOnce();
  });

  m33_it('does not echo unknown field names or request values', async () => {
    await m33_expect(m33_callAgentTool('request_grant', { ...valid, 'private-marker': 'private-value' }, 'unknown'))
      .rejects.toThrow('input: expected only advertised fields');
    const error = await m33_callAgentTool('request_grant', { ...valid, 'private-marker': 'private-value' }, 'unknown').catch(error => error as Error);
    m33_expect((error as Error).message).not.toMatch(/private-marker|private-value/);
  });

  m33_it.each(['action', 'kind', 'target', 'reason', 'purpose'])('names missing %s and its expected value', async field => {
    const args: Record<string, unknown> = { ...valid };
    delete args[field];
    await m33_expect(m33_callAgentTool('request_grant', args, `missing-${field}`)).rejects.toThrow(new RegExp(`${field}: expected`));
  });

  m33_it.each([
    ['action', 'private-marker', 'request, list'],
    ['kind', 'private-marker', 'host'],
    ['target', 123, 'string'],
    ['target', '', 'at least 1'],
    ['target', 'private-marker'.repeat(100), 'at most 512'],
    ['reason', false, 'string'],
    ['reason', '', 'at least 1'],
    ['purpose', '', 'at least 1'],
    ['purpose', 'private-marker'.repeat(100), 'at most 240'],
    ['ttl', 1, 'at least 60'],
    ['touches', {}, 'string'],
    ['capabilities', [], 'string'],
  ])('explains invalid %s without echoing values', async (field, value, expected) => {
    const error = await m33_callAgentTool('request_grant', { ...valid, [field]: value }, `invalid-${field}`).catch(error => error as Error);
    m33_expect(error).toBeInstanceOf(Error);
    m33_expect((error as Error).message).toContain(`${field}: expected`);
    m33_expect((error as Error).message).toContain(expected);
    m33_expect((error as Error).message).not.toContain('private-marker');
  });
});
});

import { mkdtempSync as m34_mkdtempSync, mkdirSync as m34_mkdirSync, realpathSync as m34_realpathSync, rmSync as m34_rmSync, symlinkSync as m34_symlinkSync, writeFileSync as m34_writeFileSync } from 'node:fs';

import { tmpdir as m34_tmpdir } from 'node:os';

import { join as m34_join } from 'node:path';

import { afterEach as m34_afterEach, beforeEach as m34_beforeEach, describe as m34_describe, expect as m34_expect, it as m34_it, vi as m34_vi } from 'vitest';

import { bindBriefFiles as m34_bindBriefFiles, postArtifact as m34_postArtifact, resolveAttachPath as m34_resolveAttachPath, type PostArtifactDeps as m34_PostArtifactDeps } from "./read-only-mcp.js";
import { describe as mergedDescribe34 } from 'vitest';
mergedDescribe34("resolve-attach-path.test.ts", () => {


m34_describe('attachment home shortcut', () => {
  let root: string;
  let home: string;
  let checkout: string;
  let roots: string[];
  m34_beforeEach(() => {
    root = m34_mkdtempSync(m34_join(m34_tmpdir(), 'attach-home-'));
    home = m34_join(root, 'home');
    checkout = m34_join(root, 'checkout');
    m34_mkdirSync(home);
    m34_mkdirSync(checkout);
    roots = [checkout, home];
    m34_vi.stubEnv('HOME', home);
    m34_writeFileSync(m34_join(home, 'notes.txt'), 'File for delivery');
    m34_writeFileSync(m34_join(root, 'outside.txt'), 'Private');
  });
  m34_afterEach(() => {
    m34_vi.unstubAllEnvs();
    m34_rmSync(root, { recursive: true, force: true });
  });

  m34_it('Reproduction artifact-tilde-path: resolves a file in the shell home', () => {
    m34_expect(m34_resolveAttachPath(roots, '~/notes.txt')).toBe(m34_realpathSync(m34_join(home, 'notes.txt')));
  });

  m34_it('keeps absolute and checkout-relative paths working', () => {
    m34_expect(m34_resolveAttachPath(roots, m34_join(home, 'notes.txt'))).toBe(m34_realpathSync(m34_join(home, 'notes.txt')));
    m34_writeFileSync(m34_join(checkout, 'local.txt'), 'Local');
    m34_expect(m34_resolveAttachPath(roots, 'local.txt')).toBe(m34_realpathSync(m34_join(checkout, 'local.txt')));
  });

  m34_it('refuses absolute, home traversal and symlink escapes', () => {
    m34_symlinkSync(m34_join(root, 'outside.txt'), m34_join(home, 'link.txt'));
    for (const path of [m34_join(root, 'outside.txt'), '~/../outside.txt', '~/link.txt']) {
      m34_expect(() => m34_resolveAttachPath(roots, path)).toThrow(/outside your checkout/);
    }
    m34_expect(() => m34_resolveAttachPath([checkout], '~/notes.txt')).toThrow(/outside your checkout/);
  });

  m34_it('leaves username and embedded tildes literal', () => {
    for (const dir of ['~someone', 'nested/~']) {
      m34_mkdirSync(m34_join(checkout, dir), { recursive: true });
      m34_writeFileSync(m34_join(checkout, dir, 'notes.txt'), 'Literal');
      m34_expect(m34_resolveAttachPath(roots, `${dir}/notes.txt`)).toBe(m34_realpathSync(m34_join(checkout, dir, 'notes.txt')));
    }
  });

  m34_it('delivers home-shortcut bytes through artifact and brief attachment paths', async () => {
    const uploaded: Buffer[] = [];
    const queued: unknown[] = [];
    const deps: m34_PostArtifactDeps = {
      roomId: 'fixture', roots,
      upload: async (bytes) => {
        uploaded.push(bytes);
        return { url: '/v1/media/11111111-1111-4111-8111-111111111111' };
      },
      queue: async (attachment) => { queued.push(attachment); },
    };
    await m34_postArtifact({ path: '~/notes.txt' }, deps);
    const brief = await m34_bindBriefFiles({ attachments: [{ path: '~/notes.txt' }] }, deps);
    m34_expect(uploaded.map((bytes) => bytes.toString())).toEqual(['File for delivery', 'File for delivery']);
    m34_expect(queued).toHaveLength(2);
    m34_expect(brief.attachments).toEqual([m34_expect.objectContaining({ objectId: '11111111-1111-4111-8111-111111111111' })]);
  });
});
});

import { afterEach as m43_afterEach, describe as m43_describe, expect as m43_expect, it as m43_it, vi as m43_vi } from 'vitest';

import { agentToolsFor as m43_agentToolsFor, callAgentTool as m43_callAgentTool, daemonOperationIsSafeToRepeat as m43_daemonOperationIsSafeToRepeat } from "./read-only-mcp.js";
import { describe as mergedDescribe43 } from 'vitest';
mergedDescribe43("wallet-tools.test.ts", () => {


m43_afterEach(() => {
  m43_vi.unstubAllEnvs();
  m43_vi.unstubAllGlobals();
  m43_vi.useRealTimers();
});


const payload = {
  domain: {
    name: 'Exchange',
    version: '1',
    chainId: 1337,
    verifyingContract: '0x' + '0'.repeat(40),
  },
  types: { BeelineTest: [{ name: 'notice', type: 'string' }] },
  primaryType: 'BeelineTest',
  message: { notice: 'Harmless signing test; no order or transfer' },
};


m43_describe('wallet MCP identity and signing', () => {
  m43_it('routes every wallet tool as the actual agent in its active corner', async () => {
    m43_vi.stubEnv('BEELINE_DAEMON_AGENT_ID', 'agent-1');
    m43_vi.stubEnv('BEELINE_DAEMON_ROOM_ID', 'parent-room');
    m43_vi.stubEnv('BEELINE_DAEMON_CORNER_ID', 'corner-1');
    m43_vi.stubEnv('BEELINE_DAEMON_BASE_URL', 'http://localhost:1234');
    m43_vi.stubEnv('BEELINE_DAEMON_TOKEN', 'test-token');
    m43_vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', '');
    const calls: Array<{ name: string; body: Record<string, unknown> }> = [];
    m43_vi.stubGlobal('fetch', async (url: URL, options: RequestInit) => {
      const body = JSON.parse(options.body as string);
      calls.push({ name: url.pathname.split('/').at(-1)!, body });
      // Mirror the server ownership invariant: the old literal self fails.
      if (body.agentId !== 'agent-1')
        return Response.json(
          { error: 'daemon token does not own requested agent' },
          { status: 503 },
        );
      return Response.json({ ok: true });
    });
    for (const [tool, args] of [
      ['wallet_address', {}],
      ['wallet_balance', {}],
      ['wallet_chains', {}],
      ['wallet_history', { limit: 5 }],
      ['wallet_quote', { asset: 'usdc', amount: '1' }],
      ['wallet_pay', { asset: 'usdc', amount: '1', to: '0xabc' }],
      ['wallet_swap', { fromAsset: 'usdc', toAsset: 'eth', amount: '1' }],
      [
        'wallet_contract_call',
        {
          chain: 'arbitrum',
          contract: '0x' + '1'.repeat(40),
          data: '0xd0e30db0',
          approve: { asset: 'usdc', amount: '5' },
        },
      ],
      ['wallet_sign_typed_data', payload],
    ] as const)
      await m43_expect(m43_callAgentTool('app_tool', { app:'beeline:wallet', tool:tool.replace('wallet_', ''), args }, 'wallet-call')).resolves.toBe('{"ok":true}');
    m43_expect(calls).toHaveLength(9);
    m43_expect(calls.find((call) => call.name === 'walletContractCall')?.body).toEqual({
      completionV1: true,
      agentId: 'agent-1',
      roomId: 'corner-1',
      chain: 'arbitrum',
      contract: '0x' + '1'.repeat(40),
      data: '0xd0e30db0',
      approve: { asset: 'usdc', amount: '5' },
    });
    for (const call of calls)
      m43_expect(call.body).toMatchObject({ agentId: 'agent-1', roomId: 'corner-1' });
    for (const call of calls.filter(call => ['walletPay', 'walletSwap', 'walletContractCall'].includes(call.name)))
      m43_expect(call.body.completionV1).toBe(true);
    m43_expect(calls.at(-1)).toEqual({
      name: 'walletSignTypedData',
      body: { ...payload, agentId: 'agent-1', roomId: 'corner-1' },
    });
    m43_expect(m43_daemonOperationIsSafeToRepeat('walletSignTypedData', {})).toBe(false);
    m43_expect(m43_daemonOperationIsSafeToRepeat('walletContractCall', {})).toBe(false);
  });

  m43_it('discovers wallet operations without mounting wallet schemas on ordinary turns', async () => {
    const names = m43_agentToolsFor(true, false).map(tool => tool.name);
    m43_expect(names).toContain('app_tool');
    m43_expect(names).not.toContain('wallet_contract_call');
    const catalog = JSON.parse(await m43_callAgentTool('app_tool', { app: 'beeline:wallet' }, 'discover'));
    const typed = catalog.tools.find((tool: { name: string }) => tool.name === 'sign_typed_data');
    m43_expect(typed.inputSchema.required).toEqual(['domain', 'types', 'primaryType', 'message']);
    m43_expect(typed.description).toContain('authorize transfers');
    m43_expect(catalog.tools.map((tool: { name: string }) => tool.name)).toEqual(m43_expect.arrayContaining(['contract_call', 'link_request', 'link_wait']));
  });

  m43_it('returns an uncertain payment as pending and never redispatches it on elapsed time', async () => {
    m43_vi.useFakeTimers();
    m43_vi.stubEnv('BEELINE_DAEMON_AGENT_ID', 'agent-1');
    m43_vi.stubEnv('BEELINE_DAEMON_CORNER_ID', 'corner-1');
    m43_vi.stubEnv('BEELINE_DAEMON_BASE_URL', 'http://localhost:1234');
    m43_vi.stubEnv('BEELINE_DAEMON_TOKEN', 'test-token');
    m43_vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', '');
    const result = { outcome: 'pending', reason: 'Transaction submission is UNKNOWN. Do not resubmit this intent.' };
    const fetched = m43_vi.fn(async (_url: unknown, init: RequestInit) => {
      m43_expect(JSON.parse(String(init.body))).toMatchObject({ completionV1: true, agentId: 'agent-1' });
      return Response.json(result);
    });
    m43_vi.stubGlobal('fetch', fetched);
    m43_expect(JSON.parse(await m43_callAgentTool('app_tool', { app: 'beeline:wallet', tool: 'pay',
      args: { chain: 'base', asset: 'usdc', amount: '1', to: `0x${'1'.repeat(40)}` } }, 'uncertain-payment'))).toEqual(result);
    await m43_vi.advanceTimersByTimeAsync(86_400_000);
    m43_expect(fetched).toHaveBeenCalledTimes(1);
    m43_expect(m43_daemonOperationIsSafeToRepeat('walletPay', {})).toBe(false);
  });

});
});
