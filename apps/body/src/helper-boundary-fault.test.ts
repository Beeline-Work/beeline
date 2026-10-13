import { build } from 'esbuild';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { activateRelease, stageRelease } from './self-update.js';
import { journalInterruptedTurns, reportInterruptedTurns } from './force-update-journal.js';
import { identityFromKey, writeRuntimeRecord, type AgentRuntimeRecord } from './runtime.js';

// Instrument built-in file operations in this private child, never production
// code. A synchronous pipe checkpoint lets the parent kill at the exact edge.
const barrier = `import f from 'node:fs'; import p from 'node:fs/promises'; import {syncBuiltinESMExports,createRequire} from 'node:module'; const require=createRequire(import.meta.url); {
const hold=()=>{ f.writeSync(1,'boundary\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0); };
const point=process.env.BOUNDARY;
const write=p.writeFile; p.writeFile=async(...a)=>{const r=await write(...a);if(point==='verification'&&String(a[0]).endsWith('.node-path'))hold();return r;};
const rename=p.rename; p.rename=async(...a)=>{const target=String(a[1]);if((point==='anchor-before'&&target.endsWith('/beeline'))||(point==='migration-before'&&target.endsWith('/runtime.json')))hold();const r=await rename(...a);if((point==='anchor-after'&&target.endsWith('/beeline'))||(point==='migration-after'&&target.endsWith('/runtime.json')))hold();return r;};
const sync=f.fsyncSync; f.fsyncSync=(...a)=>{if(point==='journal')hold();return sync(...a);};
syncBuiltinESMExports(); }`;

it.each([
  'verification',
  'migration-before',
  'migration-after',
  'anchor-before',
  'anchor-after',
  'journal',
])(
  'owner death at %s leaves an atomic, recoverable boundary',
  async (point) => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-boundary-'));
    const layout = {
      libDir: resolve(root, 'lib/beeline'),
      releasesRoot: resolve(root, 'lib/beeline-releases'),
      binDir: resolve(root, 'bin'),
    };
    const entry = resolve(root, 'boundary.mjs');
    const release = resolve(layout.releasesRoot, 'new');
    const runtime = resolve(root, 'agent');
    const turn = { roomId: 'room', requestId: 'command', generationId: 'generation' };
    const storedIdentity = (key: string, name: string) => {
      const identity = identityFromKey(key, name);
      return {
        name,
        publicKey: identity.publicKey,
        secretKeyHex: Buffer.from(identity.secretKey).toString('hex'),
      };
    };
    const record: AgentRuntimeRecord = {
      version: 2,
      agent: storedIdentity('11'.repeat(32), 'Legacy'),
      body: storedIdentity('22'.repeat(32), 'Body'),
      communityId: 'workspace',
      pairedBy: 'owner',
      supervisorRoot: root,
      rooms: [],
      agentBinary: '/bin/true',
      mcpBinary: '/bin/true',
    };
    const migrated: AgentRuntimeRecord = {
      ...record,
      transport: {
        kind: 'monolith',
        baseUrl: 'http://fixture',
        exchangeToken: `bde_${'x'.repeat(43)}`,
      },
    };
    const recordPath = await writeRuntimeRecord(record);
    const sourceRoot = new URL('.', import.meta.url).pathname;
    const server = (await import('node:http')).createServer(async (_request, response) =>
      response.end(await readFile(resolve(root, 'bundle.tar.gz'))),
    );
    let child: ReturnType<typeof spawn> | undefined;
    try {
      await mkdir(resolve(layout.releasesRoot, 'old/lib/beeline'), { recursive: true });
      await writeFile(
        resolve(layout.releasesRoot, 'old/lib/beeline/beeline-cli.mjs'),
        'console.log("old");',
      );
      await symlink('beeline-releases/old', layout.libDir);
      await mkdir(resolve(release, 'lib/beeline'), { recursive: true });
      await writeFile(resolve(release, 'lib/beeline/beeline-cli.mjs'), 'console.log("new");');
      await writeFile(
        resolve(release, 'bundle.json'),
        JSON.stringify({ version: 'v1.0.0', commit: 'new', node: '>=20.11.0' }),
      );
      for (const name of ['squire-mcp-proxy.mjs', 'agent-tool-mcp-proxy.mjs', 'pi-mcp-adapter.mjs'])
        await writeFile(resolve(release, 'lib/beeline', name), 'export {};');
      await mkdir(resolve(release, 'lib/beeline/codegraph/bin'), { recursive: true });
      await writeFile(
        resolve(release, 'lib/beeline/codegraph/bin/codegraph'),
        '#!/bin/sh\nexit 0\n',
        { mode: 0o755 },
      );
      execFileSync('tar', [
        '-czf',
        resolve(root, 'bundle.tar.gz'),
        '-C',
        release,
        'lib',
        'bundle.json',
      ]);
      const sha256 = createHash('sha256')
        .update(await readFile(resolve(root, 'bundle.tar.gz')))
        .digest('hex');
      const published = { file: 'bundle.tar.gz', sha256, commit: 'new', version: 'v1.0.0' };
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      const manifest = `http://127.0.0.1:${(server.address() as { port: number }).port}/manifest.json`;
      if (point === 'verification') await rm(release, { recursive: true });
      if (point === 'journal') journalInterruptedTurns(runtime, [turn]);
      await build({
        stdin: {
          contents: `import {stageRelease,activateRelease} from './self-update.ts'; import {journalInterruptedTurns} from './force-update-journal.ts'; import {writeRuntimeRecord} from './runtime.ts'; const layout=${JSON.stringify(layout)}; if(process.env.BOUNDARY==='verification')await stageRelease(layout,${JSON.stringify(manifest)},${JSON.stringify(published)});else if(process.env.BOUNDARY==='journal')journalInterruptedTurns(${JSON.stringify(runtime)},[${JSON.stringify({ ...turn, requestId: 'second' })}]);else if(process.env.BOUNDARY.startsWith('migration'))await writeRuntimeRecord(${JSON.stringify(migrated)});else await activateRelease(layout,'new');`,
          resolveDir: sourceRoot,
        },
        bundle: true,
        platform: 'node',
        format: 'esm',
        outfile: entry,
        banner: { js: barrier },
      });
      child = spawn(process.execPath, [entry], {
        env: { ...process.env, BOUNDARY: point },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr!.on('data', (chunk) => {
        stderr += chunk;
      });
      const exit = new Promise<void>((done) => child!.once('exit', () => done()));
      await new Promise<void>((done, reject) => {
        const deadline = setTimeout(() => reject(new Error(`did not reach ${point}`)), 10_000);
        let output = '';
        child!.stdout!.on('data', (chunk) => {
          output += chunk;
          if (output.includes('boundary\n')) {
            clearTimeout(deadline);
            done();
          }
        });
        child!.once('exit', (code) => {
          clearTimeout(deadline);
          reject(new Error(`child exited before ${point}: ${code}: ${stderr}`));
        });
      });
      child.kill('SIGKILL');
      await exit;
      if (point === 'verification') {
        expect(await readlink(layout.libDir)).toBe('beeline-releases/old');
        expect(
          await readFile(resolve(release, '.stage-ok')).catch(() => undefined),
        ).toBeUndefined();
        await stageRelease(layout, manifest, published);
        await activateRelease(layout, 'new');
      } else if (point.startsWith('migration')) {
        expect(JSON.parse(await readFile(recordPath, 'utf8'))).toEqual(
          point === 'migration-before' ? record : migrated,
        );
        await writeRuntimeRecord(migrated);
        expect(JSON.parse(await readFile(recordPath, 'utf8'))).toEqual(migrated);
      } else if (point === 'journal') {
        const delivered: unknown[] = [];
        await reportInterruptedTurns(
          runtime,
          {
            execute: async (_name, input) => {
              delivered.push(input);
              return {} as never;
            },
          },
          'agent',
        );
        expect(delivered).toHaveLength(1);
        expect(delivered[0]).toMatchObject(turn);
        expect(
          JSON.parse(await readFile(resolve(runtime, 'force-update-interruptions.json'), 'utf8')),
        ).toEqual([]);
      } else {
        expect(await readlink(layout.libDir)).toBe(
          `beeline-releases/${point === 'anchor-before' ? 'old' : 'new'}`,
        );
        await activateRelease(layout, 'new');
        expect(await readlink(layout.libDir)).toBe('beeline-releases/new');
      }
    } finally {
      child?.kill('SIGKILL');
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(root, { recursive: true, force: true });
    }
  },
  20_000,
);
