import { createServer, createHmac, randomUUID, AddressInfo, mkdtemp, rm, join, describe, expect, it, WebSocket, WebSocketServer, waitForComputerHandback, SYSTEM_IDENTITY_ID, systemLine, createAgentCommand, claimAgentCommand, readAgentCommands, DaemonService, backfillComputerObservations, createBeelineServer, readRoomViewMessage, CommandExecutionContext, runServerCommandIntake, assembleTurnPrompt, computerViewToken, createComputerSession, endComputerSession, expireComputerSessions, getComputerSession, refreshComputerSession, startComputerExpirySweep, trustedComputerShareUpstream, HUMAN, OTHER, AGENT, WORKSPACE, ROOM, testSquire, opened, next, nextType, until, fixtureScope1, type TokenAuth, type DaemonApiClient } from './computer-session.test-support.js';

describe('computer session handoff', () => {
const scope1 = fixtureScope1();


  it('Reproduction 2026-10-20: public links open Beeline and token failures explain access', async () => {
    const share = await createComputerSession(scope1.database, scope1.live, {
      roomId: ROOM, agentId: AGENT, sessionId: 'public-link', upstreamUrl: 'body:',
    });
    const publicPage = await fetch(`${scope1.origin}/s/${share.id}/`);
    expect(publicPage.status).toBe(200);
    const html = await publicPage.text();
    expect(html).toContain(`https://web.usebeeline.app/beeline/browser-share?id=${share.id}`);
    expect(html).toContain(`beeline://beeline/browser-share?id=${share.id}`);
    expect(html).not.toContain(ROOM);
    const unknown = await fetch(`${scope1.origin}/s/${'z'.repeat(43)}/`);
    expect(unknown.status).toBe(200);
    expect(await unknown.text()).toContain('Open Beeline and sign in');
    const invalid = await fetch(`${scope1.origin}/s/${share.id}/?access=invalid`);
    expect(invalid.status).toBe(403);
    expect(await invalid.text()).toContain('You do not have access');
    const row = (await getComputerSession(scope1.database, share.id))!;
    const expires = Date.now() - 1000;
    const signature = createHmac('sha256', row.view_secret!).update(`${share.id}.${HUMAN}.${expires}`).digest('hex');
    const expired = await fetch(`${scope1.origin}/s/${share.id}/?access=${HUMAN}.${expires}.${signature}`);
    expect(expired.status).toBe(403);
    expect(await expired.text()).toContain('has expired');
    const access = await computerViewToken(scope1.database, share.id, HUMAN);
    const allowed = await fetch(`${scope1.origin}/s/${share.id}/?access=${access}`);
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toContain('Page.screencastFrame');
    const otherAccess = await computerViewToken(scope1.database, share.id, OTHER);
    await scope1.database.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [ROOM, OTHER]);
    try {
      const refused = await fetch(`${scope1.origin}/s/${share.id}/?access=${otherAccess}`);
      expect(refused.status).toBe(403);
      expect(await refused.text()).toContain('You do not have access');
    } finally {
      await scope1.database.query(`UPDATE memberships SET removed_at=NULL WHERE room_id=$1 AND identity_id=$2`, [ROOM, OTHER]);
    }
    await endComputerSession(scope1.database, scope1.live, row);
    const ended = await fetch(`${scope1.origin}/s/${share.id}/?access=${access}`);
    expect(ended.status).toBe(410);
    expect(await ended.text()).toContain('has ended');
  });


  it('Reproduction SHARE-CARD-DM-1: delivers the committed card directly to an open owner DM', async () => {
    const dm = '33333333-3333-4333-8333-333333333339';
    await scope1.database.query(`INSERT INTO rooms(id,workspace_id,name,direct_participants)
      VALUES($1,$2,'Direct message',$3::jsonb)`, [dm, WORKSPACE, JSON.stringify([HUMAN, AGENT])]);
    for (const member of [HUMAN, AGENT]) await scope1.database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [WORKSPACE, dm, member]);
    const mounted = createBeelineServer({ database: scope1.database, live: scope1.live, phone: scope1.phone,
      auth: { authenticatePhone: async (token: string) => token === 'owner' ? HUMAN : OTHER } as unknown as TokenAuth,
      daemon: new DaemonService(scope1.database, scope1.live), mediaMaximumBytes: 1024 });
    await new Promise<void>((resolve) => mounted.listen(0, '127.0.0.1', resolve));
    const port = (mounted.address() as AddressInfo).port;
    const owner = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, ['bearer.owner']);
    const outsider = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live`, ['bearer.outsider']);
    const received: Array<Record<string, any>> = [];
    const forbidden: Array<Record<string, any>> = [];
    owner.on('message', raw => received.push(JSON.parse(raw.toString())));
    outsider.on('message', raw => forbidden.push(JSON.parse(raw.toString())));
    try {
      await Promise.all([opened(owner), opened(outsider)]);
      const subscribed = nextType(owner, 'subscribed');
      owner.send(JSON.stringify({ type: 'subscribe', roomIds: [dm] }));
      outsider.send(JSON.stringify({ type: 'subscribe', roomIds: [dm] }));
      await subscribed;
      const share = await createComputerSession(scope1.database, scope1.live, {
        roomId: dm, agentId: AGENT, sessionId: 'dm-card-delivery', upstreamUrl: 'body:', title: 'Shared browser',
      });
      // No LISTEN bridge and no covering Room read: the publishing service
      // must deliver the card itself to an already-open transcript.
      for (let attempt = 0; attempt < 100 && !received.some(frame => frame.type === 'message-delta'); attempt++)
        await new Promise(resolve => setTimeout(resolve, 10));
      const delta = received.find(frame => frame.type === 'message-delta');
      expect(delta?.message.id).toBe(share.messageId);
      expect(readRoomViewMessage(delta?.message)?.computerSession).toMatchObject({ id: share.id, status: 'live' });
      expect(forbidden.some(frame => frame.type === 'message-delta')).toBe(false);
      expect((await scope1.phone.readRoom(dm, HUMAN))?.messages.find(message => message.id === share.messageId)?.computerSession)
        .toMatchObject({ id: share.id, status: 'live' });
    } finally {
      owner.terminate(); outsider.terminate();
      await new Promise<void>(resolve => mounted.close(() => resolve()));
      await scope1.database.query('DELETE FROM rooms WHERE id=$1', [dm]);
    }
  });


  it('keeps passive viewer context for the next agent read without a wake or human transcript line', async () => {
    const share = await createComputerSession(scope1.database, scope1.live, {
      roomId: ROOM, agentId: AGENT, sessionId: 'passive-view', upstreamUrl: 'body:',
    });
    const access = await computerViewToken(scope1.database, share.id, HUMAN);
    const viewer = new WebSocket(`${scope1.origin.replace('http:', 'ws:')}/s/${share.id}/ws?access=${access}`);
    await opened(viewer); viewer.close();
    await new Promise<void>(resolve => viewer.once('close', resolve));
    await until(async () => (await scope1.database.query(`SELECT 1 FROM messages WHERE
      system_event->'payload'->>'sessionId'=$1 AND system_event->'payload'->>'activity'='viewer-closed'`, [share.id])).rowCount ? true : undefined);
    const commands = await scope1.database.query(`SELECT 1 FROM agent_commands command JOIN messages source
      ON source.id=command.source_message_id WHERE source.system_event->'payload'->>'sessionId'=$1`, [share.id]);
    expect(commands.rowCount).toBe(0);
    const conversation = await new DaemonService(scope1.database, scope1.live).execute('getRoomConversation', { roomId: ROOM }, AGENT);
    const context = conversation.items.filter(item =>
      (item.systemEvent?.payload as { sessionId?: string } | undefined)?.sessionId === share.id);
    expect(context.map(item => item.body)).toEqual(['Human opened the shared browser', 'Human closed the shared browser view']);
    expect(context.every(item => item.type === 'activity')).toBe(true);
    for (const item of context) expect(await scope1.phone.readLiveDelta(ROOM, HUMAN, {
      type: 'message', messageId: item.id,
    })).toBeNull();
    expect((await scope1.phone.readRoom(ROOM, HUMAN))?.messages.some(message =>
      message.systemEvent?.kind === 'computer-session-activity')).toBe(false);
    await endComputerSession(scope1.database, scope1.live, (await getComputerSession(scope1.database, share.id))!);
  });


  it('retires all unclaimed browser wakes while preserving sent messages', async () => {
    const share = await createComputerSession(scope1.database, scope1.live, {
      roomId: ROOM, agentId: AGENT, sessionId: 'old-view', upstreamUrl: 'body:',
    });
    const meaningfulShare = await createComputerSession(scope1.database, scope1.live, {
      roomId: ROOM, agentId: AGENT, sessionId: 'old-input', upstreamUrl: 'body:',
    });
    const observation = (activity: string) => systemLine(scope1.database, {
      roomId: ROOM, authorId: SYSTEM_IDENTITY_ID, subject: { kind: 'system', name: 'A person' },
      verb: activity === 'input' ? 'used' : 'opened', object: 'the shared browser',
      kind: 'computer-session-activity', payload: { sessionId: activity === 'input' ? meaningfulShare.id : share.id, activity }, wakes: [AGENT],
    });
    const passive = await observation('viewer-opened');
    // Legacy pre-coalescing commands had the normal subscribed-event reason.
    await scope1.database.query(`UPDATE agent_commands SET reason='subscribed_event' WHERE source_message_id=$1`, [passive.id]);
    const meaningful = await observation('input');
    const humanId = randomUUID();
    await scope1.database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Please check this screen')`, [humanId, ROOM, HUMAN]);
    const human = await createAgentCommand(scope1.database, { roomId: ROOM, agentId: AGENT, sourceMessageId: humanId, reason: 'human_tag' });
    await backfillComputerObservations(scope1.database);
    expect((await scope1.database.query<{ state: string }>(`SELECT state FROM agent_commands WHERE id=$1`, [human!.id])).rows[0]?.state).toBe('pending');
    await scope1.database.query(`UPDATE agent_commands SET state='complete' WHERE id=$1`, [human!.id]);
    const commands = await scope1.database.query<{source_message_id: string;state: string}>(
      `SELECT source_message_id,state FROM agent_commands WHERE source_message_id=ANY($1::text[])`, [[passive.id,meaningful.id]]);
    expect(commands.rows).toEqual(expect.arrayContaining([
      {source_message_id: passive.id,state:'cancelled'}, {source_message_id: meaningful.id,state:'cancelled'},
    ]));
    const rows = await scope1.database.query<{text: string;presentation: string}>(
      `SELECT text,presentation FROM messages WHERE id=ANY($1::text[])`, [[passive.id,meaningful.id]]);
    expect(rows.rows.every(row => row.presentation === 'activity' && !row.text.includes('A person'))).toBe(true);
    await backfillComputerObservations(scope1.database);
    await endComputerSession(scope1.database, scope1.live, (await getComputerSession(scope1.database, share.id))!);
    await endComputerSession(scope1.database, scope1.live, (await getComputerSession(scope1.database, meaningfulShare.id))!);
  });


  it('posts a live card, relays frames and only the controller input, then ends the card', async () => {
    const share = await createComputerSession(scope1.database, scope1.live, {
      roomId: ROOM, agentId: AGENT, sessionId: 'chromium-page-1', upstreamUrl: 'body:', title: 'Dashboard',
    });
    const row = await getComputerSession(scope1.database, share.id);
    const access = await computerViewToken(scope1.database, share.id, HUMAN);
    expect(access).toBeTruthy();
    expect(row?.status).toBe('live');
    const card = await scope1.database.query<{ card: { status: string; url: string } }>(
      'SELECT card FROM messages WHERE id=$1', [row!.message_id]);
    expect(card.rows[0]?.card).toMatchObject({ status: 'live', url: share.url });
    expect((await scope1.phone.readRoom(ROOM, HUMAN))?.messages.find((message) => message.id === row!.message_id)?.computerSession)
      .toMatchObject({ id: share.id, status: 'live', url: share.url });
    expect((await fetch(`${scope1.origin}/s/${share.id}`)).status).toBe(200);
    const page = await fetch(`${scope1.origin}/s/${share.id}?access=${access}`);
    expect(page.status).toBe(200);
    const viewerHtml = await page.text();
    expect(viewerHtml).toContain('Page.screencastFrame');
    expect(viewerHtml).toContain('viewer-snapshot-request');
    expect(viewerHtml).toContain('computer-snapshot');
    const source = new WebSocket(`${scope1.origin.replace('http:', 'ws:')}/s/${share.id}/source`);
    await opened(source);
    const frame = JSON.stringify({ method: 'Page.screencastFrame', params: { data: 'abc', sessionId: 1 } });
    source.send(frame); // A static tab can send its first frame before the phone opens it.
    let viewer = new WebSocket(`${scope1.origin.replace('http:', 'ws:')}/s/${share.id}/ws?access=${access}`);
    const receivedFrame = next(viewer);
    await opened(viewer);
    const waiter = new WebSocket(`${scope1.origin.replace('http:', 'ws:')}/s/${share.id}/wait?since=0`);
    await opened(waiter);
    expect(await receivedFrame).toBe(frame);
    viewer.close(); // A transport drop is not a deliberate handback.
    await new Promise<void>((resolve) => viewer.once('close', resolve));
    expect((await (await fetch(`${scope1.origin}/s/${share.id}/status?access=${access}`)).json()).status).toBe('live');
    viewer = new WebSocket(`${scope1.origin.replace('http:', 'ws:')}/s/${share.id}/ws?access=${access}`);
    const reconnectFrame = next(viewer);
    await opened(viewer);
    expect(await reconnectFrame).toBe(frame);
    await until(async () => (await scope1.database.query(`SELECT 1 FROM messages
      WHERE system_event->'payload'->>'sessionId'=$1
      AND system_event->'payload'->>'activity'='viewer-closed'`, [share.id])).rowCount ? true : undefined);
    expect((await scope1.database.query(`SELECT 1 FROM agent_commands command JOIN messages source ON source.id=command.source_message_id
      WHERE source.system_event->'payload'->>'sessionId'=$1`, [share.id])).rowCount).toBe(0);
    expect((await scope1.phone.readRoom(ROOM, HUMAN))?.messages.some(message =>
      message.systemEvent?.kind === 'computer-session-activity')).toBe(false);

    await new Promise<void>((resolve) => setTimeout(resolve, 5_100));
    expect((await getComputerSession(scope1.database, share.id))?.handoff_count).toBe(0);
    const pausedFrames: string[] = [];
    viewer.on('message', (data) => pausedFrames.push(data.toString()));
    viewer.send(JSON.stringify({ type: 'pause-view' }));
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    source.send(frame);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(pausedFrames).toEqual([]);
    const resumedFrame = next(viewer);
    viewer.send(JSON.stringify({ type: 'resume-view' }));
    source.send(frame);
    expect(await resumedFrame).toBe(frame);
    const takeover = next(source);
    viewer.send(JSON.stringify({ type: 'takeover' }));
    expect(JSON.parse(await takeover)).toEqual({ type: 'takeover' });
    const click = next(source);
    viewer.send(JSON.stringify({ id: 1, method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 10, y: 12 } }));
    expect(JSON.parse(await click).method).toBe('Input.dispatchMouseEvent');
    const release = next(source);
    const handback = nextType(waiter, 'handoff');
    viewer.send(JSON.stringify({ type: 'leave' }));
    viewer.close();
    expect(JSON.parse(await release)).toEqual({ type: 'release' });
    await new Promise<void>((resolve) => setTimeout(resolve, 5_100));
    expect((await getComputerSession(scope1.database, share.id))?.handoff_count).toBe(0);
    viewer = new WebSocket(`${scope1.origin.replace('http:', 'ws:')}/s/${share.id}/ws?access=${access}`);
    await opened(viewer);
    await scope1.phone.execute('handbackComputerSession', { id: share.id }, HUMAN);
    expect(await handback).toMatchObject({ type: 'handoff', note: 'Human handed the browser back' });
    const activity = await until(async () => {
      const result = await scope1.database.query<{ id: string; system_event: { payload: { activity: string } } }>(
        `SELECT id,system_event FROM messages WHERE room_id=$1
         AND system_event->>'kind'='computer-session-activity' ORDER BY created_at`, [ROOM],
      );
      return result.rows.some((event) => event.system_event.payload.activity === 'handback') ? result.rows : undefined;
    });
    expect((await scope1.phone.readRoom(ROOM, HUMAN))?.messages.some(message =>
      message.systemEvent?.kind === 'computer-session-activity')).toBe(false);
    expect(activity.map((event) => event.system_event.payload.activity))
      .toEqual(expect.arrayContaining(['viewer-opened', 'viewer-closed', 'takeover', 'input', 'handback']));
    expect((await scope1.database.query(
      `SELECT id FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2`,
      [activity.find((event) => event.system_event.payload.activity === 'handback')!.id, AGENT],
    )).rowCount).toBe(0);
    viewer.close();
    expect((await getComputerSession(scope1.database, share.id))?.status).toBe('live');
    source.close();
    await new Promise<void>((resolve) => source.once('close', resolve));
    // The close handler writes the ended card asynchronously after the socket closes.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect((await getComputerSession(scope1.database, share.id))?.status).toBe('ended');
    expect((await scope1.phone.readRoom(ROOM, HUMAN))?.messages.find((message) => message.id === row!.message_id)?.computerSession?.status)
      .toBe('ended');
    const ended = await fetch(`${scope1.origin}/s/${share.id}?access=${access}`);
    expect(ended.status).toBe(410);
    expect((await fetch(`${scope1.origin}/s/${share.id}/last.jpg`)).status).toBe(404);
  }, 60_000);


  it('keeps the card readable while refusing a reader who cannot steer the agent', async () => {
    const share = await createComputerSession(scope1.database, scope1.live, {
      roomId: ROOM, agentId: AGENT, sessionId: 'restricted-browser', upstreamUrl: 'body:',
    });
    await scope1.database.query(`UPDATE agents SET access_policy='{"type":"creator"}'::jsonb WHERE agent_id=$1`, [AGENT]);
    try {
      const room = await scope1.phone.readRoom(ROOM, OTHER);
      expect(room?.messages.some((message) => message.computerSession?.id === share.id)).toBe(true);
      await expect(scope1.phone.execute('openComputerSession', { id: share.id }, OTHER)).rejects.toThrow('access denied');
      await expect(scope1.phone.execute('handbackComputerSession', { id: share.id }, OTHER)).rejects.toThrow('access denied');
      expect(await computerViewToken(scope1.database, share.id, OTHER)).toBeNull();
      expect((await fetch(`${scope1.origin}/s/${share.id}`)).status).toBe(200);
      expect((await fetch(`${scope1.origin}/s/${share.id}/status`)).status).toBe(403);
      const { access } = await scope1.phone.execute('openComputerSession', { id: share.id }, HUMAN);
      expect((await fetch(`${scope1.origin}/s/${share.id}?access=${access}`)).status).toBe(200);
      const refused = new WebSocket(`${scope1.origin.replace('http:', 'ws:')}/s/${share.id}/ws`);
      await new Promise<void>((resolve) => { refused.once('error', () => resolve()); });
      const allowed = new WebSocket(`${scope1.origin.replace('http:', 'ws:')}/s/${share.id}/ws?access=${access}`);
      await opened(allowed);
      allowed.close();
      await new Promise<void>((resolve) => allowed.once('close', resolve));
      await scope1.database.query(`UPDATE agents SET access_policy='{"type":"allowlist","allow":[]}'::jsonb WHERE agent_id=$1`, [AGENT]);
      expect((await fetch(`${scope1.origin}/s/${share.id}?access=${access}`)).status).toBe(403);
      expect((await fetch(`${scope1.origin}/s/${share.id}/status?access=${access}`)).status).toBe(403);
      const revoked = new WebSocket(`${scope1.origin.replace('http:', 'ws:')}/s/${share.id}/ws?access=${access}`);
      await new Promise<void>((resolve) => { revoked.once('error', () => resolve()); });
      await scope1.database.query(`UPDATE agents SET access_policy='{"type":"everyone"}'::jsonb WHERE agent_id=$1`, [AGENT]);
      await scope1.database.query(`UPDATE memberships SET role='spectator' WHERE room_id IS NULL AND identity_id=$1`, [OTHER]);
      expect(await computerViewToken(scope1.database, share.id, OTHER)).toBeNull();
    } finally {
      await scope1.database.query(`UPDATE memberships SET role='member' WHERE room_id IS NULL AND identity_id=$1`, [OTHER]);
      await scope1.database.query(`UPDATE agents SET access_policy='{"type":"everyone"}'::jsonb WHERE agent_id=$1`, [AGENT]);
      await endComputerSession(scope1.database, scope1.live, (await getComputerSession(scope1.database, share.id))!);
    }
  });


  it('proxies Squire page and stream without exposing its bearer URL, then hands back and expires', async () => {
    const token = 's'.repeat(43);
    let expired = false;
    let failOnce = true;
    const squire = createServer((request, response) => {
      if (request.url !== `/s/${token}/`) { response.writeHead(404).end(); return; }
      if (expired) { response.writeHead(410).end(); return; }
      if (failOnce) { failOnce = false; response.writeHead(503).end(); return; }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><head><meta name="viewport" content="width=device-width,initial-scale=1,shrink-to-fit=yes"></head><body><div id="bar"></div><script>const socket = new WebSocket(new URL("stream", location.href));</script></body>');
    });
    const upstreamSockets = new WebSocketServer({ noServer: true });
    squire.on('upgrade', (request, socket, head) => {
      if (request.url !== `/s/${token}/stream`) { socket.destroy(); return; }
      upstreamSockets.handleUpgrade(request, socket, head, (client) => upstreamSockets.emit('connection', client, request));
    });
    await new Promise<void>((resolve) => squire.listen(0, '127.0.0.1', resolve));
    const upstreamUrl = `http://127.0.0.1:${(squire.address() as AddressInfo).port}/s/${token}/`;
    let upstream: WebSocket | undefined;
    upstreamSockets.on('connection', (socket) => { upstream ??= socket; });
    try {
      const share = await createComputerSession(scope1.database, scope1.live, {
        roomId: ROOM, agentId: AGENT, sessionId: 'squire-operate-1', upstreamUrl, title: 'Squire tab',
      }, testSquire);
      const access = await computerViewToken(scope1.database, share.id, HUMAN);
      const loading = await (await fetch(`${scope1.origin}/s/${share.id}/?access=${access}`)).text();
      expect(loading).toContain('Try again');
      expect(loading).toContain('location.replace(next.href)');
      expect(loading).toContain('event.isTrusted');expect(loading).not.toContain('setTimeout');
      const html = await (await fetch(`${scope1.origin}/s/${share.id}/?access=${access}`)).text();
      expect(html).not.toContain(upstreamUrl);
      expect(html).not.toContain(token);
      expect(html).toContain('new URL("stream" + location.search, location.href)');
      expect(html).toContain('function viewerLayout(');
      // The viewer owns the gesture: no document zoom and no upstream viewport.
      expect(html).toContain('maximum-scale=1,user-scalable=no');
      expect(html).toContain('html,body{background:#1b1320!important;touch-action:none!important');
      expect(html).not.toContain('shrink-to-fit=yes');
      expect(html).not.toContain('beeline-handback');
      expect(html).not.toContain('beeline-end');
      const viewer = new WebSocket(`${scope1.origin.replace('http:', 'ws:')}/s/${share.id}/stream?access=${access}`);
      await opened(viewer);
      await until(async () => upstream);
      const frame = JSON.stringify({ type: 'frame', data: Buffer.from('frame').toString('base64') });
      const received = next(viewer);
      upstream!.send(frame);
      expect(await received).toBe(frame);
      const secondViewer = new WebSocket(`${scope1.origin.replace('http:', 'ws:')}/s/${share.id}/stream?access=${access}`);
      const cachedFrame = next(secondViewer);
      await opened(secondViewer);
      expect(await cachedFrame).toBe(frame);
      secondViewer.close();
      await new Promise<void>((resolve) => secondViewer.once('close', resolve));
      expect((await getComputerSession(scope1.database, share.id))?.handoff_count).toBe(0);
      const waiter = new WebSocket(`${scope1.origin.replace('http:', 'ws:')}/s/${share.id}/wait?since=0`);
      await opened(waiter);
      const input = next(upstream!);
      viewer.send(JSON.stringify({ type: 'text', text: 'human' }));
      expect(JSON.parse(await input)).toEqual({ type: 'text', text: 'human' });
      upstream!.send(JSON.stringify({ type: 'control', state: 'human' }));
      const handback = nextType(waiter, 'handoff');
      upstream!.send(JSON.stringify({ type: 'control', state: 'agent' }));
      viewer.send(JSON.stringify({ type: 'handback' }));
      expect(await handback).toMatchObject({ type: 'handoff' });
      const endedNotice = next(viewer);
      expired = true;
      upstream!.close(1000, 'session ended');
      expect(JSON.parse(await endedNotice)).toEqual({ type: 'ended' });
      await until(async () => (await getComputerSession(scope1.database, share.id))?.status === 'ended' ? true : undefined);
      expect((await fetch(`${scope1.origin}/s/${share.id}?access=${access}`)).status).toBe(410);
      expect((await fetch(`${scope1.origin}/s/${share.id}/last.jpg`)).status).toBe(404);
    } finally {
      for (const client of upstreamSockets.clients) client.close();
      await new Promise<void>((resolve) => upstreamSockets.close(() => resolve()));
      await new Promise<void>((resolve) => squire.close(() => resolve()));
    }
  }, 60_000);


  for (const navigation of [{ url: 'https://httpbin.org/post?custname=private' }, { origin: 'https://httpbin.org' }]) {
    it(`keeps Squire's human input/navigation/handback quiet until a composer message (${'url' in navigation ? 'URL' : 'origin'})`, async () => {
      const roomId = randomUUID();
      await scope1.database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Navigation proof')`, [roomId, WORKSPACE]);
      for (const identityId of [AGENT, HUMAN]) await scope1.database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [WORKSPACE, roomId, identityId]);
      const squire = createServer((_request, response) => response.writeHead(200).end('live'));
      const streams = new WebSocketServer({ noServer: true });
      let upstream: WebSocket | undefined;
      squire.on('upgrade', (request, socket, head) => streams.handleUpgrade(request, socket, head, client => { upstream = client; }));
      await new Promise<void>(resolve => squire.listen(0, '127.0.0.1', resolve));
      const share = await createComputerSession(scope1.database, scope1.live, {
        roomId, agentId: AGENT, sessionId: `form-submit-${roomId}`,
        upstreamUrl: `http://127.0.0.1:${(squire.address() as AddressInfo).port}/s/form/`,
      }, testSquire);
      let viewer: WebSocket | undefined;
      try {
        const access = await computerViewToken(scope1.database, share.id, HUMAN);
        viewer = new WebSocket(`${scope1.origin.replace('http:', 'ws:')}/s/${share.id}/stream?access=${access}`);
        await opened(viewer);
        await until(async () => upstream);
        // Squire announces page state on stream start too. Agent/preview
        // navigation must not masquerade as a human's action.
        upstream!.send(JSON.stringify({ type: 'navigation', ...navigation }));
        const input = next(upstream!);
        viewer.send(JSON.stringify({ type: 'click', x: 0.1, y: 0.8 }));
        expect(JSON.parse(await input)).toMatchObject({ type: 'click' });
        upstream!.send(JSON.stringify({ type: 'control', state: 'human' }));
        upstream!.send(JSON.stringify({ type: 'frame', data: Buffer.from('form-response').toString('base64') }));
        await until(async () => (await scope1.database.query(`SELECT 1 FROM computer_session_events WHERE session_id=$1 AND name='input'`,
          [share.id])).rowCount ? true : undefined);
        expect((await scope1.database.query(`SELECT 1 FROM computer_session_events WHERE session_id=$1 AND name='navigation'`, [share.id])).rowCount).toBe(0);
        for (const message of [{ type: 'wheel', delta_y: 100 }, { type: 'text', text: 'private page input' }]) {
          const forwarded = next(upstream!);
          viewer.send(JSON.stringify(message));
          expect(JSON.parse(await forwarded)).toEqual(message);
        }
        await until(async () => (await scope1.database.query(`SELECT 1 FROM messages WHERE system_event->'payload'->>'sessionId'=$1
          AND system_event->'payload'->>'detail'='typing'`, [share.id])).rowCount ? true : undefined);
        expect((await scope1.database.query(`SELECT 1 FROM agent_commands WHERE room_id=$1`, [roomId])).rowCount).toBe(0);
        // Only Squire's explicit main-frame navigation notification supplies
        // navigation evidence; pointer events and changed pixels cannot.
        upstream!.send(JSON.stringify({ type: 'navigation', ...navigation }));
        await until(async () => (await scope1.database.query(`SELECT 1 FROM messages WHERE
          system_event->'payload'->>'sessionId'=$1 AND system_event->'payload'->>'activity'='navigation'`, [share.id])).rowCount ? true : undefined);
        await scope1.phone.execute('handbackComputerSession', { id: share.id }, HUMAN);
        await until(async () => (await scope1.database.query(`SELECT 1 FROM messages WHERE
          system_event->'payload'->>'sessionId'=$1 AND system_event->'payload'->>'activity'='handback'`, [share.id])).rowCount ? true : undefined);
        expect((await scope1.database.query(`SELECT id FROM agent_commands WHERE room_id=$1`, [roomId])).rowCount).toBe(0);
        await scope1.database.query(`UPDATE identities SET handle='computer-agent' WHERE id=$1`, [AGENT]);
        await scope1.phone.execute('sendRoomMessage', { roomId, text: '@computer-agent Please check this screen' }, HUMAN);
        const commands = (await readAgentCommands(scope1.database, roomId, AGENT)).commands;
        expect(commands).toHaveLength(1);
        const command = commands[0]!;
        expect(command.reason).toBe('human_tag');
        const destination = new URL(navigation.url ?? navigation.origin!).href;
        const contextDir = await mkdtemp(join(process.cwd(), '.navigation-turn-'));
        const abort = new AbortController();
        const daemon = new DaemonService(scope1.database, scope1.live);
        let finalInput = '';
        try {
          await runServerCommandIntake({
            api: {
              execute: (name: string, input: unknown) => name === 'getAgentCommands'
                ? Promise.resolve({ commandProtocol: 1, commands: [command] })
                : daemon.execute(name as 'claimAgentCommand', input as { roomId: string; commandId: string; generationId: string }, AGENT, scope1.helperSource),
              liveSubscribe: () => () => {},
            } as unknown as DaemonApiClient,
            roomId, agentId: AGENT, signal: abort.signal, onError:error=>{throw error;},
            context: new CommandExecutionContext(contextDir), stop: async () => {},
            run: async delivered => {
              finalInput = assembleTurnPrompt({ surface: 'room', task: {
                body: delivered.source.body, outsideEvent: delivered.source.systemEvent,
                commandReason: delivered.reason,
              } }).text;
              abort.abort();
            },
          });
          expect(finalInput).toContain('@computer-agent Please check this screen');
          const conversation = await daemon.execute('getRoomConversation', { roomId }, AGENT);
          expect(conversation.items.some(item => item.body === `Human navigated the shared browser to ${destination}`)).toBe(true);
        } finally { await rm(contextDir, { recursive: true, force: true }); }
        const events = await scope1.database.query<{ detail: string }>(
          `SELECT detail FROM computer_session_events WHERE session_id=$1 AND name='navigation'`, [share.id]);
        expect(events.rows).toEqual([{ detail: destination }]);
      } finally {
        await endComputerSession(scope1.database, scope1.live, (await getComputerSession(scope1.database, share.id))!);
        viewer?.terminate();
        for (const client of streams.clients) client.terminate();
        await new Promise<void>(resolve => streams.close(() => resolve()));
        await new Promise<void>(resolve => squire.close(() => resolve()));
      }
    });
  }


  it('rejects share upstreams outside the trusted Squire tunnel hosts', async () => {
    const token = 'r'.repeat(43);
    for (const upstreamUrl of [
      'http://127.0.0.1/', 'http://[::1]/', 'http://10.0.0.1/', 'http://[fdaa::1]/', 'http://x.internal/',
      'http://169.254.169.254/', 'https://127.0.0.1/', 'https://[fdaa::1]/', 'https://localhost/',
      'https://db.internal/', 'https://printer.local/', 'https://evil.example/', 'https://trycloudflare.com/',
      'https://faketrycloudflare.com/', `http://share.trycloudflare.com/s/${token}/`,
      `https://user:pass@share.trycloudflare.com/s/${token}/`, 'not a url',
    ]) {
      await expect(createComputerSession(scope1.database, scope1.live, {
        roomId: ROOM, agentId: AGENT, sessionId: `rejected-${upstreamUrl}`, upstreamUrl,
      }), upstreamUrl).rejects.toThrow('computer share URL is invalid');
    }
    const trusted = await createComputerSession(scope1.database, scope1.live, {
      roomId: ROOM, agentId: AGENT, sessionId: 'trusted-tunnel',
      upstreamUrl: `https://quiet-river-1.trycloudflare.com/s/${token}/`,
    });
    expect((await getComputerSession(scope1.database, trusted.id))?.upstream_url).toBe(`https://quiet-river-1.trycloudflare.com/s/${token}/`);
    expect((await createComputerSession(scope1.database, scope1.live, {
      roomId: ROOM, agentId: AGENT, sessionId: 'trusted-body', upstreamUrl: 'body:',
    })).id).toBeTruthy();
    expect(trustedComputerShareUpstream(new URL(`https://share.squire.example/s/${token}/`))).toBe(false);
    expect(trustedComputerShareUpstream(new URL(`https://quiet-river-1.trycloudflare.com/s/${token}/`))).toBe(true);
    await scope1.database.query(`UPDATE computer_sessions SET status='ended' WHERE source_session_id IN ('trusted-tunnel','trusted-body')`);
  });


  it('keeps renewed leases live, binds renewal to owner/source, and never revives an ended card', async () => {
    const upstreamUrl = `https://squire.test/s/${'r'.repeat(43)}/`;
    const share = await createComputerSession(scope1.database, scope1.live, {
      roomId: ROOM, agentId: AGENT, sessionId: 'rolling-share', upstreamUrl, expiresAt: Date.now() + 1_000,
    }, testSquire);
    const daemon = new DaemonService(scope1.database, scope1.live);
    const renew = (expiresAt: number) => daemon.execute('refreshComputerSession', {
      roomId: ROOM, sessionId: 'rolling-share', upstreamUrl, expiresAt,
    }, AGENT);
    for (let lifetime = 0; lifetime < 3; lifetime++) {
      // Cross each prior upstream deadline; the persisted renewal wins the sweep.
      await scope1.database.query(`UPDATE computer_sessions SET expires_at=now()-interval '1 second' WHERE id=$1`, [share.id]);
      expect(await renew(Date.now() + 60_000)).toEqual({ live: true });
      await expireComputerSessions(scope1.database, scope1.live);
      expect((await getComputerSession(scope1.database, share.id))?.status).toBe('live');
    }
    const lease = { roomId: ROOM, agentId: AGENT, sessionId: 'rolling-share', upstreamUrl, expiresAt: Date.now() + 120_000 };
    expect(await refreshComputerSession(scope1.database, { ...lease, agentId: OTHER })).toEqual({ live: false });
    expect(await refreshComputerSession(scope1.database, { ...lease, upstreamUrl: 'https://another.test/' })).toEqual({ live: false });
    await expect(renew(NaN)).rejects.toThrow('expiry is invalid');
    await endComputerSession(scope1.database, scope1.live, (await getComputerSession(scope1.database, share.id))!);
    expect(await renew(Date.now() + 120_000)).toEqual({ live: false });
    expect((await getComputerSession(scope1.database, share.id))?.status).toBe('ended');
  });


  it('rechecks expiry when renewal races a sweep that already selected the old lease', async () => {
    const gone = createServer((_request, response) => response.writeHead(410).end());
    await new Promise<void>(resolve => gone.listen(0, '127.0.0.1', resolve));
    const upstreamUrl = `http://127.0.0.1:${(gone.address() as AddressInfo).port}/s/${'r'.repeat(43)}/`;
    const share = await createComputerSession(scope1.database, scope1.live, {
      roomId: ROOM, agentId: AGENT, sessionId: 'renewal-race', upstreamUrl, expiresAt: Date.now() + 1_000,
    }, testSquire);
    await scope1.database.query(`UPDATE computer_sessions SET expires_at=now()-interval '1 second' WHERE id=$1`, [share.id]);
    const racing = new Proxy(scope1.database, { get(target, property) {
      if (property === 'query') return async (sql: string, values?: unknown[]) => {
        const selected = await target.query(sql, values);
        if (sql.includes('FROM computer_sessions WHERE expires_at<=now()'))
          await refreshComputerSession(scope1.database, {
            roomId: ROOM, agentId: AGENT, sessionId: 'renewal-race', upstreamUrl, expiresAt: Date.now() + 60_000,
          });
        return selected;
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    await expireComputerSessions(racing, scope1.live);
    expect((await getComputerSession(scope1.database, share.id))?.status).toBe('live');
    expect((await scope1.database.query<{ status: string }>(`SELECT card->>'status' AS status FROM messages WHERE id=$1`,
      [(await getComputerSession(scope1.database, share.id))!.message_id])).rows[0]?.status).toBe('live');
    await endComputerSession(scope1.database, scope1.live, (await getComputerSession(scope1.database, share.id))!);
    await new Promise<void>(resolve => gone.close(() => resolve()));
  });


  it('ends a view at its committed lease expiry without probing Squire and closes viewers', async () => {
    const token = 'e'.repeat(43);
    let upstreamReads=0;
    const squire = createServer((_request, response) => {
      upstreamReads++;response.writeHead(200).end('<!doctype html>');
    });
    const upstreamSockets = new WebSocketServer({ noServer: true });
    squire.on('upgrade', (request, socket, head) =>
      upstreamSockets.handleUpgrade(request, socket, head, (client) => upstreamSockets.emit('connection', client, request)));
    await new Promise<void>((resolve) => squire.listen(0, '127.0.0.1', resolve));
    const upstreamUrl = `http://127.0.0.1:${(squire.address() as AddressInfo).port}/s/${token}/`;
    try {
      const share = await createComputerSession(scope1.database, scope1.live, {
        roomId: ROOM, agentId: AGENT, sessionId: 'squire-expires', upstreamUrl, expiresAt: Date.now() + 1_500,
      }, testSquire);
      const lasting = await createComputerSession(scope1.database, scope1.live, {
        roomId: ROOM, agentId: AGENT, sessionId: 'squire-no-expiry', upstreamUrl,
      }, testSquire);
      const access = await computerViewToken(scope1.database, share.id, HUMAN);
      const viewer = new WebSocket(`${scope1.origin.replace('http:', 'ws:')}/s/${share.id}/stream?access=${access}`);
      await opened(viewer);
      const viewerClosed = new Promise<void>((resolve) => viewer.once('close', () => resolve()));
      await new Promise((resolve) => setTimeout(resolve, 1_600));

      expect((await getComputerSession(scope1.database, share.id))?.status).toBe('live');
      const readsBeforeExpiry=upstreamReads;
      // Acquisition reconciles the stored due row even when its upstream URL
      // would still return200. There is no status request to that provider.
      const stop = startComputerExpirySweep(scope1.database, scope1.live, 60_000);
      try {
        await until(async () => (await scope1.database.query<{ status: string }>(
          'SELECT status FROM computer_sessions WHERE id=$1', [share.id])).rows[0]?.status === 'ended' ? true : undefined);
      } finally { stop(); }
      expect(upstreamReads).toBe(readsBeforeExpiry);
      expect((await fetch(`${scope1.origin}/s/${share.id}/?access=${access}`)).status).toBe(410);
      await viewerClosed;
      const refused = new WebSocket(`${scope1.origin.replace('http:', 'ws:')}/s/${share.id}/stream?access=${access}`);
      await expect(opened(refused)).rejects.toThrow();
      const card = (await scope1.database.query<{ card: { status: string } }>(
        `SELECT m.card FROM messages m JOIN computer_sessions c ON c.message_id=m.id WHERE c.id=$1`, [share.id])).rows[0];
      expect(card?.card.status).toBe('ended');
      const endedAt = (await scope1.database.query<{ ended_at: Date }>(
        'SELECT ended_at FROM computer_sessions WHERE id=$1', [share.id])).rows[0]?.ended_at;

      // Repeated processing changes nothing.
      expect(await expireComputerSessions(scope1.database, scope1.live)).toBe(0);
      await endComputerSession(scope1.database, scope1.live, { ...(await getComputerSession(scope1.database, share.id))!, status: 'live' });
      expect((await scope1.database.query<{ ended_at: Date }>(
        'SELECT ended_at FROM computer_sessions WHERE id=$1', [share.id])).rows[0]?.ended_at).toEqual(endedAt);
      expect((await getComputerSession(scope1.database, lasting.id))?.status).toBe('live');
      await endComputerSession(scope1.database, scope1.live, (await getComputerSession(scope1.database, lasting.id))!);
    } finally {
      for (const client of upstreamSockets.clients) client.close();
      await new Promise<void>((resolve) => upstreamSockets.close(() => resolve()));
      await new Promise<void>((resolve) => squire.close(() => resolve()));
    }
  }, 60_000);


  it('coalesces each share into one latest observation, behind human requests, with silent completion', async () => {
    const share = await createComputerSession(scope1.database, scope1.live, {
      roomId: ROOM, agentId: AGENT, sessionId: 'activity-burst', upstreamUrl: 'body:',
    });
    const observe = (name: string) => systemLine(scope1.database, {
      roomId: ROOM, authorId: SYSTEM_IDENTITY_ID, subject: { kind: 'system', name: 'A person' },
      verb: 'used', object: `the shared browser ${name}`, kind: 'computer-session-activity',
      payload: { sessionId: share.id, activity: name }, wakes: [AGENT],
    });
    const opened = await observe('viewer-opened');
    const snapshot = (await readAgentCommands(scope1.database, ROOM, AGENT)).commands.find((c) => c.sourceMessageId === opened.id)!;
    await observe('pointer');
    const latest = await observe('navigation');
    const pending = await scope1.database.query<{ id: string; source_message_id: string }>(
      `SELECT id,source_message_id FROM agent_commands WHERE reason='computer_activity'
       AND source_message_id IN (SELECT id FROM messages WHERE system_event->'payload'->>'sessionId'=$1)
       AND state='pending'`, [share.id]);
    expect(pending.rows).toEqual([{ id: snapshot.id, source_message_id: latest.id }]);
    const humanId = '9'.repeat(64);
    await scope1.database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Please answer')`, [humanId, ROOM, HUMAN]);
    const human = await createAgentCommand(scope1.database, { roomId: ROOM, agentId: AGENT, sourceMessageId: humanId, reason: 'human_tag' });
    const duringHumanRequest = (await readAgentCommands(scope1.database, ROOM, AGENT)).commands;
    expect(duringHumanRequest.some((c) => c.id === human!.id)).toBe(true);
    expect(duringHumanRequest.some((c) => c.id === snapshot.id)).toBe(false);
    await expect(claimAgentCommand(scope1.database, ROOM, AGENT, snapshot.id, 'activity-generation')).rejects.toThrow('command claim conflict');
    await claimAgentCommand(scope1.database, ROOM, AGENT, human!.id, 'human-generation');
    await expect(claimAgentCommand(scope1.database, ROOM, AGENT, snapshot.id, 'activity-generation')).rejects.toThrow('command claim conflict');
    await scope1.database.query(`UPDATE agent_commands SET state='complete',completed_at=now() WHERE id=$1`, [human!.id]);
    const daemon = new DaemonService(scope1.database, scope1.live, scope1.origin);
    const claimed = await daemon.execute('claimAgentCommand', { roomId: ROOM, commandId: snapshot.id, generationId: 'activity-generation' }, AGENT, scope1.helperSource);
    expect(claimed.activitySource).toMatchObject({ body: 'A person used the shared browser navigation',
      systemEvent: { payload: { sessionId: share.id, activity: 'navigation' } } });
    expect(claimed.recoveryContext).toBe('A person used the shared browser viewer-opened\nA person used the shared browser pointer\nA person used the shared browser navigation');
    await observe('typing');
    await observe('handback');
    // Lost claim responses remain replayable even when a person arrives next.
    const anotherHumanId = '8'.repeat(64);
    await scope1.database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Another request')`, [anotherHumanId, ROOM, HUMAN]);
    const anotherHuman = await createAgentCommand(scope1.database, { roomId: ROOM, agentId: AGENT, sourceMessageId: anotherHumanId, reason: 'human_tag' });
    await expect(claimAgentCommand(scope1.database, ROOM, AGENT, snapshot.id, 'activity-generation',scope1.helperSource)).resolves.toMatchObject({ id: snapshot.id });
    await scope1.database.query(`UPDATE agent_commands SET state='complete' WHERE id=$1`, [anotherHuman!.id]);
    expect((await readAgentCommands(scope1.database, ROOM, AGENT)).commands.filter((c) =>
      (c.source.systemEvent?.payload as { sessionId?: string })?.sessionId === share.id)).toHaveLength(1);
    await daemon.execute('postAgentTurnReceipt',{roomId:ROOM,requestId:snapshot.turnRequestId,
      generationId:'activity-generation',status:'complete',completionKind:'no-reply'},AGENT,scope1.helperSource);
    expect((await scope1.database.query(`SELECT id FROM messages WHERE room_id=$1 AND card_type='turn-failed'
      AND card->>'requestId'=$2`, [ROOM, snapshot.turnRequestId])).rowCount).toBe(0);
    await endComputerSession(scope1.database, scope1.live, (await getComputerSession(scope1.database, share.id))!);
    await scope1.database.query(`UPDATE agent_commands SET state='complete' WHERE room_id=$1 AND reason='computer_activity'`, [ROOM]);
  });


  it('replays authorized HTML to the source machine that owns the preview cache', async () => {
    const share = await createComputerSession(scope1.database, scope1.live, {
      roomId: ROOM, agentId: AGENT, sessionId: 'machine-cache', upstreamUrl: 'body:',
    });
    const access = await computerViewToken(scope1.database, share.id, HUMAN);
    const previous = process.env.FLY_MACHINE_ID;
    try {
      await scope1.database.query(`UPDATE computer_sessions SET relay_instance_id='source-machine' WHERE id=$1`, [share.id]);
      process.env.FLY_MACHINE_ID = 'other-machine';
      const denied = await fetch(`${scope1.origin}/s/${share.id}/`, { redirect: 'manual' });
      expect(denied.status).toBe(200);
      expect(denied.headers.get('fly-replay')).toBeNull();
      const replay = await fetch(`${scope1.origin}/s/${share.id}/?access=${access}`, { redirect: 'manual' });
      expect(replay.status).toBe(307);
      expect(replay.headers.get('fly-replay')).toBe('instance=source-machine');
    } finally {
      if (previous === undefined) delete process.env.FLY_MACHINE_ID;
      else process.env.FLY_MACHINE_ID = previous;
      await endComputerSession(scope1.database, scope1.live, (await getComputerSession(scope1.database, share.id))!);
    }
  });


  it('keeps one Squire tunnel and cached HTML/frame through five full-view reopenings beside a preview', async () => {
    let htmlReads = 0;
    const frame = JSON.stringify({ type: 'frame', data: Buffer.from('warm preview').toString('base64') });
    const squire = createServer((_request, response) => {
      htmlReads++;
      response.end('<!doctype html><head></head><body><script>const socket=new WebSocket(new URL("stream", location.href));</script></body>');
    });
    const streams = new WebSocketServer({ noServer: true });
    let tunnels = 0;
    let source: WebSocket | undefined;
    squire.on('upgrade', (request, socket, head) => streams.handleUpgrade(request, socket, head, (client) => {
      tunnels++;
      source = client;
      client.on('message', data => {
        const message = JSON.parse(data.toString());
        client.send(JSON.stringify({ type: 'control', state: message.type === 'release' ? 'agent' : 'human' }));
      });
      client.send(frame);
    }));
    await new Promise<void>((resolve) => squire.listen(0, '127.0.0.1', resolve));
    const share = await createComputerSession(scope1.database, scope1.live, {
      roomId: ROOM, agentId: AGENT, sessionId: 'warm-squire',
      upstreamUrl: `http://127.0.0.1:${(squire.address() as AddressInfo).port}/s/warm/`,
    }, testSquire);
    const access = await computerViewToken(scope1.database, share.id, HUMAN);
    const url = `${scope1.origin}/s/${share.id}/?access=${access}`;
    await fetch(url + '&preview=1');
    const preview = new WebSocket(`${scope1.origin.replace('http:', 'ws:')}/s/${share.id}/stream?access=${access}&preview=1`);
    const ready = next(preview);
    await opened(preview);
    expect(await ready).toBe(frame);
    try {
      for (let sample = 0; sample < 5; sample++) {
        const html = await fetch(url);
        expect(html.headers.get('server-timing')).toContain('cached');
        expect(await html.text()).toContain(`atob('${Buffer.from(frame).toString('base64')}')`);
        const viewer = new WebSocket(`${scope1.origin.replace('http:', 'ws:')}/s/${share.id}/stream?access=${access}`);
        const cached = next(viewer);
        await opened(viewer);
        expect(await Promise.race([cached, new Promise((r) => setTimeout(() => r('no cached frame'), 1000))])).toBe(frame);
        const liveFrame = next(viewer);
        source!.send(frame);
        expect(await liveFrame).toBe(frame);
        const input = next(source!);
        viewer.send(JSON.stringify({ type: 'text', text: `sample ${sample}` }));
        expect(JSON.parse(await input)).toEqual({ type: 'text', text: `sample ${sample}` });
        viewer.close();
        await new Promise<void>((resolve) => viewer.once('close', resolve));
      }
      expect(tunnels).toBe(1);
      expect(htmlReads).toBe(1);
      // The upstream web canvas sends pointer; touch is the phone path.
      const pointerViewer = new WebSocket(`${scope1.origin.replace('http:', 'ws:')}/s/${share.id}/stream?access=${access}`);
      await opened(pointerViewer);
      const pointer = next(source!);
      pointerViewer.send(JSON.stringify({ type: 'pointer', phase: 'down', x: 0.5, y: 0.5 }));
      expect(JSON.parse(await pointer)).toMatchObject({ type: 'pointer' });
      await until(async () => (await scope1.database.query(
        `SELECT 1 FROM computer_session_events WHERE session_id=$1 AND name='input' AND detail='pointer'`, [share.id],
      )).rowCount ? true : undefined);
      const release = next(source!);
      pointerViewer.close();
      await new Promise<void>((resolve) => pointerViewer.once('close', resolve));
      expect(JSON.parse(await release)).toEqual({ type: 'release' });
      const blockedInput: string[] = [];
      source!.on('message', (data) => blockedInput.push(data.toString()));
      preview.send(JSON.stringify({ type: 'text', text: 'preview cannot control' }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(blockedInput).toEqual([]);
      const warmViewer = new WebSocket(`${scope1.origin.replace('http:', 'ws:')}/s/${share.id}/stream?access=${access}&warm=1`);
      await opened(warmViewer);
      warmViewer.send(JSON.stringify({ type: 'text', text: 'hidden viewer' }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(blockedInput).toEqual([]);
      warmViewer.send(JSON.stringify({ type: 'viewer-mode', interactive: true }));
      warmViewer.send(JSON.stringify({ type: 'text', text: 'visible viewer' }));
      await until(async () => blockedInput.length ? true : undefined);
      expect(JSON.parse(blockedInput[0]!)).toEqual({ type: 'text', text: 'visible viewer' });
      warmViewer.send(JSON.stringify({ type: 'viewer-mode', interactive: false }));
      warmViewer.send(JSON.stringify({ type: 'text', text: 'closed viewer' }));
      await until(async () => blockedInput.length >= 2 ? true : undefined);
      expect(blockedInput.map(value => JSON.parse(value))).toEqual([
        { type: 'text', text: 'visible viewer' }, { type: 'release' },
      ]);
      warmViewer.close();
      await new Promise<void>((resolve) => warmViewer.once('close', resolve));
      expect(tunnels).toBe(1);
    } finally {
      await endComputerSession(scope1.database, scope1.live, (await getComputerSession(scope1.database, share.id))!);
      preview.close();
      for (const client of streams.clients) client.close();
      await new Promise<void>((resolve) => streams.close(() => resolve()));
      await new Promise<void>((resolve) => squire.close(() => resolve()));
    }
  });


  it('waits without a helper expiry timer until the server ends the share', async () => {
    const share=await createComputerSession(scope1.database,scope1.live,{roomId:ROOM,agentId:AGENT,sessionId:'squire-expiry',upstreamUrl:'body:'});
    const pending=waitForComputerHandback({serverBaseUrl:scope1.origin,shareId:share.id,daemonToken:'test-token',expiresAt:Date.now()+100});
    await endComputerSession(scope1.database,scope1.live,(await getComputerSession(scope1.database,share.id))!);
    expect(await pending).toEqual({type:'ended',events:[]});
  });
});
