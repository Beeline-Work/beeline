/**
 * Live proof for the daemon-shipped `using-beeline` skill (`beeline-skill.ts` +
 * `agent-home.ts`'s managed skills directories).
 *
 * Builds the SAME per-room harness home the daemon builds for every Room
 * (`prepareRoomAgentHome`), then drives a real ACP harness inside it and
 * reports whether the harness actually discovers/loads the managed skill —
 * codex-acp surfaces loaded skills as `available_commands_update` entries, so
 * an advertised `using-beeline` command proves the SKILL.md was found, parsed,
 * and loaded by the harness itself.
 *
 * Usage:
 *   npx tsx apps/body/scripts/probe-beeline-skill.ts [agent-command]
 *
 * Defaults to `codex-acp` on PATH; `claude-agent-acp` is the other verified
 * target. Exit code 0 always; read the transcript.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { prepareRoomAgentHome } from '../src/agent-home.js';
import { USING_BEELINE_SKILL_NAME } from '../src/beeline-skill.js';

const agentCommand = process.argv[2] ?? 'codex-acp';

const home = mkdtempSync(join(tmpdir(), 'beeline-skill-probe-'));
const envOverlay = await prepareRoomAgentHome({
  root: join(home, 'agent-home'),
  operatorHome: homedir(),
});
console.log(`[probe] agent home: ${join(home, 'agent-home')}`);

// The managed skill must be on disk in every harness home before the child starts.
for (const [envVar, subdir] of [
  ['CLAUDE_CONFIG_DIR', 'claude'],
  ['CODEX_HOME', 'codex'],
  ['GROK_HOME', 'grok'],
] as const) {
  const skill = join(
    envOverlay[envVar] ?? join(home, 'agent-home', subdir),
    'skills',
    USING_BEELINE_SKILL_NAME,
    'SKILL.md',
  );
  console.log(`[probe] ${envVar}: ${skill} present=${existsSync(skill)}`);
}

const child = spawn(agentCommand, [], {
  env: { ...process.env, ...envOverlay },
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (c) => process.stderr.write(`[agent] ${c}`));

let buf = '';
let nextId = 1;
const pending = new Map();
const advertisedCommands: Array<{ name: string; description?: string }> = [];
let sessionId: string | undefined;

function send(method: string, params: unknown): Promise<Record<string, unknown>> {
  const id = nextId++;
  const payload = { jsonrpc: '2.0', id, method, params };
  child.stdin.write(`${JSON.stringify(payload)}\n`);
  return new Promise((resolvePromise, rejectPromise) => {
    pending.set(id, { resolvePromise, rejectPromise });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        rejectPromise(new Error(`${method} timed out after 60s`));
      }
    }, 60_000);
  });
}

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const entry = pending.get(message.id as number);
      if (entry) {
        pending.delete(message.id as number);
        if (message.error) entry.rejectPromise(new Error(JSON.stringify(message.error)));
        else entry.resolvePromise(message.result as Record<string, unknown>);
      }
      continue;
    }
    if (message.method === 'session/update') {
      const update = (message.params as Record<string, unknown>)?.update as
        Record<string, unknown> | undefined;
      if (update?.sessionUpdate === 'available_commands_update') {
        const commands = (update.availableCommands ?? update.commands ?? []) as Array<
          Record<string, unknown>
        >;
        for (const command of commands) {
          advertisedCommands.push({
            name: String(command.name ?? ''),
            description: command.description ? String(command.description) : undefined,
          });
        }
      }
    }
  }
});

try {
  await send('initialize', {
    protocolVersion: 1,
    clientCapabilities: {},
  });
  console.log('[probe] initialized');

  const created = await send('session/new', {
    cwd: process.cwd(),
    mcpServers: [],
  });
  sessionId = String(created.sessionId);
  console.log(`[probe] session ${sessionId}`);

  // Give late available_commands_update notifications a beat to arrive.
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 3000));

  console.log(
    `[probe] advertised commands (${advertisedCommands.length}):`,
    advertisedCommands.map((command) => command.name).join(', ') || '(none)',
  );
  const managed = advertisedCommands.find((command) =>
    [USING_BEELINE_SKILL_NAME, `$${USING_BEELINE_SKILL_NAME}`].includes(command.name),
  );
  if (managed) {
    console.log(`[probe] RESULT: ${agentCommand} DISCOVERED the managed skill:`);
    console.log(`[probe]   description: ${managed.description?.slice(0, 160)}...`);
  } else {
    console.log(
      `[probe] RESULT: ${agentCommand} did NOT advertise '${USING_BEELINE_SKILL_NAME}' ` +
        '(check stderr above for loader errors)',
    );
  }

  const operatorSkillPath = join(homedir(), '.codex', 'skills');
  if (existsSync(operatorSkillPath)) {
    console.log('[probe] note: probe only ever READS the operator home via prepareRoomAgentHome');
  }
} catch (error) {
  console.error(`[probe] error driving ${agentCommand}:`, error);
} finally {
  child.kill('SIGTERM');
}
