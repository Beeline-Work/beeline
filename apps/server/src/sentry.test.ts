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
