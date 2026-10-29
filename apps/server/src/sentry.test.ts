import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it.each([['server', false], ['body', false], ['server', true], ['body', true]] as const)(
  'sends a thrown %s error (fatal=%s) through the real SDK and privacy filter', async (surface, fatal) => {
  const envelopes: string[] = [];
  const collector = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    envelopes.push(Buffer.concat(chunks).toString());
    response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}');
  });
  await new Promise<void>(r => collector.listen(0, '127.0.0.1', r));
  try {
    const port = (collector.address() as AddressInfo).port;
    const modulePath = resolve('../', surface, 'src/sentry.ts');
    const capture = surface === 'server' ? 'captureServerError' : 'captureHelperError';
    const flush = surface === 'server' ? 'flushServerErrors' : 'flushHelperErrors';
    const thrown = `throw new Error('Beeline Sentry E2E test ${surface} Bearer private user@example.com');`;
    const source = `import { ${capture}, ${flush} } from ${JSON.stringify(modulePath)};
      ${fatal ? thrown : `try { ${thrown} } catch (error) { ${capture}(error); } await ${flush}();`}`;
    const result = await new Promise<{ code: number | null; error: string }>((done, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
        env: { ...process.env, SENTRY_DSN: `http://public@127.0.0.1:${port}/1`,
          BEELINE_SENTRY_DSN: `http://public@127.0.0.1:${port}/1`, SENTRY_ENVIRONMENT: 'test' },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let error = ''; child.stderr.on('data', value => { error += String(value); });
      child.on('error', reject); child.on('exit', code => done({ code, error }));
    });
    expect(result, result.error).toMatchObject({ code: fatal ? 1 : 0 });
    const events = envelopes.flatMap(envelope => envelope.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)))
      .filter(item => item.exception);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tags: { surface: surface === 'body' ? 'helper' : surface }, environment: 'test',
      exception: { values: [{ value: `Beeline Sentry E2E test ${surface} Bearer [redacted] [email]` }] } });
    expect(events[0].exception.values[0].stacktrace.frames.length).toBeGreaterThan(0);
    expect(JSON.stringify(events[0])).not.toContain('user@example.com');
    expect(JSON.stringify(events[0])).not.toContain('Bearer private');
    expect(events[0].request).toBeUndefined(); expect(events[0].user).toBeUndefined();
  } finally { await new Promise<void>(r => collector.close(() => r())); }
});


it('R-GH-403: actual PR and discussion rate limits send no Sentry event; plain 403s still send', async () => {
  const envelopes: string[] = [];
  const collector = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    envelopes.push(Buffer.concat(chunks).toString());
    response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}');
  });
  await new Promise<void>(r => collector.listen(0, '127.0.0.1', r));
  try {
    const port = (collector.address() as AddressInfo).port;
    const source = `import { captureServerError, flushServerErrors } from ${JSON.stringify(resolve('src/sentry.ts'))};
      import { GitHubAppClient } from '@beeline/auth/github';
      const client = new GitHubAppClient({appId:'42',privateKey:'unused',slug:'beeline'});
      for (const headers of [
        {'x-ratelimit-remaining':'0','x-ratelimit-reset':String(Math.floor(Date.now()/1000)+600)},
        {'retry-after':'120'}, {}
      ]) {
        globalThis.fetch = async () => new Response('{}',{status:403,headers});
        for (const read of [() => client.readPullRequest('fake','owner/widgets',1),
          () => client.readPullRequestDiscussion('fake','owner/widgets',1)]) {
          try { await read(); } catch (error) { captureServerError(error); }
        }
      }
      await flushServerErrors();`;
    const result = await new Promise<{ code: number | null; error: string }>((done, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
        env: { ...process.env, SENTRY_DSN: `http://public@127.0.0.1:${port}/1`, SENTRY_ENVIRONMENT: 'test' },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let error = ''; child.stderr.on('data', value => { error += String(value); });
      child.on('error', reject); child.on('exit', code => done({ code, error }));
    });
    expect(result, result.error).toMatchObject({ code: 0 });
    const events = envelopes.flatMap(envelope => envelope.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)))
      .filter(item => item.exception);
    expect(events).toHaveLength(2);
    expect(events.map(event => event.exception.values[0].value).sort()).toEqual([
      'GitHub PR checks GET /repos/owner/widgets/pulls/1 failed: HTTP 403', 'GitHub pull request read failed: HTTP 403',
    ]);
  } finally { await new Promise<void>(r => collector.close(() => r())); }
});


it('GH-CHECK-REFUSAL: check refresh preserves permission diagnostics and blocks merge without a Sentry event', async () => {
  const envelopes: string[] = [];
  const collector = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    envelopes.push(Buffer.concat(chunks).toString());
    response.writeHead(200); response.end('{}');
  });
  await new Promise<void>(r => collector.listen(0, '127.0.0.1', r));
  try {
    const port = (collector.address() as AddressInfo).port;
    const source = `
      import assert from 'node:assert/strict';
      import { PgliteDatabase } from './src/test-support.ts';
      import { migrate } from './dist/database.js';
      import { GitHubOperations } from './dist/github-operations.js';
      import { captureServerError, flushServerErrors } from './dist/sentry.js';
      import { GitHubAppClient, GitHubHttpError } from '@beeline/auth/github';
      const db = new PgliteDatabase();
      await migrate(db);
      const human = 'a'.repeat(64), head = '1'.repeat(40);
      const workspace='11111111-1111-4111-8111-111111111111';
      const room='22222222-2222-4222-8222-222222222222';
      const corner='33333333-3333-4333-8333-333333333333';
      await db.query("INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner')",[human]);
      await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Fixture')",[workspace]);
      await db.query("INSERT INTO github_installations(installation_id,owner_id,account_id,account_login,account_type,repository_selection,status) VALUES(77,$1,'42','owner','User','selected','active')",[human]);
      await db.query("INSERT INTO github_repositories(repository_id,installation_id,full_name,default_branch) VALUES(101,77,'owner/widgets','main')");
      await db.query("INSERT INTO rooms(id,workspace_id,created_by,name,repository_key,repository_remote,repository_resolution,github_installation_id) VALUES($1,$2,$3,'Fixture','owner/widgets','https://github.com/owner/widgets.git','repository',77)",[room,workspace,human]);
      await db.query("INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES($1,$2,$3,$4,'Checks')",[corner,workspace,room,human]);
      await db.query("INSERT INTO corner_facts(corner_id,objective,feature_branch,lifecycle) VALUES($1,'Check refusal','feature/fixture',$2::jsonb)",[corner,JSON.stringify({checks:'passing',pr:{number:1,headSha:head,url:'https://github.com/owner/widgets/pull/1',mergeability:'clean'}})]);
      await db.query("INSERT INTO corner_brief_revisions(corner_id,revision,content,spec,author_id,source_room_id) VALUES($1,1,'Fixture','Fixture',$2,$3)",[corner,human,room]);
      const client = new GitHubAppClient({appId:'42',privateKey:'unused',slug:'beeline'});
      client.installationToken = async () => ({token:'fixture',expiresAt:'2030-01-01T00:00:00Z'});
      let merges=0, actionsReads=0;
      client.mergePullRequest = async () => { merges++; };
      globalThis.fetch = async (url) => {
        const path = String(url);
        if (path.endsWith('/graphql')) return Response.json({data:{repository:{object:{oid:head,statusCheckRollup:null}}}});
        if (path.includes('/check-suites')) return Response.json({total_count:0,check_suites:[]});
        if (path.includes('/actions/runs?')) {
          actionsReads++;
          return Response.json({message:'Resource not accessible by integration'},{status:403,headers:{'x-accepted-github-permissions':'actions=read','x-github-request-id':'fixture-request'}});
        }
        if (path.endsWith('/pulls/1')) return Response.json({number:1,head:{sha:head},html_url:'https://github.com/owner/widgets/pull/1',mergeable_state:'clean',state:'open',draft:false});
        throw new Error('Unexpected fixture route: '+path);
      };
      const operations = new GitHubOperations(db, {}, client, 'fixture');
      const checkFailure = error => {
        assert.ok(error instanceof GitHubHttpError);
        assert.equal(error.status,403);
        assert.equal(error.rateLimited,false);
        assert.match(error.message,/GET \\/repos\\/owner\\/widgets\\/actions\\/runs\\?head_sha=/);
        assert.match(error.message,/Resource not accessible by integration/);
        assert.match(error.message,/accepted permissions: actions=read/);
        assert.match(error.message,/request ID: fixture-request/);
        return true;
      };
      try {
        const payload={action:'completed',installation:{id:77},repository:{full_name:'owner/widgets'},check_run:{name:'lint',status:'completed',conclusion:'success',head_sha:head,check_suite:{head_branch:'feature/fixture',head_sha:head}}};
        await assert.rejects(operations.processWebhook('check_run',payload),error=>{checkFailure(error);captureServerError(error);return true;});
        await assert.rejects(operations.prChecksStatus({cornerId:corner}),checkFailure);
        assert.equal(await operations.landCorner(corner),false);
        assert.equal(merges,0);
        assert.equal(actionsReads,3);
        // Queue recovery uses the same real error and capture boundary.
        await db.query("UPDATE corner_facts SET lifecycle=jsonb_set(lifecycle,'{checkRefreshRetry}',$2::jsonb) WHERE corner_id=$1",[corner,JSON.stringify({headSha:head,after:0})]);
        await operations.refreshQueuedChecks();
        const stored=(await db.query("SELECT lifecycle FROM corner_facts WHERE corner_id=$1",[corner])).rows[0].lifecycle;
        assert.equal(stored.checks,'passing'); // Historical evidence never bypasses the live merge read.
        assert.equal(stored.checkRefreshRetry,undefined);
        // Text alone, an unexplained 403, and unexpected server failures still report.
        captureServerError(new Error('Resource not accessible by integration'));
        captureServerError(new GitHubHttpError('Unexplained refusal',403));
        captureServerError(new GitHubHttpError('Provider outage',500));
        await flushServerErrors();
      } finally { await db.close(); }
    `;
    const result = await new Promise<{ code: number | null; error: string }>((done, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
        env: { ...process.env, SENTRY_DSN: `http://public@127.0.0.1:${port}/1`, SENTRY_ENVIRONMENT: 'test' },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let error = ''; child.stderr.on('data', value => { error += String(value); });
      child.on('error', reject); child.on('exit', code => done({ code, error }));
    });
    expect(result, result.error).toMatchObject({ code: 0 });
    const events = envelopes.flatMap(envelope => envelope.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)))
      .filter(item => item.exception);
    expect(events.map(event => event.exception.values[0].value).sort()).toEqual([
      'Provider outage failed: HTTP 500', 'Resource not accessible by integration', 'Unexplained refusal failed: HTTP 403',
    ]);
  } finally { await new Promise<void>(r => collector.close(() => r())); }
}, 30_000);


it('SENTRY-7807034373: schedule HTTP refusals stay visible without Sentry events', async () => {
  const envelopes: string[] = [];
  const collector = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    envelopes.push(Buffer.concat(chunks).toString());
    response.writeHead(200); response.end('{}');
  });
  await new Promise<void>(r => collector.listen(0, '127.0.0.1', r));
  try {
    const port = (collector.address() as AddressInfo).port;
    const source = `
      import assert from 'node:assert/strict';
      import { PgliteDatabase } from './src/test-support.ts';
      import { migrate } from './src/database.ts';
      import { DaemonService } from './src/daemon-service.ts';
      import { LiveHub } from './src/live.ts';
      import { createBeelineServer } from './src/server.ts';
      import { flushServerErrors } from './src/sentry.ts';
      const db = new PgliteDatabase();
      await migrate(db);
      const agent = 'c'.repeat(64);
      const room = '22222222-2222-4222-8222-222222222222';
      const workspace = '11111111-1111-4111-8111-111111111111';
      await db.query("INSERT INTO identities(id,kind,name) VALUES($1,'agent','Worker')", [agent]);
      await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Test')", [workspace]);
      await db.query("INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Test')", [room,workspace,agent]);
      await db.query("INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'member'),($1,$2,$3,'member')", [workspace,room,agent]);
      const live = new LiveHub();
      const daemon = new DaemonService(db, live);
      const server = createBeelineServer({ database: db, live, daemon, phone: {},
        auth: { authenticateDaemon: async () => agent, authenticatePhone: async () => null }, mediaMaximumBytes: 1 });
      await new Promise(r => server.listen(0,'127.0.0.1',r));
      const call = async (operation,input) => {
        const response = await fetch('http://127.0.0.1:' + server.address().port + '/v1/daemon/operations/' + operation, {
          method:'POST', headers:{authorization:'Bearer isolated-sentry-proof-token','content-type':'application/json'}, body:JSON.stringify(input) });
        return {status:response.status, body:await response.json()};
      };
      try {
        const input = {roomId:room,agentId:agent,title:'Check work',prompt:'Check work.',cadence:{kind:'interval',everyMinutes:60}};
        const created = await call('createAgentSchedule',input);
        assert.equal(created.status,200);
        const before = (await db.query('SELECT * FROM agent_schedules')).rows;
        for (const operation of ['createAgentSchedule','updateAgentSchedule']) {
          for (const title of ['', 'one two three four five', 'x'.repeat(81), 7, null]) {
            const result = await call(operation,{...input,scheduleId:created.body.scheduleId,title});
            assert.equal(result.status,503);
            assert.deepEqual(result.body,{error:typeof title === 'string'
              ? 'title must be one to four words, at most 80 characters' : 'title must be one to four words'});
            assert.deepEqual((await db.query('SELECT * FROM agent_schedules')).rows,before);
          }
        }
        await flushServerErrors();
        // An unexpected fault with identical wording must still be reported.
        daemon.execute = async () => { throw new Error('title must be one to four words'); };
        assert.equal((await call('createAgentSchedule',input)).status,503);
        await flushServerErrors();
      } finally {
        await new Promise(r => server.close(r));
        await db.close();
      }
      process.exit(0);`;
    const result = await new Promise<{ code: number | null; error: string }>((done, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
        env: { ...process.env, SENTRY_DSN: `http://public@127.0.0.1:${port}/1`, SENTRY_ENVIRONMENT: 'test' },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let error = ''; child.stderr.on('data', value => { error += String(value); });
      child.on('error', reject); child.on('exit', code => done({ code, error }));
    });
    expect(result, result.error).toMatchObject({ code: 0 });
    const events = envelopes.flatMap(envelope => envelope.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)))
      .filter(item => item.exception);
    expect(events).toHaveLength(1);
    expect(events[0].exception.values[0].value).toBe('title must be one to four words');
  } finally { await new Promise<void>(r => collector.close(() => r())); }
}, 60_000);

it('R-CHECKIN-ACTIVITY: invalid final output is actionable while unexpected database errors still alert', async () => {
  const envelopes: string[] = [];
  const collector = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    envelopes.push(Buffer.concat(chunks).toString());
    response.end('{}');
  });
  await new Promise<void>(r => collector.listen(0, '127.0.0.1', r));
  try {
    const port = (collector.address() as AddressInfo).port;
    const source = `
      import assert from 'node:assert/strict';
      import { PgliteDatabase } from './src/test-support.ts';
      import { migrate } from './src/database.ts';
      import { DaemonService } from './src/daemon-service.ts';
      import { LiveHub } from './src/live.ts';
      import { createAgentCommand, claimAgentCommand } from './src/agent-command.ts';
      import { createBeelineServer } from './src/server.ts';
      import { flushServerErrors } from './src/sentry.ts';
      const db = new PgliteDatabase(); await migrate(db);
      const agent='b'.repeat(64), human='a'.repeat(64);
      const room='22222222-2222-4222-8222-222222222222', workspace='11111111-1111-4111-8111-111111111111';
      await db.query("INSERT INTO identities(id,kind,name) VALUES($1,'agent','Worker'),($2,'human','Owner')",[agent,human]);
      await db.query("INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)",[agent,human]);
      await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Test')",[workspace]);
      await db.query("INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Test')",[room,workspace]);
      await db.query("INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'member'),($1,$2,$3,'member')",[workspace,room,agent]);
      const command=await createAgentCommand(db,{roomId:room,agentId:agent,sourceMessageId:null,reason:'free_agent_checkin'});
      await db.query("INSERT INTO next_day_checkin_candidates(identity_id,first_at,due_at) VALUES($1,now()-interval '1 day',now())",[human]);
      await db.query("INSERT INTO next_day_checkins(identity_id,due_at,room_id,agent_id,command_id) VALUES($1,now(),$2,$3,$4)",[human,room,agent,command.id]);
      await claimAgentCommand(db,room,agent,command.id,'proof');
      const live=new LiveHub(), daemon=new DaemonService(db,live);
      const server=createBeelineServer({database:db,live,daemon,phone:{},
        auth:{authenticateDaemon:async()=>agent,authenticatePhone:async()=>null},mediaMaximumBytes:1});
      await new Promise(r=>server.listen(0,'127.0.0.1',r));
      const call=async(operation,extra)=>{
        const response=await fetch('http://127.0.0.1:'+server.address().port+'/v1/daemon/operations/'+operation,{
          method:'POST',headers:{authorization:'Bearer isolated-checkin-proof','content-type':'application/json'},
          body:JSON.stringify({roomId:room,requestId:command.turn_request_id,generationId:'proof',...extra})});
        return {status:response.status,body:await response.json()};
      };
      try {
        const activity={activity:[{kind:'thinking',title:'Working',status:'in_progress'}]};
        assert.equal((await call('postAgentActivity',activity)).status,200);
        for (const output of [{text:'   '},{text:'Card',presentation:'card'}]) {
          const result=await call('postRoomMessage',output);
          assert.match(result.body.error,/Post nonempty text with message presentation/);
        }
        assert.equal((await db.query('SELECT sent_at FROM next_day_checkins')).rows[0].sent_at,null);
        // Exercise an actual database failure with the old validation wording.
        await db.query(\`CREATE FUNCTION fail_checkin_activity() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'A check-in must be one plain Room message'; END $$;
          CREATE TRIGGER checkin_fault BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION fail_checkin_activity();\`);
        assert.equal((await call('postAgentActivity',activity)).status,503);
        await flushServerErrors();
      } finally { await new Promise(r=>server.close(r)); await db.close(); }
      process.exit(0);`;
    const result = await new Promise<{ code: number | null; error: string }>((done, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
        env: { ...process.env, SENTRY_DSN: `http://public@127.0.0.1:${port}/1`, SENTRY_ENVIRONMENT: 'test' },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let error = ''; child.stderr.on('data', value => { error += String(value); });
      child.on('error', reject); child.on('exit', code => done({ code, error }));
    });
    expect(result, result.error).toMatchObject({ code: 0 });
    const events = envelopes.flatMap(envelope => envelope.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)))
      .filter(item => item.exception);
    expect(events).toHaveLength(1);
    expect(events[0].exception.values[0].value).toBe('A check-in must be one plain Room message');
  } finally { await new Promise<void>(r => collector.close(() => r())); }
}, 60_000);

it.each(['server', 'body'] as const)('R-SENTRY-REPEAT: %s sends one envelope for a changing-PID loop', async (surface) => {
  const events: unknown[] = [];
  const collector = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    for (const line of Buffer.concat(chunks).toString().split('\n')) {
      try { const item = JSON.parse(line); if (item.exception) events.push(item); } catch { /* Envelope framing. */ }
    }
    response.end('{}');
  });
  await new Promise<void>(r => collector.listen(0, '127.0.0.1', r));
  try {
    const port = (collector.address() as AddressInfo).port;
    const capture = surface === 'server' ? 'captureServerError' : 'captureHelperError';
    const flush = surface === 'server' ? 'flushServerErrors' : 'flushHelperErrors';
    const source = `import { ${capture}, ${flush} } from ${JSON.stringify(resolve('../', surface, 'src/sentry.ts'))};
      for (let pid = 695; pid < 705; pid++) {
        ${capture}(new Error('previous runtime owner ' + pid + ' still alive; native topology migration incomplete'));
      }
      await ${flush}();`;
    let stderr = "";
    const code = await new Promise<number | null>((done, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
        env: { ...process.env, SENTRY_DSN: `http://public@127.0.0.1:${port}/1`,
          BEELINE_SENTRY_DSN: `http://public@127.0.0.1:${port}/1` }, stdio: ['ignore', 'ignore', 'pipe'],
      });
      child.stderr.on('data', chunk => { stderr += String(chunk); });
      child.on('error', reject); child.on('exit', done);
    });
    expect(code, stderr).toBe(0);
    expect(events).toHaveLength(1);
  } finally { await new Promise<void>(r => collector.close(() => r())); }
});

it('ATTACH-CAP-1: attachment cap is a client error and unexpected failures still alert', async () => {
  const envelopes: string[] = [];
  const collector = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    envelopes.push(Buffer.concat(chunks).toString());
    response.writeHead(200); response.end('{}');
  });
  await new Promise<void>(r => collector.listen(0, '127.0.0.1', r));
  try {
    const port = (collector.address() as AddressInfo).port;
    const source = `
      import assert from 'node:assert/strict';
      import { PgliteDatabase } from './src/test-support.ts';
      import { migrate } from './src/database.ts';
      import { DaemonService } from './src/daemon-service.ts';
      import { LiveHub } from './src/live.ts';
      import { createAgentCommand } from './src/agent-command.ts';
      import { createBeelineServer } from './src/server.ts';
      import { flushServerErrors } from './src/sentry.ts';
      const db = new PgliteDatabase();
      await migrate(db);
      const agent = 'c'.repeat(64), human = 'a'.repeat(64);
      const room = '22222222-2222-4222-8222-222222222222';
      const workspace = '11111111-1111-4111-8111-111111111111';
      const media = '33333333-3333-4333-8333-333333333333';
      await db.query("INSERT INTO identities(id,kind,name) VALUES($1,'agent','Worker'),($2,'human','Owner')", [agent,human]);
      await db.query("INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)", [agent,human]);
      await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Test')", [workspace]);
      await db.query("INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Test')", [room,workspace]);
      await db.query("INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'member'),($1,$2,$3,'member')", [workspace,room,agent]);
      await db.query("INSERT INTO objects(id,owner_id,kind,key,mime,title,size,sha256,state,expires_at) VALUES($1,$2,'artifact','test/key','text/plain','File',10,repeat('d',64),'ready',now()+interval '24 hours')", [media,agent]);
      const live = new LiveHub();
      const daemon = new DaemonService(db, live, undefined, 10);
      const command = await createAgentCommand(db, {roomId:room,agentId:agent,sourceMessageId:null,reason:'system'});
      const [pending] = (await daemon.execute('getAgentCommands',{roomId:room},agent)).commands;
      assert.equal(pending.id,command.id);
      await daemon.execute('claimAgentCommand',{roomId:room,commandId:pending.id,generationId:'proof'},agent);
      const server = createBeelineServer({ database: db, live, daemon, phone: {},
        auth: { authenticateDaemon: async () => agent, authenticatePhone: async () => null }, mediaMaximumBytes: 10 });
      await new Promise(r => server.listen(0,'127.0.0.1',r));
      const input = {roomId:room,requestId:pending.turnRequestId,generationId:'proof',
        attachment:{url:'http://test/v1/media/'+media,name:'file.txt',mimeType:'text/plain',size:9}};
      const call = async (payload=input) => {
        const response = await fetch('http://127.0.0.1:' + server.address().port + '/v1/daemon/operations/postAgentAttachment', {
          method:'POST', headers:{authorization:'Bearer isolated-sentry-proof-token','content-type':'application/json'}, body:JSON.stringify(payload) });
        return {status:response.status, body:await response.json()};
      };
      const queue = async () => (await db.query('SELECT * FROM agent_pending_attachments ORDER BY id')).rows;
      try {
        assert.equal((await call()).status,200); // One byte below the total cap.
        assert.equal((await call({...input,attachment:{...input.attachment,size:1}})).status,200); // Exactly at cap.
        const before = await queue();
        assert.equal(before.length,2);
        const over = await call({...input,attachment:{...input.attachment,size:1}});
        console.log('ATTACH-CAP-1 over-cap HTTP response',JSON.stringify(over));
        assert.equal(over.status,400);
        assert.deepEqual(over.body,{error:'Queued attachments exceed the 10-byte total limit per reply: 10 bytes already queued; artifact size: 1 bytes. Use smaller files, or deliver the queued attachments with your next reply or report before posting more.'});
        assert.deepEqual(await queue(),before);
        await db.query('DELETE FROM agent_pending_attachments');
        assert.equal((await call({...input,attachment:{...input.attachment,size:11}})).status,400);
        assert.deepEqual(await queue(),[]);
        // Turn and ownership checks must still refuse without queueing.
        assert.equal((await call({...input,generationId:'stale'})).status,403);
        await db.query('UPDATE objects SET owner_id=$2 WHERE id=$1',[media,human]);
        assert.equal((await call()).status,503);
        assert.deepEqual(await queue(),[]);
        // The exact same wording on an unexpected failure must still alert.
        daemon.execute = async () => { throw new Error('queued attachments exceed the size cap'); };
        assert.equal((await call()).status,503);
        await flushServerErrors();
      } finally {
        await new Promise(r => server.close(r));
        await db.close();
      }
      process.exit(0);`;
    const result = await new Promise<{ code: number | null; error: string }>((done, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
        env: { ...process.env, SENTRY_DSN: `http://public@127.0.0.1:${port}/1`, SENTRY_ENVIRONMENT: 'test' },
        stdio: ['ignore', 'inherit', 'pipe'],
      });
      let error = ''; child.stderr.on('data', value => { error += String(value); });
      child.on('error', reject); child.on('exit', code => done({ code, error }));
    });
    expect(result, result.error).toMatchObject({ code: 0 });
    const events = envelopes.flatMap(envelope => envelope.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)))
      .filter(item => item.exception);
    expect(events).toHaveLength(2);
    expect(events.map(event => event.exception.values[0].value).sort()).toEqual([
      'attachment media is not owned by this agent', 'queued attachments exceed the size cap',
    ]);
  } finally { await new Promise<void>(r => collector.close(() => r())); }
}, 60_000);

it('BEELINE-SENTRY-REFUSALS / APP-REFUSAL-5 / VIDEO-PREVIEW-1P: real agent handlers keep refusals out of Sentry', async () => {
  const envelopes: string[] = [];
  const collector = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    envelopes.push(Buffer.concat(chunks).toString());
    response.writeHead(200); response.end('{}');
  });
  await new Promise<void>(r => collector.listen(0, '127.0.0.1', r));
  try {
    const port = (collector.address() as AddressInfo).port;
    const source = `
      import assert from 'node:assert/strict';
      import { createServer } from 'node:http';
      import { reserveServiceReviewWorkspaces } from './src/service-review.ts';
      import { postRoomChoice } from './src/room-choice.ts';
      import { saveWorkflow, startWorkflow } from './src/workflow-runs.ts';
      import { ComposioApps } from './src/composio-apps.ts';
      import { describedWorkflow } from './src/test-support.ts';
      import { PgliteDatabase } from './src/test-support.ts';
      import { migrate } from './src/database.ts';
      import { DaemonService } from './src/daemon-service.ts';
      import { LiveHub } from './src/live.ts';
      import { createAgentCommand } from './src/agent-command.ts';
      import { createBeelineServer } from './src/server.ts';
      import { flushServerErrors } from './src/sentry.ts';
      const db = new PgliteDatabase();
      await migrate(db);
      const agent = 'c'.repeat(64), human = 'a'.repeat(64);
      const room = '22222222-2222-4222-8222-222222222222';
      const workspace = '11111111-1111-4111-8111-111111111111';
      const media = '33333333-3333-4333-8333-333333333333';
      await db.query("INSERT INTO identities(id,kind,name) VALUES($1,'agent','Worker'),($2,'human','Owner')", [agent,human]);
      await db.query("INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)", [agent,human]);
      await db.query("INSERT INTO workspaces(id,name) VALUES($1,'Test')", [workspace]);
      await db.query("INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Test')", [room,workspace]);
      await db.query("INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$3,'member'),($1,$2,$3,'member')", [workspace,room,agent]);
      await db.query("INSERT INTO objects(id,owner_id,kind,key,mime,title,size,sha256,state,expires_at) VALUES($1,$2,'artifact','test/key','text/plain','File',10,repeat('d',64),'ready',now()+interval '24 hours')", [media,agent]);
      const live = new LiveHub();
      let providerFault = 'flagged404';
      const providerResponse = async (url) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith('/toolkits')) return Response.json({items:[]});
        if (path.includes('/connected_accounts/')) return Response.json({id:path.split('/').at(-1),user_id:human,status:'ACTIVE',toolkit:{slug:path.endsWith('/fixture-youtube') ? 'youtube' : 'slack'}});
        if (path.endsWith('/tools/SLACK_FETCH')) return Response.json({version:'fixture',toolkit:{slug:'slack'}});
        if (path.endsWith('/tools/execute/SLACK_FETCH')) {
          if (providerFault === 'permission') return Response.json({successful:false,error:JSON.stringify({error:{code:403,message:'Request had insufficient authentication scopes.',status:'PERMISSION_DENIED'}})});
          if (providerFault === 'nested404') return Response.json({successful:false,error:JSON.stringify({error:{code:404,message:'Not Found',status:'NOT_FOUND'}})});
          if (providerFault === 'unexpected') return Response.json({successful:false,error:JSON.stringify({error:{code:500,message:'Insufficient Permission',status:'INTERNAL'}})});
          if (providerFault === 'flagged404') return Response.json({successful:false,error:JSON.stringify({message:'Not Found',status_code:404})});
          return Response.json({message:'upstream broken'}, {status:providerFault === 'http404' ? 404 : 500});
        }
        throw new Error('unexpected provider path: '+path);
      };
      const upstream = createServer(async (request,response) => {
        const fixture = await providerResponse('http://fixture'+request.url);
        response.writeHead(fixture.status,{'content-type':'application/json'});
        response.end(await fixture.text());
      });
      await new Promise(r => upstream.listen(0,'127.0.0.1',r));
      const provider = new ComposioApps('fixture-only', (url,init) =>
        fetch('http://127.0.0.1:'+upstream.address().port+new URL(String(url)).pathname,init));
      const daemon = new DaemonService(db, live, undefined, 10);
      Object.assign(daemon,{composio:provider});
      await db.query("INSERT INTO workspace_apps(id,workspace_id,owner_identity_id,app_key,display_name,transport,route,composio_account_id) VALUES('44444444-4444-4444-8444-444444444444',$1,$2,'slack','Slack','composio','composio','fixture-account')",[workspace,human]);
      await db.query("INSERT INTO messages(id,room_id,author_id,text) VALUES('human-root',$1,$2,'Run the refusal proof')",[room,human]);
      const command = await createAgentCommand(db, {roomId:room,agentId:agent,sourceMessageId:'human-root',reason:'test'});
      const [pending] = (await daemon.execute('getAgentCommands',{roomId:room},agent)).commands;
      assert.equal(pending.id,command.id);
      await daemon.execute('claimAgentCommand',{roomId:room,commandId:pending.id,generationId:'proof'},agent);
      const server = createBeelineServer({ database: db, live, daemon, phone: {},
        auth: { authenticateDaemon: async () => agent, authenticatePhone: async () => null }, mediaMaximumBytes: 10 });
      await new Promise(r => server.listen(0,'127.0.0.1',r));
      const input = {roomId:room,requestId:pending.turnRequestId,generationId:'proof',
        attachment:{url:'http://test/v1/media/'+media,name:'file.txt',mimeType:'text/plain',size:9}};
      const call = async (payload=input, operation='postAgentAttachment') => {
        const response = await fetch('http://127.0.0.1:' + server.address().port + '/v1/daemon/operations/' + operation, {
          method:'POST', headers:{authorization:'Bearer isolated-sentry-proof-token','content-type':'application/json'}, body:JSON.stringify(payload) });
        return {status:response.status, body:await response.json()};
      };
      const queue = async () => (await db.query('SELECT * FROM agent_pending_attachments ORDER BY id')).rows;
      try {
        assert.equal((await call()).status,200); // One byte below the total cap.
        assert.equal((await call({...input,attachment:{...input.attachment,size:1}})).status,200); // Exactly at cap.
        const before = await queue();
        assert.equal(before.length,2);
        const over = await call({...input,attachment:{...input.attachment,size:1}});
        console.log('BEELINE-SENTRY-REFUSALS over-cap HTTP response',JSON.stringify(over));
        assert.equal(over.status,400);
        assert.deepEqual(over.body,{error:'Queued attachments exceed the 10-byte total limit per reply: 10 bytes already queued; artifact size: 1 bytes. Use smaller files, or deliver the queued attachments with your next reply or report before posting more.'});
        assert.deepEqual(await queue(),before);
        await db.query('DELETE FROM agent_pending_attachments');
        assert.equal((await call({...input,attachment:{...input.attachment,size:11}})).status,400);
        assert.deepEqual(await queue(),[]);
        // Stale turns must still refuse without queueing.
        assert.equal((await call({...input,generationId:'stale'})).status,403);
        // Schedule and tray validators already carry typed refusals.
        const schedule = await call({...input,agentId:agent,title:'one two three four five',prompt:'Check work',cadence:{kind:'interval',everyMinutes:60}},'createAgentSchedule');
        assert.match(schedule.body.error,/title must be one to four words/);
        const ask = await call({...input,status:'needs_decision',text:'needs-decision: Choose a path',ask:'x'.repeat(141)},'report');
        assert.equal(ask.status,400);
        assert.match(ask.body.error,/ask must be plain text/);
        const worker = (await db.query('SELECT * FROM agent_commands WHERE id=$1',[command.id])).rows[0];
        for (const name of ['refusal-proof','workspace-walk']) {
          await saveWorkflow(db,worker,{contract:describedWorkflow({version:1,name,description:'Prove caller refusals',roles:['triager'],start:'browse',handoffs:{
            browse:{role:'triager',requires:[],on:{reviewed:'done'}},done:{kind:'terminal',status:'done'}
          }})});
          const {runId} = await startWorkflow(db,worker,{name,roleBindings:{triager:agent}});
          if (name === 'workspace-walk') await reserveServiceReviewWorkspaces(db,agent,runId,true);
          const contents = name === 'workspace-walk' ? {receipts:(await db.query('SELECT * FROM service_review_targets($1,$2)',[agent,runId])).rows.map(row=>({workspace:row.workspace_id,rowsRead:0,firstMessageTime:null,lastMessageTime:null,findings:'none'}))} : {text:'x'.repeat(17000)};
          const result = await call({...input,runId,outcome:'reviewed',contents},'handoff');
          assert.match(result.body.error,name === 'workspace-walk' ? /workspace receipt must match/ : /contents exceeds 16 KB/);
        }
        for (const failure of ['flagged404','http404','permission','nested404']) {
          providerFault = failure;
          const result = await call({...input,appId:'app:slack',tool:'SLACK_FETCH',arguments:{}},'executeAppTool');
          assert.ok(result.body.error.includes(failure !== 'http404' ? 'App tool execution failed:' : 'App provider request failed (404)'));
          assert.equal(result.status,failure === 'permission' ? 403 : 404);
          if (failure === 'permission') assert.equal(result.body.error,'App tool execution failed: '+JSON.stringify({error:{code:403,message:'Request had insufficient authentication scopes.',status:'PERMISSION_DENIED'}}));
          if (failure === 'flagged404') assert.ok(result.body.error.includes('Not Found'));
        }
        // VIDEO-PREVIEW-1P: exercise the real app-tool guard before provider execution.
        await db.query("INSERT INTO messages(id,room_id,author_id,text,card,created_at) VALUES('video-welcome',$1,$2,'Welcome',$3::jsonb,now()-interval '1 minute')",
          [room,agent,JSON.stringify({starterOnboarding:'welcome',selectedOptionId:'B'})]);
        await db.query("INSERT INTO workspace_apps(id,workspace_id,owner_identity_id,app_key,display_name,transport,route,composio_account_id) VALUES('55555555-5555-4555-8555-555555555555',$1,$2,'youtube','YouTube','composio','composio','fixture-youtube')",[workspace,human]);
        const upload = {...input,appId:'app:youtube',tool:'YOUTUBE_MULTIPART_UPLOAD_VIDEO',arguments:{title:'Changed'}};
        const tapMessage = 'Show the video preview with Post and Cancel, and wait for the person to tap Post before uploading.';
        const matchMessage = 'Upload arguments must match the approved video preview exactly: title mismatched. Use videoFile: {beelineObjectId: "<videoObjectId from the preview>"}. Show a new preview for any changes.';
        const missingApproval = await call(upload,'executeAppTool');
        console.log('VIDEO-PREVIEW-1P missing approval HTTP response',JSON.stringify(missingApproval));
        assert.deepEqual(missingApproval,{status:403,body:{error:tapMessage}});
        const preview = await postRoomChoice(db,{roomId:room,agentId:agent,mode:'question',prompt:'Preview',
          options:[{label:'Post',consequence:'Post'},{label:'Cancel',consequence:'Cancel'}]});
        await db.query("UPDATE messages SET card=card || $2::jsonb WHERE id=$1",[preview.messageId,JSON.stringify({
          status:'answered',selectedOptionId:'A',videoPreview:{videoObjectId:media,title:'Approved',description:'Description',visibility:'private'}
        })]);
        const changedUpload = await call(upload,'executeAppTool');
        console.log('VIDEO-PREVIEW-1P changed upload HTTP response',JSON.stringify(changedUpload));
        assert.deepEqual(changedUpload,{status:403,body:{error:matchMessage}});
        assert.equal((await db.query('SELECT card FROM messages WHERE id=$1',[preview.messageId])).rows[0].card.youtubeUploadUsed,undefined);
        await flushServerErrors();
        // A database failure in this same guard must still alert, even with refusal wording.
        const transaction = db.transaction.bind(db);
        const failGuard = executor => ({
          query: async (sql,params) => {
            if (sql.includes("m.card->>'selectedOptionId' selected")) throw new Error(tapMessage);
            return executor.query(sql,params);
          },
          transaction: work => executor.transaction(tx => work(failGuard(tx))),
        });
        db.transaction = work => transaction(tx => work(failGuard(tx)));
        try {
          assert.deepEqual(await call(upload,'executeAppTool'),{status:503,body:{error:tapMessage}});
        } finally { db.transaction = transaction; }
        await flushServerErrors();
        providerFault = 'unexpected';
        const unexpected = await call({...input,appId:'app:slack',tool:'SLACK_FETCH',arguments:{}},'executeAppTool');
        assert.equal(unexpected.status,503);
        assert.ok(unexpected.body.error.includes('Insufficient Permission'));
        providerFault = 'http500';
        const outage = await call({...input,appId:'app:slack',tool:'SLACK_FETCH',arguments:{}},'executeAppTool');
        assert.equal(outage.status,503);
        assert.equal(outage.body.error,'App provider request failed (500): upstream broken');
        // The exact same wording on an unexpected failure must still alert.
        daemon.execute = async () => { throw new Error('queued attachments exceed the size cap'); };
        assert.equal((await call()).status,503);
        await flushServerErrors();
      } finally {
        await new Promise(r => server.close(r));
        await new Promise(r => upstream.close(r));
        await db.close();
      }
      process.exit(0);`;
    const result = await new Promise<{ code: number | null; error: string }>((done, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
        env: { ...process.env, SENTRY_DSN: `http://public@127.0.0.1:${port}/1`, SENTRY_ENVIRONMENT: 'test' },
        stdio: ['ignore', 'inherit', 'pipe'],
      });
      let error = ''; child.stderr.on('data', value => { error += String(value); });
      child.on('error', reject); child.on('exit', code => done({ code, error }));
    });
    expect(result, result.error).toMatchObject({ code: 0 });
    const events = envelopes.flatMap(envelope => envelope.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)))
      .filter(item => item.exception);
    expect(events).toHaveLength(4);
    expect(events.map(event => event.exception.values[0].value).sort()).toEqual([
      'App provider request failed (500): upstream broken',
      'App tool execution failed: '+JSON.stringify({error:{code:500,message:'Insufficient Permission',status:'INTERNAL'}}),
      'queued attachments exceed the size cap',
      'Show the video preview with Post and Cancel, and wait for the person to tap Post before uploading.',
    ].sort());
  } finally { await new Promise<void>(r => collector.close(() => r())); }
}, 60_000);
