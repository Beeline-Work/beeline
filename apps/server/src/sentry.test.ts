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
      'GitHub PR checks failed: HTTP 403', 'GitHub pull request read failed: HTTP 403',
    ]);
  } finally { await new Promise<void>(r => collector.close(() => r())); }
});


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
