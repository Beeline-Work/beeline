import { m26_expect, m26_it, m26_vi, m26_callAgentTool, mergedDescribe26, m27_expect, m27_it, m27_vi, m27_agentToolsFor, m27_callAgentTool, mergedDescribe27, m28_describe, m28_expect, m28_it, m28_vi, m28_beelineManagedSkills, m28_callAgentTool, mergedDescribe28, m29_describe, m29_expect, m29_it, m29_vi, m29_callAgentTool, m29_daemonOperationIsSafeToRepeat, m29_isDaemonNetworkFailure, mergedDescribe29, m30_describe, m30_expect, m30_it, m30_callAgentTool, mergedDescribe30, m31_expect, m31_it, m31_vi, m31_agentToolsFor, m31_callAgentTool, mergedDescribe31, m32_describe, m32_expect, m32_it, m32_agentToolsFor, m32_callAgentTool, mergedDescribe32, m33_describe, m33_expect, m33_it, m33_vi, m33_callAgentTool, mergedDescribe33, m34_mkdirSync, m34_realpathSync, m34_symlinkSync, m34_writeFileSync, m34_join, m34_describe, m34_expect, m34_it, m34_bindBriefFiles, m34_postArtifact, m34_resolveAttachPath, mergedDescribe34, m43_describe, m43_expect, m43_it, m43_vi, m43_agentToolsFor, m43_callAgentTool, m43_daemonOperationIsSafeToRepeat, mergedDescribe43, fixtureScope24, fixtureScope25, fixtureScope27, fixtureScope28, fixtureScope33, fixtureScope34, fixtureScope36, fixtureScope37, fixtureScope38, fixtureScope41, fixtureScope42, type m34_PostArtifactDeps } from './read-only-mcp.test-support.js';

mergedDescribe26("read-only-mcp.onboarding.test.ts", () => {
const scope24 = fixtureScope24();



m26_it.each(['GitHub', 'link my repository', 'connect my repo', 'GitHub repository'])('R-REPO-CARD: routes %s to the repository card before connector search', async service => {
  const result = JSON.parse(await m26_callAgentTool('connect', {mode:'ensure', service, reason:`Connect ${service}`, continuation:`Connect my ${service} account.`}, 'repo-connect'));
  m26_expect(result).toMatchObject({status:'ready', app:'beeline:onboarding'});
  await m26_callAgentTool('app_tool', {app:result.app, tool:'repository', args:{}}, 'repo-card');
  m26_expect(scope24.calls.some(call => call.name === 'postRepositoryOnboarding')).toBe(true);
  m26_expect(scope24.calls.some(call => ['connect','find_connectors'].includes(call.name))).toBe(false);
});


m26_it('advertises repository onboarding without an exact-name query', async () => {
  const result = JSON.parse(await m26_callAgentTool('connect', {mode:'discover'}, 'discover'));
  m26_expect(result.capabilities).toContain('beeline:onboarding');
});



m26_it('reports unavailable repo cards without attempting an external connector', async () => {
  m26_vi.stubGlobal('fetch', async (url: URL) => {
    scope24.calls.push({name:new URL(url).pathname.split('/').pop()!,input:{}});
    return Response.json({repositoryOnboarding:false});
  });
  const result = JSON.parse(await m26_callAgentTool('connect', {mode:'ensure',service:'link my repository',reason:'Connect the repository',continuation:'Show the repository card.'}, 'connect'));
  m26_expect(result).toMatchObject({status:'unavailable',app:'beeline:onboarding'});
  m26_expect(result.next).toContain('active Room');
  m26_expect(scope24.calls.map(call => call.name)).toEqual(['getRoomRepositoryState']);
});



m26_it('keeps ordinary GitHub repository reads on the connector route', async () => {
  await m26_callAgentTool('connect', {mode:'ensure', service:'GitHub', reason:'List repositories', continuation:'Read the account repositories.'}, 'github');
  m26_expect(scope24.calls.map(call => call.name)).toEqual(['connect']);
});



m26_it('binds the visual clip preview and visibility to the active Room turn', async () => {
  const args={videoObjectId:'11111111-1111-4111-8111-111111111111',frameObjectId:'22222222-2222-4222-8222-222222222222',title:'Clip preview',description:'A short clip',visibility:'unlisted'};
  await m26_callAgentTool('app_tool',{app:'beeline:onboarding',tool:'video_preview',args});
  m26_expect(scope24.calls.find(call=>call.name==='postStarterVideoPreview')!.input).toMatchObject({...args,roomId:'room-1',requestId:'request-1',taskId:'command-1',generationId:scope24.context.generationId});
});
});
mergedDescribe27("read-only-mcp.order.test.ts", () => {
const scope25 = fixtureScope25();



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
mergedDescribe28("read-only-mcp.procedure.test.ts", () => {m28_describe('read procedure built-in skills (R1)', () => {
const scope27 = fixtureScope27();


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
mergedDescribe29("read-only-mcp.retry.test.ts", () => {
const scope28 = fixtureScope28();
m29_describe('daemon network-failure classification', () => {
  m29_it('recognises a bare fetch failed and a coded cause, never a server response', () => {
    m29_expect(m29_isDaemonNetworkFailure(scope28.bareFetchFailed())).toBe(true);
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
    const fetched=m29_vi.fn(async()=>{throw coded?new TypeError('fetch failed',{cause:{code:'ECONNREFUSED'}}):scope28.bareFetchFailed();});
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
      throw scope28.bareFetchFailed();
    });
    await m29_expect(m29_callAgentTool('close_corner', { address:'corner-1' }, 'call-1')).rejects.toThrow(
      'daemon operation archiveCorner failed before the server answered; await a new action or recovery boundary; the write outcome is unknown',
    );
    m29_expect(calls).toBe(1);
  });
});
});
mergedDescribe30("read-only-mcp.usage.test.ts", () => {m30_describe('read facet usage', () => {
const scope33 = fixtureScope33();


  m30_it('reads only the calling agent, even when another address is named', async () => {
    scope33.usage = null;
    m30_expect(await scope33.read({ address: 'someone-elses-room' })).toEqual({
      summary: 'Usage: unknown (harness reports none).',
    });
    m30_expect(scope33.calls).toEqual([{ name: 'getAgentUsage', input: { agentId: 'agent-self' } }]);
  });


  m30_it('returns every Claude window, context and staleness with a summary', async () => {
    scope33.usage = {
      updatedAt: scope33.now - 1900,
      windows: [
        { rateLimitType: 'five_hour', status: 'allowed', utilization: 0.42, resetsAt: scope33.now + 600, updatedAt: scope33.now - 1900 },
        { rateLimitType: 'seven_day', status: 'allowed_warning', utilization: 0.83, resetsAt: scope33.now + 86_400 * 3, updatedAt: scope33.now - 1900 },
      ],
      context: { used: 612_000, size: 1_000_000 },
    };
    const result = await scope33.read();
    m30_expect(result.old).toBe(true);
    m30_expect(result.usage.windows).toHaveLength(2);
    m30_expect(result.summary).toMatch(/^Usage: 5-hour 42% .*weekly 83% .*context 612K of 1M tokens/);
  });


  m30_it('gives free agents tokens and paused state, never money', async () => {
    scope33.usage = { updatedAt: scope33.now, windows: [], free: { used: 840_000, limit: 1_000_000, resetsAt: scope33.now + 3600, paused: true } };
    const text = await m30_callAgentTool('read', { facet: 'usage' }, 'call-2');
    m30_expect(JSON.parse(text).usage.free.paused).toBe(true);
    m30_expect(text).not.toContain('$');
  });


  m30_it('reports OpenRouter key spend as shared', async () => {
    scope33.usage = { updatedAt: scope33.now, windows: [], spend: { today: 4.12, week: 18.4, limit: 20, remaining: 15.88 } };
    m30_expect((await scope33.read()).summary).toContain('$15.88 of $20 key limit left');
    m30_expect((await scope33.read()).summary).toContain('shared OpenRouter key');
  });
});
});
mergedDescribe31("read-only-mcp.watch-corner.test.ts", () => {
const scope34 = fixtureScope34();



m31_it('calls watchCorner in the current corner and returns readable state and kinds', async () => {
  const text = await m31_callAgentTool(
    'wake', { action:"create",trigger:"lifecycle", ...{ address: 'sibling' } },
    'watch-1',
  );
  m31_expect(scope34.calls).toEqual([
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
    scope34.snapshot.pullRequestUrl,
    scope34.snapshot.headSha,
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
  m31_expect(scope34.calls).toEqual([]);
});



m31_it('routes pause and resume for a schedule or subscription through the own-wake action', async () => {
  m31_vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
    scope34.calls.push({ name: String(url).split('/').at(-1)!, input: JSON.parse(String(init.body)) });
    return Response.json({ id: 'write-receipt', createdAt: 1 });
  });
  await m31_callAgentTool('wake', { action: 'pause', scheduleId: 'saved-schedule' }, 'pause-1');
  await m31_callAgentTool('wake', { action: 'resume', subscriptionId: 'saved-subscription' }, 'resume-1');
  m31_expect(scope34.calls).toEqual([
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
  const merged = { ...scope34.snapshot, workflowState: 'done', mergeCommitSha: 'f'.repeat(40) };
  m31_vi.stubGlobal('fetch', async () =>
    Response.json({ kinds: [], state: 'merged', woken: true, snapshot: merged }),
  );
  const text = await m31_callAgentTool(
    'wake', { action:"create",trigger:"lifecycle", ...{ address: 'sibling' } },
    'watch-3',
  );
  m31_expect(text).toContain('Corner already merged; one merged wake queued now');
  m31_expect(text).toContain('f'.repeat(40));
  m31_vi.stubGlobal('fetch', async () => Response.json({ kinds: [], state: 'closed', snapshot: scope34.snapshot }));
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
mergedDescribe32("read-only-mcp.workflow.test.ts", () => {m32_describe('workflow run tools', () => {
const scope36 = fixtureScope36();


  m32_it('keeps workflows discoverable without mounting their schemas on ordinary turns', async () => {
    m32_expect(m32_agentToolsFor(true, false).map(tool => tool.name)).toContain('app_tool');
    m32_expect(m32_agentToolsFor(true, false).map(tool => tool.name)).not.toContain('get_workflow_run');
    const discovered = JSON.parse(await m32_callAgentTool('app_tool', { app: 'beeline:workflow' }, 'discover'));
    m32_expect(discovered.tools.map((tool: { name: string }) => tool.name)).toEqual(['save', 'describe', 'start', 'read', 'advance', 'cancel', 'archive', 'rebind']);
    m32_expect(scope36.calls).toEqual([]);
  });


  m32_it('reads a returned run id without requiring a write turn', async () => {
    m32_expect(JSON.parse(await m32_callAgentTool('app_tool', { app: 'beeline:workflow', tool: 'read', args: { runId: 'run-1' } }, 'read'))).toMatchObject({ runId: 'run-1' });
    m32_expect(scope36.calls).toEqual([{ name: 'getWorkflowRun', input: { roomId: 'room-1', agentId: 'agent-1', runId: 'run-1' } }]);
  });


  m32_it('binds cancellation to the active turn and forwards its reason', async () => {
    await m32_callAgentTool('app_tool', { app:'beeline:workflow', tool:'cancel', args:{ runId: 'run-1', reason: 'Request withdrawn' } });
    m32_expect(scope36.calls).toEqual([{ name: 'cancelWorkflowRun', input: {
      roomId: 'room-1', agentId: 'agent-1', runId: 'run-1', reason: 'Request withdrawn',
      requestId: 'request-1', generationId: scope36.context.generationId, taskId: 'command-1',
    } }]);
  });
});
m32_describe('workflow run tools inside a corner', () => {
const scope37 = fixtureScope37();


  m32_it('reads the run stored in the corner, not the parent Room', async () => {
    await m32_callAgentTool('app_tool', { app: 'beeline:workflow', tool: 'read', args: { runId: 'run-1' } }, 'read');
    m32_expect(scope37.calls).toEqual([{ name: 'getWorkflowRun', input: { roomId: 'corner-1', agentId: 'agent-1', runId: 'run-1' } }]);
  });


  m32_it('advances a run with handoff scoped to the corner', async () => {
    await m32_callAgentTool('app_tool', { app:'beeline:workflow', tool:'advance', args:{ runId: 'run-1', outcome: 'done', contents: { note: 'ready' } } });
    m32_expect(scope37.calls).toEqual([{ name: 'handoff', input: {
      roomId: 'corner-1', agentId: 'agent-1', runId: 'run-1', outcome: 'done', contents: { note: 'ready' },
      requestId: 'request-1', generationId: scope37.context.generationId, taskId: 'command-1',
    } }]);
  });


  m32_it('starts, cancels and reassigns a workflow role scoped to the corner', async () => {
    await m32_callAgentTool('app_tool', { app:'beeline:workflow', tool:'start', args:{ name: 'triage', roleBindings: { reviewer: 'agent-1' } } });
    await m32_callAgentTool('app_tool', { app:'beeline:workflow', tool:'cancel', args:{ runId: 'run-1', reason: 'no longer needed' } });
    await m32_callAgentTool('app_tool', { app:'beeline:workflow', tool:'rebind', args:{ runId: 'run-1', role: 'reviewer', agent: 'agent-2' } });
    m32_expect(scope37.calls.map((call) => call.input.roomId)).toEqual(['corner-1', 'corner-1', 'corner-1']);
  });
});
});
mergedDescribe33("request-grant-validation.test.ts", () => {
const scope38 = fixtureScope38();
m33_describe('GRANT-VALIDATION-1: advertised request_grant refusals', () => {
  m33_it('names all missing request fields together', async () => {
    const error = await m33_callAgentTool('request_grant', {}, 'empty').catch(error => error as Error);
    for (const field of Object.keys(scope38.valid)) m33_expect((error as Error).message).toContain(`${field}: expected`);
  });


  m33_it.each([{ action: 'list' }, scope38.valid])('preserves valid dispatch for $action', async args => {
    m33_vi.stubEnv('BEELINE_DAEMON_ROOM_ID', 'room-1');
    m33_vi.stubEnv('BEELINE_DAEMON_BASE_URL', 'http://localhost:1234');
    m33_vi.stubEnv('BEELINE_DAEMON_TOKEN', 'test-token');
    const fetch = m33_vi.fn(async () => Response.json({ grants: [] }));
    m33_vi.stubGlobal('fetch', fetch);
    await m33_callAgentTool('request_grant', args, 'valid');
    m33_expect(fetch).toHaveBeenCalledOnce();
  });


  m33_it('does not echo unknown field names or request values', async () => {
    await m33_expect(m33_callAgentTool('request_grant', { ...scope38.valid, 'private-marker': 'private-value' }, 'unknown'))
      .rejects.toThrow('input: expected only advertised fields');
    const error = await m33_callAgentTool('request_grant', { ...scope38.valid, 'private-marker': 'private-value' }, 'unknown').catch(error => error as Error);
    m33_expect((error as Error).message).not.toMatch(/private-marker|private-value/);
  });


  m33_it.each(['action', 'kind', 'target', 'reason', 'purpose'])('names missing %s and its expected value', async field => {
    const args: Record<string, unknown> = { ...scope38.valid };
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
    const error = await m33_callAgentTool('request_grant', { ...scope38.valid, [field]: value }, `invalid-${field}`).catch(error => error as Error);
    m33_expect(error).toBeInstanceOf(Error);
    m33_expect((error as Error).message).toContain(`${field}: expected`);
    m33_expect((error as Error).message).toContain(expected);
    m33_expect((error as Error).message).not.toContain('private-marker');
  });
});
});
mergedDescribe34("resolve-attach-path.test.ts", () => {m34_describe('attachment home shortcut', () => {
const scope41 = fixtureScope41();


  m34_it('Reproduction artifact-tilde-path: resolves a file in the shell home', () => {
    m34_expect(m34_resolveAttachPath(scope41.roots, '~/notes.txt')).toBe(m34_realpathSync(m34_join(scope41.home, 'notes.txt')));
  });


  m34_it('keeps absolute and checkout-relative paths working', () => {
    m34_expect(m34_resolveAttachPath(scope41.roots, m34_join(scope41.home, 'notes.txt'))).toBe(m34_realpathSync(m34_join(scope41.home, 'notes.txt')));
    m34_writeFileSync(m34_join(scope41.checkout, 'local.txt'), 'Local');
    m34_expect(m34_resolveAttachPath(scope41.roots, 'local.txt')).toBe(m34_realpathSync(m34_join(scope41.checkout, 'local.txt')));
  });


  m34_it('refuses absolute, home traversal and symlink escapes', () => {
    m34_symlinkSync(m34_join(scope41.root, 'outside.txt'), m34_join(scope41.home, 'link.txt'));
    for (const path of [m34_join(scope41.root, 'outside.txt'), '~/../outside.txt', '~/link.txt']) {
      m34_expect(() => m34_resolveAttachPath(scope41.roots, path)).toThrow(/outside your checkout/);
    }
    m34_expect(() => m34_resolveAttachPath([scope41.checkout], '~/notes.txt')).toThrow(/outside your checkout/);
  });


  m34_it('leaves username and embedded tildes literal', () => {
    for (const dir of ['~someone', 'nested/~']) {
      m34_mkdirSync(m34_join(scope41.checkout, dir), { recursive: true });
      m34_writeFileSync(m34_join(scope41.checkout, dir, 'notes.txt'), 'Literal');
      m34_expect(m34_resolveAttachPath(scope41.roots, `${dir}/notes.txt`)).toBe(m34_realpathSync(m34_join(scope41.checkout, dir, 'notes.txt')));
    }
  });


  m34_it('delivers home-shortcut bytes through artifact and brief attachment paths', async () => {
    const uploaded: Buffer[] = [];
    const queued: unknown[] = [];
    const deps: m34_PostArtifactDeps = {
      roomId: 'fixture', roots: scope41.roots,
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
mergedDescribe43("wallet-tools.test.ts", () => {
const scope42 = fixtureScope42();
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
      ['wallet_sign_typed_data', scope42.payload],
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
      body: { ...scope42.payload, agentId: 'agent-1', roomId: 'corner-1' },
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
