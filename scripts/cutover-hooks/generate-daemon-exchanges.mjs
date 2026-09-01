#!/usr/bin/env node
import { chmod, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PostgresDatabase } from '../../apps/server/dist/database.js';
import { TokenAuth } from '../../apps/server/dist/auth.js';

function fail(message) { throw new Error(message); }
const [output, ...runtimePaths] = process.argv.slice(2);
if (!output || runtimePaths.length === 0) fail('usage: generate-daemon-exchanges.mjs OUTPUT RUNTIME.json...');
if (!process.env.DATABASE_URL) fail('DATABASE_URL is required');

const path = resolve(output);
if (await stat(path).then(() => true, () => false)) fail(`refusing to replace existing manifest: ${path}`);
const runtimes = [];
const seen = new Set();
for (const rawPath of runtimePaths) {
  const runtimePath = resolve(rawPath);
  const runtime = JSON.parse(await readFile(runtimePath, 'utf8'));
  const agentId = runtime?.agent?.publicKey;
  if (runtime?.version !== 2 || typeof agentId !== 'string' || !/^[0-9a-f]{64}$/.test(agentId)) {
    fail(`invalid v2 runtime identity: ${runtimePath}`);
  }
  if (seen.has(agentId)) fail(`duplicate agent runtime: ${agentId}`);
  seen.add(agentId);
  runtimes.push({ agentId, runtimePath });
}

const entries = [];
const database = new PostgresDatabase(process.env.DATABASE_URL, 1);
const auth = new TokenAuth(database, async () => fail('GitHub verifier is not used'));
try {
  for (const runtime of runtimes) {
    const { exchangeToken } = await auth.createDaemonExchange(runtime.agentId);
    entries.push({ ...runtime, exchangeToken });
  }
} finally { await database.close(); }

const temporary = `${path}.tmp-${process.pid}`;
await open(temporary, 'wx', 0o600).then(async (handle) => {
  try { await handle.writeFile(`${JSON.stringify(entries, null, 2)}\n`, { encoding: 'utf8' }); }
  finally { await handle.close(); }
});
try {
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
} catch (error) {
  await rm(temporary, { force: true });
  throw error;
}
process.stdout.write(`wrote ${entries.length} daemon exchanges to ${path}\n`);
