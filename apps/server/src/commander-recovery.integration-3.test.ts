import { randomUUID, randomBytes, expect, it, vi, MemoryObjectStorage, ObjectService, callAgentTool, createServer, mkdtemp, readFile, rm, tmpdir, join, createAgentCommand, HUMAN, RUBY, WORKER, WS, ROOM, DM, db, daemon, phone, claim, authority, commands, open, rootFixture, type CommandRow } from './test-support-commander-recovery.integration.test-support.js';



// Reproduction ARTIFACT-READ-BY-ID: actual agent read tool over loopback HTTP.
it('ARTIFACT-READ-BY-ID reads sibling and parent artifacts without exposing private files', async () => {
  const source = randomUUID(), sibling = randomUUID(), remote = randomUUID(), remoteRoom = randomUUID();
  await rootFixture.db.query(`INSERT INTO rooms(id,workspace_id,name,parent_id,created_by)
    VALUES($1,$3,'Artifact source',$4,$5),($2,$3,'Artifact reader',$4,$5)`, [source,sibling,WS,ROOM,HUMAN]);
  await rootFixture.db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Other workspace')`, [remote]);
  await rootFixture.db.query(`INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'Other Room',$3)`, [remoteRoom,remote,HUMAN]);
  const objects = new ObjectService(rootFixture.db, new MemoryObjectStorage(), 'http://test');
  const bytes = Buffer.from('sibling artifact read by id');
  const files: string[] = [];
  for (const roomId of [source, DM, remoteRoom]) {
    const attachment = await objects.uploadArtifact(WORKER, roomId === source ? bytes : Buffer.from('private ' + roomId), 'text/plain', 'report.txt');
    const media = /\/v1\/media\/([^/]+)$/.exec(attachment.url)![1]!;
    files.push(media);
    await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text,attachments) VALUES($1,$2,$3,'Report',$4::jsonb)`,
      [randomBytes(32).toString('hex'),roomId,WORKER,JSON.stringify([attachment])]);
  }
  const unrelated = randomBytes(32).toString('hex');
  await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'No file here')`, [unrelated,ROOM,HUMAN]);
  const scratch = await mkdtemp(join(tmpdir(), 'artifact-read-by-id-'));
  const bridge = createServer(async (request,response) => {
    try {
      if (request.url === '/v1/daemon/operations/getRoomMessage') {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const result = await rootFixture.daemon.execute('getRoomMessage', JSON.parse(Buffer.concat(chunks).toString()), WORKER);
        response.writeHead(200, {'content-type':'application/json'}).end(JSON.stringify(result));
      } else if (request.url?.startsWith('/v1/media/')) {
        response.writeHead(200).end(await objects.readOwnedBytes(WORKER, request.url.split('/').pop()!));
      } else response.writeHead(404).end();
    } catch {
      response.writeHead(404).end(JSON.stringify({error:'not_found'}));
    }
  });
  try {
    await new Promise<void>(resolve => bridge.listen(0,'127.0.0.1',resolve));
    const address = bridge.address();
    if (!address || typeof address === 'string') throw new Error('missing proof port');
    vi.stubEnv('BEELINE_DAEMON_BASE_URL', `http://127.0.0.1:${address.port}`);
    vi.stubEnv('BEELINE_DAEMON_TOKEN', 'isolated-fixture-token');
    vi.stubEnv('BEELINE_DAEMON_CORNER_ID', '');
    vi.stubEnv('BEELINE_ATTACH_SCRATCH_ROOT', scratch);
    vi.stubEnv('BEELINE_TURN_CONTEXT_FILE', '');
    for (const roomId of [sibling, ROOM]) {
      vi.stubEnv('BEELINE_DAEMON_ROOM_ID', roomId);
      const result = JSON.parse(await callAgentTool('read', {facet:'attachment',attachmentId:files[0]}, 'artifact-read-by-id'));
      expect(await readFile(result.path)).toEqual(bytes);
      const fallback = JSON.parse(await callAgentTool('read', {
        facet: 'attachment', messageId: unrelated, attachmentId: files[0],
      }, 'wrong-message'));
      expect(await readFile(fallback.path)).toEqual(bytes);
      for (const id of [files[1],files[2],randomUUID()]) {
        await expect(callAgentTool('read', {facet:'attachment',attachmentId:id}, 'unreachable')).rejects.toThrow('no attachment with this id');
      }
    }
  } finally {
    vi.unstubAllEnvs();
    bridge.closeAllConnections();
    await new Promise<void>((resolve,reject) => bridge.close(error => error ? reject(error) : resolve()));
    await rm(scratch,{recursive:true,force:true});
  }
});


// Reproduction BRIEF-CITATION: approval follows a commander delivery, including
// a forwarded human source that the worker cannot read directly.
it.each(['human', 'order', 'resume', 'ancestor'] as const)('Reproduction BRIEF-CITATION: revise using the delivered %s citation', async citation => {
  const opened = await open();
  await rootFixture.db.query(`UPDATE agent_commands SET state='complete' WHERE room_id=$1`, [opened.cornerId]);
  const messageId = randomBytes(32).toString('hex');
  await rootFixture.phone.execute('sendRoomMessage', { roomId: DM, messageId, text: 'Include the approved validation step' }, HUMAN);
  const incoming = (await commands(DM, RUBY)).find(c => c.rootSourceMessageId === messageId)!;
  await claim(incoming);
  const delivered = await rootFixture.daemon.execute('order', {
    ...authority(incoming), address: ROOM, agent: 'worker', text: 'Revise the assigned brief with the approved validation step',
  }, RUBY);
  let turn = (await commands(ROOM, WORKER)).find(c => c.id === delivered.id)!;
  if (citation === 'resume' || citation === 'ancestor') {
    const parent = (await rootFixture.db.query<CommandRow>('SELECT * FROM agent_commands WHERE id=$1', [turn.id])).rows[0]!;
    await rootFixture.db.query(`UPDATE agent_commands SET state='complete' WHERE id=$1`, [turn.id]);
    const resumed = await createAgentCommand(rootFixture.db, { roomId: ROOM, agentId: WORKER, sourceMessageId: null,
      action: 'resume', reason: 'report', parent, retainDepth: true });
    turn = (await commands(ROOM, WORKER)).find(c => c.id === resumed!.id)!;
  }
  await claim(turn);
  const sourceMessageId = citation === 'human' ? messageId : citation === 'ancestor' ? delivered.id : turn.id;
  const revise = (citationId: string) => rootFixture.daemon.execute('reviseCornerBrief', {
    ...authority(turn), cornerId: opened.cornerId, expectedRevision: 1,
    brief: { spec: 'Build the widget and validate the result', change: 'Record the approved validation step',
      repositoryWork: false, approval: { sourceMessageId: citationId } },
  }, WORKER);
  // Another message in the same private source is not forwarded approval.
  const unrelated = randomBytes(32).toString('hex');
  await rootFixture.db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Unrelated scope')`, [unrelated, DM, HUMAN]);
  await expect(revise(unrelated)).rejects.toThrow('brief.approval.sourceMessageId');
  // Even the active delivery cannot lend approval from the worker or a peer.
  for (const author of [WORKER, HUMAN]) {
    await rootFixture.db.query(`UPDATE agent_commands SET private_payload=jsonb_set(private_payload,'{authorId}',to_jsonb($2::text)) WHERE id=$1`, [delivered.id, author]);
    await expect(revise(sourceMessageId)).rejects.toThrow('brief.approval.sourceMessageId');
  }
  await rootFixture.db.query(`UPDATE agent_commands SET private_payload=jsonb_set(private_payload,'{authorId}',to_jsonb($2::text)) WHERE id=$1`, [delivered.id, RUBY]);
  if (citation === 'human') {
    await rootFixture.db.query(`UPDATE memberships SET removed_at=now() WHERE identity_id=$1`, [HUMAN]);
    await expect(revise(sourceMessageId)).rejects.toThrow('brief.approval.sourceMessageId');
    await rootFixture.db.query(`UPDATE memberships SET removed_at=NULL WHERE identity_id=$1`, [HUMAN]);
  }
  const revised = await revise(sourceMessageId);
  expect(revised).toMatchObject({ revision: 2, approval: {
    sourceMessageId: citation === 'human' ? messageId : delivered.id,
    approvedBy: citation === 'human' ? HUMAN : RUBY,
  } });
  console.info(`Demonstrated BRIEF-CITATION: ${citation} delivery → revision 2 with server-resolved approval`);
});
