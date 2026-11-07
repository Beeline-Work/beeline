import { describe, it, expect, cornerCallText, Check, callAgentTool, CAPABILITY_TOOLS, toolValidationSchema, m7_describe, m7_expect, m7_it, m7_agentToolsFor, m7_askChoice, m7_openPoll, mergedDescribe7, m8_describe, m8_expect, m8_it, m8_agentToolsFor, m8_emitEvent, m8_listEventSubscriptions, m8_subscribeEvents, mergedDescribe8, m9_createHash, m9_tmpdir, m9_describe, m9_expect, m9_it, m9_REQUESTABLE_AGENT_GRANT_KINDS, m9_agentToolsFor, m9_listGrants, m9_requestGrant, m9_requestSharedAssetIsolation, m9_runGrantedCommand, m9_storeSecret, m9_resolveGrantCommand, m9_approvedDeviceGrant, mergedDescribe9, schema, fixtureScope3, fixtureScope6, fixtureScope8, fixtureScope12, type m9_GrantRunDeps, type Call } from './test-support-read-only-mcp.test-support.js';

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
    expect(Check(schema('report'),{status:'blocked',text:'input required',to:'captain'})).toBe(false);
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
mergedDescribe7("agent-choice-tools.test.ts", () => {
const scope3 = fixtureScope3();
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
    await m7_askChoice({ prompt: 'Ship the OTA tonight?', options: scope3.options }, scope3.deps({ choiceId: 'c-1' }, ops));
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
        options: scope3.options,
        ttl: 900,
      },
      scope3.deps({ choiceId: 'c-1', messageId: 'm-1', mode: 'question', electorateCount: 1 }, ops),
    );
    m7_expect(ops).toEqual([
      {
        name: 'askRoomChoice',
        input: {
          roomId: 'room-1',
          ask: 'Which approach should we use?',
        prompt: 'How do you want to push the desk past this?',
          constraint: 'CDP AgentKit needs JWT signing',
          options: scope3.options,
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
      { prompt: 'Which paper API?', options: scope3.options, ttl: 3600 },
      scope3.deps(
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
        options: scope3.options,
        ttlSeconds: 3600,
      },
    });
    m7_expect(reply).toContain('electorate 4');
    m7_expect(reply).toContain('preference fact');
    m7_expect(reply).toContain('tie or no votes');
  });
});
});
mergedDescribe8("agent-event-tools.test.ts", () => {
const scope6 = fixtureScope6();
m8_describe('beeline-agent event tools', () => {
  m8_it('an agent subscribes itself, and the reply names the whole resulting list', async () => {
    const calls: Call[] = [];
    const result = await m8_subscribeEvents(
      { kinds: ['joined'] },
      scope6.deps(calls, { setEventSubscriptions: { kinds: ['joined'] } }),
    );
    m8_expect(calls).toEqual([
      { name: 'setEventSubscriptions', input: { roomId: 'room-1', kinds: ['joined'] } },
    ]);
    m8_expect(result).toContain('joined');
    m8_expect(result).toContain('You now react to');
  });


  m8_it('refuses a kind that is not a server event kind, without calling the daemon', async () => {
    const calls: Call[] = [];
    await m8_expect(m8_subscribeEvents({ kinds: ['agent:handoff'] }, scope6.deps(calls))).rejects.toThrow(
      /not an event kind you can subscribe to: agent:handoff/,
    );
    await m8_expect(m8_subscribeEvents({ kinds: ['everything'] }, scope6.deps(calls))).rejects.toThrow(
      /not an event kind/,
    );
    m8_expect(calls).toEqual([]);
  });


  m8_it('refuses a per-item kind: it already wakes its own owner, with no subscription involved', async () => {
    const calls: Call[] = [];
    await m8_expect(m8_subscribeEvents({ kinds: ['grant-decided'] }, scope6.deps(calls))).rejects.toThrow(
      /grant-decided wakes its own item's owner automatically/,
    );
    await m8_expect(
      m8_subscribeEvents({ kinds: ['joined', 'choice-answered'] }, scope6.deps(calls)),
    ).rejects.toThrow(/choice-answered wakes its own item's owner automatically/);
    m8_expect(calls).toEqual([]);
  });


  m8_it('an empty subscription list is a legal answer and says the agent reacts to nothing', async () => {
    const calls: Call[] = [];
    const result = await m8_subscribeEvents(
      { kinds: [] },
      scope6.deps(calls, { setEventSubscriptions: { kinds: [] } }),
    );
    m8_expect(calls[0]?.input).toEqual({ roomId: 'room-1', kinds: [] });
    m8_expect(result).toContain('react to no events');
  });


  m8_it('lists what the agent currently reacts to', async () => {
    const calls: Call[] = [];
    const result = await m8_listEventSubscriptions(
      scope6.deps(calls, { listEventSubscriptions: { kinds: ['joined', 'merged'] } }),
    );
    m8_expect(calls).toEqual([{ name: 'listEventSubscriptions', input: { roomId: 'room-1' } }]);
    m8_expect(result).toContain('joined, merged');
  });


  m8_it('emit_event forwards kind, sentence and mentions, and never a cause', async () => {
    const calls: Call[] = [];
    const result = await m8_emitEvent(
      { kind: 'agent:handoff', consequence: 'the branch is ready', mentionAgentIds: ['agent-b'] },
      scope6.deps(calls),
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
    await m8_expect(m8_emitEvent({ kind: 'joined', consequence: 'hello' }, scope6.deps(calls))).rejects.toThrow(
      /a fact the server states/,
    );
    await m8_expect(
      m8_emitEvent({ kind: 'agent:Handoff', consequence: 'hello' }, scope6.deps(calls)),
    ).rejects.toThrow(/agent:<slug>/);
    await m8_expect(m8_emitEvent({ kind: 'agent:x', consequence: '   ' }, scope6.deps(calls))).rejects.toThrow(
      /one sentence/,
    );
    await m8_expect(
      m8_emitEvent(
        { kind: 'agent:x', consequence: 'ok', mentionAgentIds: ['a', 'b', 'c', 'd'] },
        scope6.deps(calls),
      ),
    ).rejects.toThrow(/at most 3 agents/);
    m8_expect(calls).toEqual([]);
  });


  m8_it('accepts the advertised maximum lengths and refuses the next character', async () => {
    const calls: Call[] = [];
    await m8_emitEvent({ kind: `agent:${'x'.repeat(40)}`, consequence: 'x'.repeat(200) }, scope6.deps(calls));
    await m8_expect(m8_emitEvent({ kind: `agent:${'x'.repeat(41)}`, consequence: 'ok' }, scope6.deps(calls)))
      .rejects.toThrow(/slug at most 40 characters/);
    await m8_expect(m8_emitEvent({ kind: 'agent:x', consequence: 'x'.repeat(201) }, scope6.deps(calls)))
      .rejects.toThrow(/at most 200 characters/);
    m8_expect(calls).toHaveLength(1);
  });


  m8_it("surfaces the server's refusal verbatim, so the emitting model reads why nothing was posted", async () => {
    const calls: Call[] = [];
    await m8_expect(
      m8_emitEvent(
        { kind: 'agent:ping', consequence: 'again' },
        scope6.deps(calls, {
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
mergedDescribe9("agent-grant-tools.test.ts", () => {
const scope8 = fixtureScope8();
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
      ...scope8.deps({ grantId: 'native', status: 'pending', auto: false }, ops),
      scriptRoots: [m9_tmpdir()],
    });
    m9_expect(ops).toHaveLength(1);
    m9_expect(ops[0]!.name).toBe('requestAgentGrant');
    m9_expect(ops[0]!.input.script).toBeUndefined();
  });


  m9_it.each([undefined, '', '   ', 'x'.repeat(241)])('rejects invalid purpose %s before requesting approval', async (purpose) => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    await m9_expect(m9_requestGrant({ kind: 'command', target: 'git status', reason: 'inspect', purpose }, scope8.deps({}, ops))).rejects.toThrow('purpose is required');
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
    }, scope8.deps({ grantId: 'g-7', status: 'pending', auto: false }, ops));
    m9_expect(ops).toEqual([{ name: 'requestAgentGrant', input: {
      roomId: 'room-1', kind: 'shared_asset', target: 'package-cache',
      purpose: 'Shared npm tarball is corrupt', reason: 'Shared npm tarball is corrupt',
    } }]);
    m9_expect(answer).toContain('pending, card posted: isolate package-cache');
    await m9_expect(m9_requestSharedAssetIsolation({ category: 'cache/file', purpose: 'broken', reason: 'broken' },
      scope8.deps({}, ops))).rejects.toThrow('category must be one of');
    m9_expect(ops).toHaveLength(1);
  });

  m9_it.each([
    { kind: 'budget', target: '$10', purpose: 'more tokens', reason: 'more tokens' },
    { kind: 'repository', target: 'acme/widgets', purpose: 'edit the repository', reason: 'edit the repository' },
  ])('rejects retired $kind prompts before calling the server', async (ask) => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    await m9_expect(m9_requestGrant(ask, scope8.deps({}, ops))).rejects.toThrow('kind must be one of');
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
      scope8.deps(
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
      scope8.deps(
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
      scope8.deps({ grantId: 'g-2', status: 'approved', auto: true }),
    );
    m9_expect(command).toBe(
      'approved: run npm test [grant g-2]. Run it now with run_granted_command and the argv.',
    );
    const host = await m9_requestGrant(
      { kind: 'host', target: ' api.fly.io ', purpose: 'reach the Fly API', reason: 'reach the Fly API' },
      scope8.deps({ grantId: 'g-3', status: 'approved', auto: true }),
    );
    m9_expect(host).toBe(
      "approved: reach api.fly.io [grant g-3]; applies at the agent's next session.",
    );
  });


  m9_it('tells an instantly approved /dev/ device grant that this same turn continues with it', async () => {
    const device = await m9_requestGrant(
      { kind: 'device', target: '/dev/kvm', purpose: 'run the Android emulator', reason: 'run the Android emulator' },
      scope8.deps({ grantId: 'g-4', status: 'approved', auto: true }),
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
      scope8.deps({ grantId: 'g-5', status: 'approved', auto: true }),
    );
    m9_expect(outside).toBe(
      'approved: use kvm [grant g-5], but only device nodes under /dev/ are added to your session, so nothing was added.',
    );
  });


  m9_it('refuses shell metacharacters and malformed asks before the server is called', async () => {
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    const answer = scope8.deps({ grantId: 'never' }, ops);
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
    const ask = scope8.deps({ grantId: 'never' }, ops, {});
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
      scope8.deps({ grantId: 'g-7', status: 'approved', auto: true }, ops),
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
      scope8.deps(
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
    const reply = await m9_listGrants(scope8.deps({ grants: [] }));
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
m9_describe('request_grant carries the script an interpreter will run', () => {
const scope12 = fixtureScope12(scope8);


  m9_it.each(['-v', '-iv --', '--chdir=CHECKOUT', '-i -u FOO -C CHECKOUT', '--block-signal=PIPE', '--ignore-signal', '--default-signal='])('binds env %s scripts to the executed bytes', async (option) => {
    const contents = '#!/bin/sh\nprintf approved\n';
    const root = scope12.checkout(contents, 'script.sh');
    const ops: Array<{ name: string; input: Record<string, unknown> }> = [];
    await m9_requestGrant({ kind: 'command', target: `env ${option.replaceAll('CHECKOUT', root)} ./script.sh`,
      purpose: 'Run reviewed script', reason: 'Wrapper hash regression' }, {
      ...scope8.deps({ grantId: 'script', status: 'pending', auto: false }, ops), scriptRoots: [root],
    });
    m9_expect(ops[0]!.input.script).toEqual({ path: './script.sh', contents, bytes: Buffer.byteLength(contents),
      sha256: m9_createHash('sha256').update(contents).digest('hex') });
  });
});
});
