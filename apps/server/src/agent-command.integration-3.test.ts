import { expect, it, insertCornerFacts, DaemonService, LiveHub, createAgentCommand, SYSTEM_IDENTITY_ID, ensureSystemIdentity, advanceCorner, H, A, B, P, W, R, C, id, stopProofPostgresUrl, db, phone, daemon, live, commands, send, helperOwner, claim, result, rootFixture, type SqlDatabase } from './test-support-agent-command.integration.test-support.js';


it('rolls the command claim back when a cancelled turn cannot become working', async () => {
  await send('@hoots');
  const [c] = await commands();
  await rootFixture.db.query(
    `INSERT INTO agent_turns(room_id,request_id,agent_id,status)
     VALUES($1,$2,$3,'cancelled') ON CONFLICT(room_id,request_id,agent_id)
     DO UPDATE SET status='cancelled'`,
    [R, c!.turnRequestId, A],
  );
  await expect(
    rootFixture.daemon.execute(
      'claimAgentCommand',
      { roomId: R, commandId: c!.id, generationId: 'too-late' },
      A, await helperOwner(A),
    ),
  ).rejects.toThrow('cancelled');
  expect((await rootFixture.db.query(`SELECT state FROM agent_commands WHERE id=$1`, [c!.id])).rows).toEqual([
    { state: 'pending' },
  ]);
});

it('never reopens terminal commands and never accepts missing generation claims', async () => {
  await send('@hoots');
  const [c] = await commands();
  await expect(
    rootFixture.daemon.execute('claimAgentCommand', { roomId: R, commandId: c!.id } as never, A, await helperOwner(A)),
  ).rejects.toThrow();
  await claim(c!);
  await result(c!, 'Terminal');
  await expect(claim(c!, 'another')).rejects.toThrow();
});

it('settles a failed command instead of redelivering it after its lease expires', async () => {
  await send('@hoots');
  const [c] = await commands();
  await claim(c!);
  await rootFixture.daemon.execute(
    'postAgentTurnReceipt',
    {
      roomId: R,
      requestId: c!.turnRequestId,
      generationId: 'g1',
      status: 'failed',
      reason: 'authentication required',
    },
    A, await helperOwner(A),
  );
  await rootFixture.db.query(
    `UPDATE agent_commands SET lease_expires_at=now()-interval '1 second' WHERE id=$1`,
    [c!.id],
  );
  expect(await commands()).toEqual([]);
  await expect(claim(c!, 'retry')).rejects.toThrow('conflict');
});

it('rechecks tagged agent membership at final commit', async () => {
  await send('@hoots');
  const [c] = await commands();
  await claim(c!);
  await rootFixture.db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [
    R,
    B,
  ]);
  await result(c!, '@goosy no target remains');
  expect((await rootFixture.db.query(`SELECT 1 FROM agent_commands WHERE agent_id=$1`, [B])).rowCount).toBe(0);
});

it('binds emitted events to the issuing command when agents share a human request', async () => {
  await send('@hoots @goosy');
  const [a] = await commands(A),
    [b] = await commands(B);
  await claim(a!);
  await claim(b!);
  const event = await rootFixture.daemon.execute(
    'postRoomEvent',
    {
      roomId: R,
      requestId: a!.turnRequestId,
      generationId: 'g1',
      kind: 'agent:handoff',
      consequence: 'Ready',
      mentionAgentIds: [B],
    },
    A,
  );
  const [child] = (await commands(B)).filter((c) => c.sourceMessageId === event.id);
  expect(child?.parentCommandId).toBe(a!.id);
  expect(child?.agentDepth).toBe(1);
});


it.each(['unknown', 'wrong-agent', 'wrong-room', 'stale', 'cancelled', 'completed'])(
  'rejects every output surface for %s authority',
  async (invalid) => {
    await send('@hoots');
    const [c] = await commands();
    await claim(c!);
    const input = {
      roomId: R,
      agentId: A,
      requestId: c!.turnRequestId,
      turnId: c!.turnRequestId,
      generationId: 'g1',
    };
    let author = A;
    if (invalid === 'unknown') {
      input.requestId = id();
      input.turnId = input.requestId;
    }
    if (invalid === 'wrong-agent') {
      author = B;
      input.agentId = B;
    }
    if (invalid === 'wrong-room') input.roomId = C;
    if (invalid === 'stale') input.generationId = 'stale';
    if (invalid === 'cancelled')
      await rootFixture.phone.execute(
        'cancelAgentTurn',
        { roomId: R, agentId: A, requestId: c!.turnRequestId },
        H,
      );
    if (invalid === 'completed') await result(c!, 'Already done');
    const writes = [
      ['postAgentDraft', { text: 'Late draft' }],
      ['postAgentThought', { text: 'Late thought' }],
      [
        'postAgentActivity',
        { activity: [{ kind: 'thinking', title: 'Late', status: 'in_progress' }] },
      ],
      [
        'postAgentAttachment',
        {
          attachment: {
            url: 'http://test/v1/media/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            name: 'file.txt',
            mimeType: 'text/plain',
            size: 1,
          },
        },
      ],
      ['postRoomMessage', { text: 'Late final' }],
    ] as const;
    const before = (await rootFixture.db.query(`SELECT count(*)::int n FROM messages`)).rows[0];
    for (const [operation, payload] of writes)
      await expect(
        rootFixture.daemon.execute(operation, { ...input, ...payload } as never, author),
      ).rejects.toThrow();
    expect((await rootFixture.db.query(`SELECT count(*)::int n FROM messages`)).rows[0]).toEqual(before);
  },
);

it('accepts and settles draft, thought, activity, attachment and final under one claimed generation', async () => {
  await send('@hoots');
  const [c] = await commands();
  await claim(c!);
  const input = {
    roomId: R,
    agentId: A,
    requestId: c!.turnRequestId,
    turnId: c!.turnRequestId,
    generationId: 'g1',
  };
  await rootFixture.daemon.execute('postAgentDraft', { ...input, text: 'Draft' }, A);
  await rootFixture.daemon.execute('postAgentThought', { ...input, text: 'Thought' }, A);
  await rootFixture.daemon.execute(
    'postAgentActivity',
    { ...input, activity: [{ kind: 'thinking', title: 'Working', status: 'in_progress' }] },
    A,
  );
  const media = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const mediaDigest = id();
  await rootFixture.db.query(
    `INSERT INTO objects(id,owner_id,kind,key,mime,title,size,sha256,state,expires_at)
     VALUES($1,$2,'media',$3,'text/plain','result.txt',2,$4,'ready',now()+interval '24 hours')
     ON CONFLICT(id) DO NOTHING`,
    [media, A, `media/${A}/${mediaDigest}`, mediaDigest],
  );
  // Person files and artifacts both live in `objects` and share /v1/media/<id>.
  const artifact = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  await rootFixture.db.query(
    `INSERT INTO objects(id,owner_id,kind,key,mime,title,size,sha256,state,expires_at)
     VALUES($1,$2,'artifact',$3,'text/html','Mock',12,$4,'ready',now()+interval '24 hours')
     ON CONFLICT(id) DO NOTHING`,
    [artifact, A, `artifact/${A}/${id()}`, id()],
  );
  await rootFixture.daemon.execute(
    'postAgentAttachment',
    {
      ...input,
      attachment: {
        url: 'http://test/v1/media/' + artifact,
        name: 'mock.html',
        mimeType: 'text/html',
        size: 12,
      },
    },
    A,
  );
  await rootFixture.daemon.execute(
    'postAgentAttachment',
    {
      ...input,
      attachment: {
        url: 'http://test/v1/media/' + media,
        name: 'result.txt',
        mimeType: 'text/plain',
        size: 2,
      },
    },
    A,
  );
  const final = await result(c!, 'With attachment');
  const saved = (
    await rootFixture.db.query<{ attachments: unknown[] }>(`SELECT attachments FROM messages WHERE id=$1`, [
      final.id,
    ])
  ).rows[0]!;
  expect(saved.attachments).toHaveLength(2);
  expect(
    (
      await rootFixture.db.query(
        `SELECT 1 FROM live_outputs WHERE room_id=$1 AND agent_id=$2 AND kind IN ('draft','thought')`,
        [R, A],
      )
    ).rowCount,
  ).toBe(0);
});


it('keeps Room drafts private while preserving liveness, final replies, and corner streaming', async () => {
  await send('@hoots work in the Room');
  const [roomCommand] = await commands();
  await claim(roomCommand!);
  const roomInput = {
    roomId: R,
    agentId: A,
    requestId: roomCommand!.turnRequestId,
    turnId: roomCommand!.turnRequestId,
    generationId: 'g1',
  };
  const events: Array<{ type: string; roomId?: string }> = [];
  const unsubscribe = rootFixture.live.subscribeAll((event) => events.push(event));
  try {
    await rootFixture.daemon.execute('postAgentDraft', { ...roomInput, text: 'Room draft' }, A);
    expect(
      (
        await rootFixture.db.query(
          `SELECT 1 FROM live_outputs
           WHERE room_id=$1 AND agent_id=$2 AND turn_id=$3 AND kind='draft'`,
          [R, A, roomCommand!.turnRequestId],
        )
      ).rowCount,
    ).toBe(0);
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'draft', roomId: R }));
    // During a two-machine rollout, an older server can leave a Room draft
    // behind. Reconnecting readers must not recover that stale prose.
    await rootFixture.db.query(
      `INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body)
       VALUES($1,$2,$3,'draft','{"text":"Stale Room draft"}'::jsonb)`,
      [R, A, roomCommand!.turnRequestId],
    );
    expect(await rootFixture.phone.liveDraftSnapshot(R)).toEqual([]);
    expect(
      (
        await rootFixture.db.query<{ status: string }>(
          `SELECT status FROM agent_turns WHERE room_id=$1 AND agent_id=$2 AND request_id=$3`,
          [R, A, roomCommand!.turnRequestId],
        )
      ).rows[0]?.status,
    ).toBe('working');
    const final = await result(roomCommand!, 'Room final');
    expect(
      (await rootFixture.db.query<{ text: string }>(`SELECT text FROM messages WHERE id=$1`, [final.id]))
        .rows[0]?.text,
    ).toBe('Room final');

    await send('@hoots work in the corner', C);
    const [cornerCommand] = await commands(A, C);
    await claim(cornerCommand!);
    await rootFixture.daemon.execute(
      'postAgentDraft',
      {
        roomId: C,
        agentId: A,
        requestId: cornerCommand!.turnRequestId,
        turnId: cornerCommand!.turnRequestId,
        generationId: 'g1',
        text: 'Corner draft',
      },
      A,
    );
    expect(
      (
        await rootFixture.db.query(
          `SELECT 1 FROM live_outputs
           WHERE room_id=$1 AND agent_id=$2 AND turn_id=$3 AND kind='draft'`,
          [C, A, cornerCommand!.turnRequestId],
        )
      ).rowCount,
    ).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'draft', roomId: C, text: 'Corner draft' }),
    );
    expect(await rootFixture.phone.liveDraftSnapshot(C)).toContainEqual(
      expect.objectContaining({ type: 'draft', roomId: C, text: 'Corner draft' }),
    );
    expect(
      (
        await rootFixture.db.query<{ repository_resolution: string }>(
          `SELECT repository_resolution FROM rooms WHERE id=$1`,
          [C],
        )
      ).rows[0]?.repository_resolution,
    ).toBe('none');
    await result(cornerCommand!, 'No-code corner final');

    await rootFixture.db.query(
      `UPDATE rooms SET repository_resolution='repository',repository_key='owner/repo',
         repository_name='repo',repository_remote='https://github.com/owner/repo.git'
       WHERE id=$1`,
      [C],
    );
    await send('@hoots continue in the repository corner', C);
    const [repositoryCornerCommand] = await commands(A, C);
    await claim(repositoryCornerCommand!);
    await rootFixture.daemon.execute(
      'postAgentDraft',
      {
        roomId: C,
        agentId: A,
        requestId: repositoryCornerCommand!.turnRequestId,
        turnId: repositoryCornerCommand!.turnRequestId,
        generationId: 'g1',
        text: 'Repository corner draft',
      },
      A,
    );
    expect(
      (
        await rootFixture.db.query(
          `SELECT 1 FROM live_outputs
           WHERE room_id=$1 AND agent_id=$2 AND turn_id=$3 AND kind='draft'`,
          [C, A, repositoryCornerCommand!.turnRequestId],
        )
      ).rowCount,
    ).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'draft', roomId: C, text: 'Repository corner draft' }),
    );
  } finally {
    unsubscribe();
    await rootFixture.db.query(
      `UPDATE rooms SET repository_resolution='none',repository_key=NULL,
         repository_name=NULL,repository_remote=NULL WHERE id=$1`,
      [C],
    );
  }
});


it('deletes draft and thought rows when a successful turn settles without a reply', async () => {
  await send('@hoots open a corner');
  const [command] = await commands();
  await claim(command!);
  const input = {
    roomId: R,
    agentId: A,
    requestId: command!.turnRequestId,
    turnId: command!.turnRequestId,
    generationId: 'g1',
  };
  await rootFixture.daemon.execute('postAgentDraft', { ...input, text: 'Opening a corner.' }, A);
  await rootFixture.daemon.execute('postAgentThought', { ...input, text: 'Preparing the handoff.' }, A);

  // A successful open_corner turn has no postRoomMessage call. Its terminal
  // receipt is the durable ending and must reap the live rows itself even if
  // the best-effort retract never arrived.
  await rootFixture.daemon.execute('postAgentTurnReceipt', { ...input, status: 'complete' }, A, await helperOwner(A));

  expect(
    (
      await rootFixture.db.query(
        `SELECT 1 FROM live_outputs
         WHERE room_id=$1 AND agent_id=$2 AND turn_id=$3 AND kind IN ('draft','thought')`,
        [R, A, command!.turnRequestId],
      )
    ).rowCount,
  ).toBe(0);
});


it('stores an ambiguous agent tag as prose without dispatching either candidate', async () => {
  await rootFixture.db.query(`UPDATE identities SET handle='hoots' WHERE id=$1`, [B]);
  try {
    const source = await send('@hoots who is this?');
    expect(await commands(A)).toEqual([]);
    expect(await commands(B)).toEqual([]);
    expect(
      (await rootFixture.db.query(`SELECT text FROM messages WHERE id=$1`, [source.messageId])).rows[0]?.text,
    ).toBe('@hoots who is this?');
  } finally {
    await rootFixture.db.query(`UPDATE identities SET handle='goosy' WHERE id=$1`, [B]);
  }
});


  it('stamps the producing model on an agent reply at generation time', async () => {
    await rootFixture.db.query(`UPDATE agents SET selected_model='grok-4-fast' WHERE agent_id=$1`, [A]);
    await send('@hoots model check');
    const command = (await commands(A))[0]!;
    await claim(command);
    await result(command, 'Stamped answer');
    // The stamp freezes the selection as of the turn; a later roster change
    // must not retro-label the row.
    await rootFixture.db.query(`UPDATE agents SET selected_model='newer-model' WHERE agent_id=$1`, [A]);
    const view = await rootFixture.phone.readRoom(R, H);
    const reply = view!.messages.find((message) => message.text === 'Stamped answer');
    expect(reply?.agentModel).toBe('grok-4-fast');
    // A human row carries no stamp, and an agent row with no known model
    // stays unstamped rather than guessing.
    expect(
      view!.messages.find((message) => message.author.pubkey === H)?.agentModel,
    ).toBeUndefined();
  });



it('excludes concurrent avatar jobs across rooms and refuses non-owner generation', async () => {
  const outcomes = await Promise.allSettled([
    send('@hoots /draw-avatar', R),
    send('@hoots /draw-avatar brighter eyes', C),
  ]);
  expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
  expect((await rootFixture.phone.readAgent(W, A, H))?.avatarGenerationPending).toBe(true);
  await expect(
    rootFixture.phone.execute('sendRoomMessage', { roomId: R, text: '@hoots /draw-avatar' }, P),
  ).rejects.toThrow();
  await rootFixture.db.query(`UPDATE agent_commands SET state='complete' WHERE agent_id=$1 AND avatar_job`, [
    A,
  ]);
  expect((await rootFixture.phone.readAgent(W, A, H))?.avatarGenerationPending).toBe(false);
  await expect(send('@hoots /draw-avatar', R)).resolves.toBeDefined();
});



it.runIf(Boolean(stopProofPostgresUrl))('R-ACTIVITY-DEADLOCK: attempts concurrent activity and working receipt writes on isolated PostgreSQL', async () => {
  await send('@hoots inspect contention', C);
  const [command] = await commands(A, C);
  await claim(command!);
  const authority = { roomId: C, requestId: command!.turnRequestId!, generationId: 'g1' };
  await Promise.all(Array.from({ length: 12 }, async (_, index) => Promise.all([
    rootFixture.daemon.execute('postAgentActivity', { ...authority, cornerActivityKey: `contention-${index}`,
      activity: [{ kind: 'tool', title: 'Inspect', operation: 'read', status: 'completed' }] }, A),
    rootFixture.daemon.execute('postAgentTurnReceipt', { ...authority, status: 'working' }, A, await helperOwner(A)),
  ])));
  expect((await rootFixture.phone.readRoom(C, H))?.toolRows?.filter(row => row.requestId === authority.requestId)).toHaveLength(12);
});


it('R-ACTIVITY-DEADLOCK: never replays another daemon operation', async () => {
  await send('@hoots inspect retry scope', C);
  const [command] = await commands(A, C);
  await claim(command!);
  let attempts = 0;
  const failure = Object.assign(new Error('deadlock proof'), { code: '40P01' });
  const watched = new DaemonService({
    query: (sql, values) => rootFixture.db.query(sql, values),
    transaction: async () => { attempts++; throw failure; },
  }, rootFixture.live);
  await expect(watched.execute('postAgentThought', {
    roomId: C, requestId: command!.turnRequestId!, generationId: 'g1', text: 'Inspecting',
  }, A)).rejects.toBe(failure);
  expect(attempts).toBe(1);
});


it.each([
  ['recover on explicit request', '40P01', 1],
  ['persistent failure', '40P01', 10],
  ['other error', '23505', 1],
  ['authorization changes', '40P01', 1],
])('R-ACTIVITY-DEADLOCK: %s at the owning transaction boundary', async (scenario, code, failures) => {
  await send('@hoots inspect recovery', C);
  const [command] = await commands(A, C);
  await claim(command!);
  const input = { roomId: C, requestId: command!.turnRequestId!, generationId: 'g1',
    cornerActivityKey: 'deadlock-proof',
    activity: [{ kind: 'tool' as const, title: 'Inspect', operation: 'read', status: 'completed' }] };
  const originalTurn = (await rootFixture.db.query(`SELECT created_at FROM agent_turns WHERE request_id=$1`, [input.requestId])).rows;
  let attempts = 0;
  const events: unknown[] = [];
  const hub = new LiveHub();
  hub.publish = event => { events.push(event); };
  const failure = Object.assign(new Error('transaction proof failure'), { code });
  const wrapped: SqlDatabase = {
    query: (sql, values) => rootFixture.db.query(sql, values),
    transaction: async work => {
      attempts++;
      try {
        return await rootFixture.db.transaction(async tx => {
          const result = await work(tx);
          // Fail after the activity insert, turn update and buffered event.
          // The real database must roll all writes back before recovery.
          if (attempts <= failures) throw failure;
          return result;
        });
      } catch (error) {
        expect(events).toHaveLength(0);
        expect((await rootFixture.db.query(`SELECT created_at FROM agent_turns WHERE request_id=$1`, [input.requestId])).rows).toEqual(originalTurn);
        expect((await rootFixture.db.query(`SELECT 1 FROM messages WHERE request_id=$1 AND presentation='activity'`,
          [input.requestId])).rowCount).toBe(0);
        if (scenario === 'authorization changes')
          await rootFixture.db.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1`, [A]);
        throw error;
      }
    },
  };
  const watched = new DaemonService(wrapped, hub);
  // A failed observation is parked. A new caller invocation, not an internal
  // retry/backoff loop, owns any later attempt and must recheck authority.
  await expect(watched.execute('postAgentActivity', input, A)).rejects.toBe(failure);
  expect(attempts).toBe(1);
  expect(events).toHaveLength(0);
  expect((await rootFixture.db.query(`SELECT 1 FROM messages WHERE request_id=$1 AND presentation='activity'`,
    [input.requestId])).rowCount).toBe(0);
  if (scenario === 'recover on explicit request') {
    const saved = await watched.execute('postAgentActivity', input, A);
    expect(attempts).toBe(2);
    expect(events).toHaveLength(1);
    expect((await rootFixture.phone.readRoom(C, H))?.toolRows?.find(row => row.id === saved.id)?.activity).toEqual(input.activity);
    expect(await watched.execute('postAgentActivity', input, A)).toEqual(saved);
    expect(events).toHaveLength(1);
  } else if (scenario === 'authorization changes') {
    await expect(watched.execute('postAgentActivity', input, A)).rejects.toThrow(/access|member|authority/i);
    expect(attempts).toBe(1);
    expect(events).toHaveLength(0);
  } else if (scenario === 'persistent failure') {
    await expect(watched.execute('postAgentActivity', input, A)).rejects.toBe(failure);
    expect(attempts).toBe(2);
    expect(events).toHaveLength(0);
  }
});


it.each([
  ['NUL', 'before\0after', 'before\uFFFDafter'],
  ['high surrogate', 'before\uD800after', 'before\uFFFDafter'],
  ['low surrogate', 'before\uDC00after', 'before\uFFFDafter'],
  ['valid Unicode', 'café 😀 𝄞', 'café 😀 𝄞'],
  ['literal escapes', String.raw`\u0000 \ud800 \\u0000`, String.raw`\u0000 \ud800 \\u0000`],
])('Reproduction R-ACTIVITY-UNICODE: persists and reads %s tool output with stable replay', async (_label, output, expected) => {
  await send('@hoots inspect output', C);
  const [command] = await commands(A, C);
  await claim(command!);
  const activity = [{ kind: 'tool' as const, title: 'Inspect', operation: 'read', status: 'completed', output,
    files: [{ path: output }], plan: { items: [{ step: output, status: 'completed' as const }] } }];
  const input = { roomId: C, requestId: command!.turnRequestId!, generationId: 'g1',
    cornerActivityKey: 'unicode-proof', activity };
  const first = await rootFixture.daemon.execute('postAgentActivity', input, A);
  expect(await rootFixture.daemon.execute('postAgentActivity', input, A)).toEqual(first);
  const stored = [{ ...activity[0], output: expected, files: [{ path: expected }],
    plan: { items: [{ step: expected, status: 'completed' }] } }];
  expect((await rootFixture.db.query('SELECT activity FROM messages WHERE id=$1', [first.id])).rows[0]?.activity).toEqual(stored);
  const view = await rootFixture.phone.readRoom(C, H);
  expect(view?.toolRows?.find(row => row.id === first.id)?.activity).toEqual(stored);
  expect(activity[0]?.output).toBe(output);
  await expect(rootFixture.daemon.execute('postAgentActivity', { ...input,
    activity: [{ ...activity[0]!, output: 'different output' }] }, A)).rejects.toThrow('conflicts');
});


it('superseded review output cancels its command and turn through the terminal owner', async () => {
  const corner = '44444444-4444-4444-8444-444444444444';
  await rootFixture.db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES($1,$2,$3,'stuck-turn-proof')`, [corner,W,R]);
  await insertCornerFacts(rootFixture.db, { cornerId: corner, ownerAgentId: A, lifecycle: '{"lifecycle":"working"}' });
  await send('@hoots review this head', corner);
  const [command] = await commands(A, corner);
  await claim(command!);
  await rootFixture.db.query(`UPDATE agent_commands SET review_context=$2::jsonb WHERE id=$1`,
    [command!.id, JSON.stringify({cornerId:corner,headSha:'obsolete',pullRequest:1})]);
  const state = async () => {
    await advanceCorner(rootFixture.db, corner, { kind: 'reconcile' });
    return (await rootFixture.phone.readCorners(R,H))!.corners.find(row => row.corner.id===corner)!.state;
  };
  expect(await state()).toBe('review');
  await result(command!, '@hoots Review output for the old head');
  expect((await rootFixture.db.query(`SELECT state FROM agent_commands WHERE id=$1`, [command!.id])).rows)
    .toEqual([{state:'cancelled'}]);
  expect((await rootFixture.db.query(`SELECT status,failure_reason FROM agent_turns
    WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`, [corner,command!.turnRequestId,A])).rows)
    .toEqual([{status:'cancelled',failure_reason:'superseded_review'}]);
  expect(await state()).toBe('idle');
  await expect(rootFixture.daemon.execute('postAgentTurnReceipt', {roomId:corner,requestId:command!.turnRequestId,
    generationId:'g1',status:'complete'}, A, await helperOwner(A))).rejects.toThrow();
  expect((await rootFixture.db.query(`SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=$2 AND agent_id=$3`,
    [corner,command!.turnRequestId,A])).rows).toEqual([{status:'cancelled'}]);
});



it.each(['no_reply_needed', 'mcp__beeline-agent__no_reply_needed', 'mcp__beeline_agent__no_reply_needed',
  'beeline-agent__no_reply_needed', 'beeline_agent__no_reply_needed', 'mcp.beeline-agent.no_reply_needed'])(
  'SILENT-END-1 (%s): late silent-tool results do not wake again; other completions and later triggers survive', async title => {
  const queued = await createAgentCommand(rootFixture.db, { roomId: C, agentId: A, sourceMessageId: null, reason: 'system' });
  const command = (await commands(A, C)).find(c => c.id === queued!.id)!;
  await claim(command);
  const turn = { roomId: C, requestId: command.turnRequestId, generationId: 'g1' };
  await rootFixture.daemon.execute('markAgentTurnSilent', turn, A);
  await rootFixture.daemon.execute('postAgentTurnReceipt', { ...turn, status: 'complete', completionKind: 'no-reply' }, A, await helperOwner(A));
  for (const status of ['completed', 'failed'] as const) {
    await rootFixture.daemon.execute('postBackgroundToolCompletion', {
      ...turn, toolCallId: 'silent', title, status,
    }, A);
  }
  expect((await commands(A, C)).filter(c => c.reason === 'corner_background_tool')).toEqual([]);
  expect((await rootFixture.db.query(`SELECT 1 FROM agent_turns WHERE room_id=$1 AND status='failed'`, [C])).rowCount).toBe(0);
  expect((await rootFixture.db.query(`SELECT 1 FROM messages WHERE card_type='turn-failed' AND room_id=$1`, [C])).rowCount).toBe(0);
  await rootFixture.daemon.execute('postBackgroundToolCompletion', {
    ...turn, toolCallId: 'build', title: 'Run build', status: 'completed',
  }, A);
  expect((await commands(A, C)).filter(c => c.reason === 'corner_background_tool')).toHaveLength(1);
  const next = await createAgentCommand(rootFixture.db, { roomId: C, agentId: A, sourceMessageId: null, reason: 'system' });
  expect((await commands(A, C)).some(c => c.id === next!.id)).toBe(true);
});


// Command-only roots are server-authored private work, never synthetic messages.
it.each(['replay', 'idle'] as const)('command-only requester: System %s survives a cold repository read and delegation', async kind => {
  await ensureSystemIdentity(rootFixture.db);
  const root = (await createAgentCommand(rootFixture.db, { roomId: R, agentId: A, sourceMessageId: null,
    reason: kind === 'replay' ? 'order' : 'report', privatePayload: {
      kind: kind === 'replay' ? 'order' : 'report', authorId: SYSTEM_IDENTITY_ID, fromRoomId: R,
      text: kind === 'replay' ? 'Automatic prompt replay for a verified head.' : 'blocked: Corner is idle.',
      ...(kind === 'idle' ? { automatic: true, idleSince: new Date().toISOString(), originCornerId: C } : {}),
    } }))!;
  expect(root.root_source_message_id).toBe(root.id);
  expect(await rootFixture.daemon['grantRequester'](root)).toMatchObject({ id: SYSTEM_IDENTITY_ID });
  const command = (await commands()).find(c => c.id === root.id)!;
  await claim(command);
  await expect(rootFixture.daemon.execute('getRoomRepositoryState', {
    roomId: R, requestId: command.turnRequestId, generationId: 'g1',
  }, A)).resolves.toMatchObject({ resolution: 'none', repositoryOnboarding: true });
  const child = (await createAgentCommand(rootFixture.db, { roomId: R, agentId: B, sourceMessageId: null,
    parent: root, reason: 'order', privatePayload: { kind: 'order', authorId: A, fromRoomId: R, text: 'Delegated replay' } }))!;
  expect(await rootFixture.daemon['grantRequester'](child)).toMatchObject({ id: SYSTEM_IDENTITY_ID });
  expect((await rootFixture.db.query('SELECT 1 FROM messages WHERE id=$1', [root.id])).rowCount).toBe(0);
});


it('command-only requester: delegation retains the original human message requester', async () => {
  const sent = await send('@hoots Do this');
  const root = (await rootFixture.db.query<import('./agent-command.js').CommandRow>(
    'SELECT * FROM agent_commands WHERE source_message_id=$1', [sent.messageId])).rows[0]!;
  const child = (await createAgentCommand(rootFixture.db, { roomId: R, agentId: B, sourceMessageId: null,
    parent: root, reason: 'order', privatePayload: { kind: 'order', authorId: A, fromRoomId: R, text: 'Delegated task' } }))!;
  expect(await rootFixture.daemon['grantRequester'](child)).toMatchObject({ id: H });
});


it.each(['rootless', 'human-author', 'wrong-root', 'wrong-source', 'parented', 'missing-message', 'checkin', 'ordinary-report'])(
  'command-only requester refuses %s provenance', async shape => {
    await ensureSystemIdentity(rootFixture.db);
    const root = (await createAgentCommand(rootFixture.db, { roomId: R, agentId: A, sourceMessageId: null,
      reason: 'order', privatePayload: { kind: 'order', authorId: SYSTEM_IDENTITY_ID, fromRoomId: R, text: 'Automatic replay' } }))!;
    const command = { ...root };
    if (shape === 'rootless') command.root_command_id = id();
    if (shape === 'wrong-root') await rootFixture.db.query('UPDATE agent_commands SET root_command_id=$2 WHERE id=$1', [root.id, id()]);
    if (shape === 'wrong-source') await rootFixture.db.query('UPDATE agent_commands SET root_source_message_id=$2 WHERE id=$1', [root.id, id()]);
    if (shape === 'parented') await rootFixture.db.query('UPDATE agent_commands SET parent_command_id=$1 WHERE id=$1', [root.id]);
    if (shape === 'missing-message') {
      const sent = await send('Message-backed root');
      await rootFixture.db.query('UPDATE agent_commands SET source_message_id=$2 WHERE id=$1', [root.id, sent.messageId]);
    }
    if (shape === 'human-author')
      await rootFixture.db.query(`UPDATE agent_commands SET private_payload=jsonb_set(private_payload,'{authorId}',to_jsonb($2::text)) WHERE id=$1`,
        [root.id, H]);
    if (shape === 'checkin') await rootFixture.db.query("UPDATE agent_commands SET reason='free_agent_checkin',private_payload=NULL WHERE id=$1", [root.id]);
    if (shape === 'ordinary-report') await rootFixture.db.query(`UPDATE agent_commands SET reason='report',private_payload=$2::jsonb WHERE id=$1`,
      [root.id, JSON.stringify({ kind: 'report', authorId: SYSTEM_IDENTITY_ID, fromRoomId: R, text: 'Ordinary report' })]);
    await expect(rootFixture.daemon['grantRequester'](command)).rejects.toThrow('resource requester');
  },
);


it('command-only requester: workflow gate requester override stays authoritative', async () => {
  const handoffId = id(), runId = id();
  await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text,card_type,card)
    VALUES($1,$2,$3,'Workflow wake','workflow-handoff',$4::jsonb)`,
    [handoffId, R, B, JSON.stringify({ runId, seq: 1, receipt: { exit: { actorId: P } } })]);
  const root = (await createAgentCommand(rootFixture.db, { roomId: R, agentId: A, sourceMessageId: handoffId, reason: 'workflow_handoff' }))!;
  expect(await rootFixture.daemon['grantRequester'](root)).toMatchObject({ id: P });
});
