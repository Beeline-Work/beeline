// Container entry: bundle with esbuild, then run after the installer's Node bootstrap.
// No helper lifecycle commands, production runtime pointers, or credential files.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, readdir, watch } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { helperToolchainEnvironment, helperToolchainBins } from '../apps/body/src/helper-toolchain.ts';
import { resolveAgentCommand } from '../apps/body/src/agent-command.ts';
import { AcpClient } from '../apps/body/src/acp.ts';

assert.equal(process.env.PATH, '/usr/bin:/bin');
for (const name of ['node', 'npm', 'codex', 'claude', 'pi']) {
  assert.throws(() => execFileSync('sh', ['-c', `command -v ${name}`], { stdio: 'pipe' }));
}
const proof = '/proof/output';
await mkdir(proof, { recursive: true });
let serial = 0;
const pendingRelays = new Set();
const server = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    if (!request.url.includes('messages') && !request.url.includes('responses') && !request.url.includes('chat/completions')) {
      response.setHeader('content-type', 'application/json'); response.end('{}'); return;
    }
    if (request.url.includes('count_tokens')) { response.setHeader('content-type', 'application/json'); response.end('{"input_tokens":1}'); return; }
    const id = String(++serial);
    const target = join(proof, `${id}.response.json`);
    const pending = join(proof, `${id}.request.json`);
    await writeFile(pending, JSON.stringify({ url: request.url, body: JSON.parse(body) }));
    console.log(`Provider relay request ${id}: ${request.url}`);
    const controller = new AbortController();
    pendingRelays.add(controller);
    response.once('close', () => controller.abort());
    const deadline = setTimeout(() => controller.abort(), 180_000);
    try {
      for await (const event of watch(proof, { signal: controller.signal })) {
        if (event.filename === `${id}.response.json`) break;
      }
      const result = JSON.parse(await readFile(target, 'utf8'));
      response.writeHead(result.status || 200, { 'content-type': result.contentType || 'text/event-stream' });
      response.end(result.body);
    } finally { clearTimeout(deadline); pendingRelays.delete(controller); }
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
try {
  for (const kind of ['codex', 'claude', 'pi']) {
    const env = { ...process.env, HOME: `/proof/home-${kind}`, XDG_CONFIG_HOME: `/proof/home-${kind}/config`,
      XDG_STATE_HOME: `/proof/home-${kind}/state`, XDG_DATA_HOME: '/proof/data', PATH: '/usr/bin:/bin' };
    await mkdir(env.HOME, { recursive: true });
    const before = { ...env, BEELINE_HARNESS_PATH_AUGMENT: '0' };
    assert.throws(() => resolveAgentCommand({ kind, env: before }), /not found/);
    console.log(`Reproduction helper-pinned-dependencies: ${kind} without user installations fails before provisioning`);
    // Exercise the built helper's public installation path using only its bootstrapped Node.
    execFileSync(process.execPath, ['/proof/helper-cli.mjs', 'toolchain', 'install', kind], { env, stdio: 'inherit', timeout: 600_000 });
    const selected = resolveAgentCommand({ kind, env });
    const agentEnv = helperToolchainEnvironment(env);
    assert(selected.command.startsWith('/proof/data/beeline/toolchain/'));
    if (kind === 'codex') {
      agentEnv.CODEX_HOME = join(env.HOME, '.codex');
      await mkdir(agentEnv.CODEX_HOME);
      await writeFile(join(agentEnv.CODEX_HOME, 'config.toml'), `model="toolchain-proof"\nmodel_provider="proof"\n[model_providers.proof]\nname="Proof"\nbase_url="${base}/v1"\nenv_key="PROOF_API_KEY"\nwire_api="responses"\n`);
      agentEnv.PROOF_API_KEY = 'local-relay-placeholder';
    } else if (kind === 'claude') {
      agentEnv.ANTHROPIC_BASE_URL = base;
      agentEnv.ANTHROPIC_AUTH_TOKEN = 'local-relay-placeholder';
      agentEnv.ANTHROPIC_MODEL = 'anthropic/claude-haiku-4.5';
      agentEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    } else {
      agentEnv.PI_CODING_AGENT_DIR = join(env.HOME, '.pi/agent');
      agentEnv.PI_ACP_PI_COMMAND = join(helperToolchainBins(env).find(path => path.includes('/pi-')), 'pi');
      agentEnv.PROOF_API_KEY = 'local-relay-placeholder';
      await mkdir(agentEnv.PI_CODING_AGENT_DIR, { recursive: true });
      await writeFile(join(agentEnv.PI_CODING_AGENT_DIR, 'models.json'), JSON.stringify({ providers: { proof: {
        baseUrl: `${base}/v1`, api: 'openai-completions', apiKey: '$PROOF_API_KEY', models: [{ id: 'toolchain-proof', name: 'Proof', reasoning: false,
          input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
      } } }));
      await writeFile(join(agentEnv.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ defaultProvider: 'proof', defaultModel: 'toolchain-proof' }));
    }
    const client = new AcpClient({ agentCommand: selected.command, agentArgs: selected.args, agentEnv,
      resourceScope: 'none', permissionHandler: async () => ({ outcome: { outcome: 'cancelled' } }) });
    client.on('stderr', text => process.stderr.write(`[${kind}] ${text}`));
    try {
      await client.start(30_000);
      console.log(`${kind}: ACP initialized`);
      const session = await client.sessionNew({ cwd: env.HOME, timeoutMs: 30_000 });
      console.log(`${kind}: ACP session opened`);
      const result = await client.sessionPrompt(session.sessionId, 'Reply exactly TOOLCHAIN_OK. Do not use tools.', 240_000);
      assert.match(result.agentText, /TOOLCHAIN_OK/);
      console.log(`Reproduction helper-pinned-dependencies PASS: ${kind} answered ${JSON.stringify(result.agentText)}`);
      await writeFile(join(proof, `${kind}.pass.json`), JSON.stringify({ kind, command: selected.command, answer: result.agentText }));
    } finally { await client.stop(); }
    // A second start must do no downloads or replacement.
    const generations = await readdir('/proof/data/beeline/toolchain');
    execFileSync(process.execPath, ['/proof/helper-cli.mjs', 'toolchain', 'install', kind], { env, stdio: 'inherit', timeout: 30_000 });
    assert.deepEqual(await readdir('/proof/data/beeline/toolchain'), generations);
  }
} finally { for (const controller of pendingRelays) controller.abort(); server.closeAllConnections(); server.close(); }
