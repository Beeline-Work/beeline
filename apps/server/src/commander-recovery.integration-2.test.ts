import { advanceCorner, createHash, randomUUID, randomBytes, expect, it, vi, MemoryObjectStorage, ObjectService, callAgentTool, postArtifact, createServer, spawn, createInterface, mkdtemp, readFile, writeFile, rm, tmpdir, join, CommandExecutionContext, runServerCommandIntake, HUMAN, RUBY, WORKER, WS, ROOM, DM, db, daemon, phone, order, claim, authority, commands, open, worker, rootFixture, type AgentCommand, type DaemonApiClient } from './test-support-commander-recovery.integration.test-support.js';


it('keeps the originating corner waiting for a decision returned to its parent Room', async () => {
  await rootFixture.phone.execute(
    'sendRoomMessage',
    {
      roomId: ROOM,
      messageId: randomBytes(32).toString('hex'),
      text: '@ruby open a corner and choose endpoint',
    },
    HUMAN,
  );
  const incoming = (await commands(ROOM, RUBY)).find((c) => c.reason === 'human_tag')!;
  await claim(incoming);
  const opened = await rootFixture.daemon.execute(
    'createCorner',
    {
      ...authority(incoming),
      targetRoomId: ROOM,
      name: 'Endpoint',
      objective: 'Choose endpoint',
      implementer: 'worker',
      brief: { spec: 'Choose endpoint', approval: { sourceMessageId: incoming.sourceMessageId } },
    },
    RUBY,
  );
  const turn = await worker(opened.cornerId);
  await rootFixture.daemon.execute(
    'report',
    { status: 'needs_decision', ...authority(turn), ask: 'Which endpoint should we use?', text: 'needs-decision: choose endpoint' },
    WORKER,
  );
  const returned = (await commands(ROOM, RUBY)).find((c) => c.reason === 'report')!;
  await claim(returned);
  await rootFixture.daemon.execute(
    'report',
    { status: 'needs_decision', ...authority(returned), ask: 'Which endpoint should we use?', text: 'needs-decision: choose endpoint @captain' },
    RUBY,
  );
  expect(
    (await rootFixture.db.query(`SELECT 1 FROM corner_owed WHERE corner_id=$1`, [opened.cornerId])).rowCount,
  ).toBe(1);
  await rootFixture.daemon.execute(
    'postRoomMessage',
    { ...authority(turn), text: 'Reported the decision' },
    WORKER,
  );
  await rootFixture.daemon.execute('postAgentTurnReceipt', { ...authority(turn), agentId: WORKER, status: 'complete' }, WORKER);
  const state = async () => {
    await advanceCorner(rootFixture.db, opened.cornerId, { kind: 'reconcile' });
    return (await rootFixture.phone.readCorners(ROOM, HUMAN))?.corners.find(
      (item) => item.corner.id === opened.cornerId,
    )?.state;
  };
  expect(await state()).toBe('waiting');
  await rootFixture.db.query('SELECT corner_owed_refresh($1,$2)', [opened.cornerId, HUMAN]);
  expect(await state()).toBe('waiting');
  await rootFixture.phone.execute(
    'sendRoomMessage',
    { roomId: ROOM, messageId: randomBytes(32).toString('hex'), text: 'Use endpoint v2' },
    HUMAN,
  );
  expect(
    (await rootFixture.db.query(`SELECT 1 FROM corner_owed WHERE corner_id=$1`, [opened.cornerId])).rowCount,
  ).toBe(0);
  expect(await state()).toBe('waiting');
  await rootFixture.phone.execute(
    'sendRoomMessage',
    { roomId: opened.cornerId, messageId: randomBytes(32).toString('hex'), text: 'Use endpoint v2' },
    HUMAN,
  );
  expect(await state()).toBe('idle');
  await rootFixture.db.query('SELECT corner_owed_refresh($1,$2)', [opened.cornerId, HUMAN]);
  expect(await state()).toBe('idle');
  await rootFixture.db.query(
    `UPDATE messages SET deleted_at=now() WHERE room_id=$1 AND text IN ('Use endpoint v2','@ruby Use endpoint v2')`,
    [opened.cornerId],
  );
  expect(await state()).toBe('waiting');
});


it('keeps DM-returned decisions indexed until answered or source membership ends', async () => {
  const opened = await open(),
    turn = await worker(opened.cornerId);
  await rootFixture.daemon.execute(
    'report',
    { status: 'needs_decision', ...authority(turn), ask: 'Which endpoint should we use?', text: 'needs-decision: choose endpoint' },
    WORKER,
  );
  await rootFixture.daemon.execute(
    'postRoomMessage',
    { ...authority(turn), text: 'Reported the decision' },
    WORKER,
  );
  const returned = (await commands(DM, RUBY)).find((c) => c.reason === 'report')!;
  await claim(returned);
  await rootFixture.daemon.execute(
    'report',
    { status: 'needs_decision', ...authority(returned), ask: 'Which endpoint should we use?', text: 'needs-decision: choose endpoint @captain' },
    RUBY,
  );
  expect((await rootFixture.phone.readRoom(opened.cornerId, HUMAN))?.cornerOwed).toBe(true);
  await rootFixture.db.query('SELECT corner_owed_refresh($1,$2)', [opened.cornerId, HUMAN]);
  expect((await rootFixture.phone.readRoom(opened.cornerId, HUMAN))?.cornerOwed).toBe(true);
  await rootFixture.db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [
    DM,
    HUMAN,
  ]);
  expect((await rootFixture.phone.readRoom(opened.cornerId, HUMAN))?.cornerOwed).toBe(false);
  await rootFixture.db.query(`UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2`, [
    DM,
    HUMAN,
  ]);
  expect((await rootFixture.phone.readRoom(opened.cornerId, HUMAN))?.cornerOwed).toBe(true);
});


it('R1 carries a closed corner artifact into a successor brief and refuses private archived sources', async () => {
  const source = (await rootFixture.phone.execute('createHumanCorner', { roomId: ROOM, title: 'Source-evidence' }, HUMAN)) as { id: string };
  await rootFixture.phone.execute('sendRoomMessage', { roomId: source.id, messageId: randomBytes(32).toString('hex'), text: '@worker record evidence' }, HUMAN);
  const turn = await worker(source.id);
  const bytes = Buffer.from('R1 evidence');
  const objects = new ObjectService(rootFixture.db, new MemoryObjectStorage(), 'http://test');
  await postArtifact({ bytes: bytes.toString('base64'), title: 'evidence.txt', mime: 'text/plain' }, {
    roomId: source.id, roots: [],
    upload: (content, mime, title) => objects.uploadArtifact(WORKER, content, mime, title),
    queue: async (attachment) => { await rootFixture.daemon.execute('postAgentAttachment', { ...authority(turn), attachment }, WORKER); },
  });
  const media = (await rootFixture.db.query<{ id: string }>(`SELECT id FROM objects WHERE title='evidence.txt' AND owner_id=$1`, [WORKER])).rows[0]!.id;
  await rootFixture.daemon.execute('postRoomMessage', { ...authority(turn), text: 'Evidence recorded' }, WORKER);
  const message = (await rootFixture.db.query<{ id: string }>(`SELECT id FROM messages WHERE room_id=$1 AND text='Evidence recorded'`, [source.id])).rows[0]!;
  expect((await rootFixture.daemon.execute('getRoomMessage', { roomId: source.id, messageId: message.id }, WORKER)).attachments)
    .toEqual([expect.objectContaining({ name: 'evidence.txt' })]);
  await rootFixture.daemon.execute('archiveCorner', { ...authority(rootFixture.order), cornerId: source.id }, RUBY);
  expect((await rootFixture.daemon.execute('getRoomMessage', { ...authority(rootFixture.order), messageId: message.id }, RUBY)).attachments)
    .toEqual([expect.objectContaining({ name: 'evidence.txt' })]);
  // An archived corner in another Room remains unavailable even when its
  // object id is known to the caller.
  const privateRoom = randomUUID(), privateCorner = randomUUID(), privateMedia = randomUUID();
  await rootFixture.db.query(`INSERT INTO rooms(id,workspace_id,name,parent_id,created_by,archived_at)
    VALUES($1,$3,'Private-room',NULL,$4,NULL),($2,$3,'Private-source',$1,$4,now())`,
    [privateRoom, privateCorner, WS, HUMAN]);
  await rootFixture.db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,$2,$3,'member'),($1,$2,$4,'member') `,
    [WS, privateRoom, HUMAN, WORKER]);
  await rootFixture.db.query(`INSERT INTO objects(id,owner_id,kind,key,mime,title,size,sha256,state,expires_at)
    VALUES($1,$2,'artifact',$3,'text/plain','private.txt',2,$4,'ready',now()+interval '24 hours')`,
    [privateMedia, WORKER, 'artifact/' + privateMedia, randomBytes(32).toString('hex')]);
  await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text,attachments)
    VALUES($1,$2,$3,'Private evidence',$4::jsonb)`, [randomBytes(32).toString('hex'), privateCorner, WORKER,
    JSON.stringify([{ url: 'http://test/v1/media/' + privateMedia, name: 'private.txt' }])]);
  const tryPrivate = () => rootFixture.daemon.execute('createCorner', {
    ...authority(rootFixture.order), idempotencyKey: 'private-source-proof', targetRoomId: ROOM, name: 'Refused-successor', objective: 'Continue from evidence', implementer: 'worker',
    brief: { spec: 'Read private evidence', repositoryWork: false,
      approval: { sourceMessageId: rootFixture.order.sourceMessageId },
      attachments: [{ objectId: privateMedia, purpose: 'Private evidence', required: true }] },
  }, RUBY);
  await expect(tryPrivate()).rejects.toThrow('missing or unavailable in this Room');
  // Even if the commander is a member, a successor audience without access
  // cannot receive the file. The human requester is also checked.
  await rootFixture.db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,$2,$3,'member') `, [WS, privateRoom, RUBY]);
  await rootFixture.db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [privateRoom, HUMAN]);
  await expect(tryPrivate()).rejects.toThrow('missing or unavailable in this Room');
  await rootFixture.db.query(`UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2`, [privateRoom, HUMAN]);
  const outsider = 'f'.repeat(64);
  await rootFixture.db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Reader','reader')`, [outsider]);
  await rootFixture.db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [WS, ROOM, outsider]);
  await expect(tryPrivate()).rejects.toThrow('missing or unavailable in this Room');
  await rootFixture.db.query(`DELETE FROM memberships WHERE identity_id=$1`, [outsider]);
  const remoteSuccessor = await tryPrivate();
  const remoteBrief = await rootFixture.daemon.execute('listCornerBriefRevisions', { ...authority(rootFixture.order), cornerId: remoteSuccessor.cornerId, limit: 1 }, RUBY);
  expect(remoteBrief.revisions[0]!.attachments).toEqual([expect.objectContaining({ objectId: privateMedia })]);
  const successor = await rootFixture.daemon.execute('createCorner', {
    ...authority(rootFixture.order), targetRoomId: ROOM, name: 'Successor-evidence', objective: 'Continue from evidence', implementer: 'worker',
    brief: { spec: 'Read the source evidence', repositoryWork: false,
      approval: { sourceMessageId: rootFixture.order.sourceMessageId },
      attachments: [{ objectId: media, purpose: 'Source evidence', required: true }] },
  }, RUBY);
  const next = await worker(successor.cornerId);
  const brief = await rootFixture.daemon.execute('listCornerBriefRevisions', { ...authority(next), cornerId: successor.cornerId, limit: 1 }, WORKER);
  expect(brief.revisions[0]!.attachments).toEqual([expect.objectContaining({ objectId: media, title: 'evidence.txt' })]);
  // Drive the actual read tool through a loopback transport to the service,
  // then verify the downloaded file, rather than just manifest metadata.
  const scratch = await mkdtemp(join(tmpdir(), 'beeline-r1-'));
  const bridge = createServer(async (request, response) => {
    try {
      if (request.url === '/v1/daemon/operations/listCornerBriefRevisions' || request.url === '/v1/daemon/operations/getRoomMessage') {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const input = JSON.parse(Buffer.concat(chunks).toString());
        const result = await rootFixture.daemon.execute(request.url.endsWith('getRoomMessage') ? 'getRoomMessage' : 'listCornerBriefRevisions', input, WORKER);
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
      } else if (request.url === '/v1/media/' + media) {
        response.writeHead(200, { 'content-type': 'text/plain' }).end(await objects.readOwnedBytes(WORKER, media));
      } else response.writeHead(404).end();
    } catch (error) {
      response.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(error) }));
    }
  });
  try {
    await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
    const address = bridge.address();
    if (!address || typeof address === 'string') throw new Error('missing proof port');
    vi.stubEnv('BEELINE_DAEMON_BASE_URL', `http://127.0.0.1:${address.port}`);
    vi.stubEnv('BEELINE_DAEMON_TOKEN', 'isolated-fixture-token');
    vi.stubEnv('BEELINE_DAEMON_ROOM_ID', successor.cornerId);
    vi.stubEnv('BEELINE_DAEMON_CORNER_ID', successor.cornerId);
    vi.stubEnv('BEELINE_ATTACH_SCRATCH_ROOT', scratch);
    vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', '');
    const downloaded = JSON.parse(await callAgentTool('read', { facet: 'attachment', attachmentId: media }, 'r1'));
    expect(await readFile(downloaded.path)).toEqual(bytes);
    await expect(callAgentTool('read', { facet: 'attachment', attachmentId: privateMedia }, 'unattached')).rejects.toThrow('not_found');
    vi.stubEnv('BEELINE_DAEMON_ROOM_ID', source.id);
    vi.stubEnv('BEELINE_DAEMON_CORNER_ID', source.id);
    const ownMessage = JSON.parse(await callAgentTool('read', { facet: 'attachment', messageId: message.id, attachmentId: media }, 'own-message'));
    expect(await readFile(ownMessage.path)).toEqual(bytes);
    // The file remains readable through its brief after its message no longer carries it.
    await rootFixture.db.query(`UPDATE messages SET attachments='[]'::jsonb WHERE id=$1`, [message.id]);
    vi.stubEnv('BEELINE_DAEMON_ROOM_ID', ROOM);
    vi.stubEnv('BEELINE_DAEMON_CORNER_ID', '');
    const pinnedOnly = JSON.parse(await callAgentTool('read', { facet: 'attachment', attachmentId: media }, 'pinned-only'));
    expect(await readFile(pinnedOnly.path)).toEqual(bytes);
  } finally {
    vi.unstubAllEnvs();
    bridge.closeAllConnections();
    await new Promise<void>((resolve, reject) => bridge.close((error) => error ? reject(error) : resolve()));
    await rm(scratch, { recursive: true, force: true });
  }
});


// Reproduction commander-files: the commander's open_corner, revise_corner and
// order tools run in-process against the daemon service; the worker then reads
// the brief file with its own read tool.
it('Reproduction commander-files: a commander home file reaches the worker as the same bytes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'commander-home-'));
  const workerHome = await mkdtemp(join(tmpdir(), 'worker-home-'));
  const trace = join(home, 'trace.csv');
  const bytes = Buffer.from('at,step\n1,open\n2,fail\n');
  await writeFile(trace, bytes);
  await writeFile(join(home, 'turn.json'), JSON.stringify(authority(rootFixture.order)));
  const objects = new ObjectService(rootFixture.db, new MemoryObjectStorage(), 'http://test');
  let caller = RUBY;
  const bridge = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const url = request.url ?? '';
      let result: unknown;
      if (url === '/v1/daemon/artifacts') {
        result = await objects.uploadArtifact(caller, body, String(request.headers['content-type']),
          decodeURIComponent(String(request.headers['x-artifact-title'])));
      } else if (url.startsWith('/v1/media/')) {
        const owned = await objects.readOwnedBytes(RUBY, url.slice('/v1/media/'.length));
        response.writeHead(200, { 'content-type': 'text/csv' }).end(owned);
        return;
      } else if (url.startsWith('/v1/daemon/operations/')) {
        result = await rootFixture.daemon.execute(url.slice('/v1/daemon/operations/'.length) as never, JSON.parse(body.toString()) as never, caller);
      } else throw new Error('unexpected proof route');
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(error) }));
    }
  });
  const openCorner = (name: string, brief: object) => callAgentTool('open_corner', {
    room: ROOM, name, objective: 'Find the failing step', implementer: 'worker',
    brief: { repositoryWork: false, approval: { sourceMessageId: rootFixture.order.sourceMessageId }, ...brief },
  }, name);
  const cornerCount = async () => Number((await rootFixture.db.query<{ count: string }>(
    `SELECT count(*) FROM rooms WHERE parent_id=$1`, [ROOM])).rows[0]!.count);
  try {
    await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
    const port = (bridge.address() as { port: number }).port;
    vi.stubEnv('BEELINE_DAEMON_BASE_URL', `http://127.0.0.1:${port}`);
    vi.stubEnv('BEELINE_DAEMON_TOKEN', 'isolated-fixture-token');
    vi.stubEnv('BEELINE_DAEMON_ROOM_ID', DM);
    vi.stubEnv('BEELINE_DAEMON_CORNER_ID', '');
    vi.stubEnv('BEELINE_ATTACH_ROOT', home);
    vi.stubEnv('BEELINE_ATTACH_SCRATCH_ROOT', home);
    vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', join(home, 'turn.json'));
    const before = await cornerCount();
    // A brief that names the private file without attaching it is refused by name.
    await expect(openCorner('Named-only', { spec: `Read ${trace} and find the failing step.` }))
      .rejects.toThrow(`the brief names ${trace}, which only you can open`);
    // Quoted filenames and missing home files must never silently reach a worker.
    const spaced = join(home, 'trace data.csv');
    await writeFile(spaced, bytes);
    for (const named of [`"${spaced}"`, `'${spaced}'`, `\`${spaced}\``, join(home, 'missing.csv'), `"${join(home, 'missing trace.csv')}"`]) {
      const path = named.replace(/^["'`]|["'`]$/g, '');
      await expect(openCorner('Private-path', { spec: `Read ${named}` }))
        .rejects.toThrow(`the brief names ${path}, which only you can open`);
      await expect(callAgentTool('order', { address: ROOM, agent: 'worker', text: `Read ${named}` }, 'order-private'))
        .resolves.toContain(`Warning: the order names ${path}, which recipients may not be able to open`);
    }
    // A path that cannot be read is refused by name.
    await expect(openCorner('Missing-file', { spec: 'Read the trace.', attachments: [
      { path: join(home, 'gone.csv'), purpose: 'Failing trace', required: true }] }))
      .rejects.toThrow(`brief attachment ${join(home, 'gone.csv')} cannot be delivered`);
    expect(await cornerCount()).toBe(before);
    // An order that names a private file is delivered with advice to attach it.
    await expect(callAgentTool('order', { address: ROOM, agent: 'worker', text: `Read ${trace}` }, 'order-named'))
      .resolves.toContain(`Warning: the order names ${trace}, which recipients may not be able to open`);
    const opened = JSON.parse(await openCorner('Attached-trace', { spec: `Read "${spaced}" and find the failing step.`,
      attachments: [{ path: spaced, purpose: 'Failing trace', required: true }] }));
    const next = await worker(opened.address);
    const brief = await rootFixture.daemon.execute('listCornerBriefRevisions', { ...authority(next), cornerId: opened.address, limit: 1 }, WORKER);
    const [file] = brief.revisions[0]!.attachments;
    expect(file).toMatchObject({ title: 'trace data.csv', mime: 'text/csv', required: true,
      sha256: createHash('sha256').update(bytes).digest('hex') });
    // The worker opens the brief file with its own read tool.
    caller = WORKER;
    vi.stubEnv('BEELINE_DAEMON_ROOM_ID', opened.address);
    vi.stubEnv('BEELINE_DAEMON_CORNER_ID', opened.address);
    vi.stubEnv('BEELINE_ATTACH_SCRATCH_ROOT', workerHome);
    vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', '');
    const downloaded = JSON.parse(await callAgentTool('read', { facet: 'attachment', attachmentId: file!.objectId }, 'worker-read'));
    expect(await readFile(downloaded.path)).toEqual(bytes);
    console.info(`Demonstrated commander-files: worker read ${downloaded.path} (${bytes.length} bytes, same sha256)`);
  } finally {
    vi.unstubAllEnvs();
    bridge.closeAllConnections();
    await new Promise<void>((resolve) => bridge.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
    await rm(workerHome, { recursive: true, force: true });
  }
});


// Reproduction duplicate-artifact: worker report -> commander upload -> human DM.
for (const delivery of ['report', 'postRoomMessage'] as const) {
  it(`delivers identical carried and uploaded artifacts once through ${delivery}`, async () => {
    const opened = await open();
    const turn = await worker(opened.cornerId);
    const original = randomUUID(), copy = randomUUID();
    await rootFixture.db.query(`DELETE FROM objects WHERE sha256=$1`, ['c97fb129a60faa9cdb824abfecf20b2dbcc3e1b8b8c8b590c61e3238a6db282b']);
    const hash = 'c97fb129a60faa9cdb824abfecf20b2dbcc3e1b8b8c8b590c61e3238a6db282b';
    const attachment = (id: string, name: string) => ({
      url: 'http://test/v1/media/' + id, name, mimeType: 'text/html', size: 11867,
    });
    for (const [id, owner] of [[original, WORKER], [copy, RUBY]]) {
      await rootFixture.db.query(
        `INSERT INTO objects(id,owner_id,kind,key,mime,title,size,sha256,state,expires_at)
         VALUES($1,$2,'artifact',$3,'text/html','design',11867,$4,'ready',now()+interval '24 hours')`,
        [id, owner, 'artifact/' + id, hash]);
    }
    await rootFixture.daemon.execute('postAgentAttachment', {
      ...authority(turn), attachment: attachment(original, 'owner approval'),
    }, WORKER);
    await rootFixture.daemon.execute('report', {
      ...authority(turn), status: 'done', text: 'done: design ready',
    }, WORKER);
    const report = (await commands(DM, RUBY)).find(c => c.reason === 'report')!;
    await claim(report);
    await rootFixture.daemon.execute('postAgentAttachment', {
      ...authority(report), attachment: attachment(copy, 'design for approval'),
    }, RUBY);
    if (delivery === 'report') {
      await rootFixture.daemon.execute('report', {
        ...authority(report), status: 'done', text: 'done: design attached',
      }, RUBY);
    } else {
      await rootFixture.daemon.execute('postRoomMessage', {
        ...authority(report), text: 'Here is the design',
      }, RUBY);
    }
    const visible = (await rootFixture.phone.readRoom(DM, HUMAN))!.messages.filter(m => m.attachments?.length);
    expect(visible).toHaveLength(1);
    expect(visible[0]!.attachments).toEqual([expect.objectContaining({
      url: 'http://test/v1/media/' + original, name: 'owner approval',
    })]);
    expect((await rootFixture.db.query(`SELECT 1 FROM agent_pending_attachments WHERE request_id=$1`,
      [report.turnRequestId])).rowCount).toBe(0);
  });
}


it('Reproduction R-ID: supplied private report and order ids reopen their payloads and refuse other readers', async () => {
  const opened = await open();
  const turn = await worker(opened.cornerId);
  const read = (messageId: string, agent = WORKER, roomId = opened.cornerId) =>
    rootFixture.daemon.execute('getRoomMessage', { roomId, messageId }, agent);
  expect(await read(turn.id)).toMatchObject({ body: expect.stringContaining('Build the widget') });
  await expect(read(turn.id, RUBY, ROOM)).resolves.toBeDefined();
  const uploaded = await new ObjectService(rootFixture.db, new MemoryObjectStorage(), 'http://test')
    .uploadArtifact(WORKER, Buffer.from('Synthetic handoff'), 'text/plain', 'handoff.txt');
  const attachment = { url: uploaded.url, name: 'handoff.txt', mimeType: 'text/plain', size: Buffer.byteLength('Synthetic handoff') };
  await rootFixture.daemon.execute('postAgentAttachment', { ...authority(turn), attachment }, WORKER);
  const report = await rootFixture.daemon.execute('report', { ...authority(turn), status: 'done', text: 'done: evidence ready' }, WORKER);
  expect(await read(report.id, RUBY, DM)).toMatchObject({ body: 'done: evidence ready', attachments: [expect.objectContaining({ name: 'handoff.txt' })] });
  expect(await read(report.id)).toMatchObject({ body: 'done: evidence ready' });
  // Continuations retain private payloads and expose their own command ids.
  await rootFixture.db.query(`UPDATE agent_commands SET private_payload=jsonb_set(private_payload,'{kind}','\"lifecycle\"'::jsonb) WHERE id=$1`, [report.id]);
  expect(await read(report.id, RUBY, DM)).toMatchObject({ body: 'done: evidence ready' });
  // A current Room member who is neither sender nor recipient cannot see it.
  const outsider = 'e'.repeat(64);
  await rootFixture.db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'agent','Observer') ON CONFLICT DO NOTHING`, [outsider]);
  await rootFixture.db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [WS, ROOM, outsider]);
  await expect(read(report.id, outsider, ROOM)).rejects.toThrow('message access denied');
  await expect(read(turn.id, outsider, ROOM)).rejects.toThrow('message access denied');
  await rootFixture.db.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [DM, RUBY]);
  await expect(read(report.id, RUBY, ROOM)).rejects.toThrow('message access denied');
});


it('Reproduction R-ID: an order card id returns the expanded text and archived sibling messages retain read access', async () => {
  const opened = await open();
  const turn = await worker(opened.cornerId);
  await rootFixture.daemon.execute('order', { ...authority(rootFixture.order), address: opened.cornerId, text: 'Build the widget from evidence' }, RUBY);
  const card = (await rootFixture.db.query<{ id: string }>(`SELECT id FROM messages WHERE room_id=$1 AND card_type='agent-command'`, [opened.cornerId])).rows[0]!;
  expect(await rootFixture.daemon.execute('getRoomMessage', { ...authority(turn), messageId: card.id }, WORKER))
    .toMatchObject({ body: expect.stringContaining('Build the widget') });
  const sibling = await open();
  const messageId = randomBytes(32).toString('hex');
  await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Archived evidence')`, [messageId, opened.cornerId, WORKER]);
  await rootFixture.daemon.execute('archiveCorner', { ...authority(rootFixture.order), cornerId: opened.cornerId }, RUBY);
  expect(await rootFixture.daemon.execute('getRoomMessage', { ...authority(rootFixture.order), messageId }, RUBY))
    .toMatchObject({ body: 'Archived evidence' });
  expect(await rootFixture.daemon.execute('getRoomMessage', { roomId: sibling.cornerId, messageId }, WORKER))
    .toMatchObject({ body: 'Archived evidence' });
});


it('Reproduction R-ID2: archived activity and readable prefixes resolve without exposing inaccessible candidates', async () => {
  const opened = await open();
  const sibling = await open();
  const prefix = randomBytes(12).toString('hex');
  const activity = prefix + 'a'.repeat(40);
  const person = prefix + 'b'.repeat(40);
  const hidden = prefix + 'c'.repeat(40);
  await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text,presentation) VALUES
    ($1,$4,$6,'Archived activity','activity'),($2,$4,$7,'Person evidence','message'),
    ($3,$5,$7,'Private evidence','message')`, [activity, person, hidden, opened.cornerId, DM, WORKER, HUMAN]);
  await rootFixture.daemon.execute('archiveCorner', { ...authority(rootFixture.order), cornerId: opened.cornerId }, RUBY);
  const read = (messageId: string) => rootFixture.daemon.execute('getRoomMessage', { roomId: sibling.cornerId, messageId }, WORKER);
  expect(await read(activity)).toMatchObject({ messageId: activity, body: 'Archived activity' });
  expect(await read(person.slice(0, 25))).toMatchObject({ messageId: person, body: 'Person evidence' });
  expect(await rootFixture.daemon.execute('getRoomMessage', { ...authority(rootFixture.order), messageId: activity }, RUBY))
    .toMatchObject({ messageId: activity, body: 'Archived activity' });
  expect(await rootFixture.daemon.execute('getRoomMessage', { ...authority(rootFixture.order), messageId: person.slice(0, 25) }, RUBY))
    .toMatchObject({ messageId: person, body: 'Person evidence' });
  await expect(read(prefix + '%')).rejects.toThrow('message not found');
  expect(await read(activity.slice(0, 25))).toMatchObject({ messageId: activity, body: 'Archived activity' });
  await expect(read(prefix)).rejects.toThrow(`ambiguous message id: ${activity}, ${person}`);
  await expect(read(hidden)).rejects.toThrow('message access denied');
  await expect(read(hidden.slice(0, 25))).rejects.toThrow('message not found');
});


it('Reproduction R-ID: the read tool downloads bytes from a private report hand-off', async () => {
  const opened = await open();
  const turn = await worker(opened.cornerId);
  const bytes = Buffer.from('Synthetic private report attachment');
  const uploaded = await new ObjectService(rootFixture.db, new MemoryObjectStorage(), 'http://test')
    .uploadArtifact(WORKER, bytes, 'text/plain', 'report-evidence.txt');
  const media = uploaded.url.split('/').at(-1)!;
  await rootFixture.daemon.execute('postAgentAttachment', { ...authority(turn), attachment: {
    url: uploaded.url, name: 'report-evidence.txt', mimeType: 'text/plain', size: bytes.length,
  } }, WORKER);
  const report = await rootFixture.daemon.execute('report', { ...authority(turn), status: 'done', text: 'done: evidence attached' }, WORKER);
  const scratch = await mkdtemp(join(tmpdir(), 'beeline-read-id-'));
  const bridge = createServer(async (request, response) => {
    try {
      if (request.url === '/v1/daemon/operations/getRoomMessage') {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const result = await rootFixture.daemon.execute('getRoomMessage', JSON.parse(Buffer.concat(chunks).toString()), RUBY);
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
      } else if (request.url === '/v1/media/' + media) {
        response.writeHead(200, { 'content-type': 'text/plain' }).end(bytes);
      } else response.writeHead(404).end();
    } catch (error) {
      response.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(error) }));
    }
  });
  try {
    await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));
    const address = bridge.address();
    if (!address || typeof address === 'string') throw new Error('missing proof port');
    vi.stubEnv('BEELINE_DAEMON_BASE_URL', `http://127.0.0.1:${address.port}`);
    vi.stubEnv('BEELINE_DAEMON_TOKEN', 'isolated-fixture-token');
    vi.stubEnv('BEELINE_DAEMON_ROOM_ID', opened.cornerId);
    vi.stubEnv('BEELINE_DAEMON_CORNER_ID', opened.cornerId);
    vi.stubEnv('BEELINE_ATTACH_SCRATCH_ROOT', scratch);
    vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', '');
    const message = JSON.parse(await callAgentTool('read', { facet: 'message', messageId: report.id }, 'read-report'));
    expect(message.body).toBe('done: evidence attached');
    const downloaded = JSON.parse(await callAgentTool('read', { facet: 'attachment', messageId: report.id, attachmentId: media }, 'read-report-file'));
    expect(await readFile(downloaded.path)).toEqual(bytes);
  } finally {
    vi.unstubAllEnvs();
    bridge.closeAllConnections();
    await new Promise<void>((resolve, reject) => bridge.close((error) => error ? reject(error) : resolve()));
    await rm(scratch, { recursive: true, force: true });
  }
});



it.each(['success', 'failure', 'replacement'])('Reproduction ARTIFACT-REPORT: shipped MCP waits for upload %s before reporting', async (outcome) => {
  const scratch = await mkdtemp(join(tmpdir(), 'artifact-report-proof-'));
  await writeFile(join(scratch, 'turn.json'), JSON.stringify(authority(rootFixture.order)));
  await writeFile(join(scratch, 'evidence.txt'), 'Artifact report evidence');
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const uploading = new Promise<void>(resolve => { started = resolve; });
  const objects = new ObjectService(rootFixture.db, new MemoryObjectStorage(), 'http://test');
  let reportCalls = 0;
  let uploadAttempts = 0;
  const bridge = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      let result: unknown;
      if (request.url === '/v1/daemon/artifacts') {
        started(); await held;
        if (outcome === 'failure' || (outcome === 'replacement' && uploadAttempts++ === 0)) {
          response.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'storage_unavailable' }));
          return;
        }
        result = await objects.uploadArtifact(RUBY, body, 'text/plain', 'evidence.txt');
      } else if (request.url === '/v1/daemon/operations/postAgentAttachment') {
        result = await rootFixture.daemon.execute('postAgentAttachment', JSON.parse(body.toString()), RUBY);
      } else if (request.url === '/v1/daemon/operations/report') {
        reportCalls++;
        result = await rootFixture.daemon.execute('report', JSON.parse(body.toString()), RUBY);
      } else throw new Error('unexpected proof route');
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise<void>(resolve => bridge.listen(0, '127.0.0.1', resolve));
  const port = (bridge.address() as { port: number }).port;
  const child = spawn(process.execPath, [new URL('../../body/dist/read-only-mcp.js', import.meta.url).pathname], {
    env: { ...process.env, BEELINE_MCP_SURFACE: 'agent', BEELINE_DAEMON_BASE_URL: `http://127.0.0.1:${port}`,
      BEELINE_DAEMON_TOKEN: 'isolated-proof', BEELINE_DAEMON_ROOM_ID: DM, BEELINE_DAEMON_CORNER_ID: '',
      BEELINE_ATTACH_ROOT: scratch, BEELINE_TURN_CONTEXT_FILE: join(scratch, 'turn.json') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  type ToolResult = { isError?: boolean; content: { text: string }[] };
  const pending = new Map<number, (result: ToolResult) => void>();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const response = JSON.parse(line);
    pending.get(response.id)?.(response.result);
  });
  const call = (id: number, name: string, args: object) => new Promise<ToolResult>(resolve => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
  try {
    const upload = call(1, 'post_artifact', { path: join(scratch, 'evidence.txt') });
    await uploading;
    const report = call(2, 'report', { status: 'done', text: 'done: evidence attached' });
    await new Promise(resolve => setTimeout(resolve, 30));
    const sentEarly = reportCalls > 0;
    release();
    const [uploaded, reported] = await Promise.all([upload, report]);
    expect(sentEarly).toBe(false);
    if (outcome === 'failure') {
      expect(uploaded.isError).toBe(true);
      expect(reported).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('storage_unavailable') }] });
      expect(reportCalls).toBe(0);
    } else if (outcome === 'replacement') {
      expect(uploaded.isError).toBe(true);
      expect(reported.isError).toBe(true);
      expect(reportCalls).toBe(0);
      const replacement = await call(3, 'post_artifact', { path: join(scratch, 'evidence.txt') });
      expect(replacement.isError).not.toBe(true);
      const retried = await call(4, 'report', { status: 'done', text: 'done: replacement evidence attached' });
      expect(retried.isError).not.toBe(true);
      const result = JSON.parse(retried.content[0]!.text);
      const message = await rootFixture.daemon.execute('getRoomMessage', { roomId:rootFixture.order.roomId, messageId: result.id }, RUBY);
      expect(message).toMatchObject({ body: 'done: replacement evidence attached', attachments: [expect.objectContaining({ name: 'evidence.txt' })] });
      console.info('Demonstrated upload-1: failed upload and refused report, successful replacement, delivered report with readable attachment metadata');
    } else {
      expect(uploaded.isError).not.toBe(true);
      expect(reported.isError).not.toBe(true);
      const result = JSON.parse(reported.content[0]!.text);
      const message = await rootFixture.daemon.execute('getRoomMessage', { roomId:rootFixture.order.roomId, messageId: result.id }, RUBY);
      expect(message).toMatchObject({ body: 'done: evidence attached', attachments: [expect.objectContaining({ name: 'evidence.txt' })] });
      console.info('Demonstrated ARTIFACT-REPORT: shipped MCP delivered the report with evidence.txt through the daemon service');
    }
  } finally {
    release(); child.kill(); lines.close();
    bridge.closeAllConnections();
    await new Promise<void>(resolve => bridge.close(() => resolve()));
    await rm(scratch, { recursive: true, force: true });
  }
});


it('QUEUE-1: a tag, order and brief revision during a running turn retain separate commands', async () => {
  const opened = await open(), active = await worker(opened.cornerId);
  await rootFixture.db.query(`INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body) VALUES($1,$2,'presence','presence','{"status":"online"}')`, [opened.cornerId, WORKER]);
  await rootFixture.phone.execute('sendRoomMessage', { roomId: opened.cornerId, messageId: randomBytes(32).toString('hex'), text: '@worker First: use the blue widget' }, HUMAN);
  await rootFixture.daemon.execute('order', { ...authority(rootFixture.order), address: opened.cornerId, text: 'Second: add rounded edges' }, RUBY);
  await rootFixture.daemon.execute('reviseCornerBrief', { ...authority(rootFixture.order), cornerId: opened.cornerId,
    expectedRevision: 1, brief: { spec: 'Third: keep the approved width', repositoryWork: false,
      approval: { sourceMessageId: rootFixture.order.sourceMessageId }, change: 'Third: keep the approved width' } }, RUBY);
  const queued = await commands(opened.cornerId, WORKER);
  expect(queued.filter(command => command.action === 'stop')).toEqual([]);
  expect((await rootFixture.db.query('SELECT state FROM agent_commands WHERE id=$1', [active.id])).rows).toEqual([{ state: 'claimed' }]);
  await rootFixture.daemon.execute('postAgentTurnReceipt', { ...authority(active), status: 'complete' }, WORKER);
  const next = (await commands(opened.cornerId, WORKER)).filter(command => command.action === 'input');
  expect(next).toHaveLength(3);
  expect(next[0]!.source.body).toContain('First: use the blue widget');
  expect(next[1]!.source.body).toContain('Second: add rounded edges');
  expect(next[2]!.source.body).toContain('revised the corner brief');
  for (const command of next) {
    await claim(command);
    await rootFixture.daemon.execute('postAgentTurnReceipt', { ...authority(command), status: 'complete' }, WORKER);
  }
});

it('QUEUE-1: direct messages sent during a running turn each require a result', async () => {
  for (const text of ['Second question', 'Third question'])
    await rootFixture.phone.execute('sendRoomMessage', { roomId: DM, messageId: randomBytes(32).toString('hex'), text }, HUMAN);
  await rootFixture.daemon.execute('postAgentTurnReceipt', { ...authority(rootFixture.order), status: 'complete' }, RUBY);
  const next = (await commands(DM, RUBY)).filter(command => command.action === 'input');
  expect(next.map(command => command.source.body)).toEqual(['Second question', 'Third question']);
  await claim(next[0]!);
  await rootFixture.daemon.execute('postAgentTurnReceipt', { ...authority(next[0]!), status: 'complete' }, RUBY);
  expect((await commands(DM, RUBY)).map(command => command.id)).toEqual([next[1]!.id]);
});


it('AGENT-STOP-1: a commander stops its worker\'s running turn, then its new order runs next', async () => {
  const opened = await open();
  await rootFixture.db.query(`INSERT INTO live_outputs(room_id,agent_id,turn_id,kind,body) VALUES($1,$2,'presence','presence','{"status":"online"}')`, [opened.cornerId, WORKER]);
  const root = await mkdtemp(join(tmpdir(), 'agent-stop-proof-'));
  const abort = new AbortController();
  const ctx = new CommandExecutionContext(root);
  const prompts: AgentCommand[] = [];
  const stops: string[] = [];
  const errors: unknown[] = [];
  let pushed: ((rows: readonly AgentCommand[]) => void) | undefined;
  let finishOld!: () => void;
  const oldRun = new Promise<void>((resolve) => { finishOld = resolve; });
  const api = {
    execute: (name: string, input: object) => rootFixture.daemon.execute(name as never, input as never, WORKER),
    liveSubscribe: (_room: unknown, _cursor: unknown, _items: unknown, _state: unknown,
      _presence: unknown, onCommands: typeof pushed) => { pushed = onCommands; return () => {}; },
  } as unknown as DaemonApiClient;
  const running = runServerCommandIntake({ api, roomId: opened.cornerId, agentId: WORKER,
    context: ctx, signal: abort.signal, onError: (error) => errors.push(error),
    stop: (id) => { stops.push(id); finishOld(); },
    run: async (command) => {
      prompts.push(command);
      if (prompts.length === 1) await oldRun;
      else abort.abort();
    },
  });
  try {
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    const old = prompts[0]!;
    const result = await rootFixture.daemon.execute('stopAgentTurn', { ...authority(rootFixture.order), address: opened.cornerId }, RUBY);
    expect(result).toMatchObject({ stopped: true, agent: WORKER });
    expect((await rootFixture.db.query(`SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=$2`,
      [opened.cornerId, old.turnRequestId])).rows[0]?.status).toBe('cancelled');
    expect((await rootFixture.db.query(`SELECT text FROM messages WHERE room_id=$1 AND text LIKE '%stopped @%''s running turn%'`,
      [opened.cornerId])).rows.map((row) => row.text)).toEqual([expect.stringMatching(/^@\S+ stopped @\S+'s running turn$/)]);
    await rootFixture.daemon.execute('order', { ...authority(rootFixture.order), address: opened.cornerId, text: 'New plan: paint it green' }, RUBY);
    pushed?.((await rootFixture.daemon.execute('getAgentCommands', { roomId: opened.cornerId }, WORKER)).commands);
    await vi.waitFor(() => expect(prompts).toHaveLength(2));
    await running;
    expect(stops).toContain(old.turnRequestId);
    expect(prompts[1]!.source.body).toContain('New plan: paint it green');
    expect(errors).toEqual([]);
    console.log('AGENT-STOP-1: commander stop cancelled the running turn; the follow-up order ran next');
  } finally {
    abort.abort(); finishOld(); await running; await rm(root, { recursive: true, force: true });
  }
});


it('AGENT-STOP-3: an orderer stops its own turn and preserves an unrelated human request', async () => {
  const OTHER = 'd'.repeat(64);
  await rootFixture.db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Other','other') ON CONFLICT DO NOTHING`, [OTHER]);
  await rootFixture.db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [OTHER, HUMAN]);
  await rootFixture.db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`, [WS, OTHER, ROOM]);
  const send = (text: string) => rootFixture.phone.execute('sendRoomMessage', { roomId: ROOM, messageId: randomBytes(32).toString('hex'), text }, HUMAN);
  await send('@worker First: look at the widget');
  const first = (await commands(ROOM, WORKER))[0]!;
  await claim(first);
  await send('@worker Second: check the hinge');
  await rootFixture.daemon.execute('order', { ...authority(rootFixture.order), address: ROOM, agent: 'worker', text: 'Third: sand the edges' }, RUBY);
  await commands(ROOM, WORKER);
  await rootFixture.daemon.execute('postAgentTurnReceipt', { ...authority(first), agentId: WORKER, status: 'complete' }, WORKER);
  const next = (await commands(ROOM, WORKER)).filter(command => command.action === 'input');
  expect(next).toHaveLength(2);
  const assigned = next.find(command => command.reason === 'order')!;
  await claim(assigned);
  await send('@other Look at the widget');
  const otherTurn = (await commands(ROOM, OTHER))[0]!;
  await claim(otherTurn);
  await expect(rootFixture.daemon.execute('stopAgentTurn', { ...authority(otherTurn), address: ROOM, agent: 'worker' }, OTHER))
    .rejects.toThrow(/you did not order this turn and you do not command this corner/);
  expect((await rootFixture.db.query(`SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=$2`,
    [ROOM, assigned.turnRequestId])).rows[0]?.status).toBe('working');
  const result = await rootFixture.daemon.execute('stopAgentTurn', { ...authority(rootFixture.order), address: ROOM, agent: 'worker' }, RUBY);
  expect(result).toMatchObject({ stopped: true, agent: WORKER });
  expect((await rootFixture.db.query(`SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=$2`,
    [ROOM, assigned.turnRequestId])).rows[0]?.status).toBe('cancelled');
  await rootFixture.daemon.execute('order', { ...authority(rootFixture.order), address: ROOM, agent: 'worker', text: 'New plan: paint it green' }, RUBY);
  const followUp = (await commands(ROOM, WORKER)).filter(command => command.action === 'input');
  expect(followUp).toHaveLength(2);
  const newOrder = followUp.find(command => command.reason === 'order')!;
  expect(newOrder.source.body).toContain('New plan: paint it green');
  await claim(newOrder);
  expect(followUp.some(command => command.source.body.includes('Second: check the hinge'))).toBe(true);
});


it('AGENT-STOP-2: an agent with no command over the running turn is refused and nothing stops', async () => {
  const OTHER = 'd'.repeat(64);
  await rootFixture.db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Other','other') ON CONFLICT DO NOTHING`, [OTHER]);
  await rootFixture.db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [OTHER, HUMAN]);
  await rootFixture.db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`, [WS, OTHER, ROOM]);
  const opened = await open();
  const running = await worker(opened.cornerId);
  await rootFixture.phone.execute('sendRoomMessage', { roomId: ROOM, messageId: randomBytes(32).toString('hex'), text: '@other Look at the widget' }, HUMAN);
  const otherTurn = (await commands(ROOM, OTHER))[0]!;
  await claim(otherTurn);
  await expect(rootFixture.daemon.execute('stopAgentTurn', { ...authority(otherTurn), address: opened.cornerId, agent: 'worker' }, OTHER))
    .rejects.toThrow(/you did not order this turn and you do not command this corner/);
  expect((await rootFixture.db.query(`SELECT status FROM agent_turns WHERE room_id=$1 AND request_id=$2`,
    [opened.cornerId, running.turnRequestId])).rows[0]?.status).toBe('working');
  expect((await rootFixture.db.query(`SELECT count(*)::int n FROM agent_commands WHERE room_id=$1 AND action='stop'`,
    [opened.cornerId])).rows[0]?.n).toBe(0);
});


it('Reproduction files-2: explicit post binds uploaded media before the turn finishes', async () => {
  const media = randomUUID();
  await rootFixture.db.query(
    `INSERT INTO objects(id,owner_id,kind,key,mime,title,size,sha256,state,expires_at)
     VALUES($1,$2,'artifact',$3,'text/plain','evidence.txt',2,$4,'ready',now()+interval '24 hours')`,
    [media, RUBY, 'artifact/' + media, randomBytes(32).toString('hex')],
  );
  await rootFixture.daemon.execute('postAgentAttachment', { ...authority(rootFixture.order), attachment: {
    url: 'http://test/v1/media/' + media, name: 'evidence.txt', mimeType: 'text/plain', size: 2,
  } }, RUBY);
  // Posting elsewhere must not drain files scoped to the private current place.
  const elsewhere = await rootFixture.daemon.execute('postCornerMessage', { ...authority(rootFixture.order), cornerId: ROOM, text: 'Work started' }, RUBY);
  expect((await rootFixture.daemon.execute('getRoomMessage', { roomId: ROOM, messageId: elsewhere.id }, WORKER)).attachments).toHaveLength(0);
  const posted = await rootFixture.daemon.execute('postCornerMessage', { ...authority(rootFixture.order), cornerId: DM, text: 'evidence.txt attached' }, RUBY);
  const read = await rootFixture.daemon.execute('getRoomMessage', { roomId: DM, messageId: posted.id }, RUBY);
  expect(read.attachments).toEqual([expect.objectContaining({ name: 'evidence.txt', url: 'http://test/v1/media/' + media })]);
  expect((await rootFixture.db.query('SELECT 1 FROM agent_pending_attachments WHERE request_id=$1', [rootFixture.order.turnRequestId])).rowCount).toBe(0);
  await expect(rootFixture.daemon.execute('getRoomMessage', { roomId: DM, messageId: posted.id }, WORKER)).rejects.toThrow();
});
