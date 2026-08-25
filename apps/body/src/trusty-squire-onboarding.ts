/**
 * Human, pair-time half of Beeline's Trusty Squire integration.
 *
 * This module is never imported by the daemon path. `connect` runs while the
 * operator is present, on their own machine, and Trusty Squire itself performs
 * the live idempotency probe: a valid local vault/account/provider link refreshes
 * config without opening a browser; only missing or stale state starts the
 * Google/GitHub browser ceremony.
 */
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { AgentKind } from './agent-command.js';
import { SQUIRE_MCP_PACKAGE } from './external-mcp-capabilities.js';
import { trustySquireHostEnv } from './trusty-squire-storage.js';

const CONNECT_TIMEOUT_MS = 30 * 60_000;

const TRUSTY_SQUIRE_SKILL = `---
name: trusty-squire
description: Use Trusty Squire when an agent must call an external API with a vaulted credential or mint/revoke bounded backend egress without exposing the provider secret.
license: MIT
metadata:
  homepage: https://trustysquire.ai
  repository: https://github.com/Trusty-Squire/trusty-squire
  npm: "@trusty-squire/mcp"
---

# Trusty Squire in Beeline

Trusty Squire is the machine-local credential layer. Raw provider credentials
never enter chat, source, logs, or .env files.

- Use \`list_credentials\` to select an opaque credential reference.
- Use \`use_credential\` for one authenticated HTTPS call; the secret is
  injected only at Squire's outbound boundary.
- Use \`grant_app_access\` only with an explicit \`rate_limit_per_hour\`; its
  token is backend-only, host-scoped, audited, and independently revocable.
- Use \`list_app_access\` and \`revoke_app_access\` as the immediate kill switch.
- Every credential use, egress grant, and revocation requires a signed Beeline
  factory permission card for the exact arguments. Never work around that card.
`;

export type TrustySquireConnectTarget = 'codex' | 'claude-code';

export function trustySquireConnectTarget(kind: AgentKind): TrustySquireConnectTarget | undefined {
  if (kind === 'codex') return 'codex';
  if (kind === 'claude') return 'claude-code';
  return undefined;
}

export function assertTrustySquireConnectSupported(kind: AgentKind): TrustySquireConnectTarget {
  const target = trustySquireConnectTarget(kind);
  if (!target) {
    throw new Error(
      `Trusty Squire requires a harness with both a supported connect target and ` +
        `interceptable MCP permission calls; ${kind} cannot enforce the P1 credential gate`,
    );
  }
  return target;
}

export interface TrustySquireConnectRunner {
  (
    command: string,
    args: readonly string[],
    timeoutMs: number,
    env: NodeJS.ProcessEnv,
  ): Promise<void>;
}

async function runConnectProcess(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    let timer: NodeJS.Timeout | undefined;
    const child = spawn(command, [...args], { stdio: 'inherit', env });
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    child.once('error', (error) => finish(error));
    child.once('exit', (code, signal) => {
      if (code === 0) finish();
      else
        finish(
          new Error(
            `Trusty Squire connect failed` +
              (signal ? ` (${signal})` : ` (exit ${code ?? 'unknown'})`),
          ),
        );
    });
    timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new Error(`Trusty Squire connect timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
  });
}

async function ensureSkillAt(path: string): Promise<string> {
  try {
    await access(path, constants.R_OK);
    return path;
  } catch {
    // Missing is the expected first-install path.
  }
  await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, TRUSTY_SQUIRE_SKILL, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') throw error;
  }
  return path;
}

/** Install the cross-harness copy without replacing an operator-owned skill. */
export async function ensureTrustySquireSkill(operatorHome = homedir()): Promise<string> {
  return ensureSkillAt(resolve(operatorHome, '.agents', 'skills', 'trusty-squire', 'SKILL.md'));
}

async function ensureHarnessSkill(kind: AgentKind, operatorHome: string): Promise<string> {
  const harnessDir = kind === 'codex' ? '.codex' : '.claude';
  return ensureSkillAt(resolve(operatorHome, harnessDir, 'skills', 'trusty-squire', 'SKILL.md'));
}

/**
 * Run the upstream connect contract exactly once per pair attempt. Its own
 * preflight makes this idempotent and opens a browser only when the local
 * vault/account/provider link is absent or stale. `--no-interactive` skips the
 * redundant agent/settings picker, not the human OAuth browser ceremony.
 */
export async function connectTrustySquireForPair(input: {
  agentKind: AgentKind;
  operatorHome?: string;
  configRoot: string;
  run?: TrustySquireConnectRunner;
}): Promise<{ target: TrustySquireConnectTarget; skillPath: string }> {
  const target = assertTrustySquireConnectSupported(input.agentKind);
  await mkdir(input.configRoot, { recursive: true, mode: 0o700 });
  await chmod(input.configRoot, 0o700);
  await (input.run ?? runConnectProcess)(
    'npx',
    ['-y', SQUIRE_MCP_PACKAGE, 'connect', `--target=${target}`, '--no-interactive'],
    CONNECT_TIMEOUT_MS,
    {
      ...trustySquireHostEnv(process.env, input.configRoot),
      TRUSTY_SQUIRE_SKIP_VERSION_CHECK: '1',
    },
  );
  const operatorHome = input.operatorHome ?? homedir();
  await ensureTrustySquireSkill(operatorHome);
  // `agent-home.ts` links this harness-native skills directory into every
  // isolated Room/corner state root. The generic copy above also makes the
  // skill discoverable to hosts that read the shared agents convention.
  const skillPath = await ensureHarnessSkill(input.agentKind, operatorHome);
  return { target, skillPath };
}
